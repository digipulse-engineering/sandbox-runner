import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesRunInput, parseInput, parseProviderRunInput } from "../contract.ts";
import { outcome } from "../diagnostics.ts";
import { openCodeParser } from "../opencode-parser.ts";
import { openCodeNetworkBlocked, readOpenCodeNetworkProof } from "../opencode-network-fixture.ts";
import { openCodeConfig, openCodeEnv, openCodeModelRef, resolveOpenCodeSettings } from "../opencode-settings.ts";
import { openCodeProviderConfig, providerCredential } from "../provider.ts";

const id = "12b712d0-f53d-45e3-9128-17d3667c5487";
const request = { operationId: id, kind: "agent", agent: "opencode", authMode: "api-key",
  modelProvider: "openai", prompt: "Work on the fixture" };

test("OpenCode is admitted only through v4 with a qualified provider/model/effort and a direct API key", () => {
  assert.equal(parseInput(request, true), undefined);
  assert.equal(parseInput(request, false), undefined);
  const input = parseProviderRunInput(request).input;
  assert.deepEqual(input, { operationId: id, agent: "opencode", authMode: "api-key",
    modelProvider: "openai", prompt: request.prompt });
  for (const fields of [
    { modelProvider: undefined }, { modelProvider: "other" }, { modelProvider: "anthropic", model: "gpt-4.1-mini" },
    { effort: "high" }, { modelProvider: "anthropic", effort: "max" }, { model: "-flag" },
    { authMode: "subscription" }, { authMode: undefined }, { publish: true }, { reviewProducer: "claude" },
    { repository: { slug: "Owner/Repo", sha: "main" } }, { prompt: "one\0two" }, { agent: "claude" },
    { timeoutMs: 0 }, { timeoutMs: "5000" },
  ]) assert.equal(parseProviderRunInput({ ...request, ...fields }), undefined);
  assert.equal(parseProviderRunInput({ ...request, timeoutMs: 5_000 }).input.timeoutMs, 5_000);
  assert.equal(matchesRunInput({ ...input, model: "gpt-4.1-mini" }, input), true);
  assert.equal(matchesRunInput(input, parseProviderRunInput({ ...request, model: "gpt-4.1-mini" }).input), false);
  assert.equal(matchesRunInput(input, parseProviderRunInput({ ...request, modelProvider: "anthropic" }).input), false);
  const high = parseProviderRunInput({ ...request, modelProvider: "anthropic", effort: "high" }).input;
  const defaultEffort = parseProviderRunInput({ ...request, modelProvider: "anthropic" }).input;
  assert.equal(matchesRunInput(high, high), true);
  assert.equal(matchesRunInput(high, defaultEffort), false);
});

test("OpenCode checkout binds the exact canonical slug and commit to the v4 replay contract", () => {
  const repository = { slug: "Owner/Repo", sha: "a".repeat(40) };
  const parse = repository => parseProviderRunInput({ ...request, repository })?.input;
  const input = parse({ ...repository, sha: repository.sha.toUpperCase() });
  assert.deepEqual(input.repository, repository);
  assert.equal(matchesRunInput(input, parse(repository)), true);
  for (const changed of [{ ...repository, sha: "b".repeat(40) }, { ...repository, slug: "owner/repo" }]) {
    assert.equal(matchesRunInput(input, parse(changed)), false);
  }
  assert.equal(matchesRunInput(input, parseProviderRunInput(request).input), false);
  const repositoryRef = { slug: repository.slug, ref: "refs/heads/team/release" };
  for (const modelProvider of ["openai", "anthropic"]) {
    const reference = parseProviderRunInput({ ...request, modelProvider, repository: repositoryRef }).input;
    assert.deepEqual(reference.repositoryRef, repositoryRef);
    assert.equal(reference.repository, undefined);
    const resolved = { ...reference, repository };
    assert.equal(matchesRunInput(resolved, reference), true);
    for (const changed of [repository, { ...repositoryRef, slug: "owner/repo" },
      { ...repositoryRef, ref: "refs/tags/team/release" }]) {
      const different = parseProviderRunInput({ ...request, modelProvider, repository: changed }).input;
      assert.equal(matchesRunInput(resolved, different), false);
    }
  }
  for (const requested of [repository, repositoryRef]) {
    for (const fields of [{ reviewProducer: "claude" }, { publish: true }, { authMode: "subscription" }]) {
      assert.equal(parseProviderRunInput({ ...request, repository: requested, ...fields }), undefined);
    }
  }
  for (const invalid of [undefined, null, {}, { slug: repository.slug }, { ...repository, slug: "https://github.com/Owner/Repo" },
    { ...repository, ref: repositoryRef.ref }, { ...repositoryRef, ref: "main" }]) {
    assert.equal(parse(invalid), undefined);
  }
});

