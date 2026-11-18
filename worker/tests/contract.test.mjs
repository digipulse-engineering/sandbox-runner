import assert from "node:assert/strict";
import test from "node:test";
import { matchesRunInput, operationId, parseClaudeOverrideInput, parseInput, parseProviderRunInput,
  resolveRunRouting, sameProviderRequest } from "../contract.ts";
import { resolveClaudeSettings } from "../claude-settings.ts";
import { codexPresetSettings } from "../agent-settings.ts";
import { codexApiCreditPromoRestriction } from "../codex-api-diagnostics.ts";
import { connectorAccessFor } from "../mcp-run-access.ts";
import { providerConfig, providerCredential } from "../provider.ts";
import { guardedForward } from "../relay.ts";
import { parseReviewResult, withReviewResult } from "../review.ts";

const id = "12B712D0-F53D-45E3-9128-17D3667C5487";

test("binds agent replays to the admitted profile request and rejects a raw receipt", () => {
  const raw = { operationId: id, kind: "agent", agent: "claude", prompt: "Same prompt" };
  const { input } = parseProviderRunInput(raw);
  const profile = { slug: "claude-work", revision: "a".repeat(64), source: "client-supplied", requestDigest: "b".repeat(64) };
  const admitted = { ...input, profile };
  assert.equal(matchesRunInput(admitted, { ...input, profile: { ...profile } }), true);
  assert.equal(matchesRunInput(admitted, { ...input, profile: { ...profile, requestDigest: "c".repeat(64) } }), false);
  assert.equal(matchesRunInput(admitted, input), false);
  assert.equal(matchesRunInput(input, admitted), false);
  assert.equal(parseProviderRunInput({ ...raw, profile }), undefined);
});

test("requires a different producer and exact checkout and keeps the review input idempotent", () => {
  const request = { operationId: id, kind: "agent", agent: "codex", prompt: "Check the changes.",
    repository: { slug: "Owner/Repo", sha: "a".repeat(40) }, reviewProducer: "claude" };
  const accepted = parseProviderRunInput(request);
  assert.equal(accepted.input.reviewProducer, "claude");
  for (const invalid of [{ reviewProducer: "codex" }, { reviewProducer: "unknown" },
    { reviewProducer: null }, { repository: undefined }, { publish: true }]) {
    assert.equal(parseProviderRunInput({ ...request, ...invalid }), undefined);
  }
  const stored = { ...accepted.input, review: { producerAgent: "claude" } };
  assert.equal(matchesRunInput(stored, accepted.input), true);
  assert.equal(matchesRunInput(stored, { ...accepted.input, reviewProducer: undefined }), false);
});

test("projects only structured review findings and distinguishes a FAIL verdict from an invalid result", () => {
  const review = { producerAgent: "claude" };
  for (const verdict of ["PASS", "FAIL", "ESCALATE"]) {
    const output = JSON.stringify({ verdict, findings: verdict === "PASS" ? [] : ["src/a.ts:4 can throw."] });
    assert.deepEqual(withReviewResult({ status: "succeeded", output }, review), {
      status: "succeeded", review: { ...review, ...JSON.parse(output) },
    });
  }
  for (const output of [undefined, "PASS", "{\"verdict\":\"PASS\"}", "{\"verdict\":\"FAIL\",\"findings\":[]}",
    "{\"verdict\":\"PASS\",\"findings\":[\" \"]}", "{\"verdict\":\"PASS\",\"findings\":[],\"raw\":\"ignored\"}"]) {
    assert.equal(parseReviewResult(output), undefined);
    assert.deepEqual(withReviewResult({ status: "succeeded", output }, review), { status: "failed", reason: "review_verdict_invalid" });
  }
  const quota = { status: "capacity", reason: "provider_quota_exhausted" };
  assert.deepEqual(withReviewResult(quota, review), quota);
});

