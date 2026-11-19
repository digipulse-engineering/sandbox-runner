import assert from "node:assert/strict";
import test from "node:test";
import { codexApiCreditPromoRestriction } from "../codex-api-diagnostics.ts";
import { mcpWriteClaimed } from "../mcp-run-access.ts";
import { runEventsPage } from "../run-events.ts";
import { activeAttempt, activeEgressAttempt, admissionPolicy, advanceStrategy, attemptName, newStrategyRun, policyFor, pollStrategy,
  requestStrategyCancellation, STRATEGY_RUN, strategyReadiness, strategyView, writeStrategyRun } from "../strategy.ts";

const id = "12b712d0-f53d-45e3-9128-17d3667c5487";
const input = { operationId: id, agent: "codex", authMode: "api-key", prompt: "  same prompt  " };
const quota = { status: "capacity", reason: "provider_quota_exhausted", cleanup: "destroyed" };
const success = { status: "succeeded", cleanup: "destroyed", output: "Fixture success." };
const strategies = [
  ["api-key-only", "api-key", undefined],
  ["api-key-first-then-subscription", "api-key", "subscription"],
  ["subscription-only", "subscription", undefined],
  ["subscription-first-then-api-key", "subscription", "api-key"],
];
const secret = (strategy, apiSpendCapConfirmed = true) => JSON.stringify({ strategy, apiSpendCapConfirmed });
const policy = (strategy, agent = "codex") => policyFor(agent, {
  SANDBOX_RUNNER_CODEX_AUTH_STRATEGY: secret(strategy),
  SANDBOX_RUNNER_CLAUDE_AUTH_STRATEGY: secret(strategy),
});

function childView(request, snapshot) {
  return { id: request.operationId, agent: request.agent, authMode: request.authMode, ...snapshot };
}

function observe(run, snapshot) {
  return pollStrategy(run, request => Promise.resolve(childView(request, snapshot)));
}

function durableStorage(state) {
  const records = new Map(structuredClone(state.records));
  let alarm = state.alarm;
  let pending = Promise.resolve();
  const tx = {
    async get(key) { return structuredClone(records.get(key)); },
    async put(key, value) { records.set(key, structuredClone(value)); },
    async delete(key) { return records.delete(key); },
    async setAlarm(time) { alarm = time; },
    async deleteAlarm() { alarm = null; },
  };
  return {
    transaction(callback) {
      const result = pending.then(() => callback(tx));
      pending = result.catch(() => {});
      return result;
    },
    snapshot() { return { records: [...structuredClone(records)], alarm }; },
    run() { return structuredClone(records.get(STRATEGY_RUN)); },
  };
}

test("a fallback reviewer keeps its producer and projects only the settled review attempt", async () => {
  const producerAgent = "claude";
  const profile = { slug: "review-codex", source: "client-supplied", revision: "a".repeat(64),
    requestDigest: "b".repeat(64), producerSource: "declared" };
  const inputWithReview = { ...input, profile, reviewProducer: producerAgent, repository: { slug: "Owner/Repo", sha: "a".repeat(40) } };
  const run = newStrategyRun(inputWithReview, policy("api-key-first-then-subscription"));
  const admit = (state, snapshot) => pollStrategy(state, request => {
    assert.equal(request.reviewProducer, producerAgent);
    assert.deepEqual(request.profile, profile);
    assert.deepEqual(request.repository, inputWithReview.repository);
    return Promise.resolve(childView(request, { ...snapshot, repository: inputWithReview.repository,
      review: snapshot.review ?? { producerAgent } }));
  });
  const fallback = await admit(run, quota);
  assert.equal(fallback.attempts.length, 2);
  assert.deepEqual(strategyView(fallback).review, { producerAgent });
  const review = { producerAgent, verdict: "ESCALATE", findings: ["The fixture needs an operator decision."] };
  const settled = strategyView(await admit(fallback, { status: "succeeded", cleanup: "destroyed", review }));
  assert.deepEqual(settled.review, review);
  assert.deepEqual(settled.profile, profile);
  assert.equal(settled.authMode, "subscription");
  assert.equal(settled.output, undefined);
});

