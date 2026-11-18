import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { browserAuthLocale, terminalAuthLocale } from "../bin/auth-i18n.mjs";
import { findOAuthConnector } from "../bin/connector-login.mjs";
import { authorizeMcpResource } from "../bin/mcp-oauth.mjs";
import { cloudflareEnv } from "../bin/auth.mjs";

const host = "https://connector.example";
const resource = host + "/work";
const resourceMetadata = host + "/.well-known/oauth-protected-resource/work";
const issuerMetadata = host + "/.well-known/oauth-authorization-server";
const scopes = ["acme.read", "acme.write"];
const scope = scopes.join(" ");
const readAuth = "SANDBOX_RUNNER_MCP_CREDENTIAL_WORK_REVIEW";
const writeAuth = "SANDBOX_RUNNER_MCP_CREDENTIAL_WORK_EXECUTE";
const fixture = { url: resource, readAuth, writeAuth };
const token = {
  access_token: "sensitive:access:test", refresh_token: "sensitive:refresh:test", token_type: "bearer",
  expires_in: 86_400, scope, resource,
};
const authorization = {
  issuer: host, authorization_endpoint: host + "/oauth/authorize", token_endpoint: host + "/oauth/token",
  registration_endpoint: host + "/oauth/register", code_challenge_methods_supported: ["S256"],
  response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"], scopes_supported: [...scopes, "acme.admin"],
};

test("connects only the resource and credential binding selected in the Worker registry", () => {
  const registry = JSON.stringify({ "acme-work": fixture });
  assert.deepEqual(findOAuthConnector(registry, "acme-work", "read-only"), { resource, binding: readAuth });
  assert.deepEqual(findOAuthConnector(registry, "acme-work", "read-write"), { resource, binding: writeAuth });
  assert.equal(findOAuthConnector(registry, "toString", "read-write"), undefined);
  for (const readAuth of ["SANDBOX_RUNNER_TOKEN", "github-app", "SANDBOX_RUNNER_MCP_CREDENTIAL_bad-name"]) {
    assert.equal(findOAuthConnector(JSON.stringify({ "acme-work": { ...fixture, readAuth } }), "acme-work", "read-only"), undefined);
  }
  const cfEnv = cloudflareEnv({ [readAuth]: "test-secret", PATH: "/usr/bin" }, { account: "fixture" });
  assert.equal(cfEnv[readAuth], undefined);
  assert.equal(cfEnv.PATH, "/usr/bin");
});

test("rejects a different audience or authorization host before registering a client", async () => {
  for (const metadata of [
    { resource: host + "/memory", authorization_servers: [host] },
    { resource, authorization_servers: ["https://foreign.example"] },
    { resource, authorization_servers: [host, "https://foreign.example"] },
  ]) {
    await assert.rejects(authorizeMcpResource({ resource, scope, timeout: 10_000 }, {
      async request(url) {
        assert.equal(url, resourceMetadata);
        return { status: 200, data: metadata };
      },
    }), { code: "connector_oauth_discovery_failed" });
  }
  await assert.rejects(authorizeMcpResource({ resource, scope, timeout: 10_000 }, {
    async request(url) {
      if (url === resourceMetadata) return { status: 200, data: { resource, authorization_servers: [host] } };
      assert.equal(url, issuerMetadata);
      return { status: 200, data: { ...authorization, token_endpoint: "https://foreign.example/token" } };
    },
  }), { code: "connector_oauth_discovery_failed" });
});