test("v4 makes MCP connector selection part of run identity and derives the mode on the Worker", () => {
  const request = { operationId: id, kind: "agent", agent: "codex", prompt: "Check the changes.",
    repository: { slug: "Owner/Repo", sha: "a".repeat(40) }, reviewProducer: "claude" };
  const connectors = ["acme-work-staging", "github"];
  const { input } = parseProviderRunInput({ ...request, connectors: [...connectors].reverse() });
  assert.deepEqual(input.connectors, connectors);
  const connectorAccess = connectorAccessFor(input.connectors, input.reviewProducer !== undefined);
  assert.deepEqual(connectorAccess, { connectors, mode: "read-only" });
  assert.deepEqual(connectorAccessFor(connectors, false), { connectors, mode: "read-write" });
  const stored = { ...input, connectorAccess, review: { producerAgent: "claude" } };
  assert.equal(matchesRunInput(stored, parseProviderRunInput({ ...request, connectors }).input), true);
  assert.equal(matchesRunInput(stored, parseProviderRunInput({ ...request, connectors: ["github"] }).input), false);
  for (const extra of [
    { connectors: ["github", "github"] }, { connectors: [] }, { connectors: ["gh/secret"] },
    { connectors: ["constructor"] }, { connectors, connectorAccess: { mode: "read-write" } },
  ]) assert.equal(parseProviderRunInput({ ...request, ...extra }), undefined);
});

test("validates and canonicalizes UUIDs without rewriting the prompt", () => {
  assert.equal(operationId(id), id.toLowerCase());
  assert.equal(operationId("bad-id"), undefined);
  assert.deepEqual(parseInput({ operationId: id, agent: "codex", prompt: "  preserve me  " }, false), {
    operationId: id.toLowerCase(), agent: "codex", authMode: "api-key", prompt: "  preserve me  ",
  });
  for (const input of [null, [], { operationId: id, agent: "other", prompt: "go" }, { operationId: id, agent: "claude", prompt: "   " }]) {
    assert.equal(parseInput(input, false), undefined);
  }
});

test("validates explicit modes and compares retries against the historical effective mode", () => {
  const input = { operationId: id, agent: "claude", prompt: "Same prompt" };
  const oldRun = { agent: input.agent, prompt: input.prompt };
  const legacy = parseInput(input, false);
  const subscription = parseInput({ ...input, authMode: "subscription" }, true);
  const apiKey = parseInput({ ...input, authMode: "api-key" }, true);
  assert.equal(matchesRunInput(oldRun, legacy), true);
  assert.equal(matchesRunInput(oldRun, subscription), true);
  assert.equal(matchesRunInput(oldRun, apiKey), false);
  assert.equal(matchesRunInput(apiKey, subscription), false);
  assert.equal(parseInput({ ...input, authMode: "api-key" }, false), undefined);
  assert.equal(parseInput(input, true), undefined);
  assert.equal(parseInput({ ...input, authMode: "other" }, true), undefined);
});

test("Claude v3 accepts independent overrides and distinguishes implicit and explicit authentication", () => {
  const input = { operationId: id, agent: "claude", prompt: "Same prompt" };
  const legacy = parseInput(input, false);
  const parsed = (fields) => parseClaudeOverrideInput({ ...input, ...fields });
  const implicit = parsed({ model: "claude-3-7-sonnet" });
  assert.deepEqual(implicit, {
    input: { ...legacy, overrides: { model: "claude-3-7-sonnet" } }, explicitAuth: false,
  });
  assert.deepEqual(parsed({ effort: "max", authMode: "api-key" }), {
    input: { ...legacy, authMode: "api-key", overrides: { effort: "max" } }, explicitAuth: true,
  });
  assert.deepEqual(parsed({ model: "opus[1m]", effort: "xhigh" }).input.overrides, { model: "opus[1m]", effort: "xhigh" });
  for (const fields of [
    {}, { model: null }, { model: "claude-4\n" }, { model: "-flag" }, { model: "claude-x--bad" },
    { model: "https://provider.invalid/claude" }, { model: "default" }, { effort: "auto" },
    { effort: " HIGH " }, { model: "sonnet", effort: null }, { agent: "codex", model: "sonnet" },
    { model: "sonnet", authMode: "" },
  ]) assert.equal(parsed(fields), undefined);
  assert.deepEqual(parseInput({ ...input, model: "opus" }, false), legacy);
  assert.equal(matchesRunInput({ ...legacy, model: "claude-3-7-sonnet" }, implicit.input), false);
  assert.equal(matchesRunInput(implicit.input, legacy), false);
  assert.equal(matchesRunInput(implicit.input, parsed({ model: "claude-3-7-sonnet" }).input), true);
  assert.equal(matchesRunInput(implicit.input, parsed({ model: "opus" }).input), false);
});