test("parses only the selected secret and requires spend cap attestation for every API strategy", () => {
  assert.equal(policyFor("codex", {}), undefined);
  const env = {
    SANDBOX_RUNNER_CLAUDE_AUTH_STRATEGY: JSON.stringify({ strategy: "subscription-only" }),
    get SANDBOX_RUNNER_CODEX_AUTH_STRATEGY() { assert.fail("read unselected secret"); },
  };
  assert.equal(policyFor("claude", env)?.strategy, "subscription-only");
  for (const [strategy] of strategies) {
    assert.equal(policy(strategy)?.strategy, strategy);
    if (strategy !== "subscription-only") {
      for (const value of [{ strategy }, { strategy, apiSpendCapConfirmed: false }]) {
        assert.equal(policyFor("codex", { SANDBOX_RUNNER_CODEX_AUTH_STRATEGY: JSON.stringify(value) }), "auth_strategy_invalid");
      }
    }
  }
  for (const raw of [
    "", "null", "[]", "{}", "not-json", '"subscription-only"',
    '{"strategy":"__proto__"}',
    '{"strategy":"subscription-only","apiSpendCapConfirmed":"false"}',
    '{"strategy":"subscription-only","unexpected":true}',
    '{"strategy":"api-key-only","apiSpendCapConfirmed":1}',
  ]) {
    assert.equal(policyFor("codex", { SANDBOX_RUNNER_CODEX_AUTH_STRATEGY: raw }), "auth_strategy_invalid");
  }
});

test("a strategy profile run never falls back to the default mode", () => {
  const configured = { SANDBOX_RUNNER_CODEX_AUTH_STRATEGY: JSON.stringify({ strategy: "api-key-first-then-subscription",
    apiSpendCapConfirmed: true }) };
  const invalid = { SANDBOX_RUNNER_CODEX_AUTH_STRATEGY: "{}" };
  // A run without an explicit mode and without a strategy profile keeps the default mode when no strategy exists.
  assert.equal(admissionPolicy("codex", {}, true, false), undefined);
  // A strategy profile run is refused instead.
  assert.equal(admissionPolicy("codex", {}, true, true), "auth_strategy_invalid");
  assert.equal(admissionPolicy("codex", invalid, true, true), "auth_strategy_invalid");
  assert.equal(admissionPolicy("codex", invalid, true, false), "auth_strategy_invalid");
  assert.equal(admissionPolicy("codex", configured, true, true)?.strategy, "api-key-first-then-subscription");
  // An explicit mode or an OpenCode run never reads a strategy.
  const unread = { get SANDBOX_RUNNER_CODEX_AUTH_STRATEGY() { assert.fail("read strategy for an explicit run"); } };
  assert.equal(admissionPolicy("codex", unread, false, false), undefined);
  assert.equal(admissionPolicy("opencode", unread, true, true), undefined);
});

test("readiness of a strategy profile requires a valid strategy and a credential for each of its modes", () => {
  const env = strategy => ({ SANDBOX_RUNNER_CLAUDE_AUTH_STRATEGY: JSON.stringify({ strategy, apiSpendCapConfirmed: true }) });
  const only = available => mode => mode === available;
  assert.equal(strategyReadiness("claude", {}, () => true), "auth_strategy_invalid");
  assert.equal(strategyReadiness("claude", { SANDBOX_RUNNER_CLAUDE_AUTH_STRATEGY: "{}" }, () => true), "auth_strategy_invalid");
  assert.equal(strategyReadiness("claude", env("api-key-first-then-subscription"), () => true), undefined);
  assert.equal(strategyReadiness("claude", env("api-key-first-then-subscription"), only("api-key")), "provider_credential_not_configured");
  assert.equal(strategyReadiness("claude", env("api-key-only"), only("api-key")), undefined);
  assert.equal(strategyReadiness("claude", env("subscription-only"), only("api-key")), "provider_credential_not_configured");
});

