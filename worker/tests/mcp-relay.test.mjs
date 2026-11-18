import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpConnectorCodes as issueCode } from "../mcp-diagnostic.mjs";
import { mcpTokenFingerprint } from "../mcp-oauth.ts";
import {
  mcpConnectorName, mcpConnectorUrl, mcpToolAccess, narrowMcpConnector, parseMcpRegistry,
} from "../mcp-policy.ts";
import { forwardMcp } from "../mcp-relay.ts";
import { mcpSession } from "../mcp-session.ts";

const name = "acme-memory-staging";
const readRef = "SANDBOX_RUNNER_MCP_CREDENTIAL_ACME_REVIEW";
const writeRef = "SANDBOX_RUNNER_MCP_CREDENTIAL_ACME_EXECUTE";
const readToken = "acme:synthetic-read-credential.Zt3";
const writeToken = "acme:synthetic-write-credential.K7m";
const workspace = "918d22ac-719f-431e-8fe0-b59fc69147fd";
const upstreamSession = "synthetic-upstream-session.Rb32";
const source = {
  url: "https://fixture.invalid/memory",
  readAuth: readRef, writeAuth: writeRef,
  read: [
    { tool: "acme_memory", match: { action: "retrieve", scope: [workspace], category: "canary" }, arguments: ["limit"] },
    { tool: "acme_memory", match: { action: "list_categories", scope: [workspace] }, arguments: [] },
  ],
  write: [{
    tool: "acme_memory", match: { action: "store", scope: [workspace], category: "canary", min_accreditation_level: 1 },
    arguments: ["content", "topic"],
  }],
};
const registry = value => parseMcpRegistry(JSON.stringify({ [name]: value }));
const connector = registry(source)[name];

test("profile runs intersect the admitted and current connector policies", () => {
  const oldRead = connector.read[0];
  const restricted = { ...oldRead, match: { ...oldRead.match, limit: 5 }, arguments: ["newArgument"] };
  const current = registry({ ...source, read: [restricted], write: [] })[name];
  const policy = narrowMcpConnector(connector, current, "read-write");
  assert.deepEqual(policy.read, [{ ...restricted, arguments: [] }]);
  assert.deepEqual(policy.write, []);
  assert.equal(mcpToolAccess(policy, "read-write", oldRead.tool, restricted.match), "read");
  assert.equal(mcpToolAccess(policy, "read-write", oldRead.tool, oldRead.match), undefined);
  assert.equal(mcpToolAccess(policy, "read-write", oldRead.tool, { ...restricted.match, newArgument: true }), undefined);
  assert.equal(narrowMcpConnector(connector, undefined, "read-only"), undefined);
  assert.equal(narrowMcpConnector(connector, { ...current, url: "https://different.invalid/mcp" }, "read-only"), undefined);
  assert.equal(narrowMcpConnector(connector, { ...current, readAuth: writeRef }, "read-only"), undefined);
  assert.equal(narrowMcpConnector(connector, { ...current, read: [], write: [restricted] }, "read-write"), undefined);
});

const toolCall = (id, action, rest = {}) => ({
  jsonrpc: "2.0", id, method: "tools/call",
  params: { name: "acme_memory", arguments: { action, scope: [workspace], category: "canary", ...rest } },
});
const stored = { min_accreditation_level: 1, content: "fixture", topic: "canary" };
const success = (id, result) => Response.json({ jsonrpc: "2.0", id, result });
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25",
  clientInfo: { name: "untrusted", version: "1" }, capabilities: { sampling: {}, roots: {} } } };
const handshake = { protocolVersion: "2025-11-25", serverInfo: { name: "fixture", version: "1" },
  capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} } };