test("v4 accepts provider-aware agent runs and rejects unsupported fields instead of ignoring them", () => {
  const request = { operationId: id, kind: "agent", agent: "claude", prompt: "  keep spacing  " };
  assert.deepEqual(parseProviderRunInput(request), {
    input: { operationId: id.toLowerCase(), agent: "claude", prompt: request.prompt, authMode: "subscription" },
    explicitAuth: false, providerRequest: { explicitAuth: false },
  });
  assert.deepEqual(parseProviderRunInput({ ...request, authMode: "api-key", effort: "high", sandboxProvider: "cloudflare" }), {
    input: { operationId: id.toLowerCase(), agent: "claude", prompt: request.prompt, authMode: "api-key", overrides: { effort: "high" } },
    explicitAuth: true, providerRequest: { explicitAuth: true, sandboxProvider: "cloudflare" },
  });
  assert.equal(parseProviderRunInput({ ...request, agent: "codex" }).input.authMode, "api-key");
  for (const fields of [{ kind: "test" }, { sandboxProvider: "cloudflare\n" }, { sandboxProvider: null },
    { sandboxProvider: "-cloudflare" }, { sandboxProvider: "Cloudflare" }, { repo: "unsupported" },
    { agent: "codex", model: "sonnet" }, { agent: "opencode" }, { authMode: "" }]) {
    assert.equal(parseProviderRunInput({ ...request, ...fields }), undefined);
  }
});

test("v4 validates Codex settings, preserves replay identity and builds pinned preset options", () => {
  const request = { operationId: id, kind: "agent", agent: "codex", authMode: "api-key", prompt: "Review." };
  const settings = { model: "gpt-6.1-sol", effort: "xhigh" };
  const { input } = parseProviderRunInput({ ...request, ...settings });
  assert.deepEqual(input.overrides, settings);
  assert.deepEqual(codexPresetSettings(input.overrides, input.authMode), {
    model: settings.model, config: ['model_reasoning_effort="xhigh"'],
  });
  assert.deepEqual(codexPresetSettings({}, "api-key"), { model: "gpt-5.1", config: [] });
  assert.deepEqual(codexPresetSettings({}, "subscription"), { model: "gpt-6.1-sol", config: [] });
  assert.equal(parseClaudeOverrideInput({ ...request, ...settings }), undefined);
  assert.equal(matchesRunInput(input, structuredClone(input)), true);
  assert.equal(matchesRunInput(input, parseProviderRunInput({ ...request, ...settings, effort: "high" }).input), false);
  assert.equal(matchesRunInput(input, parseProviderRunInput({ ...request, ...settings, model: "gpt-6-astra" }).input), false);
  for (const invalid of [{ model: "claude-sonnet-5-5" }, { model: "gpt-6-astra\n" }, { model: 'gpt-6-astra" -c' },
    { model: "gpt-6-" + "a".repeat(4_995) }, { model: null }, { effort: "auto" }, { effort: null }]) {
    assert.equal(parseProviderRunInput({ ...request, ...settings, ...invalid }), undefined);
  }
});

test("v4 resolves provider configuration once and distinguishes the caller's choices for a replay", () => {
  const implicit = { explicitAuth: false };
  const explicit = { explicitAuth: false, sandboxProvider: "cloudflare" };
  const unavailable = { explicitAuth: false, sandboxProvider: "daytona" };
  assert.deepEqual(resolveRunRouting(implicit), { request: implicit, sandboxProvider: "cloudflare" });
  assert.equal(resolveRunRouting(implicit, "other"), "sandbox_provider_default_invalid");
  assert.deepEqual(resolveRunRouting(explicit, "other"), { request: explicit, sandboxProvider: "cloudflare" });
  assert.equal(resolveRunRouting(unavailable, "cloudflare"), "sandbox_provider_unavailable");
  assert.equal(sameProviderRequest(undefined, implicit), false);
  assert.equal(sameProviderRequest(implicit, explicit), false);
  assert.equal(sameProviderRequest(explicit, { ...explicit, explicitAuth: true }), false);
  assert.equal(sameProviderRequest(explicit, structuredClone(explicit)), true);
});

test("resolves each used default independently and omits settings with no requested or configured value", () => {
  assert.deepEqual(resolveClaudeSettings(undefined, {}), {});
  assert.deepEqual(resolveClaudeSettings(undefined, { SANDBOX_RUNNER_CLAUDE_MODEL: "sonnet" }), { model: "sonnet" });
  assert.deepEqual(resolveClaudeSettings({ model: "opus" }, {
    get SANDBOX_RUNNER_CLAUDE_MODEL() { assert.fail("read overridden default"); },
    SANDBOX_RUNNER_CLAUDE_EFFORT: "medium",
  }), { model: "opus", effort: "medium" });
  assert.equal(resolveClaudeSettings({ model: "opus" }, {
    SANDBOX_RUNNER_CLAUDE_EFFORT: "other",
  }), "claude_defaults_invalid");
  assert.equal(resolveClaudeSettings(undefined, { SANDBOX_RUNNER_CLAUDE_MODEL: "" }), "claude_defaults_invalid");
  assert.deepEqual(resolveClaudeSettings({ effort: "low" }, {
    SANDBOX_RUNNER_CLAUDE_EFFORT: "invalid",
  }), { effort: "low" });
});

