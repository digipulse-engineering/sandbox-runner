import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { authorizeCodex, CodexAuthError } from "../bin/codex-oauth.mjs";

const account = "a".repeat(32);
const worker = "runner-fixture";
const clientId = "oaiapp_fixture";
const subject = "opaque-fixture-subject";
const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const signingKeys = generateKeyPair("RS256");

function hasCode(code) {
  return error => error instanceof CodexAuthError && error.code === code &&
    !error.cause && !error.message.includes("fixture");
}

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "sandbox-runner-oauth-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen = { browser: [], messages: [], requests: [], published: [] };
  const result = { status: "configured" };
  const env = { SANDBOX_RUNNER_SIWC_STATE_DIR: root, SANDBOX_RUNNER_SIWC_TIMEOUT_MS: "5000" };
  const { publicKey, privateKey } = await signingKeys;
  const jwk = { ...await exportJWK(publicKey), kid: "fixture-key", alg: "RS256" };
  let activeAuthorization;
  let issuedAccess;

  async function callback(authorize, params = {}) {
    const location = new URL(authorize.searchParams.get("redirect_uri"));
    location.search = new URLSearchParams({
      state: authorize.searchParams.get("state"),
      code: "opaque-fixture-code",
      ...(authorize.searchParams.get("client_id") === "dynamic_agent_client" ? { client_id: clientId } : {}),
      ...params,
    });
    return fetch(location, options.acceptLanguage ? { headers: { "accept-language": options.acceptLanguage } } : {});
  }

  const hooks = {
    interactive: true,
    async openBrowser(raw) {
      const authorize = new URL(raw);
      activeAuthorization = authorize;
      seen.browser.push(authorize);
      if (options.openBrowser) return options.openBrowser(authorize, params => callback(authorize, params));
      const response = await callback(authorize, options.callbackParams);
      seen.callback = { status: response.status, headers: response.headers, body: await response.text() };
      return true;
    },
    writeMessage(message) {
      seen.messages.push(message);
      options.onMessage?.(activeAuthorization, () => callback(activeAuthorization));
    },
    async request(url, request) {
      seen.requests.push({ url, request });
      if (url === issuer + "/.well-known/jwks.json") {
        return Response.json({ keys: [jwk] });
      }
      assert.equal(url, issuer + "/api/accounts/oauth/token");
      const responseStatus = options.tokenStatus ?? 200;
      if (responseStatus !== 200) return new Response(null, { status: responseStatus });
      const nonce = activeAuthorization.searchParams.get("nonce");
      const identity = await new SignJWT({
        nonce, sub: subject, aud: clientId, iss: issuer, ...options.identity,
      }).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setExpirationTime("2m")
        .sign(options.wrongSignature ? (await generateKeyPair("RS256")).privateKey : privateKey);
      issuedAccess = await new SignJWT({
        scope: scopes, client_id: clientId, aud: resource, iss: issuer, ...options.access,
      }).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setExpirationTime("2m").sign(privateKey);
      return Response.json({
        access_token: issuedAccess, id_token: identity, token_type: "Bearer",
        refresh_token: "never-store-this-fixture", scope: options.scope ?? scopes,
      });
    },
  };
  const input = {
    account, worker, env,
    async publish(accessToken) {
      seen.published.push(accessToken);
      assert.equal(accessToken, issuedAccess);
      if (options.publishError) throw options.publishError;
      return result;
    },
  };
  async function registration() {
    const [target] = await readdir(root);
    const directory = join(root, target);
    const path = join(directory, "registration.json");
    return { directory, path, value: JSON.parse(await readFile(path, "utf8")) };
  }
  async function noRegistration() {
    const [target] = await readdir(root);
    assert.deepEqual(await readdir(join(root, target)), []);
  }
  return { root, env, hooks, input, seen, result, registration, noRegistration };
}

