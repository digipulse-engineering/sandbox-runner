import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProviderRunInput } from "../worker/contract.ts";
import { parseProfileConfig, profileInputContract, profileReceipt, profileUsage, resolveProfileRequest, validateProfileInputs } from "../worker/run-profiles.mjs";
import { parseTestSubmission } from "../worker/vitest/admission.ts";

const id = "48f9fa4c-cc36-46bd-8b7d-f86f09ec79db";
const sha = "a".repeat(40);
const review = {
  kind: "agent", harness: "claude", operation: "review", sandboxProvider: "cloudflare",
  defaults: { repo: "Team/Repo", model: "claude-sonnet-5-5", effort: "medium" },
  allowedOverrides: { effort: ["medium", "high"] },
  mcp: { connectors: ["github", "acme-staging"] },
};
const vitest = {
  kind: "test", runner: "vitest", defaults: { repo: "Team/Repo" },
  allowedOverrides: { repo: ["Team/Repo", "Team/Repo-next"] },
};

function request(body, input = {}) {
  return { kind: "profile", operationId: id, profile: { slug: "example", body }, source: { sha },
    ...(body.kind === "agent" ? { prompt: "Inspect the workspace." } : {}),
    ...(body.operation === "review" ? { producerAgent: "codex" } : {}), ...input };
}

test("resolves a Claude reviewer through the existing agent contract", () => {
  const native = resolveProfileRequest(request(review, { overrides: { effort: "high" }, authMode: "subscription" }));
  assert.deepEqual(native, {
    kind: "agent", agent: "claude", operationId: id, repository: { slug: "Team/Repo", sha }, sandboxProvider: "cloudflare",
    model: "claude-sonnet-5-5", effort: "high", authMode: "subscription", prompt: "Inspect the workspace.",
    reviewProducer: "codex", connectors: ["acme-staging", "github"],
  });
  const parsed = parseProviderRunInput(native);
  assert.equal(parsed.explicitAuth, true);
  assert.equal(parsed.input.reviewProducer, "codex");
  assert.equal(parseProviderRunInput(resolveProfileRequest(request(review))).explicitAuth, false);
});

test("pins an agent profile authentication mode while preserving caller selection on unpinned profiles", async () => {
  const pinned = { ...review, authMode: "api-key" };
  const pinnedRequest = request(pinned);
  const native = resolveProfileRequest(pinnedRequest);
  const parsed = parseProviderRunInput(native);
  assert.equal(parsed.explicitAuth, true);
  assert.equal(parsed.input.authMode, "api-key");
  assert.deepEqual(resolveProfileRequest(request(pinned, { authMode: "api-key" })), native);
  assert.throws(() => resolveProfileRequest(request(pinned, { authMode: "subscription" })), { code: "invalid_profile_inputs" });
  assert.throws(() => resolveProfileRequest(request(pinned, { overrides: { authMode: "subscription" } })), { code: "invalid_profile_inputs" });
  const subscription = { ...review, authMode: "subscription" };
  assert.equal(resolveProfileRequest(request(subscription)).authMode, "subscription");
  assert.equal(resolveProfileRequest(request(review, { authMode: "subscription" })).authMode, "subscription");
  assert.equal(Object.hasOwn(resolveProfileRequest(request(review)), "authMode"), false);
  assert.notEqual((await profileReceipt(pinnedRequest)).revision, (await profileReceipt(request(subscription))).revision);
  assert.deepEqual(await profileReceipt(JSON.parse(JSON.stringify(pinnedRequest))), await profileReceipt(pinnedRequest));
});

test("resolves both test runners with the selected source and preserves command arguments", () => {
  const resolved = resolveProfileRequest(request(vitest, { overrides: { repo: "Team/Repo-next" },
    source: { ref: "refs/heads/main" } }));
  assert.deepEqual(parseTestSubmission(resolved), {
    operationId: id, repositoryRef: { slug: "Team/Repo-next", ref: "refs/heads/main" },
  });
  const argv = ["npm", "run", "check", "--", "a b", ""];
  const native = resolveProfileRequest(request({ ...vitest, runner: "command", argv }));
  assert.deepEqual(parseTestSubmission(native), { operationId: id, suite: "command", repository: { slug: "Team/Repo", sha }, argv });
  assert.notEqual(native.argv, argv);
});