const request = (body, options = {}) => new Request(mcpConnectorUrl(name), {
  method: options.method ?? "POST",
  headers: { "content-type": "application/json", ...options.headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

function fixture(mode, fetcher, options = {}) {
  const selectedConnector = options.connector ?? connector;
  const token = options.token ?? (mode === "read-only" ? readToken : writeToken);
  let state = options.initialSession;
  let credentials = 0;
  let received = 0;
  const claims = new Set();
  const issues = [];
  let pendingTransaction = Promise.resolve();
  const get = async () => structuredClone(state);
  const session = mcpSession({
    get,
    transaction(callback) {
      const next = pendingTransaction.then(() => callback({
        get,
        async put(_key, value) { state = structuredClone(value); },
        async delete() {
          const existed = state !== undefined;
          state = undefined;
          return existed;
        },
      }));
      pendingTransaction = next.catch(() => undefined);
      return next;
    },
  }, name, options.sessionAllowed ?? (async () => true));
  return {
    counts: () => ({ credentials, received, claims: claims.size }),
    issues,
    state: () => state,
    session,
    handle: req => forwardMcp(req, {
      connector: selectedConnector, mode, authorize: options.authorize ?? (async () => true),
      maxBytes: options.maxBytes ?? 4_096,
      claimWrite: async id => {
        if (claims.has(id)) return false;
        claims.add(id);
        return true;
      },
      settleWrite: options.settleWrite,
      diagnose: async issue => { issues.push(issue); },
      credentials: async (ref, selected, access, rejectedFingerprint) => {
        credentials++;
        assert.equal(selected, selectedConnector);
        assert.equal(access, mode);
        assert.equal(ref, mode === "read-only" ? selectedConnector.readAuth : selectedConnector.writeAuth);
        return options.credentials ? options.credentials(rejectedFingerprint) : { status: "ready", token };
      },
      session: options.wrapSession ? options.wrapSession(session) : session,
      githubCi: options.githubCi,
      fetcher: async (url, init) => {
        received++;
        if (options.githubCi && new URL(url).origin === "https://api.github.com") return options.githubCi.fetcher(url, init);
        assert.equal(url, selectedConnector.url);
        assert.equal(init.redirect, "manual");
        assert.equal(init.cache, "no-store");
        if (!options.credentials) assert.equal(new Headers(init.headers).get("authorization"), "Bearer " + token);
        assert.equal(new Headers(init.headers).has("x-ignored-private"), false);
        assert.equal(new Headers(init.headers).has("cookie"), false);
        return fetcher(init.body ? JSON.parse(init.body) : undefined, init);
      },
    }),
  };
}

test("GitHub CI is read-only, uses the verified run SHA, and returns only status metadata", async () => {
  const repository = { owner: "fixture", name: "private", repositoryId: 4100 };
  const match = { owner: repository.owner, repo: repository.name };
  const tool = "get_commit_ci";
  const rule = { tool, match, arguments: ["page"] };
  const config = { url: "https://api.githubcopilot.com/mcp/", readAuth: "github-app", writeAuth: "github-app", read: [rule], write: [] };
  assert.equal(registry({ ...config, read: [], write: [rule] }), undefined);
  assert.equal(registry({ ...config, read: [{ ...rule, arguments: ["sha"] }] }), undefined);
  const sha = "abc0123456789abc0123456789abc0123456789a";
  const token = "ghs_fixture-ci-token";
  const urls = [];
  let tokenMints = 0;
  const githubCi = { repository, sha,
    getToken: async () => {
      tokenMints++;
      return { repository, token, expiresAt: Date.now() + 60_000 };
    },
    fetcher: async (url, init) => {
      urls.push(url);
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "manual");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer " + token);
      const entry = { id: 75, head_sha: sha, name: "integration", status: "completed", conclusion: "success",
        repository: { full_name: "fixture/private" }, output: { text: "private log lines" }, html_url: "https://attacker.invalid/" };
      if (url.includes("/actions/runs")) return Response.json({ total_count: 1, workflow_runs: [entry] });
      return Response.json({ total_count: 1, check_runs: [entry] }, { headers: { "content-type": "application/vnd.github+json" } });
    },
  };
  const gateway = fixture("read-write", ({ id }) => success(id, { tools: [
    { name: tool, description: "spoofed", inputSchema: { type: "object" } },
  ] }), { connector: registry(config)[name], githubCi });
  const discovery = await gateway.handle(request({ jsonrpc: "2.0", id: 7, method: "tools/list" }));
  const { tools } = (await discovery.json()).result;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, tool);
  assert.match(tools[0].description, /exact checked-out commit/);
  assert.deepEqual(tools[0].inputSchema.properties.repo.enum, ["private"]);
  const call = args => request({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: tool, arguments: args } });
  for (const args of [{ ...match, sha }, { ...match, repo: "other" }, { ...match, page: 0 }]) {
    const denied = await gateway.handle(call(args));
    assert.ok((await denied.json()).error);
  }
  assert.equal(tokenMints, 0);
  assert.equal(urls.length, 0);
  const response = await gateway.handle(call({ ...match, page: 2 }));
  const result = (await response.json()).result.structuredContent;
  assert.equal(tokenMints, 1);
  assert.equal(gateway.counts().claims, 0);
  assert.deepEqual(urls, [`https://api.github.com/repos/fixture/private/actions/runs?head_sha=${sha}&page=2`,
    `https://api.github.com/repos/fixture/private/commits/${sha}/check-runs?filter=latest&page=2`]);
  assert.equal(result.sha, sha);
  assert.deepEqual(result.actions.entries[0], { id: 75, name: "integration", status: "completed", conclusion: "success",
    url: "https://github.com/fixture/private/actions/runs/75" });
  assert.deepEqual(result.checks.entries[0], { ...result.actions.entries[0], url: "https://github.com/fixture/private/runs/75" });

  const mismatched = fixture("read-only", () => assert.fail("must not contact remote MCP for the built-in tool"), {
    connector: registry(config)[name], githubCi: { ...githubCi, fetcher: async url => url.includes("/actions/runs")
      ? Response.json({ total_count: 0, workflow_runs: [] })
      : Response.json({ total_count: 1, check_runs: [{ id: 1, head_sha: "b".repeat(40) }] }) },
  });
  assert.equal((await mismatched.handle(call(match))).status, 502);

  const external = fixture("read-only", ({ id }) => success(id, { content: [{ type: "text", text: "external tool" }] }), {
    connector: registry({ ...source, read: [rule] })[name],
  });
  assert.equal((await (await external.handle(call(match))).json()).result.content[0].text, "external tool");
});

test("pins exact operator destination and rejects overlapping or unbounded credential references", () => {
  assert.equal(parseMcpRegistry(undefined)[name], undefined);
  assert.equal(parseMcpRegistry("{"), undefined);
  assert.equal(registry({ ...source, readAuth: "OPENAI_API_KEY" }), undefined);
  assert.equal(registry({ ...source, writeAuth: "github-app" }), undefined);
  assert.equal(registry({ ...source, read: [{ tool: "acme_memory", match: {}, arguments: ["action"] }] }), undefined);
  for (const url of ["http://fixture.invalid/memory", "https://person:secret@fixture.invalid/memory",
    "https://fixture.invalid/memory?key=1", "https://fixture.invalid/memory#alt"]) {
    assert.equal(registry({ ...source, url }), undefined);
  }
  assert.equal(registry({ ...source, url: "https://api.githubcopilot.com/mcp/", writeAuth: "github-app" }), undefined);
  assert.equal(mcpConnectorName(request()), name);
  assert.equal(mcpConnectorName(request(undefined, { headers: { host: "other.invalid" } })), undefined);
  for (const suffix of ["?mode=write", "/extra"]) {
    assert.equal(mcpConnectorName(new Request(mcpConnectorUrl(name) + suffix)), undefined);
  }
});

test("binds GitHub App use to explicit owner and repo and strips untrusted tool annotations", async () => {
  const github = {
    url: "https://api.githubcopilot.com/mcp/", readAuth: "github-app", writeAuth: "github-app",
    read: [{ tool: "issue_read", match: { method: "get", owner: "fixture", repo: "private" }, arguments: ["issue_number"] }],
    write: [{ tool: "issue_write", match: { method: "update", owner: "fixture", repo: "private" },
      arguments: ["issue_number", "title"] }],
  };
  const selected = registry(github)[name];
  assert.equal(registry({ ...github, readAuth: readRef }), undefined);
  assert.equal(registry({ ...github, writeAuth: writeRef }), undefined);
  assert.equal(registry({ ...github, read: github.write, write: [] }), undefined);
  assert.equal(registry({ ...github, write: [{ ...github.write[0], match: { ...github.write[0].match, method: "delete" } }] }), undefined);
  assert.equal(registry({ ...github, read: [{ ...github.read[0], match: { owner: "fixture", repo: "*" } }] }), undefined);
  const discovery = {
    name: "issue_read", annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" },
      method: { enum: ["get", "list_comments"] }, issue_number: { type: "number" } } },
  };
  const gateway = fixture("read-only", ({ id, method, params }, init) => {
    assert.equal(new Headers(init.headers).get("x-mcp-readonly"), "true");
    if (method === "tools/list") return success(id, { tools: [discovery,
      { ...discovery, name: "issue_write", annotations: { readOnlyHint: true } }] });
    assert.equal(params.arguments.owner, "fixture");
    assert.equal(params.arguments.repo, "private");
    return success(id, { content: [{ text: "private issue" }] });
  }, { connector: selected, token: "ghs_synthetic-installation-token" });
  const call = (id, tool, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call",
    params: { name: tool, arguments: { method: "get", owner: "fixture", repo: "private", issue_number: 7, ...args } } });
  for (const input of [call(2, "issue_read", { owner: "attacker" }), call(3, "issue_read", { repo: "other" }),
    call(4, "issue_read", { method: "list_comments" }), call(5, "issue_write", { method: "update" })]) {
    assert.equal((await (await gateway.handle(request(input))).json()).error.message, "mcp_tool_access_denied");
  }
  assert.equal(gateway.counts().received, 0);
  const reply = await gateway.handle(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  const { tools } = (await reply.json()).result;
  assert.deepEqual(tools.map(tool => tool.name), ["issue_read"]);
  assert.equal(Object.hasOwn(tools[0], "annotations"), false);
  assert.deepEqual(tools[0].inputSchema.properties.method.enum, ["get"]);
  assert.equal((await gateway.handle(request(call(6, "issue_read")))).status, 200);
});