test("uses loopback, PKCE and a verified grant, then reuses the saved identity and client", async t => {
  const fixture = await setup(t);
  const { input, hooks, seen, result } = fixture;
  assert.equal(await authorizeCodex(input, hooks), result);
  const [first] = seen.browser;
  const params = first.searchParams;
  assert.equal(first.origin + first.pathname, issuer + "/api/accounts/authorize");
  assert.equal(params.get("client_id"), "dynamic_agent_client");
  assert.equal(params.get("agent_name_hint"), "sandbox-runner");
  assert.equal(params.get("scope"), scopes);
  assert.equal(params.get("resource"), resource);
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("code_challenge_method"), "S256");
  const redirect = new URL(params.get("redirect_uri"));
  assert.equal(redirect.protocol, "http:");
  assert.equal(redirect.hostname, "127.0.0.1");
  assert.equal(redirect.pathname, "/auth/callback");
  assert.ok(redirect.port);
  assert.equal(seen.callback.status, 200);
  assert.equal(seen.callback.headers.get("cache-control"), "no-store");
  assert.equal(seen.callback.headers.get("referrer-policy"), "no-referrer");
  assert.equal(seen.callback.headers.get("content-language"), "en");
  assert.ok(!seen.callback.body.includes("opaque-fixture-code"));

  const exchange = seen.requests[0].request;
  const form = exchange.body;
  assert.equal(exchange.method, "POST");
  assert.equal(form.get("client_id"), clientId);
  assert.equal(form.get("code"), "opaque-fixture-code");
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("redirect_uri"), redirect.href);
  assert.equal(form.get("resource"), resource);
  assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), params.get("code_challenge"));
  assert.equal(seen.requests[1].url, issuer + "/.well-known/jwks.json");
  const { value, path, directory } = await fixture.registration();
  assert.deepEqual(value, { hostId: params.get("ext_agent_host_id"), clientId, sub: subject });
  assert.match(value.hostId, /^urn:uuid:/);
  assert.equal((await stat(fixture.root)).mode & 0o777, 0o700);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ["registration.json"]);
  assert.deepEqual(seen.messages, []);

  assert.equal(await authorizeCodex(input, hooks), result);
  const second = seen.browser[1].searchParams;
  assert.equal(second.get("client_id"), clientId);
  assert.equal(second.get("ext_agent_host_id"), value.hostId);
  assert.equal(second.get("agent_name_hint"), null);
  assert.equal(second.get("id_token_hint"), null);
  for (const key of ["state", "nonce", "code_challenge"]) assert.notEqual(second.get(key), params.get(key));
  assert.equal(seen.published.length, 2);
  assert.deepEqual((await fixture.registration()).value, value);
});

test("renders the local Codex confirmation in the explicitly selected language", async t => {
  const fixture = await setup(t, { acceptLanguage: "en-US" });
  fixture.env.SANDBOX_RUNNER_LANG = "fr";
  assert.equal(await authorizeCodex(fixture.input, fixture.hooks), fixture.result);
  assert.equal(fixture.seen.callback.status, 200);
  assert.equal(fixture.seen.callback.headers.get("content-language"), "fr");
  assert.equal(fixture.seen.callback.body, "Autorisation reçue. Revenez à sandbox-runner.");
});

test("rejects forged callback state, then accepts the genuine callback through the manual link", async t => {
  const done = Promise.withResolvers();
  let forged;
  const fixture = await setup(t, {
    async openBrowser(_url, callback) {
      forged = await callback({ state: "forged" });
      return false;
    },
    onMessage(_url, callback) {
      done.resolve(callback());
    },
  });
  assert.equal(await authorizeCodex(fixture.input, fixture.hooks), fixture.result);
  assert.equal(forged.status, 400);
  assert.equal((await done.promise).status, 200);
  const [message] = fixture.seen.messages;
  assert.equal(message, "Open this link in a browser on this computer: " + fixture.seen.browser[0].href + "\n");
  assert.ok(!message.includes("opaque-fixture-code"));
  assert.equal(fixture.seen.published.length, 1);
});

test("denial and an incomplete registration do not exchange a code or save state", async t => {
  for (const [params, error] of [
    [{ error: "access_denied" }, "codex_auth_denied"],
    [{ client_id: "dynamic_agent_client" }, "codex_auth_callback"],
  ]) {
    const fixture = await setup(t, { callbackParams: params });
    await assert.rejects(authorizeCodex(fixture.input, fixture.hooks), hasCode(error));
    assert.deepEqual(fixture.seen.requests, []);
    assert.deepEqual(fixture.seen.published, []);
    await fixture.noRegistration();
  }
});

test("rejects incomplete plan grants, forged ID tokens, wrong nonce, and a redirect", async t => {
  for (const [options, error] of [
    [{ scope: "openid profile email resource.invoke" }, "codex_auth_plan_required"],
    [{ access: { scope: "openid chatgpt.tokens.use.direct" } }, "codex_auth_plan_required"],
    [{ access: { aud: "https://other.example" } }, "codex_auth_plan_required"],
    [{ identity: { nonce: "bad-nonce" } }, "codex_auth_identity"],
    [{ wrongSignature: true }, "codex_auth_identity"],
    [{ tokenStatus: 307 }, "codex_auth_token_exchange"],
  ]) {
    const fixture = await setup(t, options);
    await assert.rejects(authorizeCodex(fixture.input, fixture.hooks), hasCode(error));
    assert.deepEqual(fixture.seen.published, []);
    await fixture.noRegistration();
  }
});

test("refuses reauthorization from a different client ID or ChatGPT identity", async t => {
  const options = {};
  const fixture = await setup(t, options);
  await authorizeCodex(fixture.input, fixture.hooks);
  const saved = await fixture.registration();
  options.callbackParams = { client_id: "oaiapp_other" };
  await assert.rejects(authorizeCodex(fixture.input, fixture.hooks), hasCode("codex_auth_callback"));
  options.callbackParams = undefined;
  options.identity = { sub: "different-subject" };
  await assert.rejects(authorizeCodex(fixture.input, fixture.hooks), hasCode("codex_auth_identity"));
  assert.equal(fixture.seen.published.length, 1);
  assert.deepEqual((await fixture.registration()).value, saved.value);
});