test("uses native Codex and OpenCode capabilities for profile resolution", () => {
  const codex = { kind: "agent", harness: "codex", operation: "start", defaults: { repo: "Team/Repo" }, publish: true };
  assert.equal(parseProviderRunInput(resolveProfileRequest(request(codex))).input.publish, true);
  const opencode = { ...codex, harness: "opencode", modelProvider: "anthropic",
    defaults: { repo: "Team/Repo", model: "claude-sonnet-5-5", effort: "high" } };
  delete opencode.publish;
  const parsed = parseProviderRunInput(resolveProfileRequest(request(opencode)));
  assert.equal(parsed.input.authMode, "api-key");
  assert.deepEqual(parsed.input.overrides, { model: "claude-sonnet-5-5", effort: "high" });
  assert.equal(resolveProfileRequest(request({ ...opencode, authMode: "api-key" })).authMode, "api-key");
  assert.throws(() => resolveProfileRequest(request({ ...opencode, authMode: "subscription" })), { code: "invalid_profile" });
  assert.throws(() => resolveProfileRequest(request(opencode, { authMode: "subscription" })), { code: "invalid_profile_inputs" });
  assert.throws(() => resolveProfileRequest(request({ ...opencode, modelProvider: "openai" })), { code: "invalid_profile" });
  assert.throws(() => resolveProfileRequest(request({ ...opencode, mcp: review.mcp })), { code: "invalid_profile" });
});

test("resolves a Codex reviewer with pinned settings and a bounded model override", () => {
  const codex = { ...review, harness: "codex",
    defaults: { repo: "Team/Repo", model: "gpt-6.1-sol", effort: "xhigh" },
    allowedOverrides: { model: ["gpt-6.1-sol", "gpt-6-astra"] } };
  const call = { producerAgent: "claude", authMode: "api-key", overrides: { model: "gpt-6-astra" } };
  const native = resolveProfileRequest(request(codex, call));
  const { input } = parseProviderRunInput(native);
  assert.deepEqual(input.overrides, { model: "gpt-6-astra", effort: "xhigh" });
  assert.deepEqual(input.connectors, ["acme-staging", "github"]);
  assert.equal(input.reviewProducer, "claude");
  assert.equal(input.authMode, "api-key");
  assert.throws(() => resolveProfileRequest(request(codex, { ...call, overrides: { model: "gpt-5.1" } })),
    { code: "invalid_profile_inputs" });
  assert.throws(() => resolveProfileRequest(request(codex, { ...call, overrides: { effort: "high" } })),
    { code: "invalid_profile_inputs" });
});

test("checks the config version, discriminators and every declared field", () => {
  const config = { schemaVersion: 1, profiles: { "claude-review": review, "unit-tests": vitest } };
  assert.equal(parseProfileConfig(config), config);
  for (const malformed of [null, { ...config, schemaVersion: "1" }, { ...config, schemaVersion: 2 },
    { ...config, unused: true }, { ...config, profiles: [] }, { ...config, profiles: { "Uppercase": review } },
    { ...config, profiles: JSON.parse('{"__proto__": {}}') }, { ...config, profiles: { constructor: review } }]) {
    assert.throws(() => parseProfileConfig(malformed), { code: "invalid_profile_config" });
  }
  for (const body of [
    { ...review, mcp: { conectors: ["github"] } }, { ...review, mcp: { connectors: ["github", "github"] } },
    { ...review, publish: false }, { ...review, sandboxProvider: "daytona" }, { ...vitest, mcp: review.mcp },
    { ...vitest, argv: ["npm"] }, { ...vitest, runner: "command", argv: ["npm", 31] },
    { ...review, defaults: { ...review.defaults, model: "sonnet" } }, { ...review, harness: "codex" },
    { ...review, allowedOverrides: { effort: [] } }, { ...review, allowedOverrides: { effort: ["low"] } },
    { ...vitest, allowedOverrides: { repo: ["Team/Repo", "team/repo"] } },
    { ...vitest, defaults: { repo: "https://github.com/Team/Repo.git" } },
    { kind: "test", runner: "vitest" }, { ...vitest, authMode: "api-key" },
    { ...review, authMode: "api-key-only" }, { ...review, authMode: null }, { ...review, authMode: undefined },
  ]) assert.throws(() => parseProfileConfig({ schemaVersion: 1, profiles: { malformed: body } }), { code: "invalid_profile" });
});