test("read-write includes the same reads and both modes enforce workspace and exact actions", () => {
  const read = toolCall(2, "retrieve").params.arguments;
  const write = toolCall(3, "store", stored).params.arguments;
  for (const mode of ["read-only", "read-write"]) {
    assert.equal(mcpToolAccess(connector, mode, "acme_memory", read), "read");
    assert.equal(mcpToolAccess(connector, mode, "acme_memory", { ...read, scope: [workspace, "foreign"] }), undefined);
    assert.equal(mcpToolAccess(connector, mode, "acme_memory", { ...read, workspace_id: "foreign" }), undefined);
    assert.equal(mcpToolAccess(connector, mode, "acme_memory", { ...write, action: "set_accreditation" }), undefined);
    assert.equal(mcpToolAccess(connector, mode, "acme_memory", { ...write, min_accreditation_level: 0 }), undefined);
  }
  assert.equal(mcpToolAccess(connector, "read-only", "acme_memory", write), undefined);
  assert.equal(mcpToolAccess(connector, "read-write", "acme_memory", write), "write");
  // Discovery can expose write fields alongside the read action. The relay
  // still authorizes the exact combination allowed for the selected action.
  assert.equal(mcpToolAccess(connector, "read-write", "acme_memory", { ...read, content: "foreign to the read" }), undefined);
  assert.equal(mcpToolAccess(connector, "read-write", "acme_memory", { ...write, scope: ["foreign"] }), undefined);
});

test("filters tools and multiplexed actions while preserving read discovery and upstream pagination", async () => {
  const original = { name: "acme_memory", inputSchema: { type: "object", required: ["action"],
    properties: { action: { enum: ["retrieve", "list_categories", "store", "admin"] },
      scope: { type: "array" }, category: { type: "string" }, content: { type: "string" } } } };
  for (const mode of ["read-only", "read-write"]) {
    const gateway = fixture(mode, async ({ id, method, params }) => {
      assert.equal(method, "tools/list");
      assert.deepEqual(params, { cursor: "page-two" });
      return success(id, { tools: [original, { ...original, name: "acme_admin" }], nextCursor: "page-three" });
    });
    const reply = await gateway.handle(request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "page-two" } }));
    const { tools, nextCursor } = (await reply.json()).result;
    assert.deepEqual(tools.map(tool => tool.name), ["acme_memory"]);
    const schema = tools[0].inputSchema;
    assert.equal(schema.type, "object");
    assert.equal(Object.hasOwn(schema, "anyOf"), false);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["action", "scope"]);
    assert.deepEqual(schema.properties.action.enum,
      mode === "read-only" ? ["retrieve", "list_categories"] : ["retrieve", "list_categories", "store"]);
    assert.deepEqual(schema.properties.scope, { type: "array", items: { type: "string", enum: [workspace] },
      description: `Use exactly this JSON value: ${JSON.stringify([workspace])}.` });
    assert.equal(Object.hasOwn(schema.properties, "content"), mode === "read-write");
    assert.equal(nextCursor, "page-three");
  }
});

test("advertises scalar enums for array pins and keeps their exact argument enforcement", async () => {
  const original = { name: "acme_memory", inputSchema: { type: "object", required: ["action"], properties: {
    action: { type: "string", enum: ["list_categories", "retrieve", "store"] },
    catalog_scope: { type: "string", enum: ["ws"], default: "ws" },
    scope: { type: "array", items: { type: "string" }, description: "Target workspace(s)." },
    category: { type: "string" }, tags: { type: "array", items: { type: "string" } }, limit: { type: "number" },
  } } };
  const pin = { action: "list_categories", scope: [workspace] };
  const readOnly = registry({ ...source, read: [{ tool: original.name, match: pin, arguments: ["catalog_scope"] }], write: [] })[name];
  const gateway = fixture("read-only", async ({ id }) => success(id, { tools: [original] }), { connector: readOnly });
  const reply = await gateway.handle(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  const { inputSchema } = (await reply.json()).result.tools[0];
  assert.deepEqual(inputSchema.properties.scope, { type: "array", items: { type: "string", enum: [workspace] },
    description: `Target workspace(s). Use exactly this JSON value: ${JSON.stringify(pin.scope)}.` });
  assert.deepEqual(inputSchema.required, ["action", "scope"]);
  assert.equal(mcpToolAccess(readOnly, "read-only", original.name, pin), "read");
  for (const scope of [[], [workspace, workspace], ["other"]]) {
    assert.equal(mcpToolAccess(readOnly, "read-only", original.name, { ...pin, scope }), undefined);
  }
});

test("describes ordered composite choices without widening the enforced connector policy", async () => {
  const original = { name: "generic_read", inputSchema: { type: "object", properties: {
    scope: { type: "array", items: { type: "string" } }, selector: { type: "object" },
  } } };
  const choices = [
    { scope: ["first", "second"], selector: { group: "one" } },
    { scope: ["third"], selector: { group: "two" } },
  ];
  const selected = registry({ ...source, read: choices.map(match => ({ tool: original.name, match, arguments: [] })), write: [] })[name];
  const gateway = fixture("read-only", async ({ id }) => success(id, { tools: [original] }), { connector: selected });
  const reply = await gateway.handle(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  const { properties, required } = (await reply.json()).result.tools[0].inputSchema;
  assert.deepEqual(required, ["scope", "selector"]);
  assert.deepEqual(properties.scope, { type: "array", items: { type: "string" },
    description: 'Use exactly one of these JSON values: ["first","second"], ["third"].' });
  assert.deepEqual(properties.selector, { type: "object",
    description: 'Use exactly one of these JSON values: {"group":"one"}, {"group":"two"}.' });
  assert.equal(mcpToolAccess(selected, "read-only", original.name, choices[0]), "read");
  assert.equal(mcpToolAccess(selected, "read-only", original.name, choices[1]), "read");
  assert.equal(mcpToolAccess(selected, "read-only", original.name, { ...choices[0], scope: ["second", "first"] }), undefined);
  assert.equal(mcpToolAccess(selected, "read-only", original.name, { ...choices[0], scope: choices[1].scope }), undefined);
});

test("denies reviewer mutation, wrong scope and alternate RPC methods before touching credentials", async () => {
  const gateway = fixture("read-only", () => assert.fail("Denied call reached the upstream"));
  for (const input of [
    toolCall(1, "store", stored),
    toolCall(2, "retrieve", { scope: ["foreign"] }),
    { ...toolCall(3, "retrieve"), method: "resources/read" },
  ]) {
    const response = await gateway.handle(request(input));
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.id, input.id);
    assert.ok(reply.error);
  }
  const batch = await gateway.handle(request([toolCall(4, "retrieve"), toolCall(5, "store", stored)]));
  assert.equal(batch.status, 400);
  assert.equal((await gateway.handle(request(undefined, { method: "GET" }))).status, 405);
  assert.deepEqual(gateway.counts(), { credentials: 0, received: 0, claims: 0 });
});

test("rebuilds credentials, reads in both roles and claims a write once even after ambiguous I/O", async () => {
  const review = fixture("read-only", ({ id, params }, init) => {
    assert.equal(params.arguments.action, "retrieve");
    assert.equal(new Headers(init.headers).has("mcp-name"), false);
    return success(id, { content: [{ type: "text", text: "read" }] });
  });
  const read = await review.handle(request(toolCall(2, "retrieve"), { headers: {
    authorization: "Bearer attacker", cookie: "attacker", "mcp-name": "acme_admin",
  } }));
  assert.equal((await read.json()).result.content[0].text, "read");
  const executor = fixture("read-write", ({ id, params }) => {
    if (params.arguments.action === "store") throw new Error("network after possible remote write");
    return success(id, { content: [{ type: "text", text: "read" }] });
  });
  assert.equal((await executor.handle(request(toolCall(2, "retrieve")))).status, 200);
  const write = toolCall(3, "store", stored);
  assert.equal((await executor.handle(request(write))).status, 502);
  const repeated = await executor.handle(request(write));
  assert.equal((await repeated.json()).error.message, "mcp_write_already_claimed");
  assert.equal(executor.counts().received, 2);
  assert.equal(executor.counts().claims, 1);
});

test("rejects an ambiguous combined Authorization credential before forwarding", async () => {
  const gateway = fixture("read-only", () => assert.fail("Malformed credential reached upstream"), {
    token: "acme:synthetic,Bearer other",
  });
  const response = await gateway.handle(request(toolCall(2, "retrieve")));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "mcp_connector_auth_required");
  assert.equal(gateway.counts().received, 0);
});