test("enforces the Worker binding size on configured and requested Claude models", () => {
  const maximum = "claude-".padEnd(5_000, "a");
  const oversized = maximum + "a";
  const parse = model => parseClaudeOverrideInput({ operationId: id, agent: "claude", prompt: "Same prompt", model });
  assert.equal(parse(maximum).input.overrides.model, maximum);
  assert.equal(parse(oversized), undefined);
  assert.deepEqual(resolveClaudeSettings(undefined, { SANDBOX_RUNNER_CLAUDE_MODEL: maximum }), { model: maximum });
  assert.equal(resolveClaudeSettings(undefined, { SANDBOX_RUNNER_CLAUDE_MODEL: oversized }), "claude_defaults_invalid");
});

test("reads only the selected provider binding and keeps fixtures isolated", () => {
  const subscription = providerConfig("claude", "subscription");
  const apiKey = providerConfig("claude", "api-key");
  const codex = providerConfig("codex", "api-key");
  const codexSubscription = providerConfig("codex", "subscription");
  const env = { SANDBOX_RUNNER_MODE: "real", ANTHROPIC_API_KEY: "claude-key", OPENAI_API_KEY: "codex-key" };
  assert.equal(providerCredential(subscription, env), undefined);
  assert.equal(providerCredential(subscription, { ...env, CLAUDE_CODE_OAUTH_TOKEN: "oauth-test" }), "Bearer oauth-test");
  assert.equal(apiKey.header, "x-api-key");
  assert.equal(providerCredential(apiKey, env), "claude-key");
  assert.equal(providerCredential(apiKey, { SANDBOX_RUNNER_MODE: "real", CLAUDE_CODE_OAUTH_TOKEN: "oauth-test" }), undefined);
  assert.equal(providerCredential(codex, env), "Bearer codex-key");
  assert.equal(providerCredential(codex, { ...env, OPENAI_API_KEY: "header.payload.signature" }), undefined);
  assert.equal(codexSubscription.originator, "sandbox-runner");
  assert.equal(codexSubscription.upstream, codex.upstream);
  assert.equal(providerCredential(codexSubscription, env), undefined);
  assert.equal(providerCredential(codexSubscription, { ...env, OPENAI_SUBSCRIPTION_OAUTH_TOKEN: "sk-proj-placeholder" }), undefined);
  const withSubscription = { SANDBOX_RUNNER_MODE: "real", OPENAI_SUBSCRIPTION_OAUTH_TOKEN: "user-oauth-access" };
  assert.equal(providerCredential(codexSubscription, withSubscription), "Bearer user-oauth-access");
  assert.equal(providerCredential(codex, withSubscription), undefined);
  const fixtureEnv = {
    SANDBOX_RUNNER_MODE: "fixture",
    get ANTHROPIC_API_KEY() { assert.fail("fixture read a provider binding"); },
  };
  assert.equal(providerCredential(apiKey, fixtureEnv), "sandbox-runner-fixture-upstream");
});

const route = {
  host: "anthropic.harness.internal", upstream: "https://api.anthropic.com",
  headers: { authorization: "Bearer worker-synthetic" },
  strip: ["authorization", "x-api-key"],
  allow: [{ method: "POST", path: "/v1/messages", searches: ["?beta=true"] }],
};
const subject = { containerId: id, contractId: null };

test("passes both streams untouched and injects only the designated authorization", async () => {
  const request = new Request("http://anthropic.harness.internal/v1/messages?beta=true", {
    method: "POST", body: "opaque request",
    headers: { authorization: "Bearer placeholder", "x-api-key": "untrusted", "anthropic-beta": "oauth-test" },
  });
  const fixture = new Response("opaque response", { headers: { "content-type": "text/event-stream" } });
  let observed;
  const result = await guardedForward(request, [route], subject, () => {}, async (target, init) => {
    observed = { target, init };
    return fixture;
  });
  assert.equal(observed.target, "https://api.anthropic.com/v1/messages?beta=true");
  assert.equal(observed.init.redirect, "manual");
  assert.equal(observed.init.body, request.body);
  assert.equal(observed.init.headers.get("authorization"), "Bearer worker-synthetic");
  assert.equal(observed.init.headers.get("x-api-key"), null);
  assert.equal(observed.init.headers.get("anthropic-beta"), "oauth-test");
  assert.equal(result, fixture);
  assert.equal(await result.text(), "opaque response");
});

