import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { mcpConnectorCodes as code } from "../mcp-diagnostic.mjs";
import { McpOAuthCredentials, mcpTokenFingerprint, parseMcpOAuthGrant } from "../mcp-oauth.ts";

const binding = "SANDBOX_RUNNER_MCP_CREDENTIAL_WORK_REVIEW";
const resource = "https://connector.example/work";
const fixedNow = 10_000;
const grant = {
  version: 1, generation: randomUUID(), resource, tokenEndpoint: "https://connector.example/oauth/token",
  clientId: "public-client", scope: "acme.read acme.write", accessToken: "old:access:opaque",
  refreshToken: "old:refresh:opaque", expiresAt: fixedNow,
};
const refreshed = {
  token_type: "bearer", access_token: "new:access:opaque", refresh_token: "new:refresh:opaque",
  expires_in: 86_400, scope: "acme.write acme.read", resource,
};

function newStorage() {
  const values = new Map();
  return { get: async key => values.get(key), put: async (key, value) => values.set(key, structuredClone(value)), values };
}

test("parses only the configured exact resource and same-origin HTTPS token endpoint", () => {
  assert.deepEqual(parseMcpOAuthGrant(JSON.stringify(grant), resource), grant);
  assert.equal(parseMcpOAuthGrant(JSON.stringify(grant), "https://connector.example/memory"), undefined);
  for (const invalid of [
    { generation: "arbitrary-state" }, { accessToken: "new\nheader" }, { refreshToken: "old token" },
    { tokenEndpoint: "https://foreign.example/token" }, { tokenEndpoint: "https://user@connector.example/oauth/token" },
    { tokenEndpoint: grant.tokenEndpoint + "?redirect=other" }, { version: 2 }, { expiresAt: -1 },
    { scope: "acme.read acme.read" }, { clientId: "malformed,client" },
  ]) assert.equal(parseMcpOAuthGrant(JSON.stringify({ ...grant, ...invalid }), resource), undefined);
});

test("uses a valid token without a network request and ignores noncredential binding names", async () => {
  const storage = newStorage();
  const credentials = new McpOAuthCredentials(storage, {
    now: () => fixedNow - 1, fetcher() { assert.fail("fresh grants require no refresh"); },
  });
  assert.deepEqual(await credentials.resolve(binding, grant), { status: "ready", token: grant.accessToken });
  assert.deepEqual(await credentials.resolve("SANDBOX_RUNNER_TOKEN", grant), { status: "failed", code: code.configurationInvalid });
  assert.equal(storage.values.size, 0);
});

test("serializes refresh and persists the rotated pair before serving it", async () => {
  const storage = newStorage();
  const { promise: rotationStarted, resolve: startRotation } = Promise.withResolvers();
  const { promise: allowRotation, resolve: finishRotation } = Promise.withResolvers();
  let calls = 0;
  const credentials = new McpOAuthCredentials(storage, {
    now: () => fixedNow,
    async fetcher(url, init) {
      calls++;
      assert.equal(url, grant.tokenEndpoint);
      assert.equal(init.redirect, "manual");
      assert.deepEqual(Object.fromEntries(init.body), {
        grant_type: "refresh_token", client_id: grant.clientId, refresh_token: grant.refreshToken, resource,
      });
      assert.deepEqual([...storage.values.values()], [{ status: "pending", resource }]);
      startRotation();
      await allowRotation;
      return Response.json(refreshed);
    },
  });
  const first = credentials.resolve(binding, grant);
  await rotationStarted;
  const second = credentials.resolve(binding, grant);
  finishRotation();
  const expected = { status: "ready", token: refreshed.access_token };
  assert.deepEqual(await Promise.all([first, second]), [expected, expected]);
  assert.equal(calls, 1);
  const afterRestart = new McpOAuthCredentials(storage, {
    now: () => fixedNow, fetcher() { assert.fail("persisted rotation already has a fresh access token"); },
  });
  assert.deepEqual(await afterRestart.resolve(binding, grant), expected);
});

test("requires a new generation after an uncertain refresh and refuses scope or audience changes", async () => {
  for (const fetcher of [
    async () => { throw new Error("response lost"); },
    async () => Response.redirect("https://foreign.example/refresh"),
    async () => new Response(null, { status: 429, headers: { "retry-after": "2" } }),
    async () => new Response(null, { status: 503 }),
    async () => Response.json({ ...refreshed, scope: "acme.read acme.write acme.admin" }),
    async () => Response.json({ ...refreshed, resource: [resource, "https://connector.example/memory"] }),
  ]) {
    const storage = newStorage();
    const options = { now: () => fixedNow, fetcher };
    const ambiguous = { status: "failed", code: code.refreshUnconfirmed };
    assert.deepEqual(await new McpOAuthCredentials(storage, options).resolve(binding, grant), ambiguous);
    const afterRestart = new McpOAuthCredentials(storage, {
      now: () => fixedNow, fetcher() { assert.fail("never spend the previous token again after an uncertain refresh"); },
    });
    assert.deepEqual(await afterRestart.resolve(binding, grant), ambiguous);
    const reconnected = { ...grant, generation: randomUUID(), expiresAt: fixedNow + 1, accessToken: "reconnected" };
    assert.deepEqual(await afterRestart.resolve(binding, reconnected), { status: "ready", token: reconnected.accessToken });
  }
});