test("commits only one concurrent first registration and isolates another target", async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const held = await setup(t, {
    async openBrowser(_url, callback) {
      entered.resolve();
      await release.promise;
      await callback();
      return true;
    },
  });
  const active = authorizeCodex(held.input, held.hooks);
  const rejected = assert.rejects(active, hasCode("codex_auth_busy"));
  const winner = await setup(t);
  try {
    await Promise.race([entered.promise, active]);
    assert.equal(await authorizeCodex({
      ...winner.input, account: account.toUpperCase(), env: held.env,
    }, winner.hooks), winner.result);
  } finally {
    release.resolve();
    await rejected;
  }
  assert.deepEqual(held.seen.published, []);
  const saved = await held.registration();
  const winningParams = winner.seen.browser[0].searchParams;
  assert.equal(saved.value.hostId, winningParams.get("ext_agent_host_id"));
  assert.deepEqual(await readdir(saved.directory), ["registration.json"]);
  assert.equal(await authorizeCodex({
    ...winner.input, worker: "other-fixture", env: held.env,
  }, winner.hooks), winner.result);
  assert.equal((await readdir(held.root)).length, 2);
  const second = winner.seen.browser[1].searchParams;
  assert.notEqual(saved.value.hostId, second.get("ext_agent_host_id"));
  assert.equal(second.get("client_id"), "dynamic_agent_client");
});

test("preserves the publisher's typed uncertainty and registration for a retry", async t => {
  const publishError = Object.assign(new Error("Cloudflare update uncertain."), {
    code: "auth_publication_uncertain", uncertain: true,
  });
  const options = { publishError };
  const fixture = await setup(t, options);
  await assert.rejects(authorizeCodex(fixture.input, fixture.hooks), error => error === publishError);
  const { value, directory } = await fixture.registration();
  assert.deepEqual(Object.keys(value).sort(), ["clientId", "hostId", "sub"]);
  assert.deepEqual(await readdir(directory), ["registration.json"]);
  options.publishError = undefined;
  assert.equal(await authorizeCodex(fixture.input, fixture.hooks), fixture.result);
});

test("rejects noninteractive use and insecure or symlinked state before launching a browser", async t => {
  const fixture = await setup(t);
  const { input, hooks, seen, root } = fixture;
  await assert.rejects(authorizeCodex(input, { ...hooks, interactive: false }), hasCode("codex_auth_interactive_required"));
  assert.deepEqual(await readdir(root), []);
  await chmod(root, 0o755);
  await assert.rejects(authorizeCodex(input, hooks), hasCode("codex_auth_state"));
  await chmod(root, 0o700);
  await authorizeCodex(input, hooks);
  const { directory, path } = await fixture.registration();
  const destination = join(directory, "moved.json");
  await rename(path, destination);
  await symlink(destination, path);
  await assert.rejects(authorizeCodex(input, hooks), hasCode("codex_auth_state"));
  assert.equal(seen.browser.length, 1);
});

test("SIGINT closes the loopback listener and leaves the target available", async t => {
  const options = {
    openBrowser() {
      process.emit("SIGINT");
      return true;
    },
  };
  const fixture = await setup(t, options);
  const initialHandlers = process.listenerCount("SIGINT");
  await assert.rejects(authorizeCodex(fixture.input, fixture.hooks), hasCode("codex_auth_cancelled"));
  assert.equal(process.listenerCount("SIGINT"), initialHandlers);
  assert.deepEqual(fixture.seen.requests, []);
  assert.deepEqual(fixture.seen.published, []);
  const closed = fixture.seen.browser[0].searchParams.get("redirect_uri");
  await assert.rejects(fetch(closed));
  await fixture.noRegistration();
  options.openBrowser = undefined;
  assert.equal(await authorizeCodex(fixture.input, fixture.hooks), fixture.result);
});

test("aborts consent or token exchange when the parent command cancels", async t => {
  const controller = new AbortController();
  const duringConsent = await setup(t, {
    openBrowser() {
      controller.abort();
      return true;
    },
  });
  await assert.rejects(authorizeCodex({
    ...duringConsent.input, signal: controller.signal,
  }, duringConsent.hooks), hasCode("codex_auth_cancelled"));
  assert.deepEqual(duringConsent.seen.requests, []);
  assert.deepEqual(duringConsent.seen.published, []);
  await duringConsent.noRegistration();

  const exchangeController = new AbortController();
  const duringExchange = await setup(t);
  await assert.rejects(authorizeCodex({
    ...duringExchange.input, signal: exchangeController.signal,
  }, {
    ...duringExchange.hooks,
    request(_url, options) {
      exchangeController.abort();
      options.signal.throwIfAborted();
      assert.fail("the token request received an independent signal");
    },
  }), hasCode("codex_auth_cancelled"));
  assert.deepEqual(duringExchange.seen.published, []);
  await duringExchange.noRegistration();
});