test("drops all upstream credential headers and keeps the SSE stream and provider metadata", async () => {
  const request = new Request("http://anthropic.harness.internal/v1/messages", {
    method: "POST", body: "opaque request", headers: { "x-codex-turn-state": "untrusted-state" },
  });
  const fixture = new Response("event: response.completed\ndata: {}\n\n", {
    headers: {
      "content-type": "text/event-stream", "request-id": "req_synthetic",
      "anthropic-ratelimit-requests-remaining": "1", authorization: "Bearer upstream",
      "proxy-authorization": "Basic upstream", cookie: "client=secret", "x-api-key": "upstream-secret",
      "x-codex-turn-state": "upstream-state",
    },
  });
  fixture.headers.append("set-cookie", "session=first; Secure");
  fixture.headers.append("set-cookie", "session=second; Secure");
  const result = await guardedForward(request, [{ ...route, strip: ["x-codex-turn-state"] }], subject, () => {}, async (_target, init) => {
    assert.equal(init.headers.has("x-codex-turn-state"), false);
    return fixture;
  });
  assert.equal(result.body, fixture.body);
  assert.equal(result.headers.get("content-type"), "text/event-stream");
  assert.equal(result.headers.get("request-id"), "req_synthetic");
  assert.equal(result.headers.get("anthropic-ratelimit-requests-remaining"), "1");
  for (const name of ["set-cookie", "authorization", "proxy-authorization", "cookie", "x-api-key", "x-codex-turn-state"]) {
    assert.equal(result.headers.has(name), false);
  }
  assert.equal(await result.text(), "event: response.completed\ndata: {}\n\n");
});

test("denies wrong origin, method, path and query before the upstream is called", async () => {
  for (const [target, method] of [
    ["http://other.harness.internal/v1/messages", "POST"],
    ["http://anthropic.harness.internal/v1/messages", "GET"],
    ["http://anthropic.harness.internal/v1/messages/count_tokens", "POST"],
    ["http://anthropic.harness.internal/v1/messages?beta=other", "POST"],
  ]) {
    const result = await guardedForward(new Request(target, { method }), [route], subject, () => {}, () => {
      assert.fail("unapproved egress reached the upstream");
    });
    assert.equal(result.status, 403);
  }
});

test("attributes only allowed inference and keeps separate journal entries for denials", async () => {
  const entries = [];
  const attempts = [];
  const observe = event => (attempts.push(event), true);
  const infer = new Request("http://anthropic.harness.internal/v1/messages", { method: "POST", body: "stream" });
  await guardedForward(infer, [route], subject, event => entries.push(event), async () => {
    assert.equal(attempts.length, 1);
    return new Response("opaque", { status: 429, headers: {
      "request-id": "req_test", "anthropic-ratelimit-requests-remaining": "0",
      authorization: "Bearer upstream-secret",
    } });
  }, undefined, observe);
  await guardedForward(new Request("http://anthropic.harness.internal/api/hello", { method: "HEAD" }),
    [route], subject, event => entries.push(event), () => assert.fail("denied request fetched"), undefined, observe);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], { id: attempts[0].id, signal: { kind: "http", status: 429 } });
  assert.deepEqual(entries.map(({ decision, status, requestId }) => ({ decision, status, requestId })), [
    { decision: "relayed", status: 429, requestId: "req_test" },
    { decision: "denied", status: null, requestId: null },
  ]);
  assert.deepEqual(entries[0].limits, { "anthropic-ratelimit-requests-remaining": "0" });
  assert(!JSON.stringify(entries).includes("upstream-secret"));
});