test("maps stateful initialization to a run-local ID and rejects forged and cross-connector IDs", async () => {
  const upstream = (message, init) => {
    const headers = new Headers(init.headers);
    if (message?.method === "initialize") {
      assert.equal(headers.has("mcp-session-id"), false);
      assert.deepEqual(message.params.capabilities, {});
      return Response.json({ jsonrpc: "2.0", id: 1, result: handshake },
        { headers: { "mcp-session-id": upstreamSession, "set-cookie": "ignored" } });
    }
    assert.equal(headers.get("mcp-session-id"), upstreamSession);
    assert.equal(headers.get("mcp-protocol-version"), "2025-11-25");
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    return success(message.id, { content: [{ type: "text", text: "run isolated" }] });
  };
  const first = fixture("read-only", upstream);
  const another = fixture("read-only", upstream);
  const response = await first.handle(request(initialize));
  const local = response.headers.get("mcp-session-id");
  assert.ok(local && local !== upstreamSession);
  assert.equal(response.headers.has("set-cookie"), false);
  assert.deepEqual((await response.json()).result.capabilities, { tools: {} });
  assert.equal(first.state().upstreamId, upstreamSession);
  for (const id of [upstreamSession, "other-local-id"]) {
    assert.equal((await first.handle(request(toolCall(2, "retrieve"), { headers: { "mcp-session-id": id } }))).status, 404);
  }
  const headers = { "mcp-session-id": local, "mcp-protocol-version": "2025-11-25" };
  assert.equal((await another.handle(request(toolCall(2, "retrieve"), { headers }))).status, 404);
  assert.equal((await first.handle(request({ jsonrpc: "2.0", method: "notifications/initialized" }, { headers }))).status, 202);
  assert.equal((await first.handle(request(toolCall(2, "retrieve"), { headers }))).status, 200);
  assert.equal((await first.handle(request(undefined, { headers, method: "DELETE" }))).status, 204);
  assert.equal(first.state(), undefined);
});

test("recovers after losing the acknowledgement of a durable initialization reservation", async () => {
  let dropAcknowledgement = true;
  const gateway = fixture("read-write", ({ id }) => success(id, handshake), {
    initialSession: { id: "legacy-pending" },
    wrapSession: session => ({
      ...session,
      async claim(id, replaces) {
        const claimed = await session.claim(id, replaces);
        if (claimed && dropAcknowledgement) {
          dropAcknowledgement = false;
          throw new Error("lost reservation acknowledgement");
        }
        return claimed;
      },
    }),
  });
  assert.equal((await gateway.handle(request(initialize))).status, 502);
  assert.notEqual(gateway.state().id, "legacy-pending");
  assert.equal(gateway.state().upstreamId, undefined);
  assert.equal((await gateway.handle(request(toolCall(2, "store", stored)))).status, 404);
  assert.deepEqual(gateway.counts(), { credentials: 0, received: 0, claims: 0 });

  const recovered = await gateway.handle(request({ ...initialize, id: 3 }));
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers.get("mcp-session-id"), null);
  assert.equal((await recovered.json()).id, 3);
  assert.equal(gateway.state(), undefined);
  assert.deepEqual(gateway.counts(), { credentials: 1, received: 1, claims: 0 });
});

test("only one concurrent initialize can replace the same pending reservation", async () => {
  const gateway = fixture("read-only", () => assert.fail("No request should reach the upstream"), {
    initialSession: { id: "interrupted" },
  });
  const results = await Promise.all(["first", "second"].map(id => gateway.session.claim(id, "interrupted")));
  assert.deepEqual(results, [true, false]);
  assert.equal(gateway.state().id, "first");
  assert.equal(await gateway.session.release("interrupted"), false);
  assert.equal(gateway.state().id, "first");
});

for (const oldUpstream of [undefined, upstreamSession]) {
  test("fences a late " + (oldUpstream ? "stateful" : "stateless") + " initialize response", async () => {
    const enteredUpstream = Promise.withResolvers();
    const oldResponse = Promise.withResolvers();
    const gateway = fixture("read-only", ({ id, method }) => {
      assert.equal(method, "initialize");
      if (id === initialize.id) {
        enteredUpstream.resolve();
        return oldResponse.promise;
      }
      return Response.json({ jsonrpc: "2.0", id, result: handshake },
        { headers: { "mcp-session-id": "new-upstream" } });
    });
    const oldRequest = gateway.handle(request(initialize));
    await enteredUpstream.promise;
    const newResponse = await gateway.handle(request({ ...initialize, id: 2 }));
    const newSession = newResponse.headers.get("mcp-session-id");
    assert.equal(newResponse.status, 200);
    oldResponse.resolve(Response.json({ jsonrpc: "2.0", id: initialize.id, result: handshake },
      oldUpstream ? { headers: { "mcp-session-id": oldUpstream } } : undefined));
    const late = await oldRequest;
    assert.equal(late.status, 502);
    assert.equal((await late.json()).error, "mcp_invalid_session");
    assert.equal(gateway.state().id, newSession);
    assert.equal(gateway.state().upstreamId, "new-upstream");
    assert.equal(gateway.counts().claims, 0);
  });
}