test("enforces allowed values, source, and run inputs before native submission", () => {
  for (const overrides of [{ effort: "max" }, { model: "claude-sonnet-5-5" }, { connectors: [] },
    { repo: "another/repo" }, { publish: true }, { sandboxProvider: "cloudflare" }, null]) {
    assert.throws(() => resolveProfileRequest(request(review, { overrides })), { code: "invalid_profile_inputs" });
  }
  assert.throws(() => resolveProfileRequest(request(vitest, { overrides: { repo: "team/repo" } })), { code: "invalid_profile_inputs" });
  assert.throws(() => resolveProfileRequest(request(vitest, { overrides: { model: "claude-sonnet-5-5" } })), { code: "invalid_profile_inputs" });
  for (const input of [{ producerAgent: "claude" }, { producerAgent: "opencode" }, { source: { ref: "refs/heads/main" } },
    { source: { sha: "abc" } }, { source: { sha, ref: "refs/heads/main" } }, { source: { sha, other: true } },
    { authMode: null }, { prompt: "" }, { connectorAccess: {} }]) {
    assert.throws(() => resolveProfileRequest(request(review, input)), { code: "invalid_profile_inputs" });
  }
  assert.throws(() => resolveProfileRequest(request(review, { profile: { slug: "example", body: review, revision: "unverified" } })),
    { code: "invalid_profile_request" });
  assert.throws(() => resolveProfileRequest(request(review, { operationId: "wrong" })), { code: "invalid_profile_request" });
  assert.throws(() => resolveProfileRequest(request(vitest, { prompt: "Review." })), { code: "invalid_profile_inputs" });
  assert.throws(() => resolveProfileRequest(request({ ...vitest, defaults: {} })), { code: "invalid_profile_inputs" });
  const chooseEffort = { ...review, defaults: { repo: review.defaults.repo, model: review.defaults.model } };
  assert.throws(() => resolveProfileRequest(request(chooseEffort)), { code: "invalid_profile_inputs" });
  assert.equal(resolveProfileRequest(request(chooseEffort, { overrides: { effort: "medium" } })).effort, "medium");
});

test("computes canonical receipts from the submitted profile and run inputs", async () => {
  const first = request(review);
  const original = await profileReceipt(first);
  const reorderedBody = Object.fromEntries(Object.entries(review).reverse());
  const reordered = Object.fromEntries(Object.entries(request(reorderedBody)).reverse());
  assert.deepEqual(await profileReceipt(reordered), original);
  assert.deepEqual(Object.keys(original).sort(), ["producerSource", "requestDigest", "revision", "slug", "source"]);
  assert.equal(original.source, "client-supplied");
  assert.equal(original.producerSource, "declared");
  assert.match(original.revision, /^[0-9a-f]{64}$/u);
  assert.match(original.requestDigest, /^[0-9a-f]{64}$/u);
  for (const input of [{ prompt: "Inspect independently." }, { overrides: { effort: "high" } },
    { authMode: "subscription" }, { source: { sha: "b".repeat(40) } }]) {
    const result = await profileReceipt(request(review, input));
    assert.equal(result.revision, original.revision);
    assert.notEqual(result.requestDigest, original.requestDigest);
  }
  const changedProfile = await profileReceipt(request({ ...review, description: "Revised description" }));
  assert.notEqual(changedProfile.revision, original.revision);
  assert.notEqual(changedProfile.requestDigest, original.requestDigest);
  assert.equal((await profileReceipt(request(vitest))).producerSource, undefined);
});