test("configures one native provider, disables project discovery and selects only its dedicated key", () => {
  const base = { SANDBOX_RUNNER_MODE: "real", OPENAI_API_KEY: "legacy-codex", ANTHROPIC_API_KEY: "legacy-claude" };
  const anth = openCodeProviderConfig("anthropic");
  const openai = openCodeProviderConfig("openai");
  for (const [provider, path, header, upstream, binding] of [
    [anth, "/v1/messages", "x-api-key", "https://api.anthropic.com", "SANDBOX_RUNNER_OPENCODE_ANTHROPIC_API_KEY"],
    [openai, "/v1/chat/completions", "authorization", "https://api.openai.com", "SANDBOX_RUNNER_OPENCODE_OPENAI_API_KEY"],
  ]) {
    assert.equal(provider.host, "opencode.harness.internal");
    assert.equal(provider.upstream, upstream);
    assert.equal(provider.path, path);
    assert.deepEqual(provider.searches, []);
    assert.equal(provider.header, header);
    assert.equal(provider.binding, binding);
    assert.equal(providerCredential(provider, base), undefined);
    const env = { ...base, [binding]: "synthetic-key" };
    assert.equal(providerCredential(provider, env), header === "authorization" ? "Bearer synthetic-key" : "synthetic-key");
    assert.equal(providerCredential(provider === anth ? openai : anth, env), undefined);
  }
  assert.equal(providerCredential(anth, { ...base, [anth.binding]: "sk-ant-oat01-test" }), undefined);
  assert.equal(providerCredential(anth, { ...base, [anth.binding]: "sk-proj-other-provider" }), undefined);
  assert.equal(providerCredential(openai, { ...base, [openai.binding]: "sk-ant-api03-other-provider" }), undefined);
  for (const provider of [openai, anth]) {
    assert.equal(providerCredential(provider, { ...base, [provider.binding]: "token.user.jwt" }), undefined);
  }
  const settings = resolveOpenCodeSettings("anthropic", undefined, "high");
  const config = openCodeConfig(settings);
  assert.deepEqual(Object.keys(config.providers), ["gateway"]);
  assert.equal(config.providers.gateway.settings.baseURL, "http://opencode.harness.internal/v1");
  assert.equal(openCodeModelRef(settings), "gateway/claude-sonnet-5-5#high");
  assert.deepEqual(config.providers.gateway.models[settings.model].variants[0].body,
    { thinking: { type: "adaptive" }, output_config: { effort: "high" } });
  const env = openCodeEnv(settings);
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), config);
  assert.equal(env.OPENCODE_CONFIG_PROJECT_DISABLE, "1");
  assert(!Object.keys(env).some(key => key.endsWith("_API_KEY") || key === "SANDBOX_RUNNER_TOKEN"));
});

test("requires terminal success with exit zero and corroborates an exact OpenAI quota", () => {
  const parser = openCodeParser();
  parser.line(JSON.stringify({ type: "step_finish", part: { reason: "tool-calls" } }));
  assert.equal(parser.end({ code: 0 }).status, "unanswered");
  parser.line(JSON.stringify({ type: "text", part: { text: "final" } }));
  parser.line(JSON.stringify({ type: "step_finish", part: { reason: "stop" } }));
  assert.equal(parser.end({ code: 1 }).status, "unanswered");
  assert.deepEqual(parser.end({ code: 0 }), { status: "done", text: "final" });
  const error = (type, code) => parser.line(JSON.stringify({ type: "error", error: {
    type, status: 429, response: { body: JSON.stringify({ error: { code, message: "private" } }) },
  } })).outcome;
  const confirmed = error("provider.quota", "insufficient_quota");
  assert(!JSON.stringify(confirmed).includes("private"));
  const attempt = { id, ambiguous: false, signal: { kind: "http", status: 429 } };
  const context = { agent: "opencode", authMode: "api-key", modelProvider: "openai" };
  assert.equal(outcome(confirmed, attempt, context).reason, "provider_quota_exhausted");
  assert.equal(outcome(error("provider.rate-limit", "rate_limit_exceeded"), attempt, context).reason, "provider_capacity");
  assert.equal(outcome(confirmed, attempt, { ...context, modelProvider: "anthropic" }).reason, "provider_capacity");
  assert.equal(outcome(confirmed, { ...attempt, ambiguous: true }, context).reason, "run_failed");
});