test("replays a lost committed initialize response until the client acknowledges its public session", async () => {
  let runOpen = true;
  const negotiated = { ...handshake, protocolVersion: "2025-03-26", instructions: "public instructions",
    ignored: "unprojected handshake field" };
  const gateway = fixture("read-write", ({ id, method }, init) => {
    if (method === "initialize") return Response.json({ jsonrpc: "2.0", id, result: negotiated },
      { headers: { "mcp-session-id": upstreamSession, "set-cookie": "discarded" } });
    assert.equal(new Headers(init.headers).get("mcp-session-id"), upstreamSession);
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    throw new Error("transport failed after a possible write");
  }, { authorize: async () => runOpen });
  const initial = await gateway.handle(request(initialize));
  const localId = initial.headers.get("mcp-session-id");
  assert.ok(localId && localId !== upstreamSession);
  await initial.body.cancel(); // The client lost the first successful response.
  const retry = { ...initialize, id: 77 };
  assert.equal((await gateway.handle(request({ ...retry, params: { ...retry.params, protocolVersion: "2025-03-26" } }))).status, 409);
  assert.equal((await gateway.handle(request(retry, { headers: { "mcp-session-id": localId } }))).status, 409);
  const reply = await gateway.handle(request(retry));
  assert.equal(reply.headers.get("mcp-session-id"), localId);
  assert.equal(reply.headers.has("set-cookie"), false);
  assert.deepEqual(await reply.json(), {
    jsonrpc: "2.0", id: 77, result: { protocolVersion: "2025-03-26", instructions: "public instructions",
      serverInfo: handshake.serverInfo, capabilities: { tools: {} } },
  });
  assert.deepEqual(gateway.counts(), { credentials: 1, received: 1, claims: 0 });

  const validHeaders = { "mcp-session-id": localId, "mcp-protocol-version": "2025-03-26" };
  const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
  assert.equal((await gateway.handle(request(notification, { headers: { ...validHeaders, "mcp-protocol-version": "2025-11-25" } }))).status, 400);
  assert.ok(gateway.state().reply);
  runOpen = false;
  assert.equal((await gateway.handle(request(retry))).status, 403);
  assert.equal(gateway.counts().credentials, 1);
  runOpen = true;

  assert.equal((await gateway.handle(request(notification, { headers: validHeaders }))).status, 202);
  assert.equal(gateway.state().reply, undefined);
  assert.equal((await gateway.handle(request(retry))).status, 409);
  const write = toolCall(8, "store", stored);
  assert.equal((await gateway.handle(request(write, { headers: validHeaders }))).status, 502);
  const repeated = await gateway.handle(request(write, { headers: validHeaders }));
  assert.equal((await repeated.json()).error.message, "mcp_write_already_claimed");
  assert.deepEqual(gateway.counts(), { credentials: 4, received: 3, claims: 1 });
});

test("a valid follow-up can acknowledge a session before a racing replay reads its reply", async () => {
  const readingReplay = Promise.withResolvers();
  const releaseReplay = Promise.withResolvers();
  const gateway = fixture("read-only", ({ id, method }) => method === "initialize"
    ? Response.json({ jsonrpc: "2.0", id, result: handshake }, { headers: { "mcp-session-id": upstreamSession } })
    : new Response(null, { status: 202 }), {
    wrapSession: session => ({
      ...session,
      async replay(...args) {
        readingReplay.resolve();
        await releaseReplay.promise;
        return session.replay(...args);
      },
    }),
  });
  const original = await gateway.handle(request(initialize));
  const retry = gateway.handle(request({ ...initialize, id: 2 }));
  await readingReplay.promise;
  const headers = { "mcp-session-id": original.headers.get("mcp-session-id") };
  assert.equal((await gateway.handle(request({ jsonrpc: "2.0", method: "notifications/initialized" }, { headers }))).status, 202);
  releaseReplay.resolve();
  assert.equal((await retry).status, 409);
  assert.deepEqual(gateway.counts(), { credentials: 2, received: 2, claims: 0 });
});

test("a lost durable commit acknowledgement leaves the ready initialize reply recoverable", async () => {
  const gateway = fixture("read-only", ({ id }) =>
    Response.json({ jsonrpc: "2.0", id, result: handshake }, { headers: { "mcp-session-id": upstreamSession } }), {
    wrapSession: session => ({
      ...session,
      async commit(...args) {
        assert.equal(await session.commit(...args), true);
        throw new Error("lost commit acknowledgement");
      },
    }),
  });
  assert.equal((await gateway.handle(request(initialize))).status, 502);
  assert.equal(gateway.state().upstreamId, upstreamSession);
  const retry = await gateway.handle(request({ ...initialize, id: 2 }));
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get("mcp-session-id"), gateway.state().id);
  assert.equal((await retry.json()).id, 2);
  assert.deepEqual(gateway.counts(), { credentials: 1, received: 1, claims: 0 });
});

test("a strategy that closes during the replay RPC receives no cached reply", async () => {
  let authorized = true;
  const gateway = fixture("read-only", ({ id }) =>
    Response.json({ jsonrpc: "2.0", id, result: handshake }, { headers: { "mcp-session-id": upstreamSession } }), {
    authorize: async () => authorized,
    wrapSession: session => ({
      ...session,
      async replay(...args) {
        const reply = await session.replay(...args);
        assert.ok(reply);
        authorized = false;
        return reply;
      },
    }),
  });
  assert.equal((await gateway.handle(request(initialize))).status, 200);
  const result = await gateway.handle(request({ ...initialize, id: 2 }));
  assert.equal(result.status, 403);
  assert.equal(result.headers.get("mcp-session-id"), null);
  assert.deepEqual(gateway.counts(), { credentials: 1, received: 1, claims: 0 });
});

for (const [method, upstreamId] of [["commit", upstreamSession], ["release", undefined]]) {
  test("a strategy that closes during initialize " + method + " receives no session", async () => {
    let authorized = true;
    const gateway = fixture("read-only", ({ id }) =>
      Response.json({ jsonrpc: "2.0", id, result: handshake },
        upstreamId ? { headers: { "mcp-session-id": upstreamId } } : undefined), {
      authorize: async () => authorized,
      wrapSession: session => ({
        ...session,
        async [method](...args) {
          const complete = await session[method](...args);
          assert.equal(complete, true);
          authorized = false;
          return complete;
        },
      }),
    });
    const response = await gateway.handle(request(initialize));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("mcp-session-id"), null);
    assert.equal(gateway.state()?.upstreamId, upstreamId);
  });
}