test("all strategies reserve one initial attempt with a distinct identity", async () => {
  for (const [strategy, firstMode, fallbackMode] of strategies) {
    const run = newStrategyRun(input, policy(strategy));
    const before = strategyView(run);
    assert.equal(before.id, input.operationId);
    assert.equal(before.strategy, strategy);
    assert.equal(before.authMode, firstMode);
    assert.equal(before.status, "queued");
    assert.equal(before.cleanup, "pending");
    assert.equal(before.attempts.length, 1);
    assert.notEqual(before.attempts[0].operationId, before.id);
    assert.equal(before.prompt, undefined);
    assert.equal(before.policy, undefined);
    const after = strategyView(await observe(run, quota));
    assert.equal(after.authMode, fallbackMode ?? firstMode);
    assert.equal(after.status, fallbackMode ? "queued" : "capacity");
    assert.equal(after.fallbackReason, fallbackMode ? quota.reason : undefined);
    assert.equal(after.attempts.length, fallbackMode ? 2 : 1);
    if (fallbackMode) {
      assert.equal(new Set([after.id, ...after.attempts.map(attempt => attempt.operationId)]).size, 3);
      assert.equal(after.attempts[0].reason, quota.reason);
      assert.equal(after.attempts[0].cleanup, "destroyed");
    }
  }
});

test("requires exact quota and destroyed cleanup before reserving a fallback", async () => {
  for (const snapshot of [
    { ...quota, reason: "provider_capacity" },
    { ...quota, reason: "provider_overloaded" },
    { ...quota, status: "failed", reason: "provider_timeout" },
    { ...quota, status: "failed", reason: codexApiCreditPromoRestriction },
    { ...quota, status: "failed" },
    { ...quota, status: "auth_required", reason: "provider_credential_missing" },
    { ...quota, status: "unanswered", reason: "container_lost" },
    { ...quota, reason: undefined },
    { ...quota, cleanup: "failed" },
  ]) {
    const run = newStrategyRun(input, policy("api-key-first-then-subscription"));
    const view = strategyView(await observe(run, snapshot));
    assert.equal(view.attempts.length, 1);
    assert.equal(view.status, snapshot.status);
    assert.equal(view.cleanup, snapshot.cleanup);
    assert.equal(view.fallbackReason, undefined);
  }
  let run = newStrategyRun(input, policy("api-key-first-then-subscription"));
  run = await observe(run, { ...quota, cleanup: "pending" });
  assert.equal(strategyView(run).attempts.length, 1);
  assert.equal(strategyView(run).cleanup, "pending");
  const resumed = await observe(run, quota);
  assert.equal(strategyView(resumed).attempts.length, 2);
  assert.equal(strategyView(resumed).authMode, "subscription");
});

test("keeps the two-attempt journal and the final outcome, including missing credentials", async () => {
  const first = newStrategyRun(input, policy("api-key-first-then-subscription"));
  const retry = await observe(first, { ...quota, output: "This first attempt output must stay private." });
  for (const snapshot of [success, quota, { ...quota, status: "auth_required", reason: "provider_credential_missing" }]) {
    const run = await observe(retry, snapshot);
    const view = strategyView(run);
    assert.equal(view.id, input.operationId);
    assert.equal(view.authMode, "subscription");
    assert.equal(view.status, snapshot.status);
    assert.equal(view.cleanup, snapshot.cleanup);
    assert.equal(view.output, snapshot.output);
    assert.equal(view.reason, snapshot.reason);
    assert.equal(view.fallbackReason, quota.reason);
    assert.equal(view.attempts.length, 2);
    assert(view.attempts.every(attempt => !("output" in attempt)));
    assert.equal(await pollStrategy(run, () => assert.fail("a settled root reserved another attempt")), run);
  }
});

test("retries a lost reservation reply with the persisted child and prompt", async () => {
  const byName = new Map();
  let root = newStrategyRun(input, policy("api-key-first-then-subscription"));
  const initial = activeAttempt(root);
  const saved = () => JSON.parse(JSON.stringify(root));
  const ambiguous = () => new Error("synthetic RPC dropped its reply");
  function reserve(request, reply, drop) {
    const name = attemptName(root.id, request.operationId);
    if (byName.has(name)) assert.deepEqual(request, byName.get(name));
    else byName.set(name, request);
    if (drop) throw ambiguous();
    return Promise.resolve(childView(request, reply));
  }
  await assert.rejects(pollStrategy(root, request => reserve(request, quota, true)), /synthetic RPC/);
  // Simulate eviction. Even a new policy would not replace this persisted snapshot.
  root = saved();
  assert.equal(activeAttempt(root).operationId, initial.operationId);
  assert.notEqual(root.policy.strategy, policy("subscription-only").strategy);
  root = await pollStrategy(root, request => reserve(request, quota));
  const fallback = activeAttempt(root);
  await assert.rejects(pollStrategy(root, request => reserve(request, success, true)), /synthetic RPC/);
  root = saved();
  assert.equal(activeAttempt(root).operationId, fallback.operationId);
  root = await pollStrategy(root, request => reserve(request, success));
  assert.equal(byName.size, 2);
  assert([...byName.values()].every(request => request.prompt === input.prompt));
  assert.equal(strategyView(root).output, success.output);
});