test("projects fixture network evidence and distinguishes proxy TCP from authenticated TLS", () => {
  const proof = { unprivileged: true, keysAbsent: true, placeholderPresent: true,
    dns: "timed_out", ip: "tcp_timed_out", refusals: { method: 403, query: 403, path: 403, credential: 403 } };
  assert.deepEqual(readOpenCodeNetworkProof({ ...proof, extra: "discarded" }), proof);
  for (const ip of ["tcp_failed", "tcp_timed_out", "tls_failed", "tls_timed_out"]) {
    assert.equal(openCodeNetworkBlocked(readOpenCodeNetworkProof({ ...proof, ip })), true);
  }
  for (const invalid of [
    { ip: "tls_established" }, { ip: "arbitrary text" }, { dns: "resolved" }, { dns: "error" },
    { keysAbsent: false }, { unprivileged: false },
    { refusals: { ...proof.refusals, credential: 200 } }, { refusals: { method: 403 } },
  ]) assert.equal(openCodeNetworkBlocked(readOpenCodeNetworkProof({ ...proof, ...invalid })), false);
  const checkout = { capabilitiesCleared: true, rootRegained: false, trustedFilesWritable: false,
    refusals: { receivePack: 403, otherRepository: 403, wrongCase: 403 } };
  assert.equal(openCodeNetworkBlocked(readOpenCodeNetworkProof(proof), true), false);
  assert.equal(openCodeNetworkBlocked(readOpenCodeNetworkProof({ ...proof, checkout }), true), true);
  for (const invalid of [
    { capabilitiesCleared: false }, { rootRegained: true }, { trustedFilesWritable: true },
    { refusals: { ...checkout.refusals, wrongCase: 200 } }, { refusals: { ...checkout.refusals, receivePack: null } },
  ]) assert.equal(openCodeNetworkBlocked(readOpenCodeNetworkProof({ ...proof, checkout: { ...checkout, ...invalid } }), true), false);
});

test("OpenCode reviewer uses only its qualified Responses route and exact read-only request", () => {
  const repository = { slug: "Owner/Repo", sha: "a".repeat(40) };
  const review = { ...request, repository, model: "gpt-6.1-sol", effort: "xhigh", reviewProducer: "claude",
    connectors: ["github", "acme-staging"] };
  const accepted = parseProviderRunInput(review).input;
  assert.deepEqual(accepted.overrides, { model: "gpt-6.1-sol", effort: "xhigh" });
  assert.deepEqual(accepted.connectors, ["acme-staging", "github"]);
  assert.equal(accepted.reviewProducer, "claude");
  const stored = { ...accepted, review: { producerAgent: "claude" },
    connectorAccess: { mode: "read-only", connectors: accepted.connectors } };
  assert.equal(matchesRunInput(stored, accepted), true);
  assert.equal(matchesRunInput(stored, parseProviderRunInput({ ...review, connectors: ["github"] }).input), false);
  for (const changes of [
    { reviewProducer: "opencode" }, { reviewProducer: undefined }, { authMode: "subscription" },
    { model: undefined }, { model: "gpt-4.1-mini" }, { effort: undefined }, { effort: "high" },
    { repository: undefined }, { repository: { slug: repository.slug, ref: "refs/heads/main" } },
    { publish: true }, { publish: false }, { connectors: ["github", "github"] }, { modelProvider: "anthropic" },
  ]) assert.equal(parseProviderRunInput({ ...review, ...changes }), undefined);
  const responses = openCodeProviderConfig("openai", true);
  assert.equal(responses.path, "/v1/responses");
  assert.equal(responses.upstream, "https://api.openai.com");
  assert.equal(responses.binding, "SANDBOX_RUNNER_OPENCODE_OPENAI_API_KEY");
  assert.equal(openCodeProviderConfig("openai").path, "/v1/chat/completions");
  const settings = resolveOpenCodeSettings("openai", review.model, review.effort, true);
  const config = openCodeConfig(settings, accepted.connectors);
  assert.equal(config.model, "gateway/gpt-6.1-sol#xhigh");
  assert.equal(config.providers.gateway.package, "@opencode/ai/providers/openai/responses");
  assert.deepEqual(config.providers.gateway.settings, { baseURL: "http://opencode.harness.internal/v1", transport: "http", encoding: "none" });
  assert.deepEqual(config.providers.gateway.models[review.model].variants, [{ id: "xhigh", settings: { reasoningEffort: "xhigh" } }]);
  assert.deepEqual(config.mcp.servers["acme-staging"], { type: "remote", url: "http://mcp.harness.internal/acme-staging/mcp",
    oauth: false, codemode: false });
  assert.deepEqual(JSON.parse(openCodeEnv(settings, accepted.connectors).SANDBOX_RUNNER_OPENCODE_REVIEW_CONNECTORS), accepted.connectors);
  for (const action of ["acme-staging_*", "github_*"]) {
    assert.ok(config.permissions.some(rule => rule.action === action && rule.effect === "allow"));
    assert.ok(config.policies.some(rule => rule.resource === action + ":*" && rule.effect === "allow"));
  }
  for (const action of ["edit", "shell", "subagent", "webfetch", "websearch", "execute"]) {
    assert.ok(config.permissions.some(rule => rule.action === action && rule.effect === "deny"));
    assert.ok(config.policies.some(rule => rule.resource === action + ":*" && rule.effect === "deny"));
  }
  const failure = openCodeParser().line('{"type":"sandbox_runner_mcp_startup_failed"}').outcome;
  assert.deepEqual(outcome(failure, undefined, { agent: "opencode", authMode: "api-key", modelProvider: "openai" }),
    { status: "failed", reason: "opencode_mcp_startup_failed" });
});