test("resolves a qualified OpenCode review profile with read-only connector names", () => {
  const { allowedOverrides: _allowed, ...base } = review;
  const profile = { ...base, harness: "opencode", modelProvider: "openai",
    defaults: { repo: "Team/Repo", model: "gpt-6.1-sol", effort: "xhigh" } };
  const values = { producerAgent: "codex", prompt: "Review the exact change." };
  const input = parseProviderRunInput(resolveProfileRequest(request(profile, values))).input;
  assert.equal(input.agent, "opencode");
  assert.equal(input.authMode, "api-key");
  assert.equal(input.reviewProducer, "codex");
  assert.deepEqual(input.connectors, ["acme-staging", "github"]);
  assert.throws(() => resolveProfileRequest(request(profile, { ...values, authMode: "subscription" })),
    { code: "invalid_profile_inputs" });
  for (const changes of [{ publish: false }, { operation: "start" }, { modelProvider: "anthropic" },
    { defaults: { repo: "Team/Repo" } }, { allowedOverrides: { effort: ["xhigh"] } }]) {
    assert.throws(() => resolveProfileRequest(request({ ...profile, ...changes }, values)), { code: "invalid_profile" });
  }
});

test("opts a named command profile into shallow checkout only for an exact commit", () => {
  const profile = { ...vitest, runner: "command", argv: ["pnpm", "test"], checkout: "shallow" };
  const resolved = resolveProfileRequest(request(profile));
  assert.equal(resolved.checkout, "shallow");
  assert.equal(parseTestSubmission(resolved), undefined);
  assert.equal(parseTestSubmission(resolved, true)?.checkout, "shallow");
  assert.throws(() => resolveProfileRequest(request(profile, { source: { ref: "refs/heads/main" } })), { code: "invalid_profile_inputs" });
  for (const invalid of [{ ...vitest, checkout: "shallow" }, { ...profile, checkout: "full" }, { ...review, checkout: "shallow" }]) {
    assert.throws(() => resolveProfileRequest(request(invalid)), { code: "invalid_profile" });
  }
});

test("derives discovery usage without changing legacy definitions or accepting contradictory roles", () => {
  const executor = { ...review, operation: "start" };
  assert.equal(profileUsage(executor), "executor");
  assert.equal(profileUsage(review), "review");
  assert.equal(profileUsage(vitest), "test");
  assert.equal(Object.hasOwn(review, "usage"), false);
  const tier2 = { ...review, usage: "tier2-review" };
  assert.equal(profileUsage(tier2), "tier2-review");
  assert.equal(parseProfileConfig({ schemaVersion: 1, profiles: { tier2 } }).profiles.tier2, tier2);
  for (const profile of [{ ...review, usage: "executor" }, { ...vitest, usage: "delivery-review" },
    { ...executor, usage: "tier2-review" }, { ...review, usage: "review" }, { ...review, usage: null },
    { ...review, authority: "operator" }]) {
    assert.throws(() => profileInputContract(profile), { code: "invalid_profile" });
  }
});

test("publishes the exact run fields, alternatives, defaults and allowlists", () => {
  const profile = { ...review, authMode: "subscription", defaults: { effort: "medium" },
    allowedOverrides: { repo: ["Team/Repo"], effort: ["medium", "high"], model: ["claude-sonnet-5-5"] } };
  const schema = profileInputContract(profile);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.required, ["source", "prompt", "producerAgent", "overrides"]);
  assert.deepEqual(Object.keys(schema.properties.source.properties), ["sha"]);
  assert.deepEqual(schema.properties.source.required, ["sha"]);
  assert.deepEqual(schema.properties.producerAgent.enum, ["codex"]);
  assert.deepEqual(schema.properties.authMode, { type: "string", enum: ["subscription"], default: "subscription" });
  assert.deepEqual(schema.properties.overrides.required, ["repo", "model"]);
  assert.deepEqual(schema.properties.overrides.properties.effort, { type: "string", enum: ["medium", "high"], default: "medium" });
  assert.deepEqual(schema.properties.overrides.properties.repo.enum, ["Team/Repo"]);
  assert.deepEqual(schema.properties.overrides.properties.model.enum, ["claude-sonnet-5-5"]);
  for (const field of ["kind", "profile", "operationId", "deliveryId", "revision"]) {
    assert.equal(Object.hasOwn(schema.properties, field), false);
  }
  const testSchema = profileInputContract(vitest);
  assert.deepEqual(testSchema.required, ["source"]);
  assert.deepEqual(Object.keys(testSchema.properties), ["source", "overrides"]);
  const refPattern = new RegExp(testSchema.properties.source.properties.ref.pattern, "u");
  for (const ref of ["refs/heads/main", "refs/tags/v1", "refs/heads/topic/name", "refs/heads/\u2028"]) {
    assert.equal(refPattern.test(ref), true);
    assert.deepEqual(validateProfileInputs(vitest, { source: { ref } }), []);
  }
  for (const ref of ["main", "refs/heads/.hidden", "refs/tags/x.lock", "refs/tags/x.lock/tag", "refs/heads/a b",
    "refs/heads/a..b", "refs/heads/a@{", "refs/heads/b.", "refs/heads/a//b", "refs/heads/b\n"]) {
    assert.equal(refPattern.test(ref), false);
    assert.equal(validateProfileInputs(vitest, { source: { ref } })[0].code, "invalid_ref");
  }
  assert.deepEqual(Object.keys(profileInputContract({ ...vitest, runner: "command", argv: ["pnpm", "test"],
    checkout: "shallow" }).properties.source.properties), ["sha"]);
});