test("relays a Codex API rejection before EOF and only records its allowlisted diagnostic", async () => {
  const upstreamCode = "codex_byok_restricted_by_api_credit_promo";
  const responseBody = JSON.stringify({ error: { code: upstreamCode, message: "upstream private text" } });
  const headers = { "content-type": "application/json; charset=utf-8", "x-request-id": "req_fixture" };
  const codexRoute = { ...route, host: "openai.harness.internal", upstream: "https://api.openai.com/v1",
    allow: [{ method: "POST", path: "/responses" }] };
  const request = () => new Request("http://openai.harness.internal/responses", { method: "POST", body: "opaque" });
  const inference = [];
  const journal = [];
  let stream;
  const raw = new ReadableStream({ start(controller) { stream = controller; } });
  const reply = new Response(raw, { status: 400, headers: { ...headers, "content-length": String(Buffer.byteLength(responseBody)) } });
  const result = await guardedForward(request(), [codexRoute], subject, entry => journal.push(entry), async () => reply,
    undefined, event => (inference.push(event), true), true);
  assert.equal(result.status, 400);
  assert.equal(result.headers.get("x-request-id"), "req_fixture");
  assert.equal(result.headers.get("content-length"), null);
  assert.deepEqual(inference[1].signal, { kind: "http", status: 400 });
  const reader = result.body.getReader();
  const head = responseBody.slice(0, 29);
  const tail = responseBody.slice(head.length);
  stream.enqueue(new TextEncoder().encode(head));
  assert.equal(new TextDecoder().decode((await reader.read()).value), head);
  assert.equal(inference.length, 2);
  stream.enqueue(new TextEncoder().encode(tail));
  stream.close();
  assert.equal(new TextDecoder().decode((await reader.read()).value), tail);
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(inference[2], { id: inference[0].id,
    signal: { kind: "http", status: 400, restriction: codexApiCreditPromoRestriction } });
  assert.doesNotMatch(JSON.stringify({ journal, inference }), /upstream private text|codex_byok_restricted/);

  for (const [body, status, contentType, enabled] of [
    ['{"error":', 400, "application/json", true],
    [JSON.stringify({ error: { message: upstreamCode } }), 400, "application/json", true],
    [JSON.stringify({ error: { code: upstreamCode + "_other" } }), 400, "application/json", true],
    [JSON.stringify({ error: { code: upstreamCode, message: "x".repeat(16 * 1024) } }), 400, "application/json", true],
    [responseBody, 400, "text/plain", true],
    [responseBody, 422, "application/json", true],
    [responseBody, 400, "application/json", false],
  ]) {
    const observed = [];
    const response = await guardedForward(request(), [codexRoute], subject, () => {}, async () =>
      new Response(body, { status, headers: { "content-type": contentType } }), undefined,
      event => (observed.push(event), true), enabled);
    assert.equal(await response.text(), body);
    assert.deepEqual(observed, [{ id: observed[0].id }, { id: observed[0].id, signal: { kind: "http", status } }]);
  }

  const observed = [];
  let interrupted;
  const upstream = new ReadableStream({ start(controller) { interrupted = controller; } });
  const partial = await guardedForward(request(), [codexRoute], subject, () => {}, async () =>
    new Response(upstream, { status: 400, headers }), undefined, event => (observed.push(event), true), true);
  const partialReader = partial.body.getReader();
  interrupted.enqueue(new TextEncoder().encode(responseBody));
  assert.equal(new TextDecoder().decode((await partialReader.read()).value), responseBody);
  const timeout = new DOMException("upstream timeout", "TimeoutError");
  interrupted.error(timeout);
  await assert.rejects(partialReader.read(), timeout);
  assert.deepEqual(observed, [{ id: observed[0].id }, { id: observed[0].id, signal: { kind: "http", status: 400 } }]);
});

test("distinguishes transport errors, timeout, and redirects without inspecting body", async () => {
  for (const [failure, kind] of [
    [new TypeError("sensitive transport failure"), "transport_failed"],
    [new DOMException("sensitive timeout", "TimeoutError"), "transport_timeout"],
    [undefined, "redirect"],
  ]) {
    const attempts = [];
    const request = new Request("http://anthropic.harness.internal/v1/messages", { method: "POST", body: "opaque" });
    const relay = guardedForward(request, [route], subject, () => {}, async () => {
      if (failure) throw failure;
      return new Response("opaque", { status: 307, headers: { location: "https://another.invalid" } });
    }, undefined, event => (attempts.push(event), true));
    if (failure) await assert.rejects(relay, failure);
    else assert.equal((await relay).status, 307);
    assert.deepEqual(attempts, [{ id: attempts[0].id }, { id: attempts[0].id, signal: { kind } }]);
  }
});

test("requires current authorization before any upstream request", async () => {
  const request = new Request("http://anthropic.harness.internal/v1/messages", { method: "POST", body: "opaque" });
  const response = await guardedForward(request, [route], subject, () => {}, () => {
    assert.fail("upstream reached after observation authorization was denied");
  }, undefined, () => false);
  assert.equal(response.status, 403);
});
