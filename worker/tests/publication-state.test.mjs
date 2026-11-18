import assert from "node:assert/strict";
import test from "node:test";
import { matchesRunInput, parseProviderRunInput } from "../contract.ts";
import { cancelPublication, claimReference, finishReference, publicationView, timeoutPublication } from "../publication-state.ts";
import { runEventsPage } from "../run-events.ts";
import { activeAttempt, expireStrategy, newStrategyRun, pollStrategy, requestStrategyCancellation,
  STRATEGY_RUN, strategyPreparationAllowed, strategyView, writeStrategyRun } from "../strategy.ts";

const id = "c09125cb-95e3-4e63-a094-8c008f1c9427";
const branch = "sandbox-runner/" + id;
const repository = { slug: "org/private", sha: "a".repeat(40) };
const githubRepository = { owner: "org", name: "private", repositoryId: 101 };
const receipt = { repository: githubRepository, operationId: id, baseSha: repository.sha,
  treeSha: "b".repeat(40), commitSha: "c".repeat(40) };
const verified = { status: "published", ref: "refs/heads/" + branch, commitSha: receipt.commitSha };
const uncertain = { status: "uncertain", ref: "refs/heads/" + branch };
const routing = { sandboxProvider: "cloudflare", request: { explicitAuth: false } };
const request = { kind: "agent", operationId: id, agent: "claude", prompt: "same prompt", repository };
const input = parseProviderRunInput({ ...request, publish: true }).input;

test("accepts explicit opt-in only with a repository and matches replay exactly", () => {
  assert.equal(input.publish, true);
  const previous = parseProviderRunInput(request).input;
  assert.equal(previous.publish, undefined);
  assert.equal(matchesRunInput(previous, input), false);
  assert.equal(matchesRunInput(input, previous), false);
  assert.equal(matchesRunInput(input, input), true);
  assert.equal(parseProviderRunInput({ ...request, publish: false }), undefined);
  assert.equal(parseProviderRunInput({ ...request, repository: undefined, publish: true }), undefined);
  assert.equal(parseProviderRunInput({ ...request, operationId: id + "\n", publish: true }), undefined);
});

test("cancel before claim closes authority; cancel after claim preserves read-only reconciliation", () => {
  const prepared = { phase: "prepared", receipt };
  const cancelled = cancelPublication(prepared);
  assert.deepEqual(publicationView(cancelled), { status: "cancelled" });
  assert.equal(claimReference(cancelled, receipt, 100), undefined);
  assert.equal(finishReference(cancelled, receipt, verified), undefined);
  assert.equal(claimReference(prepared, { ...receipt, commitSha: "d".repeat(40) }, 100), undefined);

  const claimed = claimReference(prepared, receipt, 100);
  assert.equal(claimed.phase, "claimed");
  assert.equal(claimReference(structuredClone(claimed), receipt, 100), undefined);
  const interrupted = structuredClone(cancelPublication(claimed));
  assert.deepEqual(publicationView(interrupted), { status: "pending" });
  assert.equal(interrupted.cancelRequested, true);
  const expired = structuredClone(finishReference(interrupted, receipt, uncertain));
  assert.deepEqual(publicationView(expired), { status: "uncertain", branch });
  assert.equal(claimReference(expired, receipt, 100), undefined);
  assert.deepEqual(publicationView(finishReference(expired, receipt, verified)), {
    status: "published", branch, commitSha: receipt.commitSha, treeSha: receipt.treeSha,
  });
  assert.deepEqual(publicationView(finishReference(interrupted, receipt, verified)), {
    status: "published", branch, commitSha: receipt.commitSha, treeSha: receipt.treeSha,
  });
});

test("strategy adopts a receipt only from the selected cleaned attempt and only for its root", async () => {
  const root = newStrategyRun(input, { strategy: "subscription-only" }, {}, routing, githubRepository);
  const attempt = activeAttempt(root);
  assert.equal(strategyPreparationAllowed(root, attempt.operationId), true);
  assert.equal(strategyPreparationAllowed(root, id), false);
  const finished = ({ operationId, authMode }, cleanup) => ({
    id: operationId, agent: "claude", authMode, status: "succeeded", cleanup, repository, sandboxProvider: "cloudflare",
    output: "agent done", publication: { status: "pending" },
  });
  let run = await pollStrategy(root, async child => {
    assert.equal(child.publish, true);
    return { view: finished(child, "pending"), receipt };
  });
  assert.equal(run.publicationState.phase, "requested");
  assert.equal(strategyPreparationAllowed(run, attempt.operationId), true);
  run = await pollStrategy(run, async child => ({ view: finished(child, "destroyed"), receipt }));
  assert.deepEqual(run.publicationState, { phase: "prepared", receipt });
  assert.equal(strategyView(run).output, "agent done");
  assert.deepEqual(strategyView(run).publication, { status: "pending" });
  assert.equal(strategyView(run).receipt, undefined);
  assert.equal(strategyPreparationAllowed(run, attempt.operationId), false);

  const wrong = await pollStrategy(root, async child => ({
    view: finished(child, "destroyed"), receipt: { ...receipt, operationId: child.operationId },
  }));
  assert.equal(strategyView(wrong).publication.status, "failed");
  const stored = new Map();
  const cancelled = await requestStrategyCancellation({
    async get(key) { return stored.get(key); },
    async put(key, value) { stored.set(key, value); }, async delete() {}, async setAlarm() {},
  }, run);
  assert.equal(stored.get(STRATEGY_RUN), cancelled);
  assert.equal(strategyView(cancelled).status, "succeeded");
  assert.deepEqual(strategyView(cancelled).publication, { status: "cancelled" });
  assert.equal(strategyView(cancelled).output, "agent done");
  const page = await runEventsPage({ async get(key) { return stored.get(key); } }, strategyView(cancelled), 0);
  assert.deepEqual(page.events.at(-1), { cursor: 2, type: "cancellation_requested" });
});