test("aggregates independent issues in a stable order without echoing submitted text", () => {
  const profile = { ...review, authMode: "subscription", defaults: {},
    allowedOverrides: { repo: ["Team/Repo"], effort: ["medium", "high"] } };
  const input = { source: { sha: "wrong", ref: "refs/heads/main", "secret-source": 3 }, producerAgent: "claude",
    authMode: "api-key", overrides: { effort: 5, "secret-override": true }, "secret-root": "prompt-to-hide" };
  const issues = validateProfileInputs(profile, input);
  assert.deepEqual(issues.map(({ field, code, allowed }) => [field, code, allowed]), [
    ["source", "unexpected_field", undefined], ["source", "exact_sha_required", undefined],
    ["source.sha", "invalid_sha", undefined], ["prompt", "required", undefined],
    ["producerAgent", "same_harness", ["codex"]], ["authMode", "override_not_allowed", ["subscription"]],
    ["overrides", "override_not_allowed", undefined], ["overrides.repo", "required", ["Team/Repo"]],
    ["overrides.effort", "invalid_type", ["medium", "high"]], ["$", "unexpected_field", undefined],
  ]);
  assert.equal(issues.every(issue => typeof issue.message === "string" && issue.message.length > 0), true);
  assert.doesNotMatch(JSON.stringify(issues), /secret-|prompt-to-hide|refs\/heads\/main|"wrong"/u);
  assert.deepEqual(validateProfileInputs(profile, Object.fromEntries(Object.entries(input).reverse())), issues);
  assert.throws(() => resolveProfileRequest({ kind: "profile", operationId: id, profile: { slug: "example", body: profile }, ...input }),
    { code: "invalid_profile_inputs", issues });
});

test("avoids dependent errors for malformed containers and retains valid legacy values", () => {
  const profile = { ...review, defaults: {}, allowedOverrides: { repo: ["Team/Repo"] } };
  const issues = validateProfileInputs(profile, { source: [], overrides: null, prompt: "\ud800", producerAgent: 5 });
  assert.deepEqual(issues.map(({ field, code }) => [field, code]), [
    ["source", "invalid_type"], ["prompt", "invalid_value"], ["producerAgent", "invalid_value"], ["overrides", "invalid_type"],
  ]);
  assert.deepEqual(validateProfileInputs(vitest, { source: { sha, ref: "refs/tags/v1" }, prompt: "ignored?", authMode: "api-key" })
    .map(({ field, code }) => [field, code]), [
    ["source", "source_conflict"], ["prompt", "unexpected_field"], ["authMode", "unexpected_field"],
  ]);
  const executor = { ...review, operation: "start", publish: false };
  const input = { source: { sha: sha.toUpperCase() }, prompt: "Inspect this. 😀\nReport results." };
  assert.deepEqual(validateProfileInputs(executor, input), []);
  const resolved = resolveProfileRequest(request(executor, input));
  assert.equal(resolved.repository.sha, sha);
  assert.equal(resolved.prompt, input.prompt);
  assert.equal(Object.hasOwn(resolved, "publish"), false);
});