test("preserves a legacy active session and its authorization without a replayable response", async () => {
  const legacy = { id: "legacy-active", upstreamId: upstreamSession, protocolVersion: "2025-11-25" };
  const gateway = fixture("read-only", ({ id }, init) => {
    assert.equal(new Headers(init.headers).get("mcp-session-id"), upstreamSession);
    return success(id, { content: [{ type: "text", text: "legacy session" }] });
  }, { initialSession: legacy });
  assert.equal((await gateway.handle(request(initialize))).status, 409);
  assert.equal((await gateway.handle(request(toolCall(2, "retrieve"), { headers: { "mcp-session-id": legacy.id } }))).status, 200);
  assert.deepEqual(gateway.state(), legacy);
  assert.deepEqual(gateway.counts(), { credentials: 1, received: 1, claims: 0 });
});

test("checks run authorization after credentials and expires an upstream session on 404", async () => {
  let checks = 0;
  const cancelled = fixture("read-only", () => assert.fail("Terminal run reached upstream"), {
    authorize: async () => ++checks === 1,
  });
  assert.equal((await cancelled.handle(request(toolCall(1, "retrieve")))).status, 403);
  assert.equal(cancelled.counts().received, 0);
  const expired = fixture("read-only", message => message.method === "initialize"
    ? Response.json({ jsonrpc: "2.0", id: 1, result: handshake }, { headers: { "mcp-session-id": upstreamSession } })
    : new Response("upstream auth details", { status: 404, headers: { "www-authenticate": "private" } }));
  const response = await expired.handle(request(initialize));
  const headers = { "mcp-session-id": response.headers.get("mcp-session-id") };
  const unavailable = await expired.handle(request(toolCall(2, "retrieve"), { headers }));
  assert.equal(unavailable.status, 404);
  assert.equal(unavailable.headers.has("www-authenticate"), false);
  assert.equal(expired.state(), undefined);
});

function sse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream", "set-cookie": "injected" } });
}

test("projects a correlated response from a split SSE stream and redacts reflected secrets", async () => {
  const allowed = fixture("read-only", () => sse([
    "id: event-1\r\ndata: \r\n\r\n", 'data: {"jsonrpc":"2.0","id":999,"result":{}}\n\n',
    'data: {"jsonrpc":"2.0","id":2,\r', '\ndata: "result":{"content":[{"text":"success"}]}}\r\n\r\n',
  ]));
  const result = await allowed.handle(request(toolCall(2, "retrieve")));
  assert.equal(result.status, 200);
  assert.equal(result.headers.has("set-cookie"), false);
  assert.equal((await result.json()).result.content[0].text, "success");

  for (const mode of ["read-only", "read-write"]) {
    const token = mode === "read-only" ? readToken : writeToken;
    const payload = { jsonrpc: "2.0", id: 2, result: { [token]: "reflected key", content: [{ text: "Bearer " + token }] } };
    for (const upstream of [() => Response.json(payload), () => sse(["data: " + JSON.stringify(payload) + "\n\n"])]) {
      const gateway = fixture(mode, upstream);
      const response = await gateway.handle(request(toolCall(2, "retrieve")));
      assert.equal(response.status, 502);
      assert.equal((await response.text()).includes(token), false);
    }
  }
});

test("rejects redirect, invalid correlation and oversized messages without forwarding upstream error material", async () => {
  for (const reply of [
    () => new Response(readToken, { status: 302, headers: { location: "https://foreign.invalid/" } }),
    () => success(99, { content: [{ type: "text", text: "wrong correlation" }] }),
    () => success(2, { content: [{ type: "text", text: "x".repeat(512) }] }),
  ]) {
    const gateway = fixture("read-only", reply, { maxBytes: 512 });
    const response = await gateway.handle(request(toolCall(2, "retrieve")));
    assert.equal(response.status, 502);
    assert.equal(response.headers.has("location"), false);
    assert.equal((await response.text()).includes(readToken), false);
  }
  const tooLarge = fixture("read-write", () => assert.fail("Oversize call reached upstream"), { maxBytes: 512 });
  const original = JSON.stringify(toolCall(2, "store", stored));
  const encoder = new TextEncoder();
  const req = new Request(mcpConnectorUrl(name), { method: "POST", duplex: "half",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(original));
      controller.enqueue(encoder.encode(" ".repeat(512)));
      controller.close();
    } }),
  });
  assert.equal((await tooLarge.handle(req)).status, 400);
  assert.equal(tooLarge.counts().credentials, 0);
});

test("recovers once from a Bearer invalid_token response for a safe read and checks both tokens for reflections", async () => {
  const fresh = "fixture:fresh:access-token";
  const fingerprint = await mcpTokenFingerprint(readToken);
  for (const reflectOld of [false, true]) {
    let received = 0;
    const gateway = fixture("read-only", ({ id }, init) => {
      const auth = new Headers(init.headers).get("authorization");
      received++;
      if (received === 1) {
        assert.equal(auth, "Bearer " + readToken);
        return new Response("secret challenge body", {
          status: 401, headers: { "www-authenticate": 'Basic realm="not an OAuth challenge", Bearer realm="one,two", error="invalid_token"' },
        });
      }
      assert.equal(auth, "Bearer " + fresh);
      return success(id, { content: [{ type: "text", text: reflectOld ? readToken : "read" }] });
    }, {
      credentials: rejected => {
        if (rejected !== undefined) assert.equal(rejected, fingerprint);
        return { status: "ready", token: rejected === undefined ? readToken : fresh };
      },
    });
    const response = await gateway.handle(request(toolCall(2, "retrieve")));
    assert.equal(response.status, reflectOld ? 502 : 200);
    assert.equal((await response.text()).includes(readToken), false);
    assert.equal(gateway.counts().credentials, 2);
    assert.equal(gateway.counts().received, 2);
    assert.equal(gateway.counts().claims, 0);
  }
});

test("does not rotate after a generic 401 or an invalid_token string in another auth field", async () => {
  for (const challenge of [
    'Basic realm="private", error="invalid_token"',
    'Bearer error_description="details, error=invalid_token, other detail"',
    'Bearer error="insufficient_scope"',
    'Bearer error="invalid_token", error="insufficient_scope"',
  ]) {
    const gateway = fixture("read-only", () => new Response(readToken, {
      status: 401, headers: { "www-authenticate": challenge },
    }));
    const response = await gateway.handle(request(toolCall(2, "retrieve")));
    assert.deepEqual(await response.json(), { error: issueCode.authRejected });
    assert.equal(response.headers.has("www-authenticate"), false);
    assert.deepEqual(gateway.issues, [{ code: issueCode.authRejected, connector: name, mode: "read-only" }]);
    assert.equal(gateway.counts().credentials, 1);
    assert.equal(gateway.counts().received, 1);
  }
});