test("an auth fallback keeps the publication intent and the admitted base with the new attempt", async () => {
  const root = newStrategyRun(input, { strategy: "api-key-first-then-subscription" }, {}, routing, githubRepository);
  const first = activeAttempt(root);
  const run = await pollStrategy(root, async child => ({
    id: child.operationId, agent: child.agent, authMode: child.authMode,
    repository, sandboxProvider: "cloudflare", status: "capacity", cleanup: "destroyed", reason: "provider_quota_exhausted",
    publication: { status: "failed", reason: "github_publication_agent_not_succeeded" },
  }));
  assert.equal(run.publish, true);
  assert.equal(activeAttempt(run).authMode, "subscription");
  assert.equal(strategyPreparationAllowed(run, first.operationId), false);
  assert.equal(strategyPreparationAllowed(run, activeAttempt(run).operationId), true);
  assert.deepEqual(strategyView(run).publication, { status: "pending" });
});

test("closes pre-claim stages at the deadline and retains only an already acquired claim for readback", () => {
  const prepared = { phase: "prepared", receipt };
  for (const state of [{ phase: "requested" }, { phase: "capture", commitDate: "2026-11-12T01:02:03Z" }, prepared]) {
    const expired = timeoutPublication(state);
    assert.deepEqual(publicationView(expired), { status: "failed", reason: "github_publication_run_timed_out" });
    assert.equal(finishReference(expired, receipt, verified), undefined);
  }
  assert.equal(claimReference(prepared, receipt, 300, 100, 100), undefined);
  assert.equal(claimReference(prepared, receipt, 300, 100, 101), undefined);
  const claimed = claimReference(prepared, receipt, 300, 100, 99);
  assert.equal(timeoutPublication(claimed), claimed);
  assert.equal(claimReference(claimed, receipt, 300, 100, 99), undefined);
  const published = finishReference(claimed, receipt, verified);
  assert.equal(timeoutPublication(published), published);
  assert.deepEqual(publicationView(published), { status: "published", branch, commitSha: receipt.commitSha, treeSha: receipt.treeSha });
});

test("a deadline publication projects a running root until ref settlement or expiry", async t => {
  const deadline = { admittedAt: 10_000, deadlineAt: 10_020 };
  t.mock.timers.enable({ apis: ["Date"], now: deadline.admittedAt });
  const root = newStrategyRun(input, { strategy: "subscription-only" }, {}, routing, githubRepository, undefined, deadline);
  const attempt = activeAttempt(root);
  const observed = await pollStrategy(root, async child => ({ view: {
    id: child.operationId, agent: root.agent, authMode: child.authMode, sandboxProvider: "cloudflare", repository,
    status: "succeeded", cleanup: "destroyed", output: "private until publication", deadlineAt: deadline.deadlineAt,
  }, receipt }));
  assert.equal(strategyView(observed).status, "running");
  assert.equal(strategyView(observed).attempts[0].status, "succeeded");
  assert.equal(strategyView(observed).output, undefined);
  const records = new Map();
  const tx = { async get(key) { return records.get(key); }, async put(key, value) { records.set(key, value); },
    async delete(key) { return records.delete(key); }, async setAlarm() {} };
  await writeStrategyRun(tx, root);
  await writeStrategyRun(tx, observed, root);
  t.mock.timers.setTime(deadline.deadlineAt);
  assert.equal(strategyPreparationAllowed(observed, attempt.operationId), false);
  const expired = await expireStrategy(tx, observed);
  assert.equal(strategyView(expired).status, "timed_out");
  assert.equal(strategyView(expired).attempts[0].status, "succeeded");
  assert.equal(strategyView(expired).publication.reason, "github_publication_run_timed_out");
  const page = await runEventsPage(tx, strategyView(expired), 0);
  assert.deepEqual(page.events.filter(event => event.type === "state").map(event => event.status), ["running", "timed_out"]);
});