test("freezes requested and resolved Claude settings through eviction, quota fallback and the public journal", async () => {
  const settings = { model: "opus", effort: "high" };
  const overrides = { model: settings.model };
  const claude = { ...input, agent: "claude", overrides };
  let root = newStrategyRun(claude, policy("api-key-first-then-subscription", "claude"), settings);
  assert.deepEqual(root.overrides, overrides);
  assert.equal(strategyView(root).overrides, undefined);
  assert.equal(strategyView(root).effort, "high");
  let requests = 0;
  const reserve = (snapshot) => (request, frozen) => {
    requests += 1;
    assert.deepEqual(frozen, settings);
    assert.equal(request.overrides, undefined);
    return Promise.resolve(childView(request, { ...snapshot, ...frozen }));
  };
  root = await pollStrategy(root, reserve(quota));
  root = await pollStrategy(JSON.parse(JSON.stringify(root)), reserve(success));
  const view = strategyView(root);
  assert.equal(requests, 2);
  assert.equal(view.model, settings.model);
  assert.equal(view.effort, settings.effort);
  assert.equal(view.output, success.output);
  assert.equal(view.fallbackReason, quota.reason);
  for (const attempt of view.attempts) {
    assert.equal(attempt.model, settings.model);
    assert.equal(attempt.effort, settings.effort);
  }
  const wrong = await pollStrategy(
    newStrategyRun(claude, policy("api-key-first-then-subscription", "claude"), settings),
    request => Promise.resolve(childView(request, { ...quota, ...settings, model: "haiku" })),
  );
  assert.equal(strategyView(wrong).cleanup, "failed");
  assert.equal(strategyView(wrong).attempts.length, 1);
});

test("keeps Codex reviewer settings in an API-only strategy attempt and its receipt", async () => {
  const settings = { model: "gpt-6-astra", effort: "xhigh" };
  const root = newStrategyRun({ ...input, agent: "codex", overrides: settings }, policy("api-key-only"), settings);
  const restored = JSON.parse(JSON.stringify(root));
  const completed = await pollStrategy(restored, (request, frozen) => {
    assert.equal(request.agent, "codex");
    assert.equal(request.authMode, "api-key");
    assert.deepEqual(frozen, settings);
    return Promise.resolve(childView(request, { ...success, ...frozen }));
  });
  const receipt = strategyView(completed);
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.model, settings.model);
  assert.equal(receipt.effort, settings.effort);
  assert.equal(receipt.attempts.length, 1);
  assert.deepEqual({ model: receipt.attempts[0].model, effort: receipt.attempts[0].effort }, settings);
});

test("passes the admitted sandbox provider to both attempts across eviction", async () => {
  const routing = { request: { explicitAuth: false }, sandboxProvider: "cloudflare" };
  let root = newStrategyRun(input, policy("api-key-first-then-subscription"), {}, routing);
  const seen = [];
  const reserve = (outcome) => async (request, settings, snapshot) => {
    seen.push(snapshot);
    return childView(request, { ...outcome, kind: "agent", sandboxProvider: snapshot.sandboxProvider });
  };
  root = await pollStrategy(root, reserve(quota));
  root = await pollStrategy(structuredClone(root), reserve(success));
  assert.deepEqual(seen, [routing, routing]);
  assert.equal(strategyView(root).kind, "agent");
  assert.equal(strategyView(root).sandboxProvider, "cloudflare");
  assert.equal(strategyView(root).status, "succeeded");
  assert.equal(strategyView(root).routing, undefined);
});

test("ignores stale snapshots and fails closed on an unverified child", async () => {
  let run = newStrategyRun(input, policy("api-key-first-then-subscription"));
  run = await observe(run, { status: "running", cleanup: "pending" });
  assert.equal(await observe(run, { status: "queued", cleanup: "pending" }), run);
  run = await observe(run, { ...quota, cleanup: "pending" });
  assert.equal(await observe(run, { status: "running", cleanup: "pending" }), run);
  const failed = strategyView(await pollStrategy(run, () => Promise.resolve(null)));
  assert.equal(failed.status, "capacity");
  assert.equal(failed.cleanup, "failed");
  assert.equal(failed.attempts.length, 1);
});

