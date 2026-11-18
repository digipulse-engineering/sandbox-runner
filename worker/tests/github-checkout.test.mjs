import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderRunInput, matchesRunInput } from "../contract.ts";
import { githubCheckoutFromEnv, withGithubCheckout } from "../checkout-daemon.ts";
import { activeAttempt, newStrategyRun, pollStrategy, strategyView } from "../strategy.ts";

const repository = { slug: "Example/Private.repo", sha: "0123456789abcdef0123456789abcdef01234567" };
const operationId = "48f9fa4c-cc36-46bd-8b7d-f86f09ec79db";
const request = { operationId, kind: "agent", agent: "claude", prompt: "checkout test", repository };

test("v4 repository identity is exact and changes conflict with a replay", () => {
  const value = parseProviderRunInput({ ...request, repository: { ...repository, sha: repository.sha.toUpperCase() } });
  assert.deepEqual(value.input.repository, repository);
  assert(matchesRunInput(value.input, value.input));
  assert(!matchesRunInput(value.input, { ...value.input, repository: { ...repository, sha: "1".repeat(40) } }));
  assert(!matchesRunInput(value.input, { ...value.input, repository: undefined }));
  for (const invalid of [
    null, {}, { ...repository, sha: "main" }, { ...repository, sha: repository.sha + "\n" },
    { ...repository, slug: "https://github.com/" + repository.slug },
    { ...repository, slug: "Example\n/Private.repo" }, { ...repository, slug: "Example/Private.git" },
    { ...repository, slug: "Example/../Private.repo" }, { ...repository, url: "https://unapproved.invalid" },
  ]) assert.equal(parseProviderRunInput({ ...request, repository: invalid }), undefined);
});

test("strategy children use the admitted private repository snapshot and SHA on every attempt", async () => {
  const github = { owner: "Example", name: "Private.repo", repositoryId: 9 };
  const run = newStrategyRun(parseProviderRunInput(request).input, { strategy: "api-key-first-then-subscription" }, {}, undefined, github);
  const next = await pollStrategy(run, async (input, _, routing, cancel, snapshot) => {
    assert.deepEqual(input.repository, repository);
    assert.deepEqual(snapshot, github);
    assert.equal(routing, undefined);
    assert.equal(cancel, false);
    return { id: input.operationId, agent: input.agent, authMode: input.authMode, repository,
      status: "capacity", reason: "provider_quota_exhausted", cleanup: "destroyed" };
  });
  assert.equal(activeAttempt(next).authMode, "subscription");
  assert.deepEqual(strategyView(next).repository, repository);
  assert(!Object.hasOwn(strategyView(next), "githubRepository"));
  await pollStrategy(next, async (input, _, __, cancel, snapshot) => {
    assert.deepEqual(input.repository, repository);
    assert.deepEqual(snapshot, github);
    assert.equal(cancel, false);
    return { id: input.operationId, agent: input.agent, authMode: input.authMode, repository,
      status: "succeeded", cleanup: "destroyed" };
  });
});

test("the adapter starts the agent only after checkout and reuses the workspace for later turns", async () => {
  const starts = [];
  const abort = new AbortController();
  const base = {
    id: "test", version: "1",
    open: () => ({
      async run() { starts.push("agent"); return { status: "done", text: "agent" }; },
      async close() {},
    }),
  };
  const turn = { operationId, input: "prompt", signal: abort.signal };
  const adapter = withGithubCheckout(base, async () => { starts.push("checkout"); return true; });
  await (await adapter.open({})).run({ ...turn, operationId: "b8bfaf06-16a2-40a5-895b-760fa450260f" });
  await (await adapter.open({})).run(turn);
  assert.deepEqual(starts, ["checkout", "agent", "agent"]);
  for (const checkout of [async () => false, async () => { throw new Error("raw checkout error"); }]) {
    const gated = await withGithubCheckout(base, checkout).open({});
    assert.deepEqual(await gated.run(turn), { status: "unanswered", reason: "github_checkout_failed" });
  }
  const cancelled = await withGithubCheckout(base, async () => { abort.abort(); return true; }).open({});
  assert.deepEqual(await cancelled.run(turn), { status: "unanswered", reason: "aborted" });
  assert.deepEqual(starts, ["checkout", "agent", "agent"]);
});

test("repository startup metadata is removed before opening the agent", () => {
  const env = {
    SANDBOX_RUNNER_GITHUB_REPOSITORY: repository.slug,
    SANDBOX_RUNNER_GITHUB_SHA: repository.sha,
    SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS: "25000",
    UNRELATED: "preset",
  };
  assert.equal(typeof githubCheckoutFromEnv(env), "function");
  assert.deepEqual(env, { UNRELATED: "preset" });
  assert.equal(githubCheckoutFromEnv(env), undefined);
});

test("the API deadline is its own setting, with the checkout setting as fallback for older builds", async () => {
  const { apiTimeoutMs } = await import("../github-checkout.ts");
  assert.equal(apiTimeoutMs({ SANDBOX_RUNNER_API_TIMEOUT_MS: "25000", SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS: "600000" }), 25000);
  assert.equal(apiTimeoutMs({ SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS: "600000" }), 600000);
  for (const value of ["0", "x", "2147483648"]) {
    assert.equal(apiTimeoutMs({ SANDBOX_RUNNER_API_TIMEOUT_MS: value, SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS: "25000" }), undefined);
  }
});
