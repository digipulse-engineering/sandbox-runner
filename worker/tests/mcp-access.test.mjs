import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { accessMcpConfigured, mcpResourceMetadataPath, serveAccessMcp, settledRun } from "../mcp-access.ts";
import { parseTeamCatalog } from "../team-catalog.mjs";
import { teamClientByEmail } from "../team-access.ts";

const origin = "https://runner.example.workers.dev";
const aud = "a".repeat(64);
const env = { SANDBOX_RUNNER_ACCESS_AUD: aud, SANDBOX_RUNNER_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com" };
const runId = "ab4fd2c9-91a2-4ed2-9ed3-68dfbb82c8b1";
const revision = "c".repeat(64);
const profile = { kind: "agent", harness: "claude", operation: "start", authMode: "subscription", defaults: { repo: "Owner/Repo" } };
const grant = { client: { id: "member", profiles: ["executor"] }, catalog: { profiles: { executor: profile } } };

function accessContext(email = "member@example.com", audience = aud) {
  return { waitUntil() {}, passThroughOnException() {}, access: { aud: audience, getIdentity: async () => ({ email }) } };
}

// Requests reach the Worker with a Host header, as workerd delivers them.
function request(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(origin).host);
  return new Request(origin + path, { ...init, headers });
}

function fakeApi() {
  const calls = [];
  const routes = {
    "GET /v4/profiles": () => ({ clientId: "member", profiles: [{ slug: "executor", revision, profile }] }),
    "GET /v4/profiles/executor": () => ({ clientId: "member", slug: "executor", revision, profile }),
    "POST /v4/runs": body => ({ id: body.operationId, status: "queued", cleanup: "pending" }),
    [`GET /v1/runs/${runId}`]: () => ({ id: runId, status: "running", cleanup: "pending" }),
  };
  const api = async (call, team) => {
    const url = new URL(call.url);
    const body = call.method === "POST" ? await call.json() : undefined;
    calls.push({ method: call.method, path: url.pathname + url.search, team: team.client.id, body });
    const route = routes[`${call.method} ${url.pathname}`];
    return route ? Response.json(route(body), { status: call.method === "POST" ? 202 : 200 }) : Response.json({ error: "not_found" }, { status: 404 });
  };
  return { api, calls };
}

const member = async email => email === "member@example.com" ? grant : null;

test("the endpoint stays absent until both Access settings are present and valid", async () => {
  assert.equal(accessMcpConfigured(env), true);
  for (const broken of [{}, { ...env, SANDBOX_RUNNER_ACCESS_AUD: "short" },
    { ...env, SANDBOX_RUNNER_ACCESS_TEAM_DOMAIN: "https://evil.example" }, { SANDBOX_RUNNER_ACCESS_AUD: aud }]) {
    assert.equal(accessMcpConfigured(broken), false);
    for (const path of ["/mcp", mcpResourceMetadataPath]) {
      assert.equal(await serveAccessMcp(request(path, { method: "POST" }), broken, accessContext(), member, fakeApi().api), undefined);
    }
  }
  assert.equal(await serveAccessMcp(request("/v4/runs"), env, accessContext(), member, fakeApi().api), undefined, "other paths fall through");
});

test("resource metadata points clients at the Access team domain", async () => {
  const response = await serveAccessMcp(request(mcpResourceMetadataPath), env, {}, member, fakeApi().api);
  assert.deepEqual(await response.json(), { resource: origin + "/mcp", authorization_servers: [env.SANDBOX_RUNNER_ACCESS_TEAM_DOMAIN] });
});