const timing = { advance: 2_000, recovery: 30_000 };

test("keeps a concurrent connector diagnostic and pins the grant generation across fallback", async () => {
  const connectors = ["acme-staging"];
  const generations = { "acme-staging": crypto.randomUUID() };
  const original = newStrategyRun({ ...input, connectors }, policy("api-key-first-then-subscription"),
    {}, undefined, undefined, undefined, undefined, {}, generations);
  const issue = { code: "mcp_connector_tool_unavailable", connector: connectors[0], mode: "read-write" };
  const storage = durableStorage({ records: [[STRATEGY_RUN, original]], alarm: null });
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const first = advanceStrategy(storage, async (_id, request, _settings, _routing, _cancel, _repository, _bytes, _deadline, _policy, pins) => {
    assert.deepEqual(pins, generations);
    started.resolve();
    await release.promise;
    return childView(request, { ...quota, connectorAccess: original.connectorAccess });
  }, timing);
  await started.promise;
  await storage.transaction(async tx => {
    const current = await tx.get(STRATEGY_RUN);
    await writeStrategyRun(tx, { ...current, connectorIssues: [issue] }, current);
  });
  release.resolve();
  await first;
  assert.equal(strategyView(storage.run()).attempts.length, 2);
  await advanceStrategy(storage, async (_id, request, _settings, _routing, _cancel, _repository, _bytes, _deadline, _policy, pins) => {
    assert.deepEqual(pins, generations);
    return childView(request, { ...success, connectorAccess: original.connectorAccess });
  }, timing);
  const view = strategyView(storage.run());
  assert.deepEqual(view.connectorIssues, [issue]);
  assert.equal(view.connectorGenerations, undefined);
});

test("a durable MCP write claim during a quota poll fences the fallback", async () => {
  const connectors = ["github"];
  const original = newStrategyRun({ ...input, connectors }, policy("api-key-first-then-subscription"));
  const storage = durableStorage({ records: [[STRATEGY_RUN, original]], alarm: null });
  const dispatched = Promise.withResolvers();
  const received = Promise.withResolvers();
  const poll = advanceStrategy(storage, async (_root, request) => {
    assert.deepEqual(request.connectors, connectors);
    dispatched.resolve();
    await received.promise;
    return childView(request, { ...quota, connectorAccess: original.connectorAccess });
  }, timing);
  await dispatched.promise;
  await storage.transaction(tx => tx.put(mcpWriteClaimed, true));
  received.resolve();
  await poll;
  const result = strategyView(storage.run());
  assert.equal(result.status, "capacity");
  assert.equal(result.connectorFallbackBlocked, true);
  assert.equal(result.fallbackReason, undefined);
  assert.equal(result.attempts.length, 1);

  const fresh = await pollStrategy(original, request => Promise.resolve(childView(request, {
    ...quota, connectorAccess: original.connectorAccess,
  })));
  assert.equal(strategyView(fresh).attempts.length, 2);
});

