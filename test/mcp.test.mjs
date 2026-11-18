import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyStdio } from "@modelcontextprotocol/sdk/client/stdio.js";
import { profileInputContract, profileInputErrorMessage, profileReceipt, profileRevision,
  validateProfileInputs } from "../worker/run-profiles.mjs";

const bin = process.env.SANDBOX_RUNNER_MCP_TEST_BIN ?? fileURLToPath(new URL("../bin/sandbox-runner.mjs", import.meta.url));
const token = "synthetic-private-mcp-bearer";
const id = "ab4fd2c9-91a2-4ed2-9ed3-68dfbb82c8b1";
const repository = { slug: "Owner/Repo", sha: "a".repeat(40) };
const prompt = "--publish\n$(touch local-sentinel)";
const kind = { kind: "agent", sandboxProvider: "cloudflare" };

function json(response, code, payload) {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function gateway(t, handler, controlToken = token) {
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer " + controlToken);
      await handler(request, response);
    } catch (error) {
      response.destroy();
      throw error;
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function connect(t, url, legacy = false, controlToken = token, env = {}) {
  const client = legacy ? new LegacyClient({ name: "legacy-sandbox-test", version: "1.0.0" })
    : new Client({ name: "modern-sandbox-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const Transport = legacy ? LegacyStdio : StdioClientTransport;
  const transport = new Transport({ command: process.execPath, args: [bin, "mcp"], stderr: "pipe",
    env: { SANDBOX_RUNNER_URL: url, SANDBOX_RUNNER_TOKEN: controlToken, SANDBOX_RUNNER_TIMEOUT_MS: "3000", ...env } });
  let stderr = "";
  transport.stderr.on("data", chunk => { stderr += chunk; });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    assert(!stderr.includes(controlToken));
  });
  return client;
}

function tool(client, name, args = {}, options) {
  return client.callTool({ name: "sandbox_runner_" + name, arguments: args }, options);
}

function checked(result, controlToken = token) {
  assert(!JSON.stringify(result).includes(controlToken));
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}

async function requestBody(request) {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

function queued(body, extras) {
  return { id: body.operationId, ...kind, agent: body.agent, status: "queued", cleanup: "pending", ...extras };
}

test("MCP returns the Codex API-credit restriction as a settled run receipt", async t => {
  const receipt = { id, ...kind, agent: "codex", authMode: "api-key", status: "failed", cleanup: "destroyed",
    reason: "provider_codex_api_credit_promo_restricted" };
  const url = await gateway(t, (request, response) => {
    assert.equal(request.url, `/v1/runs/${id}/result`);
    json(response, 200, receipt);
  });
  const client = await connect(t, url);
  const result = await tool(client, "result", { id });
  assert.equal(result.isError, false);
  assert.equal(checked(result).exitCode, 1);
  assert.deepEqual(checked(result).receipt, receipt);
});

test("MCP reads and replays a profile with the same request contract as the CLI", async t => {
  const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-mcp-profiles-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const file = join(scratch, "profiles.json");
  const profile = { kind: "test", runner: "vitest", defaults: { repo: repository.slug } };
  await writeFile(file, JSON.stringify({ schemaVersion: 1, profiles: { "unit-tests": profile } }));
  const posts = [];
  const url = await gateway(t, async (request, response) => {
    const body = await requestBody(request);
    posts.push(body);
    json(response, 202, { id, kind: "test", suite: "vitest", phase: "queued", status: "queued", cleanup: "pending",
      sandboxProvider: "cloudflare", repository, profile: await profileReceipt(body) });
  });
  const client = await connect(t, url, false, token, { SANDBOX_RUNNER_PROFILES: file, XDG_STATE_HOME: scratch });
  const listed = checked(await tool(client, "profile_list", { usage: "test", repo: repository.slug })).receipt;
  assert.deepEqual(listed.slugs, ["unit-tests"]);
  assert.equal(listed.profiles[0].usage, "test");
  assert.equal(listed.profiles[0].runner, "vitest");
  assert.deepEqual(checked(await tool(client, "profile_get", { slug: "unit-tests" })).receipt, {
    slug: "unit-tests", profile, revision: await profileRevision(profile), usage: "test", qualification: "unverified",
    inputContract: profileInputContract(profile),
  });
  const started = checked(await tool(client, "start_profile", { slug: "unit-tests", operationId: id, source: { sha: repository.sha } }));
  assert.equal(started.exitCode, 0);
  assert.deepEqual(posts[0], { kind: "profile", operationId: id, profile: { slug: "unit-tests", body: profile }, source: { sha: repository.sha } });
  assert.deepEqual(started.receipt.profile, await profileReceipt(posts[0]));
  await rm(file);
  assert.deepEqual(checked(await tool(client, "retry_profile", { operationId: id })), started);
  assert.deepEqual(posts[1], posts[0]);
});

test("MCP discovers and starts a shared reviewer profile with authenticated attribution", async t => {
  const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-team-mcp-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const slug = "codex-reviewer";
  const clientId = "lead-engineering";
  const deliveryId = "35f3fd11-4f5e-4835-a426-ecc4066196c4";
  const profile = { kind: "agent", harness: "codex", operation: "review", authMode: "subscription",
    defaults: { repo: repository.slug, model: "gpt-6.1-sol", effort: "xhigh" }, mcp: { connectors: ["github"] } };
  const revision = await profileRevision(profile);
  const entry = { slug, profile, revision };
  const input = { operationId: id, source: { sha: repository.sha }, prompt, producerAgent: "claude" };
  const receipt = { ...await profileReceipt({ ...input, kind: "profile", profile: { slug, body: profile } }),
    source: "worker-catalog", clientId, deliveryId };
  const view = { id, ...kind, agent: "codex", authMode: "subscription", status: "queued", cleanup: "pending",
    repository, review: { producerAgent: "claude" }, model: "gpt-6.1-sol", effort: "xhigh",
    connectorAccess: { mode: "read-only", connectors: ["github"] }, profile: receipt };
  const posts = [];
  const checks = ["sandbox", "repository", "credentials", "connectors", "timeout"].map(kind => ({ kind, status: "configured" }));
  const url = await gateway(t, async (request, response) => {
    if (request.url === "/v4/profiles") return json(response, 200, { clientId, profiles: [entry] });
    if (request.url === "/v4/profiles/" + slug) return json(response, 200, { clientId, ...entry });
    if (request.url === `/v4/profiles/${slug}/readiness?revision=${revision}`) return json(response, 200, {
      clientId, slug, revision, qualification: "unverified", checks,
    });
    if (request.method === "GET") return json(response, 200, { runs: [view], nextCursor: null });
    assert.equal(request.url, "/v4/runs");
    const body = await requestBody(request);
    if (body.kind !== "team-profile") return json(response, 403, { error: "profile_required" });
    posts.push(body);
    return json(response, 202, view);
  });
  const client = await connect(t, url, false, token, { SANDBOX_RUNNER_TEAM: "1", XDG_STATE_HOME: scratch });
  const listed = checked(await tool(client, "profile_list")).receipt;
  assert.deepEqual(listed.slugs, [slug]);
  assert.equal(listed.clientId, clientId);
  assert.equal(listed.profiles[0].usage, "review");
  assert.deepEqual(checked(await tool(client, "profile_get", { slug })).receipt, { ...entry, clientId,
    usage: "review", qualification: "unverified", inputContract: profileInputContract(profile) });
  assert.deepEqual(checked(await tool(client, "profile_check", { slug })).receipt, {
    clientId, slug, revision, qualification: "unverified", checks,
  });
  const rejected = await tool(client, "start", { agent: "claude", prompt });
  assert.equal(checked(rejected).error, "profile_required");
  const started = checked(await tool(client, "start_profile", { slug, revision, deliveryId, ...input }));
  assert.deepEqual(started.receipt, view);
  assert.deepEqual(posts, [{ ...input, kind: "team-profile", profile: slug, revision, deliveryId }]);
  assert.deepEqual(checked(await tool(client, "retry_profile", { operationId: id })), started);
  assert.deepEqual(posts[1], posts[0]);
  assert.deepEqual(checked(await tool(client, "list")).receipt.runs[0].profile, receipt);
});

test("MCP aggregates malformed profile inputs without coercion, journaling or dispatch", async t => {
  const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-mcp-inputs-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const file = join(scratch, "profiles.json");
  const slug = "reviewer";
  const profile = { kind: "agent", harness: "codex", operation: "review", authMode: "subscription",
    defaults: { repo: repository.slug }, allowedOverrides: { effort: ["medium", "high"] } };
  await writeFile(file, JSON.stringify({ schemaVersion: 1, profiles: { [slug]: profile } }));
  let posts = 0;
  const url = await gateway(t, (_request, response) => { posts++; json(response, 500, {}); });
  const client = await connect(t, url, false, token, { SANDBOX_RUNNER_PROFILES: file, XDG_STATE_HOME: scratch });
  const input = { source: { ref: "refs/heads/main", sha: [] }, prompt: false, producerAgent: "codex",
    authMode: "api-key", overrides: { effort: {}, privileged: true }, profile: { slug: "other" } };
  const result = await tool(client, "start_profile", { slug, operationId: id, ...input });
  assert.equal(result.isError, true);
  const response = checked(result);
  assert.equal(response.error, "invalid_profile_inputs");
  assert.equal(response.profile, slug);
  assert.deepEqual(response.issues, validateProfileInputs(profile, input));
  assert.deepEqual(response.issues.map(({ field }) => field), [
    "source", "source.sha", "prompt", "producerAgent", "authMode", "overrides", "overrides.effort", "$",
  ]);
  const proto = JSON.parse('{"__proto__":{"unexpected":true}}');
  const refused = await tool(client, "start_profile", { slug, operationId: id, source: { sha: repository.sha, ...proto },
    producerAgent: "claude", prompt: "review", overrides: { effort: "high" } });
  assert.equal(checked(refused).error, "invalid_profile_inputs");
  assert.deepEqual(checked(refused).issues.map(({ field, code }) => ({ field, code })), [{ field: "source", code: "unexpected_field" }]);
  await assert.rejects(stat(join(scratch, "sandbox-runner", "profile-requests", id + ".json")), { code: "ENOENT" });
  assert.equal(posts, 0);
});

test("MCP reads profile templates and generates drafts without contacting the gateway", async t => {
  let requests = 0;
  const url = await gateway(t, (_request, response) => { requests++; json(response, 500, {}); });
  const client = await connect(t, url, false, token, { SANDBOX_RUNNER_TEAM: "1" });
  const list = checked(await tool(client, "profile_template_list")).receipt.templates;
  assert(list.some(({ id }) => id === "vitest"));
  const details = checked(await tool(client, "profile_template_get", { id: "tier2-review" })).receipt.template;
  assert.equal(details.recommendedLaunch, "broker");
  const invalid = checked(await tool(client, "profile_create", { template: "executor", harness: "claude", repo: false }));
  assert.equal(invalid.error, "invalid_profile_template_inputs");
  assert.deepEqual(invalid.issues.map(({ field }) => field), ["slug", "repo", "authMode"]);
  const result = checked(await tool(client, "profile_create", { template: "test-command", slug: "workspace-test",
    repo: repository.slug, argv: ["pnpm", "test", "--run"] })).receipt;
  assert.equal(result.qualification, "unverified");
  assert.deepEqual(result.profile.argv, ["pnpm", "test", "--run"]);
  assert.deepEqual(result.config.profiles["workspace-test"], result.profile);
  assert.equal(requests, 0);
});

test("MCP returns the verified Worker profile input rejection and suppresses unsafe diagnostics", async t => {
  const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-mcp-worker-inputs-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const slug = "reviewer";
  const profile = { kind: "agent", harness: "codex", operation: "review", authMode: "subscription",
    defaults: { repo: repository.slug, effort: "high" }, allowedOverrides: { effort: ["medium", "high"] } };
  const file = join(scratch, "profiles.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 1, profiles: { [slug]: profile } }));
  const input = { source: { sha: repository.sha }, prompt, producerAgent: "claude", overrides: { effort: "high" } };
  const diagnostic = validateProfileInputs(profile, { ...input, overrides: { effort: "max" } });
  let issues = diagnostic;
  let submissions = 0;
  const url = await gateway(t, async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v4/runs");
    assert.deepEqual(await requestBody(request), { kind: "profile", profile: { slug, body: profile }, operationId: id, ...input });
    submissions++;
    json(response, 400, { error: "invalid_profile_inputs", message: "Untrusted Worker response.", profile: "another-profile", issues });
  });
  const client = await connect(t, url, false, token, { SANDBOX_RUNNER_PROFILES: file, XDG_STATE_HOME: scratch });
  const args = { slug, operationId: id, ...input };
  const verified = await tool(client, "start_profile", args);
  assert.equal(verified.isError, true);
  assert.deepEqual(checked(verified), { schemaVersion: 1, exitCode: 2, error: "invalid_profile_inputs",
    message: profileInputErrorMessage, operationId: id, httpStatus: 400, profile: slug, issues: diagnostic });
  for (const message of [token, "Unexpected\u001b[31m format."]) {
    issues = [{ ...diagnostic[0], message }];
    const rejected = await tool(client, "start_profile", args);
    assert.equal(rejected.isError, true);
    const result = checked(rejected);
    assert.equal(result.error, "invalid_response");
    assert.equal(result.uncertain, true);
    assert.equal(result.operationId, id);
    assert.equal(result.issues, undefined);
    assert(!JSON.stringify(rejected).includes(JSON.stringify(message).slice(1, -1)));
  }
  assert.equal(submissions, 3);
});

test("MCP starts and replays a Codex reviewer profile with pinned API-key authentication", async t => {
  const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-mcp-codex-reviewer-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const file = join(scratch, "profiles.json");
  const profile = { kind: "agent", harness: "codex", operation: "review", sandboxProvider: "cloudflare", authMode: "api-key",
    defaults: { repo: repository.slug, model: "gpt-6.1-sol", effort: "xhigh" },
    allowedOverrides: { model: ["gpt-6.1-sol", "gpt-6-astra"] }, mcp: { connectors: ["github"] } };
  await writeFile(file, JSON.stringify({ schemaVersion: 1, profiles: { reviewer: profile } }));
  const posts = [];
  const url = await gateway(t, async (request, response) => {
    assert.equal(request.url, "/v4/runs");
    const body = await requestBody(request);
    posts.push(body);
    json(response, 202, queued({ ...body, agent: "codex" }, { repository, authMode: "api-key",
      model: "gpt-6-astra", effort: "xhigh", review: { producerAgent: "claude" },
      connectorAccess: { mode: "read-only", connectors: ["github"] }, profile: await profileReceipt(body) }));
  });
  const client = await connect(t, url, false, token, { SANDBOX_RUNNER_PROFILES: file, XDG_STATE_HOME: scratch });
  const args = { slug: "reviewer", operationId: id, source: { sha: repository.sha }, prompt,
    producerAgent: "claude", overrides: { model: "gpt-6-astra" } };
  const conflict = await tool(client, "start_profile", { ...args, authMode: "subscription" });
  assert.equal(conflict.isError, true);
  assert.match(JSON.stringify(conflict), /override_not_allowed/);
  assert.equal(posts.length, 0);
  const started = checked(await tool(client, "start_profile", args));
  assert.equal(started.exitCode, 0);
  assert.equal(started.receipt.authMode, "api-key");
  assert.equal(started.receipt.model, "gpt-6-astra");
  assert.equal(started.receipt.effort, "xhigh");
  assert.deepEqual(started.receipt.connectorAccess, { mode: "read-only", connectors: ["github"] });
  assert.deepEqual(posts[0], { kind: "profile", operationId: id, profile: { slug: "reviewer", body: profile },
    source: args.source, prompt, producerAgent: args.producerAgent, overrides: args.overrides });
  await writeFile(file, JSON.stringify({ schemaVersion: 1, profiles: { reviewer: { ...profile, authMode: "subscription" } } }));
  assert.deepEqual(checked(await tool(client, "retry_profile", { operationId: id })), started);
  assert.deepEqual(posts[1], posts[0]);
});

for (const legacy of [false, true]) {
  test(`MCP reports connector recovery and runtime issues with the ${legacy ? "legacy" : "modern"} client`, async t => {
    const connector = "acme-staging";
    const connectorIssue = { code: "mcp_connector_reauth_required", connector, mode: "read-write" };
    const issues = [{ ...connectorIssue, code: "mcp_connector_write_unconfirmed" }];
    const observed = issues.map(issue => ({ ...issue, recovery: { action: "verify_write" } }));
    let submissions = 0;
    const url = await gateway(t, async (request, response) => {
      if (request.method === "POST") {
        const body = await requestBody(request);
        submissions++;
        assert.equal(body.operationId, id);
        return json(response, 503, {
          error: connectorIssue.code, connectorIssue: { ...connectorIssue, upstream: token },
          operationId: id, admission: "rejected", reconnectScope: "acme.read", workerVersionId: id,
        });
      }
      if (request.url.endsWith("/events")) {
        return json(response, 200, { id, ...kind, agent: "claude", nextCursor: 1,
          events: [{ cursor: 1, type: "state", status: "running", connectorIssue: issues[0] }] });
      }
      assert.ok(request.url.endsWith("/result"));
      return json(response, 200, { id, ...kind, agent: "claude", status: "failed", cleanup: "destroyed",
        connectorAccess: { mode: "read-write", connectors: [connector] }, connectorIssues: issues });
    });
    const client = await connect(t, url, legacy);
    const rejected = await tool(client, "start", { agent: "claude", operationId: id, prompt, connectors: [connector] });
    assert.equal(rejected.isError, true);
    assert.deepEqual(checked(rejected), {
      schemaVersion: 1, exitCode: 3, error: connectorIssue.code, operationId: id, httpStatus: 503,
      admission: "rejected", connectorIssue, recovery: { action: "connector_login", retry: "same_operation_id" },
      message: "Reconnect the connector in your browser.",
    });
    assert.equal(submissions, 1);
    const result = await tool(client, "result", { id });
    assert.equal(Boolean(result.isError), false);
    assert.equal(checked(result).exitCode, 1);
    assert.deepEqual(checked(result).receipt.connectorIssues, observed);
    const events = checked(await tool(client, "events", { id }));
    assert.deepEqual(events.receipt.events, [{ cursor: 1, type: "connector_issue", connectorIssue: observed[0] }]);
  });

  test(`stdio negotiates with the ${legacy ? "legacy" : "modern"} official client and exposes only typed tools`, async t => {
    const seen = [];
    const url = await gateway(t, async (request, response) => {
      const body = await requestBody(request);
      seen.push([request.method, request.url, body]);
      json(response, 202, queued(body));
    });
    const client = await connect(t, url, legacy);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(({ name }) => name.slice("sandbox_runner_".length)).sort(),
      ["cancel", "capabilities", "events", "list", "profile_check", "profile_create", "profile_get", "profile_list",
        "profile_template_get", "profile_template_list", "result", "retry_profile", "review", "start", "start_profile", "status", "test", "vitest_start", "wait"]);
    const profilePayloadTools = new Set(["sandbox_runner_profile_create", "sandbox_runner_start_profile"]);
    assert(tools.every(entry => (profilePayloadTools.has(entry.name) || entry.inputSchema.additionalProperties === false) &&
      entry.inputSchema.type === "object" && entry.outputSchema.type === "object"));
    const advertised = JSON.stringify(tools);
    assert(!advertised.includes(token));
    for (const { inputSchema } of tools) {
      for (const field of ["token", "headers", "url", "command", "environment"]) assert(!Object.hasOwn(inputSchema.properties, field));
    }
    assert.deepEqual(checked(await tool(client, "capabilities")), {
      schemaVersion: 1, agents: ["claude", "codex", "opencode"], sandboxProvider: "cloudflare",
      openCode: { authMode: "api-key", modelProviders: ["openai", "anthropic"] }, testSuites: ["vitest", "command"],
    });
    const invalid = await tool(client, "start", { agent: "claude", prompt, token: "not-operator-authority" });
    assert.equal(invalid.isError, true);
    assert(!JSON.stringify(invalid).includes(token));
    assert.equal(checked(await tool(client, "start", { agent: "claude", prompt, publish: true })).error, "usage_error");
    assert.equal(seen.length, 0);
    const started = checked(await tool(client, "start", { agent: "claude", prompt }));
    assert.match(started.receipt.id, /^[a-f0-9-]{36}$/u);
    assert.deepEqual(seen, [["POST", "/v4/runs", { operationId: started.receipt.id, ...kind, agent: "claude", prompt }]]);
  });

  test(`OpenCode keeps its API-key provider and v4-only routing on the ${legacy ? "legacy" : "modern"} client`, async t => {
    const posts = [];
    let unsupported = false;
    let wrongSha = false;
    const url = await gateway(t, async (request, response) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v4/runs");
      const body = await requestBody(request);
      posts.push(body);
      if (unsupported) return json(response, 400, { error: "invalid_request" });
      const model = body.model ?? (body.modelProvider === "openai" ? "gpt-4.1-mini" : "claude-sonnet-5-5");
      json(response, 202, queued(body, { modelProvider: body.modelProvider, model, authMode: body.authMode, effort: body.effort,
        ...(body.reviewProducer ? { review: { producerAgent: body.reviewProducer },
          connectorAccess: { mode: "read-only", connectors: body.connectors } } : {}),
        ...(body.repository ? { repository: wrongSha ? { ...body.repository, sha: "b".repeat(40) } : body.repository } : {}) }));
    });
    const client = await connect(t, url, legacy);
    const start = { agent: "opencode", prompt, operationId: id };
    for (const fields of [{}, { modelProvider: "openai", authMode: "subscription" },
      { modelProvider: "anthropic", repository, publish: true }, { modelProvider: "openai", effort: "high" },
      { agent: "claude", modelProvider: "openai" }, { modelProvider: "anthropic", repository: { slug: repository.slug } },
      { modelProvider: "openai", repository: { ...repository, slug: "https://github.com/Owner/Repo" } }]) {
      assert.equal((await tool(client, "start", { ...start, ...fields })).isError, true);
    }
    assert.equal((await tool(client, "review", { agent: "opencode", producerAgent: "claude", repository, criteria: prompt })).isError, true);
    assert.equal((await tool(client, "review", { agent: "claude", producerAgent: "opencode", repository, criteria: prompt })).isError, true);
    assert.deepEqual(posts, []);
    const openai = checked(await tool(client, "start", { ...start, modelProvider: "openai" }));
    assert.equal(openai.receipt.modelProvider, "openai");
    assert.equal(openai.receipt.authMode, "api-key");
    assert.deepEqual(posts[0], { ...kind, operationId: id, agent: "opencode", modelProvider: "openai", authMode: "api-key", prompt });
    const privateStart = { ...start, operationId: undefined, modelProvider: "anthropic", authMode: "api-key", effort: "high",
      repository: { ...repository, sha: repository.sha.toUpperCase() } };
    const anthropic = checked(await tool(client, "start", privateStart));
    assert.equal(anthropic.receipt.modelProvider, "anthropic");
    assert.equal(anthropic.receipt.effort, "high");
    assert.deepEqual(anthropic.receipt.repository, repository);
    assert.deepEqual(posts[1], { ...kind, operationId: anthropic.receipt.id, agent: "opencode",
      modelProvider: "anthropic", authMode: "api-key", effort: "high", prompt, repository });
    const replay = { ...privateStart, operationId: anthropic.receipt.id };
    assert.deepEqual(checked(await tool(client, "start", replay)), anthropic);
    wrongSha = true;
    const mismatch = await tool(client, "start", replay);
    assert.equal(mismatch.isError, true);
    assert.equal(checked(mismatch).error, "invalid_response");
    unsupported = true;
    const rejected = await tool(client, "start", replay);
    assert.equal(rejected.isError, true);
    assert.equal(checked(rejected).error, "invalid_request");
    assert.equal(posts.length, 5);
    for (const post of posts.slice(2)) assert.deepEqual(post, posts[1]);
    wrongSha = false;
    unsupported = false;
    const reviewInputs = { agent: "opencode", producerAgent: "claude", repository, criteria: prompt,
      modelProvider: "openai", model: "gpt-6.1-sol", effort: "xhigh", connectors: ["github"] };
    const reviewed = checked(await tool(client, "review", reviewInputs));
    assert.equal(reviewed.receipt.effort, "xhigh");
    assert.deepEqual(reviewed.receipt.connectorAccess, { mode: "read-only", connectors: ["github"] });
    assert.equal(posts.at(-1).reviewProducer, "claude");
    assert.equal(posts.at(-1).authMode, "api-key");
    assert.equal((await tool(client, "review", { ...reviewInputs, authMode: "subscription" })).isError, true);
  });

  test(`withholds reflected control credentials from both formats on the ${legacy ? "legacy" : "modern"} client`, async t => {
    const url = await gateway(t, async (request, response) => {
      if (request.method === "POST") {
        const body = await requestBody(request);
        return json(response, 202, queued(body, { output: request.headers.authorization }));
      }
      json(response, 200, { id, ...kind, agent: "codex", repository, status: "succeeded", cleanup: "destroyed",
        review: { producerAgent: "claude", verdict: "FAIL", findings: [`A reflected value is ${token}.`] } });
    });
    const client = await connect(t, url, legacy);
    const submission = await tool(client, "start", { agent: "claude", prompt, operationId: id });
    assert.equal(submission.isError, true);
    assert.deepEqual(checked(submission), { schemaVersion: 1, exitCode: 6, error: "invalid_response",
      message: "The Worker returned an invalid MCP response.", operationId: id, uncertain: true });
    const result = await tool(client, "result", { id });
    assert.equal(result.isError, true);
    assert.equal(checked(result).error, "invalid_response");
    assert.equal(checked(result).uncertain, undefined);

    const badIdUrl = await gateway(t, (_request, response) => json(response, 404, { error: "run_not_found" }), id);
    const badIdClient = await connect(t, badIdUrl, legacy, id);
    const failure = await tool(badIdClient, "result", { id });
    assert.equal(failure.isError, true);
    assert.equal(checked(failure, id).error, "invalid_response");
    assert.equal(checked(failure, id).operationId, undefined);
  });
}

test("Claude starts and Codex reviews request managed connectors by name through stdio", async t => {
  const posts = [];
  const url = await gateway(t, async (request, response) => {
    assert.equal(request.url, "/v4/runs");
    const body = await requestBody(request);
    posts.push(body);
    const review = body.reviewProducer ? { producerAgent: body.reviewProducer } : undefined;
    json(response, 202, queued(body, { repository: body.repository, ...(review ? { review } : {}),
      authMode: body.authMode, model: body.model, effort: body.effort,
      connectorAccess: { mode: review ? "read-only" : "read-write", connectors: body.connectors } }));
  });
  const client = await connect(t, url);
  const connectors = ["github", "acme-staging"];
  const ordered = ["acme-staging", "github"];
  const start = { agent: "claude", prompt, operationId: id, connectors };
  const review = { agent: "codex", producerAgent: "claude", criteria: prompt, repository, connectors,
    authMode: "api-key", model: "gpt-6.1-sol", effort: "xhigh" };
  for (const invalid of [{ ...start, connectors: ["https://untrusted.example/mcp"] },
    { ...start, agent: "opencode", modelProvider: "openai" }, { ...start, connectorAccess: { mode: "read-write" } }]) {
    assert.equal((await tool(client, "start", invalid)).isError, true);
  }
  assert.equal((await tool(client, "review", { ...review, connectorAccess: { mode: "read-write" } })).isError, true);
  assert.deepEqual(posts, []);
  const started = checked(await tool(client, "start", start));
  assert.deepEqual(started.receipt.connectorAccess, { mode: "read-write", connectors: ordered });
  assert.deepEqual(posts[0], { ...kind, operationId: id, agent: "claude", prompt, connectors: ordered });
  const reviewed = checked(await tool(client, "review", review));
  assert.deepEqual(reviewed.receipt.connectorAccess, { mode: "read-only", connectors: ordered });
  assert.equal(reviewed.receipt.model, review.model);
  assert.equal(reviewed.receipt.effort, review.effort);
  assert.deepEqual(posts[1], { ...kind, operationId: reviewed.receipt.id, agent: "codex", prompt, repository,
    reviewProducer: "claude", connectors: ordered, authMode: "api-key", model: review.model, effort: review.effort });
});

test("start replay, review, and both test submissions reuse the CLI wire contract", async t => {
  const seen = [];
  const url = await gateway(t, async (request, response) => {
    assert.equal(request.url, "/v4/runs");
    const body = await requestBody(request);
    seen.push(body);
    if (seen.length === 1) return response.destroy();
    if (body.kind === "test") return json(response, 202, {
      id: body.operationId, kind: "test", suite: body.suite, sandboxProvider: "cloudflare", repository,
      status: "queued", phase: "queued", cleanup: "pending",
    });
    json(response, 202, queued(body, { repository, ...(body.publish ? { publication: { status: "pending" } } : {}),
      ...(body.reviewProducer ? { review: { producerAgent: body.reviewProducer } } : {}) }));
  });
  const client = await connect(t, url);
  const submit = { agent: "claude", prompt, repository, publish: true, operationId: id };
  const lost = await tool(client, "start", submit);
  assert.equal(lost.isError, true);
  assert.equal(checked(lost).uncertain, true);
  assert.equal(checked(lost).operationId, id);
  assert.equal(seen.length, 1);
  assert.equal(checked(await tool(client, "start", submit)).receipt.id, id);
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(seen[1].publish, true);
  const reviewed = checked(await tool(client, "review", { agent: "codex", producerAgent: "claude", criteria: prompt, repository }));
  assert.equal(reviewed.receipt.review.producerAgent, "claude");
  assert.equal(seen[2].prompt, prompt);
  assert.deepEqual(seen[2].repository, repository);
  assert.equal(seen[2].publish, undefined);
  assert.equal(checked(await tool(client, "vitest_start", { repository })).receipt.suite, "vitest");
  const argv = ["node", "--", "$(touch never-run-locally)"];
  assert.equal(checked(await tool(client, "test", { repository, argv })).receipt.suite, "command");
  assert.deepEqual(seen[4].argv, argv);
});

test("wait abort closes the read, then explicit cancel and the original cursors remain usable", async t => {
  const began = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const calls = [];
  const base = { id, ...kind, agent: "claude", cleanup: "pending", status: "running" };
  const terminal = { ...base, status: "cancelled", reason: "run_cancelled", cleanup: "destroyed" };
  let blocking = true;
  const url = await gateway(t, (request, response) => {
    const { method, url } = request;
    calls.push([method, url]);
    if (url === `/v1/runs/${id}/result` && blocking) {
      response.once("close", disconnected.resolve);
      began.resolve();
      return;
    }
    if (url === `/v4/runs/${id}/cancel`) return json(response, 202, { ...terminal, cleanup: "pending" });
    if (url === `/v1/runs/${id}/result`) return json(response, 200, terminal);
    if (url === `/v1/runs/${id}`) return json(response, 200, base);
    if (url === "/v4/runs?cursor=11&limit=1") return json(response, 200, { runs: [base], nextCursor: "10" });
    if (url === `/v4/runs/${id}/events?after=2`) return json(response, 200, {
      id, ...kind, agent: "claude", nextCursor: 3, events: [{ cursor: 3, type: "state", status: "cancelled" }],
    });
    throw new Error("Unexpected fixture route");
  });
  const client = await connect(t, url);
  const abort = new AbortController();
  const waiting = assert.rejects(tool(client, "wait", { id }, { signal: abort.signal }));
  await began.promise;
  abort.abort();
  await waiting;
  await disconnected.promise;
  assert.deepEqual(calls, [["GET", `/v1/runs/${id}/result`]]);
  assert.equal(checked(await tool(client, "status", { id })).receipt.status, "running");
  assert.equal(checked(await tool(client, "list", { cursor: "11", limit: 1 })).receipt.nextCursor, "10");
  assert.equal(checked(await tool(client, "events", { id, after: 2 })).receipt.nextCursor, 3);
  assert.equal(checked(await tool(client, "wait", { id, timeoutMs: 25 })).error, "wait_timeout");
  blocking = false;
  assert.equal(checked(await tool(client, "cancel", { id })).receipt.status, "cancelled");
  const result = await tool(client, "result", { id });
  assert.equal(result.isError, false);
  assert.equal(checked(result).receipt.cleanup, "destroyed");
  assert.equal(checked(result).exitCode, 1);
  assert.equal(calls.filter(([method]) => method === "POST").length, 1);
});

test("startup failures preserve stdio framing and a redirect never transfers the Bearer", async t => {
  const invalid = spawnSync(process.execPath, [bin, "mcp"], {
    env: { SANDBOX_RUNNER_URL: "https://invalid.example/private", SANDBOX_RUNNER_TOKEN: token }, encoding: "utf8",
  });
  assert.equal(invalid.status, 3);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /^Could not start Sandbox Runner MCP/u);
  assert(!invalid.stderr.includes(token));
  const forbidden = await gateway(t, () => assert.fail("redirect destination reached"));
  const source = await gateway(t, (_request, response) => {
    response.writeHead(307, { location: forbidden });
    response.end();
  });
  const client = await connect(t, source);
  const result = await tool(client, "start", { agent: "claude", operationId: id, prompt });
  assert.equal(result.isError, true);
  assert.equal(checked(result).httpStatus, 307);
});