test("distinguishes denied grants and issuer configuration errors across a restart", async () => {
  for (const [error, expected] of [["invalid_grant", code.reauthRequired], ["invalid_target", code.configurationInvalid]]) {
    const storage = newStorage();
    const original = new McpOAuthCredentials(storage, {
      now: () => fixedNow,
      fetcher: async () => Response.json({ error, error_description: "private fixture details" }, { status: 400 }),
    });
    const rejected = { status: "failed", code: expected };
    assert.deepEqual(await original.resolve(binding, grant), rejected);
    const recovered = new McpOAuthCredentials(storage, {
      now: () => fixedNow, fetcher() { assert.fail("this generation is blocked"); },
    });
    assert.deepEqual(await recovered.resolve(binding, grant), rejected);
  }
});

test("calls the OAuth refresh fetcher without a receiver", async () => {
  const credentials = new McpOAuthCredentials(newStorage(), {
    now: () => fixedNow,
    async fetcher() {
      assert.equal(this, undefined);
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    },
  });
  assert.deepEqual(await credentials.resolve(binding, grant), { status: "failed", code: code.reauthRequired });
});

test("retains an explicit OAuth refusal's backoff and does not reuse a rejected access token", async () => {
  const storage = newStorage();
  const freshGrant = { ...grant, expiresAt: fixedNow + 30_000 };
  let now = fixedNow;
  let calls = 0;
  const options = {
    now: () => now,
    async fetcher(_url, init) {
      assert.equal(init.body.get("refresh_token"), grant.refreshToken);
      calls++;
      if (calls === 1) return Response.json({ error: "temporarily_unavailable" }, {
        status: 503, headers: { "retry-after": new Date(fixedNow + 4_000).toUTCString() },
      });
      // RFC 6749 section 6 permits success without a new refresh token.
      return Response.json({ ...refreshed, refresh_token: undefined });
    },
  };
  const initial = new McpOAuthCredentials(storage, options);
  assert.deepEqual(await initial.resolve(binding, freshGrant, await mcpTokenFingerprint(freshGrant.accessToken)), {
    status: "failed", code: code.unavailable, retryAfterSeconds: 4,
  });
  now += 3_000;
  const restarted = new McpOAuthCredentials(storage, options);
  assert.deepEqual(await restarted.resolve(binding, freshGrant), {
    status: "failed", code: code.unavailable, retryAfterSeconds: 1,
  });
  assert.equal(calls, 1);
  now += 1_000;
  assert.deepEqual(await restarted.resolve(binding, freshGrant), { status: "ready", token: refreshed.access_token });
  assert.equal(calls, 2);
  assert.equal([...storage.values.values()][0].token.refreshToken, grant.refreshToken);
});

test("coalesces rejected-token recovery and ignores stale rejections after a new token is persisted", async () => {
  const storage = newStorage();
  const freshGrant = { ...grant, expiresAt: fixedNow + 1 };
  const started = Promise.withResolvers();
  const allowRefresh = Promise.withResolvers();
  let calls = 0;
  const credentials = new McpOAuthCredentials(storage, {
    now: () => fixedNow,
    async fetcher() {
      calls++;
      started.resolve();
      await allowRefresh.promise;
      return Response.json(refreshed);
    },
  });
  const fingerprint = await mcpTokenFingerprint(freshGrant.accessToken);
  const ordinary = credentials.resolve(binding, freshGrant);
  const first = credentials.resolve(binding, freshGrant, fingerprint);
  await started.promise;
  const second = credentials.resolve(binding, freshGrant, fingerprint);
  assert.deepEqual(await ordinary, { status: "ready", token: freshGrant.accessToken });
  allowRefresh.resolve();
  const expected = { status: "ready", token: refreshed.access_token };
  assert.deepEqual(await Promise.all([first, second]), [expected, expected]);
  assert.deepEqual(await credentials.resolve(binding, freshGrant, fingerprint), expected);
  assert.equal(calls, 1);
  const otherResource = { ...freshGrant, resource: "https://connector.example/memory" };
  assert.deepEqual(await credentials.resolve(binding, otherResource), { status: "failed", code: code.configurationInvalid });
});

test("reads an interrupted legacy rotation as unconfirmed and treats a lost commit as ambiguous", async () => {
  const storage = newStorage();
  const key = `mcp-oauth:${binding}:${grant.generation}`;
  storage.values.set(key, { status: "pending" });
  const unknown = { status: "failed", code: code.refreshUnconfirmed };
  assert.deepEqual(await new McpOAuthCredentials(storage, {
    now: () => fixedNow, fetcher() { assert.fail("legacy rotation could have spent the token"); },
  }).resolve(binding, grant), unknown);

  storage.values.clear();
  const failedCommit = new McpOAuthCredentials({
    ...storage,
    async put(key, value) {
      if (value.status === "rotated") throw new Error("commit acknowledgement lost");
      await storage.put(key, value);
    },
  }, { now: () => fixedNow, fetcher: async () => Response.json(refreshed) });
  assert.deepEqual(await failedCommit.resolve(binding, grant), unknown);
  assert.deepEqual(storage.values.get(key), { status: "pending", resource });
});