test("cancellation fences an in-flight quota result and addresses the same child until cleanup", async () => {
  const routing = { request: { explicitAuth: false }, sandboxProvider: "cloudflare" };
  const repository = { slug: "fixture/private", sha: "a".repeat(40) };
  const snapshot = { owner: "fixture", name: "private", repositoryId: 101 };
  const original = newStrategyRun({ ...input, repository }, policy("api-key-first-then-subscription"), {}, routing, snapshot);
  const initialId = activeAttempt(original).operationId;
  assert.equal(activeEgressAttempt(original, initialId), activeAttempt(original));
  assert.equal(activeEgressAttempt(original, original.id), undefined);
  let storage = durableStorage({ records: [[STRATEGY_RUN, original]], alarm: null });
  const started = Promise.withResolvers();
  const released = Promise.withResolvers();
  const delayed = advanceStrategy(storage, async (_root, request, _settings, _routing, cancel, githubRepository) => {
    assert.equal(cancel, false);
    assert.deepEqual(request.repository, repository);
    assert.deepEqual(githubRepository, snapshot);
    started.resolve();
    await released.promise;
    return childView(request, { ...quota, repository, sandboxProvider: "cloudflare" });
  }, timing);
  await started.promise;
  const requestCancellation = () => storage.transaction(async tx => requestStrategyCancellation(tx, await tx.get(STRATEGY_RUN)));
  await requestCancellation();
  const requested = storage.snapshot();
  assert.equal(activeEgressAttempt(storage.run(), initialId), undefined);
  await requestCancellation();
  assert.deepEqual(storage.snapshot(), requested);
  released.resolve();
  await delayed;
  assert.deepEqual(storage.snapshot(), requested);

  storage = durableStorage(structuredClone(requested));
  for (const cleanup of ["pending", "destroyed"]) {
    await advanceStrategy(storage, async (rootId, request, settings, resolved, cancel, githubRepository) => {
      assert.equal(rootId, original.id);
      assert.equal(request.operationId, initialId);
      assert.equal(cancel, true);
      assert.deepEqual(resolved, routing);
      assert.deepEqual(request.repository, repository);
      assert.deepEqual(githubRepository, snapshot);
      return childView(request, { ...settings, repository, sandboxProvider: "cloudflare", status: "cancelled", cleanup, reason: "run_cancelled" });
    }, timing);
    const view = strategyView(storage.run());
    assert.equal(view.cancellationRequested, true);
    assert.equal(view.status, "cancelled");
    assert.equal(view.cleanup, cleanup);
    assert.equal(view.attempts.length, 1);
    assert.equal(view.fallbackReason, undefined);
    assert.deepEqual(view.repository, repository);
    assert.equal(view.githubRepository, undefined);
  }
  assert.equal(storage.snapshot().alarm, null);
  const page = await storage.transaction(tx => runEventsPage(tx, strategyView(storage.run()), 0));
  assert.deepEqual(page.events.map(event => event.type), [
    "snapshot", "cancellation_requested", "attempt_state", "state", "attempt_cleanup", "cleanup",
  ]);
  assert.equal(page.events[3].status, "cancelled");
  assert.equal(page.events[5].cleanup, "destroyed");
  assert.equal(JSON.stringify(page).includes(repository.slug), false);
  assert.equal(JSON.stringify(page).includes(repository.sha), false);
});

test("a cancellation request suppresses fallback when the child already finished on quota", async () => {
  const original = newStrategyRun(input, policy("api-key-first-then-subscription"));
  const run = { ...original, cancellationRequested: true };
  const view = strategyView(await pollStrategy(run, async (request, _settings, _routing, cancel) => {
    assert.equal(cancel, true);
    return childView(request, quota);
  }));
  assert.equal(view.status, "capacity");
  assert.equal(view.cancellationRequested, true);
  assert.equal(view.attempts.length, 1);
  assert.equal(view.cleanup, "destroyed");
});