test("only an Access identity for this application and a catalog member reaches the tools", async () => {
  const { api, calls } = fakeApi();
  const post = ctx => serveAccessMcp(request("/mcp", { method: "POST", headers: { "content-type": "application/json",
    accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env, ctx, member, api);
  assert.equal((await post({})).status, 404, "no ctx.access: Access is not in front, fail closed");
  assert.equal((await post(accessContext("member@example.com", "b".repeat(64)))).status, 404, "another Access application");
  assert.equal((await post(accessContext("stranger@example.com"))).status, 403, "authenticated but not a member");
  const unreadable = { ...accessContext(), access: { aud, getIdentity: async () => { throw new Error("down"); } } };
  assert.equal((await post(unreadable)).status, 503);
  const noEmail = { ...accessContext(), access: { aud, getIdentity: async () => ({}) } };
  assert.equal((await post(noEmail)).status, 403, "service tokens carry no email");
  const foreignOrigin = await serveAccessMcp(request("/mcp", { method: "POST", headers: { origin: "https://evil.example",
    "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env, accessContext(), member, api);
  assert.equal(foreignOrigin.status, 403, "a browser page on another site");
  assert.equal(calls.length, 0, "nothing reached the runner API");
});

test("tools call the runner API as the member's team client", async t => {
  const { api, calls } = fakeApi();
  const client = new Client({ name: "chatgpt-shaped", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
    fetch: (url, init) => serveAccessMcp(request(new URL(url).pathname, init), env, accessContext(), member, api),
  }));
  t.after(() => client.close());

  const { tools } = await client.listTools();
  assert.equal(tools.length, 9);
  const listed = (await client.callTool({ name: "sandbox_runner_profile_list", arguments: {} })).structuredContent;
  assert.deepEqual(listed.receipt.profiles[0].inputContract.required, ["source", "prompt"]);

  const started = (await client.callTool({ name: "sandbox_runner_start_profile",
    arguments: { slug: "executor", operationId: runId, revision, source: { sha: "a".repeat(40) }, prompt: "Fix it" } })).structuredContent;
  assert.equal(started.revision, revision);
  assert.equal(started.receipt.status, "queued");
  assert.deepEqual(calls.find(call => call.method === "POST").body, { source: { sha: "a".repeat(40) }, prompt: "Fix it",
    operationId: runId, kind: "team-profile", profile: "executor", revision });

  assert.equal((await client.callTool({ name: "sandbox_runner_status", arguments: { id: runId } })).structuredContent.receipt.status, "running");
  const missing = await client.callTool({ name: "sandbox_runner_result", arguments: { id: runId } });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.httpStatus, 404);
  assert(calls.every(call => call.team === "member"));

  const unpinned = await client.callTool({ name: "sandbox_runner_start_profile",
    arguments: { slug: "executor", operationId: runId, source: { sha: "a".repeat(40) }, prompt: "Fix it" } });
  assert.equal(unpinned.isError, true, "a start must pin the revision it inspected");
});

test("a failing runner call is reported as uncertain without internal details", async t => {
  const client = new Client({ name: "chatgpt-shaped", version: "1.0.0" });
  const api = async () => { throw new Error("internal secret detail"); };
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
    fetch: (url, init) => serveAccessMcp(request(new URL(url).pathname, init), env, accessContext(), member, api),
  }));
  t.after(() => client.close());
  const result = await client.callTool({ name: "sandbox_runner_start_profile",
    arguments: { slug: "executor", operationId: runId, revision, source: { sha: "a".repeat(40) }, prompt: "x" } });
  assert(!JSON.stringify(result).includes("internal secret detail"));
  assert.deepEqual(result.structuredContent, { operationId: runId, revision, uncertain: true, error: "runner_unavailable",
    httpStatus: 503, schemaVersion: 1 });
});

test("the catalog maps one lowercase Access email to at most one client", () => {
  const digest = n => String(n).repeat(64);
  const catalog = clients => parseTeamCatalog(JSON.stringify({ schemaVersion: 1, profiles: { executor: profile }, clients }));
  const parsed = catalog({ member: { tokenSha256: digest(1), profiles: ["executor"], accessEmail: "member@example.com" },
    kim: { tokenSha256: digest(3), profiles: [], accessEmail: "kim@example.com" },
    ci: { tokenSha256: digest(2), profiles: [] } });
  assert.equal(parsed.clients.find(client => client.id === "member").accessEmail, "member@example.com");
  assert.equal(teamClientByEmail(parsed, "Member@Example.com").id, "member");
  assert.equal(teamClientByEmail(parsed, "ci@example.com"), undefined);
  assert.equal(teamClientByEmail(parsed, "Kim@example.com").id, "kim");
  assert.equal(teamClientByEmail(parsed, "\u212Aim@example.com"), undefined, "no Unicode case folding onto ASCII");
  assert.equal(catalog({ a: { tokenSha256: digest(1), profiles: [], accessEmail: "Member@example.com" } }), undefined, "uppercase");
  assert.equal(catalog({ a: { tokenSha256: digest(1), profiles: [], accessEmail: "not-an-email" } }), undefined);
  assert.equal(catalog({ a: { tokenSha256: digest(1), profiles: [], accessEmail: "x@example.com" },
    b: { tokenSha256: digest(2), profiles: [], accessEmail: "x@example.com" } }), undefined, "duplicate");
  assert.equal(catalog({ a: { tokenSha256: digest(1), profiles: [], role: "owner" } }), undefined, "unknown field");
});

test("a run is settled only when it is terminal and its cleanup and publication are decided", () => {
  assert.equal(settledRun({ status: "running", cleanup: "pending" }), false);
  assert.equal(settledRun({ status: "succeeded", cleanup: "pending", publication: { status: "no_changes" } }), false, "cleanup pending");
  assert.equal(settledRun({ status: "succeeded", cleanup: "destroyed", publication: { status: "pending" } }), false, "publication pending");
  assert.equal(settledRun({ status: "succeeded", cleanup: "destroyed", publication: { status: "no_changes" } }), true);
  assert.equal(settledRun({ status: "failed", cleanup: "failed" }), true, "a failed cleanup is decided");
  assert.equal(settledRun({ status: "succeeded", cleanup: "destroyed" }), true, "no publication requested");
});

test("status reports settlement and an early result is a transient state", async t => {
  const states = [
    { status: "succeeded", cleanup: "pending", publication: { status: "pending" } },
    { status: "succeeded", cleanup: "destroyed", publication: { status: "no_changes" } },
  ];
  const api = async call => {
    const path = new URL(call.url).pathname;
    if (path === `/v1/runs/${runId}`) return Response.json({ id: runId, ...states[0] });
    if (path === `/v1/runs/${runId}/result`) {
      return states[0].cleanup === "pending" ? Response.json({ error: "run_in_progress" }, { status: 409 })
        : Response.json({ id: runId, ...states[0] });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const client = new Client({ name: "chatgpt-shaped", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
    fetch: (url, init) => serveAccessMcp(request(new URL(url).pathname, init), env, accessContext(), member, api),
  }));
  t.after(() => client.close());

  const early = (await client.callTool({ name: "sandbox_runner_status", arguments: { id: runId } })).structuredContent;
  assert.equal(early.settled, false);
  assert.equal(early.receipt.status, "succeeded");
  const tooSoon = await client.callTool({ name: "sandbox_runner_result", arguments: { id: runId } });
  assert.equal(tooSoon.isError, true);
  assert.equal(tooSoon.structuredContent.error, "run_in_progress");
  assert.equal(tooSoon.structuredContent.httpStatus, 409);
  assert.equal(tooSoon.structuredContent.transient, true);
  assert.equal(tooSoon.structuredContent.next, "poll_status");

  states.shift();
  assert.equal((await client.callTool({ name: "sandbox_runner_status", arguments: { id: runId } })).structuredContent.settled, true);
  const final = await client.callTool({ name: "sandbox_runner_result", arguments: { id: runId } });
  assert.equal(final.isError, false);
  assert.equal(final.structuredContent.receipt.publication.status, "no_changes");
});