test("propagates connector authentication, rate limit and tool failures without conflating them", async () => {
  const credential = fixture("read-only", () => assert.fail("unavailable grant cannot be forwarded"), {
    credentials: () => ({ status: "failed", code: issueCode.reauthRequired }),
  });
  assert.deepEqual(await (await credential.handle(request(toolCall(2, "retrieve")))).json(), { error: issueCode.reauthRequired });
  assert.deepEqual(credential.issues, [{ code: issueCode.reauthRequired, connector: name, mode: "read-only" }]);

  for (const [status, code] of [[403, issueCode.accessDenied], [429, issueCode.rateLimited], [503, issueCode.unavailable]]) {
    const gateway = fixture("read-only", () => new Response(readToken, {
      status, headers: { "retry-after": "5", "www-authenticate": 'Bearer error="insufficient_scope"' },
    }));
    const response = await gateway.handle(request(toolCall(2, "retrieve")));
    assert.deepEqual(await response.json(), { error: code });
    assert.equal(response.headers.get("retry-after"), status === 403 ? null : "5");
    assert.equal(response.headers.has("www-authenticate"), false);
    assert.deepEqual(gateway.issues, [{ code, connector: name, mode: "read-only", ...(status === 403 ? {} : { retryAfterSeconds: 5 }) }]);
  }

  const toolResult = { isError: true, content: [{ type: "text",
    text: JSON.stringify({ error: "Tool is unavailable", code: "TOOL_UNAVAILABLE", requested: "acme_memory" }),
  }] };
  const tool = fixture("read-only", ({ id }) => success(id, toolResult));
  const response = await tool.handle(request(toolCall(2, "retrieve")));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, toolResult);
  assert.deepEqual(tool.issues, [{ code: issueCode.toolUnavailable, connector: name, mode: "read-only" }]);
});

test("preserves authentication and permission signals while keeping a dispatched write pending", async () => {
  const fingerprint = await mcpTokenFingerprint(writeToken);
  for (const [status, credentialFailure, issue] of [
    [401, undefined, issueCode.authRejected],
    [401, issueCode.reauthRequired, issueCode.reauthRequired],
    [403, undefined, issueCode.accessDenied],
  ]) {
    const lookups = [];
    const settled = [];
    const gateway = fixture("read-write", () => new Response("rejection without proof of execution", {
      status, headers: { "www-authenticate": status === 401 ? 'Bearer error="invalid_token"' : 'Bearer error="insufficient_scope"' },
    }), {
      credentials: rejected => {
        lookups.push(rejected);
        if (rejected && credentialFailure) return { status: "failed", code: credentialFailure };
        return { status: "ready", token: rejected === undefined ? writeToken : "fixture:rotated:token" };
      },
      settleWrite: async id => { settled.push(id); return true; },
    });
    const response = await gateway.handle(request(toolCall(2, "store", stored)));
    assert.deepEqual(await response.json(), { error: issueCode.writeUnconfirmed });
    assert.deepEqual(lookups, status === 401 ? [undefined, fingerprint] : [undefined]);
    assert.deepEqual(settled, []);
    assert.deepEqual(gateway.issues, [issue, issueCode.writeUnconfirmed].map(code => ({ code, connector: name, mode: "read-write" })));
    assert.equal(gateway.counts().received, 1);
    assert.equal(gateway.counts().claims, 1);
  }
});

test("settles writes only for a confirmed success or a claim with no upstream dispatch", async () => {
  const settled = [];
  for (const result of [
    { content: [{ type: "text", text: "stored" }] },
    { content: [], isError: true },
    {},
  ]) {
    const gateway = fixture("read-write", ({ id }) => success(id, result), {
      settleWrite: async id => { settled.push(id); return true; },
    });
    const response = await gateway.handle(request(toolCall(2, "store", stored)));
    if (result.content?.length) assert.equal(response.status, 200);
    else assert.deepEqual(await response.json(), { error: issueCode.writeUnconfirmed });
  }
  assert.deepEqual(settled, [2]);
  let checks = 0;
  const noDispatch = fixture("read-write", () => assert.fail("authorization expired before dispatch"), {
    authorize: async () => ++checks < 3,
    settleWrite: async id => { settled.push(id); return true; },
  });
  const response = await noDispatch.handle(request(toolCall(3, "store", stored)));
  assert.equal(response.status, 403);
  assert.deepEqual(settled, [2, 3]);
});

test("Context7 is pinned to the public docs endpoint and never forwards credentials or mutations", async () => {
  const config = {
    url: "https://mcp.context7.com/mcp", readAuth: "context7-public", writeAuth: "context7-public",
    read: [
      { tool: "resolve-library-id", match: {}, arguments: ["libraryName", "query"] },
      { tool: "query-docs", match: {}, arguments: ["libraryId", "query", "language"] },
    ],
    write: [],
  };
  for (const invalid of [
    { ...config, url: "https://mcp.context7.com:8443/mcp" },
    { ...config, url: "https://elsewhere.invalid/mcp" },
    { ...config, url: "https://mcp.context7.com/mcp/oauth" },
    { ...config, writeAuth: writeRef },
    { ...config, read: [{ tool: "admin", match: {}, arguments: [] }] },
    { ...config, read: [{ tool: "query-docs", match: {}, arguments: ["token"] }] },
    { ...config, write: [{ tool: "refresh-library", match: {}, arguments: [] }] },
  ]) assert.equal(registry(invalid), undefined);
  const forwardedIds = new Set();
  const gateway = fixture("read-write", (body, init) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.has("authorization"), false);
    assert.match(body.id, /^[a-f0-9-]{36}$/);
    assert.equal(forwardedIds.has(body.id), false);
    forwardedIds.add(body.id);
    if (body.method === "initialize") {
      assert.equal(body.params.protocolVersion, "2025-03-26");
      assert.equal(headers.has("mcp-protocol-version"), false);
      return success(body.id, { ...handshake, protocolVersion: "2025-03-26" });
    }
    assert.equal(headers.get("mcp-protocol-version"), "2025-03-26");
    assert.equal(headers.has("mcp-method"), false);
    assert.equal(Object.hasOwn(body.params, "_meta"), false);
    if (body.method === "tools/list") return success(body.id, { tools: [
      { name: "query-docs", inputSchema: { type: "object", properties: { libraryId: {}, query: {}, credential: {} } } },
      { name: "unexpected", inputSchema: { type: "object", properties: {} } },
    ] });
    assert.equal(body.params.name, "query-docs");
    return success(body.id, { content: [{ type: "text", text: "Public documentation" }] });
  }, {
    connector: registry(config)[name],
    credentials: () => assert.fail("Public documentation must never resolve an OAuth or GitHub credential"),
  });
  const headers = { authorization: "Bearer injected", cookie: "injected=1", "mcp-protocol-version": "2026-07-28" };
  const initial = await gateway.handle(request(initialize, { headers }));
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("mcp-session-id"), null);
  const initialReply = await initial.json();
  assert.equal(initialReply.id, initialize.id);
  assert.equal(initialReply.result.protocolVersion, "2025-03-26");
  const list = await gateway.handle(request({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { headers }));
  const listReply = await list.json();
  assert.equal(listReply.id, 2);
  const [tool] = listReply.result.tools;
  assert.equal(tool.name, "query-docs");
  assert(!Object.hasOwn(tool.inputSchema.properties, "credential"));
  const call = (name, args) => request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }, { headers });
  const good = await gateway.handle(call("query-docs", { libraryId: "/vitest-dev/vitest", query: "How does toBe compare values?" }));
  const goodReply = await good.json();
  assert.equal(goodReply.id, 3);
  assert.equal(goodReply.result.content[0].text, "Public documentation");
  for (const denied of [call("refresh-library", {}), call("query-docs", { credential: "injected" })]) {
    assert((await (await gateway.handle(denied)).json()).error);
  }
  assert.deepEqual(gateway.counts(), { credentials: 0, received: 3, claims: 0 });
});