test("a stale alarm reply cannot replace the committed fallback or schedule another child", async () => {
  const repository = { slug: "fixture/private", sha: "b".repeat(40) };
  const githubRepository = { owner: "fixture", name: "private", repositoryId: 101 };
  const routing = { request: { explicitAuth: false }, sandboxProvider: "cloudflare" };
  const original = newStrategyRun({ ...input, repository }, policy("api-key-first-then-subscription"), {}, routing, githubRepository);
  const initialId = activeAttempt(original).operationId;
  const storage = durableStorage({ records: [], alarm: null });
  await storage.transaction(tx => writeStrategyRun(tx, original));
  const firstStarted = Promise.withResolvers();
  const releaseStale = Promise.withResolvers();
  const submitted = new Map();
  async function reserve(rootId, request, _settings, resolved, cancel, snapshot) {
    assert.deepEqual(resolved, routing);
    assert.equal(cancel, false);
    assert.deepEqual(snapshot, githubRepository);
    assert.deepEqual(request.repository, repository);
    const name = attemptName(rootId, request.operationId);
    const prior = submitted.get(name);
    if (prior) assert.deepEqual(prior, request);
    else submitted.set(name, request);
    if (request.operationId === initialId) {
      if (!prior) {
        firstStarted.resolve();
        await releaseStale.promise;
      }
      return childView(request, { ...quota, repository, sandboxProvider: "cloudflare" });
    }
    return childView(request, { ...success, repository, sandboxProvider: "cloudflare" });
  }

  const stale = advanceStrategy(storage, reserve, timing);
  await firstStarted.promise;
  await advanceStrategy(storage, reserve, timing);
  const winner = activeAttempt(storage.run()).operationId;
  assert.notEqual(winner, initialId);
  await advanceStrategy(storage, reserve, timing);
  const terminal = storage.snapshot();
  assert.equal(strategyView(storage.run()).status, "succeeded");
  assert.deepEqual(strategyView(storage.run()).repository, repository);
  assert.equal(terminal.alarm, null);
  releaseStale.resolve();
  await stale;
  assert.deepEqual(storage.snapshot(), terminal);
  assert.equal(activeAttempt(storage.run()).operationId, winner);
  assert.equal(submitted.size, 2);
  const page = await storage.transaction(tx => runEventsPage(tx, strategyView(storage.run()), 0));
  assert.deepEqual(page.events.map(event => event.type), [
    "admitted", "attempt_admitted", "attempt_state", "attempt_cleanup", "fallback", "attempt_admitted",
    "attempt_state", "attempt_cleanup", "state", "cleanup",
  ]);
  assert.deepEqual(page.events[4], {
    type: "fallback", cursor: 5, fromOperationId: initialId, operationId: winner, reason: quota.reason,
  });
  assert.equal(JSON.stringify(page).includes(success.output), false);
  assert.equal(JSON.stringify(page).includes(repository.slug), false);
  assert.equal(JSON.stringify(page).includes(repository.sha), false);
});

test("an ambiguous reservation leaves a recovery alarm and reuses the same attempt after eviction", async () => {
  const original = newStrategyRun(input, policy("api-key-first-then-subscription"));
  let storage = durableStorage({ records: [[STRATEGY_RUN, original]], alarm: null });
  let submitted;
  await advanceStrategy(storage, (rootId, request) => {
    assert.equal(rootId, original.id);
    submitted = request;
    throw new Error("synthetic RPC timed out after acceptance");
  }, timing);
  const persisted = storage.snapshot();
  assert(Number.isFinite(persisted.alarm));
  assert.deepEqual(storage.run(), original);
  storage = durableStorage(JSON.parse(JSON.stringify(persisted)));
  await advanceStrategy(storage, async (rootId, request) => {
    assert.equal(rootId, original.id);
    assert.deepEqual(request, submitted);
    return childView(request, quota);
  }, timing);
  assert.equal(strategyView(storage.run()).fallbackReason, quota.reason);
  assert.equal(storage.run().attempts[0].operationId, submitted.operationId);
  assert.equal(storage.run().attempts.length, 2);
  assert(Number.isFinite(storage.snapshot().alarm));
});

test("a quota reply at the deadline remains in history and cannot reserve fallback", async t => {
  const deadline = { admittedAt: 10_000, deadlineAt: 10_020, timeoutMs: 20 };
  t.mock.timers.enable({ apis: ["Date"], now: deadline.admittedAt });
  const original = newStrategyRun(input, policy("api-key-first-then-subscription"), {}, undefined, undefined, undefined, deadline);
  const storage = durableStorage({ records: [], alarm: null });
  await storage.transaction(tx => writeStrategyRun(tx, original));
  const received = Promise.withResolvers();
  const release = Promise.withResolvers();
  const originalAttempt = activeAttempt(original);
  const operation = advanceStrategy(storage, async (_root, request, _settings, _routing, _cancel, _repository, _publicationMaxBytes, inherited) => {
    assert.equal(request.operationId, originalAttempt.operationId);
    assert.deepEqual(inherited, deadline);
    received.resolve();
    await release.promise;
    return childView(request, { ...quota, deadlineAt: inherited.deadlineAt });
  }, timing);
  await received.promise;
  assert.equal(storage.snapshot().alarm, deadline.deadlineAt);
  t.mock.timers.setTime(deadline.deadlineAt);
  assert.equal(activeEgressAttempt(original, originalAttempt.operationId), undefined);
  release.resolve();
  await operation;
  assert.equal(strategyView(storage.run()).status, "timed_out");
  assert.equal(strategyView(storage.run()).cleanup, "pending");
  await advanceStrategy(storage, async (_root, request) => childView(request, { ...quota, deadlineAt: deadline.deadlineAt }), timing);
  const root = strategyView(storage.run());
  assert.equal(root.status, "timed_out");
  assert.equal(root.reason, "run_timed_out");
  assert.equal(root.cleanup, "destroyed");
  assert.equal(root.attempts.length, 1);
  assert.equal(root.attempts[0].status, "capacity");
  assert.equal(root.fallbackReason, undefined);
  assert.equal(storage.snapshot().alarm, null);
  const page = await storage.transaction(tx => runEventsPage(tx, root, 0));
  assert(page.events.some(event => event.type === "state" && event.status === "timed_out"));
  assert(!page.events.some(event => event.type === "fallback"));
});

