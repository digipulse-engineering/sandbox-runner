import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpConnectorUrl, parseMcpRegistry } from "../mcp-policy.ts";
import { paddleSandboxBinding, paddleSandboxMcpUrl } from "../mcp-paddle.ts";
import { posthogBinding, posthogTool } from "../mcp-posthog.ts";
import { restrictedApiFetcher } from "../mcp-restricted-api.ts";
import { forwardMcp } from "../mcp-relay.ts";
import { mcpSession } from "../mcp-session.ts";

const name = "staging-metrics";
const token = "phx_fixture_token";
const pins = { event: "onboarding_completed", testRunProperty: "sandbox_run_id" };
const args = { ...pins, testRunId: "2ec5f699-49b8-4c58-a143-730a970a932b", minutes: 15 };
const policy = { url: "https://eu.posthog.com/api/projects/123/query/", readAuth: posthogBinding, writeAuth: posthogBinding,
  read: [{ tool: posthogTool, match: pins, arguments: ["testRunId", "minutes"] }], write: [] };
const registry = source => parseMcpRegistry(JSON.stringify({ [name]: source }));

function connect(upstream, { connector = registry(policy)[name], accessToken = token, mode = "read-only" } = {}) {
  const issues = [];
  let state;
  const get = async () => structuredClone(state);
  const session = mcpSession({ get, transaction: callback => callback({ get, put: async (_key, value) => { state = value; },
    delete: async () => { const previous = state !== undefined; state = undefined; return previous; } }) }, name, async () => true);
  const rpc = (method, params) => forwardMcp(new Request(mcpConnectorUrl(name), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), { connector, mode, session, authorize: async () => true, claimWrite: async () => assert.fail("read-only"),
    diagnose: async issue => issues.push(issue.code), maxBytes: 16_384,
    credentials: async () => ({ status: "ready", token: accessToken }), fetcher: restrictedApiFetcher(connector, upstream) });
  return { rpc, issues, call: (argumentsForTool = args, tool = posthogTool) => rpc("tools/call", { name: tool, arguments: argumentsForTool }) };
}

test("binds the PostHog credential to the approved read-only API shape", () => {
  assert(registry(policy));
  for (const url of ["https://mcp.posthog.com/mcp", "https://eu.posthog.com/api/projects/123/query/?team=456",
    "https://eu.posthog.com/api/projects/123/events/", "https://eu.posthog.com:8080/api/projects/123/query/",
    "https://eu.posthog.com.evil.invalid/api/projects/123/query/"]) assert.equal(registry({ ...policy, url }), undefined);
  assert.equal(registry({ ...policy, write: [{ tool: "query", match: {}, arguments: [] }] }), undefined);
  assert.equal(registry({ ...policy, read: [{ tool: posthogTool, match: pins, arguments: ["minutes", "query"] }] }), undefined);
  assert.equal(registry({ ...policy, writeAuth: paddleSandboxBinding }), undefined);
});

test("relays stateless PostHog discovery, forces a fresh aggregate, and exposes only the count", async () => {
  let count = 0;
  const { rpc, call } = connect(async (url, init) => {
    assert.equal(url, policy.url);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${token}`);
    const body = JSON.parse(init.body);
    assert.equal(body.refresh, "force_blocking");
    assert.match(body.query.query, /SELECT count\(\) FROM events .*INTERVAL 15 MINUTE.*properties\.sandbox_run_id = '2ec5f699/);
    return Response.json({ results: [[count++]], fullBackendPayload: token });
  });
  const initialized = await rpc("initialize", { protocolVersion: "2025-11-25" });
  assert.equal(initialized.headers.get("mcp-session-id"), null);
  const tools = (await (await rpc("tools/list", {})).json()).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), [posthogTool]);
  assert.deepEqual(tools[0].inputSchema.properties.event.enum, [pins.event]);
  for (const count of [0, 1]) {
    const reply = await (await call()).json();
    assert.deepEqual(reply.result.structuredContent, { event: args.event, testRunId: args.testRunId, minutes: args.minutes, count });
    assert.equal(JSON.stringify(reply).includes(token), false);
  }
});

test("denies project selection, generic query, mutation, and malformed filters before provider I/O", async () => {
  for (const mode of ["read-only", "read-write"]) {
    const { call, issues } = connect(() => assert.fail("unexpected PostHog request"), { mode });
    for (const [candidate, tool] of [[{ ...args, projectId: 987 }], [{ ...args, event: "different_event" }],
      [args, "query-run"], [args, "feature-flag-update"]]) {
      assert.equal((await (await call(candidate, tool)).json()).error.message, "mcp_tool_access_denied");
    }
    assert(issues.every(issue => issue === "mcp_tool_access_denied"));
    assert.equal((await (await call({ ...args, minutes: 5 })).json()).result.isError, true);
    assert.equal((await (await call({ ...args, testRunId: "x' OR 1=1" })).json()).result.isError, true);
  }
});

test("sanitizes malformed results, errors, redirect, rate limits, and network failures", async () => {
  for (const [response, expected, issue] of [
    [Response.json({ results: [["secret"]] }), 502, "mcp_connector_unavailable"],
    [new Response("provider secret", { status: 302, headers: { location: "https://unknown.invalid" } }), 502, "mcp_connector_unavailable"],
    [new Response("provider secret", { status: 429, headers: { "retry-after": "5" } }), 429, "mcp_connector_rate_limited"],
    [new Response("provider secret", { status: 401 }), 503, "mcp_connector_auth_rejected"],
    [undefined, 502, "mcp_connector_unavailable"],
  ]) {
    const { call, issues } = connect(async () => { if (!response) throw new Error("provider secret"); return response; });
    const reply = await call();
    assert.equal(reply.status, expected);
    assert.deepEqual(issues, [issue]);
    assert.equal((await reply.text()).includes("provider secret"), false);
  }
});

test("serves only a configured Paddle sandbox read through the same gateway", async () => {
  const id = "pri_01234567890123456789012345";
  const productId = "pro_01234567890123456789012345";
  const connector = registry({ url: paddleSandboxMcpUrl, readAuth: paddleSandboxBinding, writeAuth: paddleSandboxBinding,
    read: [{ tool: "paddle_get_price", match: { id }, arguments: [] }], write: [] })[name];
  const { call } = connect(async (url, init) => {
    assert.equal(String(url), paddleSandboxMcpUrl + "prices/" + id);
    assert.equal(init.method, "GET");
    return Response.json({ data: { id, type: "standard", product_id: productId, name: "Fixture", status: "active", billing_cycle: null,
      unit_price: { amount: "1000", currency_code: "EUR" }, private: "provider payload" } });
  }, { connector, accessToken: "pdl_sdbx_apikey_fixture" });
  const reply = await (await call({ id }, "paddle_get_price")).json();
  assert.equal(reply.result.structuredContent.productId, productId);
  assert.equal(JSON.stringify(reply).includes("provider payload"), false);
  assert.equal((await (await call({ id: productId }, "paddle_get_product")).json()).error.message, "mcp_tool_access_denied");
});