const context7Args = { libraryId: "/websites/sqlite_docs", query: "How does BEGIN IMMEDIATE acquire a SQLite write transaction?" };
const context7Ref = "SANDBOX_RUNNER_MCP_CREDENTIAL_CONTEXT7";
const context7OAuth = registry({
  url: "https://mcp.context7.com/mcp/oauth", readAuth: context7Ref, writeAuth: context7Ref,
  read: [{ tool: "query-docs", match: context7Args, arguments: [] }], write: [],
})[name];

test("Context7 authenticates a pinned session with relay-generated metadata in both access modes", async () => {
  for (const mode of ["read-only", "read-write"]) {
    const forwardedIds = new Set();
    let localSession;
    const gateway = fixture(mode, (body, init) => {
      const headers = new Headers(init.headers);
      if (body?.id !== undefined) {
        assert.match(body.id, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
        assert.equal(forwardedIds.has(body.id), false);
        forwardedIds.add(body.id);
      }
      if (body?.method === "initialize") {
        assert.equal(headers.has("mcp-session-id"), false);
        assert.equal(headers.has("mcp-protocol-version"), false);
        assert.deepEqual(body.params, {
          protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "sandbox-runner", version: "1" },
        });
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { ...handshake, protocolVersion: "2025-03-26" } },
          { headers: { "mcp-session-id": upstreamSession } });
      }
      assert.equal(headers.get("mcp-protocol-version"), "2025-03-26");
      assert.equal(headers.get("mcp-session-id"), upstreamSession);
      assert.equal(headers.has("mcp-method"), false);
      assert.equal(headers.has("mcp-name"), false);
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      assert.equal(Object.hasOwn(body.params, "_meta"), false);
      if (body.method === "notifications/initialized") {
        assert.equal(body.id, undefined);
        assert.deepEqual(body.params, {});
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/list") {
        assert.deepEqual(body.params, {});
        return success(body.id, { tools: [{ name: "query-docs", inputSchema: { type: "object" } }] });
      }
      assert.equal(body.method, "tools/call");
      assert.deepEqual(body.params, { name: "query-docs", arguments: context7Args });
      return success(body.id, { content: [{ type: "text", text: "Public documentation" }] });
    }, { connector: context7OAuth });
    const initial = await gateway.handle(request({ ...initialize, id: "downstream-private",
      params: { ...initialize.params, protocolVersion: "2026-07-28" } }));
    assert.equal(initial.status, 200);
    localSession = initial.headers.get("mcp-session-id");
    assert.ok(localSession && localSession !== upstreamSession);
    const initialReply = await initial.json();
    assert.equal(initialReply.id, "downstream-private");
    assert.equal(initialReply.result.protocolVersion, "2025-03-26");
    const headers = { "mcp-session-id": localSession, "mcp-protocol-version": "2025-03-26",
      cookie: "downstream=only", "x-ignored-private": "downstream-only", "mcp-method": "downstream-only" };
    const post = (method, params, id) => gateway.handle(request({
      jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params,
    }, { headers }));
    assert.equal((await post("notifications/initialized", { _meta: "downstream-only" })).status, 202);
    assert.equal((await (await post("tools/list", { _meta: "downstream-only" }, 937)).json()).id, 937);
    const good = await post("tools/call", { name: "query-docs", arguments: context7Args }, "downstream-private");
    assert.equal((await good.json()).id, "downstream-private");
    for (const [method, params, error] of [
      ["tools/list", { cursor: "downstream-only" }, "mcp_invalid_params"],
      ["tools/call", { name: "query-docs", arguments: { ...context7Args, query: "downstream-only" } }, issueCode.policyDenied],
      ["tools/call", { name: "query-docs", arguments: { ...context7Args, language: "downstream-only" } }, issueCode.policyDenied],
      ["tools/call", { name: "refresh-library", arguments: {} }, issueCode.policyDenied],
    ]) {
      assert.equal((await (await post(method, params, "denied-id")).json()).error.message, error);
    }
    assert.deepEqual(gateway.counts(), { credentials: 4, received: 4, claims: 0 });
    const closed = await gateway.handle(request(undefined, { method: "DELETE", headers }));
    assert.equal(closed.status, 204);
    assert.equal(gateway.state(), undefined);
    assert.deepEqual(gateway.counts(), { credentials: 5, received: 5, claims: 0 });
  }
});

test("Context7 rejects an unpinned negotiation and releases its pending session", async () => {
  const gateway = fixture("read-only", ({ id }) => Response.json({ jsonrpc: "2.0", id,
    result: { ...handshake, protocolVersion: "2026-07-28" } },
  { headers: { "mcp-session-id": upstreamSession } }), { connector: context7OAuth });
  const response = await gateway.handle(request(initialize));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "mcp_invalid_response" });
  assert.equal(response.headers.get("mcp-session-id"), null);
  assert.equal(gateway.state(), undefined);
});

test("Context7 withholds upstream cursors and rejects responses with the downstream request ID", async () => {
  for (const [selectId, result] of [
    [upstreamId => upstreamId, { tools: [], nextCursor: "do-not-forward" }],
    [() => 12, { tools: [] }],
  ]) {
    const gateway = fixture("read-only", ({ id }) => success(selectId(id), result), { connector: context7OAuth });
    const response = await gateway.handle(request({ jsonrpc: "2.0", id: 12, method: "tools/list" }));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "mcp_invalid_response" });
    assert.deepEqual(gateway.counts(), { credentials: 1, received: 1, claims: 0 });
  }
});