test("fallback inherits the original absolute deadline and expiry addresses the same child after eviction", async t => {
  const deadline = { admittedAt: 10_000, deadlineAt: 10_020 };
  t.mock.timers.enable({ apis: ["Date"], now: deadline.admittedAt });
  const original = newStrategyRun(input, policy("api-key-first-then-subscription"), {}, undefined, undefined, undefined, deadline);
  let storage = durableStorage({ records: [[STRATEGY_RUN, original]], alarm: null });
  const reserve = (observed, operationId) => async (_root, request, _settings, _routing, cancel, _repository, _publicationMaxBytes, inherited) => {
    assert.equal(request.operationId, operationId);
    assert.equal(cancel, false);
    assert.deepEqual(inherited, deadline);
    return childView(request, { ...observed, deadlineAt: inherited.deadlineAt });
  };
  await advanceStrategy(storage, reserve(quota, activeAttempt(original).operationId), timing);
  const attemptId = activeAttempt(storage.run()).operationId;
  assert.equal(storage.run().attempts.length, 2);
  await advanceStrategy(storage, reserve({ status: "running", cleanup: "pending" }, attemptId), timing);
  assert.equal(storage.snapshot().alarm, deadline.deadlineAt);
  storage = durableStorage(structuredClone(storage.snapshot()));
  t.mock.timers.setTime(deadline.deadlineAt);
  await advanceStrategy(storage, reserve({ status: "timed_out", reason: "run_timed_out", cleanup: "pending" }, attemptId), timing);
  assert.equal(strategyView(storage.run()).cleanup, "pending");
  assert(storage.snapshot().alarm > deadline.deadlineAt);
  await advanceStrategy(storage, reserve({ status: "timed_out", reason: "run_timed_out", cleanup: "destroyed" }, attemptId), timing);
  const final = strategyView(storage.run());
  assert.equal(final.status, "timed_out");
  assert.equal(final.cleanup, "destroyed");
  assert.equal(final.attempts[1].operationId, attemptId);
  assert.equal(final.fallbackReason, quota.reason);
  assert.equal(storage.snapshot().alarm, null);
});

test("pre-deadline cancellation retains priority if the child reports deadline expiry", async t => {
  const deadline = { admittedAt: 10_000, deadlineAt: 10_020 };
  t.mock.timers.enable({ apis: ["Date"], now: deadline.admittedAt });
  const run = newStrategyRun(input, policy("subscription-only"), {}, undefined, undefined, undefined, deadline);
  const storage = durableStorage({ records: [[STRATEGY_RUN, run]], alarm: null });
  await storage.transaction(tx => requestStrategyCancellation(tx, run));
  t.mock.timers.setTime(deadline.deadlineAt);
  await advanceStrategy(storage, async (_root, request, _settings, _routing, cancel) => {
    assert.equal(cancel, true);
    return childView(request, { status: "timed_out", reason: "run_timed_out", cleanup: "destroyed", deadlineAt: deadline.deadlineAt });
  }, timing);
  const result = strategyView(storage.run());
  assert.equal(result.status, "cancelled");
  assert.equal(result.reason, "run_cancelled");
  assert.equal(result.attempts[0].status, "timed_out");

  const late = durableStorage({ records: [[STRATEGY_RUN, run]], alarm: null });
  const requestedAtDeadline = await late.transaction(tx => requestStrategyCancellation(tx, run));
  assert.equal(strategyView(requestedAtDeadline).status, "timed_out");
  assert.equal(requestedAtDeadline.cancellationRequested, undefined);
  assert.equal(late.snapshot().alarm, deadline.deadlineAt);
});