function runConsent({ exchange = token, deny = false, evidence, acceptLanguage, env = {} }) {
  return authorizeMcpResource({ resource, scope, timeout: 10_000, env,
    async openBrowser(url) {
      const authorize = new URL(url);
      assert.equal(authorize.origin + authorize.pathname, authorization.authorization_endpoint);
      const params = authorize.searchParams;
      assert.equal(params.get("resource"), resource);
      assert.equal(params.get("scope"), scope);
      assert.equal(params.get("code_challenge_method"), "S256");
      evidence.challenge = params.get("code_challenge");
      const callback = new URL(params.get("redirect_uri"));
      callback.searchParams.set("code", "sensitive-authorization-code");
      callback.searchParams.set("state", "bad-state");
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set("state", params.get("state"));
      if (deny) callback.searchParams.set("error", "access_denied");
      const browser = await fetch(callback, acceptLanguage ? { headers: { "accept-language": acceptLanguage } } : {});
      assert.equal(browser.status, deny ? 400 : 200);
      evidence.response = { language: browser.headers.get("content-language"), body: await browser.text() };
      assert(!evidence.response.body.includes("sensitive"));
      evidence.browser = true;
      return true;
    },
    writeMessage(message) { evidence.messages.push(message); },
  }, {
    now: () => 1000,
    async request(url, init) {
      evidence.urls.push(url);
      if (url === resourceMetadata) return { status: 200, data: { resource, authorization_servers: [host] } };
      if (url === issuerMetadata) return { status: 200, data: authorization };
      if (url === authorization.registration_endpoint) {
        assert.equal(init.method, "POST");
        const registration = JSON.parse(init.body);
        assert.deepEqual(registration.grant_types, ["authorization_code", "refresh_token"]);
        assert.equal(registration.token_endpoint_auth_method, "none");
        assert.match(registration.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        return { status: 201, data: { ...registration, client_id: "public-client" } };
      }
      assert.equal(url, authorization.token_endpoint);
      const params = new URLSearchParams(init.body);
      assert.equal(params.get("resource"), resource);
      assert.equal(params.get("code"), "sensitive-authorization-code");
      assert.equal(params.get("client_id"), "public-client");
      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(createHash("sha256").update(params.get("code_verifier")).digest("base64url"), evidence.challenge);
      return { status: 200, data: exchange };
    },
  });
}

test("binds the loopback consent and token exchange to the same exact resource and PKCE verifier", async () => {
  const evidence = { messages: [], urls: [] };
  const grant = await runConsent({ evidence });
  assert.equal(grant.resource, resource);
  assert.equal(grant.scope, scope);
  assert.equal(grant.tokenEndpoint, authorization.token_endpoint);
  assert.equal(grant.accessToken, token.access_token);
  assert.equal(grant.refreshToken, token.refresh_token);
  assert.equal(grant.expiresAt, 86_401_000);
  assert.equal(evidence.browser, true);
  assert.deepEqual(evidence.response, { language: "en", body: "Authorization received. Return to sandbox-runner." });
  assert.deepEqual(evidence.urls, [resourceMetadata, issuerMetadata, authorization.registration_endpoint, authorization.token_endpoint]);
  assert(!evidence.messages.join("\n").includes("sensitive"));
});

test("uses POSIX terminal locale precedence and an explicit language override", () => {
  assert.equal(terminalAuthLocale({ LC_ALL: "fr_BE.UTF-8", LC_MESSAGES: "en_US", LANG: "en" }), "fr");
  assert.equal(terminalAuthLocale({ LC_MESSAGES: "fr_CA@euro", LANG: "en" }), "fr");
  assert.equal(terminalAuthLocale({ LC_ALL: "", LANG: "fr_FR" }), "fr");
  assert.equal(terminalAuthLocale({ SANDBOX_RUNNER_LANG: "en", LC_ALL: "fr_FR" }), "en");
  assert.equal(terminalAuthLocale({ SANDBOX_RUNNER_LANG: "de", LANG: "fr" }), "en");
  assert.equal(terminalAuthLocale({ LC_ALL: "C.UTF-8", LANG: "fr" }), "en");
});

test("negotiates browser locale weights, regions, wildcard ranges and exclusions", () => {
  for (const [header, expected] of [
    ["nl-BE, fr-BE;q=0.8, en-US;q=0.5", "fr"],
    ["fr;q=0, en;q=0.6", "en"],
    ["en;q=0, *;q=0.9", "fr"],
    ["fr;q=0.3, *;q=0.9", "en"],
    ["fr;q=0.9, *;q=0.9", "fr"],
    ["fr-CA;q=0.8, en;q=0.8", "fr"],
    ["fr;q=1.1, en;q=0.5", "en"],
    ["fr;q=0.3;invalid, en;q=0.2", "en"],
    ["es, de;q=0.8", "en"],
  ]) assert.equal(browserAuthLocale(header, {}), expected, header);
  assert.equal(browserAuthLocale("en", { SANDBOX_RUNNER_LANG: "fr" }), "fr");
  assert.equal(browserAuthLocale(undefined, { LANG: "fr" }), "en");
});

test("localizes connector consent separately for the browser and terminal", async () => {
  const evidence = { messages: [], urls: [] };
  await assert.rejects(runConsent({
    deny: true, evidence, acceptLanguage: "fr-CA, en;q=0.8", env: { LANG: "en_US.UTF-8" },
  }), { code: "connector_oauth_denied" });
  assert.deepEqual(evidence.response, { language: "fr", body: "L’autorisation n’a pas abouti." });
  assert.match(evidence.messages.join(""), /Approve the connector/);
});

test("rejects denial and a scope-widened grant with fixed errors", async () => {
  const denied = { messages: [], urls: [] };
  await assert.rejects(runConsent({ deny: true, evidence: denied }), { code: "connector_oauth_denied" });
  assert(!denied.urls.includes(authorization.token_endpoint));
  await assert.rejects(runConsent({ exchange: { ...token, scope: scope + " acme.admin" }, evidence: { messages: [], urls: [] } }),
    { code: "connector_oauth_exchange_failed" });
});

test("pins Context7's separate issuer and accepts only its equivalent loopback alias", async () => {
  const resource = "https://mcp.context7.com/mcp/oauth";
  const issuer = "https://context7.com";
  const scope = "profile email offline_access";
  const registration = issuer + "/api/oauth/register";
  const metadata = "https://mcp.context7.com/.well-known/oauth-protected-resource/mcp/oauth";
  const clientId = "public-client";
  const run = (alias, tokenEndpoint = issuer + "/api/oauth/token") => authorizeMcpResource({
    resource, scope, timeout: 10_000, writeMessage() {},
    async openBrowser(url) {
      const auth = new URL(url);
      assert.equal(auth.origin, issuer);
      assert.equal(auth.searchParams.get("scope"), scope);
      assert.equal(auth.searchParams.get("resource"), resource);
      const callback = new URL(auth.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", auth.searchParams.get("state"));
      callback.searchParams.set("code", "mock-code");
      assert.equal((await fetch(callback)).status, 200);
      return true;
    },
  }, {
    async request(url, init) {
      if (url === metadata) return { status: 200, data: { resource,
        authorization_servers: ["https://clerk.context7.com", issuer], scopes_supported: ["profile", "email"] } };
      if (url === issuer + "/.well-known/oauth-authorization-server") return { status: 200, data: {
        ...authorization, issuer, authorization_endpoint: issuer + "/api/oauth/authorize",
        token_endpoint: tokenEndpoint, registration_endpoint: registration, scopes_supported: scope.split(" "),
      } };
      if (url === registration) {
        const payload = JSON.parse(init.body);
        return { status: 201, data: { ...payload, client_id: clientId,
          redirect_uris: [...payload.redirect_uris, alias(payload.redirect_uris[0])] } };
      }
      assert.equal(url, tokenEndpoint);
      assert.equal(new URLSearchParams(init.body).get("resource"), resource);
      return { status: 200, data: { ...token, resource, scope } };
    },
  });
  const grant = await run(url => url.replace("127.0.0.1", "localhost"));
  assert.equal(grant.clientId, clientId);
  await assert.rejects(run(url => url.replace("/callback", "/elsewhere")), { code: "connector_oauth_registration_failed" });
  await assert.rejects(run(url => url, "https://other.invalid/api/oauth/token"), { code: "connector_oauth_discovery_failed" });
});
