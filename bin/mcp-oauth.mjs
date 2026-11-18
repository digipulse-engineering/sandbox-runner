import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { request as requestHttps } from "node:https";
import { promisify } from "node:util";
import { authText, sendAuthCallback, terminalAuthLocale } from "./auth-i18n.mjs";
import { context7Resource, mcpOAuthIssuer, oauthHttpsUrl, oauthObject, oauthOpaque, oauthScopes, oauthTokenFields } from "../worker/mcp-oauth-format.mjs";

const runFile = promisify(execFile);
const messages = {
  connector_oauth_discovery_failed: "Could not verify the connector's OAuth resource and authorization server.",
  connector_oauth_registration_failed: "The connector did not register a public OAuth client.",
  connector_oauth_callback_failed: "The local OAuth callback could not complete.",
  connector_oauth_denied: "Connector authorization was denied in the browser.",
  connector_oauth_timeout: "Timed out waiting for connector authorization.",
  connector_oauth_exchange_failed: "The connector did not return a renewable grant for the requested resource and scopes.",
};

export class McpOAuthError extends Error {
  constructor(code) {
    super(messages[code]);
    this.code = code;
  }
}

async function openSystemBrowser(url, signal) {
  const command = { darwin: "/usr/bin/open", linux: "xdg-open" }[process.platform];
  if (!command) return false;
  await runFile(command, [url], { signal });
  return true;
}

// Require verified TLS even when Node's environment disables the default check.
// Node HTTPS does not follow redirects, including when a POST contains a code.
function requestJson(url, { method, body, headers, signal }) {
  return new Promise((resolve, reject) => {
    const request = requestHttps(url, { method, headers, signal, agent: false, rejectUnauthorized: true }, async response => {
      try {
        if (response.statusCode !== 200 && response.statusCode !== 201) {
          response.destroy();
          resolve({ status: response.statusCode });
          return;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response) {
          size += chunk.length;
          // Same response bound as the CLI's Cloudflare subprocess capture.
          if (size > 1024 * 1024) throw new Error();
          chunks.push(chunk);
        }
        resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch (error) {
        reject(error);
      }
    });
    request.once("error", reject);
    request.end(body);
  });
}

async function verifiedJson(request, url, init, status, errorCode) {
  try {
    const response = await request(url, {
      ...init,
      headers: { accept: "application/json", ...init.headers },
    });
    const data = oauthObject(response.data);
    if (response.status === status && data) return data;
  } catch {
    init.signal.throwIfAborted();
  }
  throw new McpOAuthError(errorCode);
}

function contains(values, ...items) {
  return Array.isArray(values) && items.every(item => values.includes(item));
}

async function discover(resource, scope, request, signal) {
  const endpoint = oauthHttpsUrl(resource);
  const scopes = oauthScopes(scope);
  const discoveryError = "connector_oauth_discovery_failed";
  if (!endpoint || !scopes) throw new McpOAuthError(discoveryError);
  const metadata = await verifiedJson(request,
    endpoint.origin + "/.well-known/oauth-protected-resource" + (endpoint.pathname === "/" ? "" : endpoint.pathname),
    { signal }, 200, discoveryError);
  const issuer = mcpOAuthIssuer(resource);
  const context7 = resource === context7Resource;
  const resourceScopes = context7 ? scopes.filter(scope => scope !== "offline_access") : scopes;
  if (metadata.resource !== resource || !contains(metadata.authorization_servers, issuer) ||
      (!context7 && metadata.authorization_servers.length !== 1) ||
      (metadata.scopes_supported !== undefined && !contains(metadata.scopes_supported, ...resourceScopes))) {
    throw new McpOAuthError(discoveryError);
  }
  const server = await verifiedJson(request, issuer + "/.well-known/oauth-authorization-server",
    { signal }, 200, discoveryError);
  const authorize = oauthHttpsUrl(server.authorization_endpoint, issuer);
  const register = oauthHttpsUrl(server.registration_endpoint, issuer);
  const token = oauthHttpsUrl(server.token_endpoint, issuer);
  if ((server.issuer !== issuer && server.issuer !== issuer + "/") || !authorize || !register || !token ||
      (context7 && (authorize.pathname !== "/api/oauth/authorize" || register.pathname !== "/api/oauth/register" ||
        token.pathname !== "/api/oauth/token")) ||
      !contains(server.code_challenge_methods_supported, "S256") || !contains(server.response_types_supported, "code") ||
      !contains(server.grant_types_supported, "authorization_code", "refresh_token") ||
      !contains(server.token_endpoint_auth_methods_supported, "none") ||
      (server.scopes_supported !== undefined && !contains(server.scopes_supported, ...scopes))) {
    throw new McpOAuthError(discoveryError);
  }
  return { authorize, register, token, scopes };
}

function sameState(actual, expected) {
  if (typeof actual !== "string" || actual.length !== expected.length) return false;
  const bytes = Buffer.from(actual);
  return bytes.length === expected.length && timingSafeEqual(bytes, Buffer.from(expected));
}

function startCallback(state, signal, env) {
  const { promise, resolve } = Promise.withResolvers();
  let callback;
  let used = false;
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("connection", "close");
    if (!callback || used || request.method !== "GET" || request.headers.host !== callback.host) {
      response.writeHead(404).end();
      return;
    }
    let url;
    try { url = new URL(request.url, callback); } catch { response.writeHead(400).end(); return; }
    const params = url.searchParams;
    if (url.origin !== callback.origin || url.pathname !== callback.pathname ||
        params.getAll("state").length !== 1 || !sameState(params.get("state"), state)) {
      response.writeHead(400).end();
      return;
    }
    used = true;
    const code = params.get("code");
    const issue = params.get("error") === "access_denied" ? "connector_oauth_denied" : "connector_oauth_callback_failed";
    if (params.has("error") || params.getAll("code").length !== 1 || !oauthOpaque(code)) {
      sendAuthCallback(request, response, env, 400, "Authorization did not complete.", () => resolve({ issue }));
      return;
    }
    sendAuthCallback(request, response, env, 200, "Authorization received. Return to sandbox-runner.", () => resolve({ code }));
  });

  const interrupt = () => resolve({ issue: "connector_oauth_timeout" });
  signal.addEventListener("abort", interrupt, { once: true });
  function close() {
    signal.removeEventListener("abort", interrupt);
    server.close();
    server.closeAllConnections();
  }
  return {
    async listen() {
      try {
        signal.throwIfAborted();
        server.listen(0, "127.0.0.1");
        await once(server, "listening", { signal });
        server.on("error", () => resolve({ issue: "connector_oauth_callback_failed" }));
        callback = new URL("http://127.0.0.1:" + server.address().port + "/callback");
        return callback.href;
      } catch {
        signal.throwIfAborted();
        throw new McpOAuthError("connector_oauth_callback_failed");
      }
    },
    async result() {
      const { code, issue } = await promise;
      if (issue) throw new McpOAuthError(issue);
      return code;
    },
    close,
  };
}

export async function authorizeMcpResource({ resource, scope, timeout, signal, env = process.env, openBrowser = openSystemBrowser,
  writeMessage = message => process.stderr.write(message) }, { request = requestJson, now = Date.now } = {}) {
  const deadline = AbortSignal.timeout(timeout);
  const flowSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const callback = startCallback(state, flowSignal, env);
  const locale = terminalAuthLocale(env);
  try {
    const { authorize, register, token, scopes } = await discover(resource, scope, request, flowSignal);
    const redirectUri = await callback.listen();
    const registration = await verifiedJson(request, register.href, {
      method: "POST", signal: flowSignal, headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Sandbox Runner", redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      }),
    }, 201, "connector_oauth_registration_failed");
    const clientId = registration.client_id;
    const registeredUris = registration.redirect_uris;
    const localhostAlias = resource === context7Resource ? redirectUri.replace("://127.0.0.1:", "://localhost:") : undefined;
    if (!oauthOpaque(clientId) || registration.client_secret !== undefined || registration.token_endpoint_auth_method !== "none" ||
        !Array.isArray(registeredUris) || !registeredUris.includes(redirectUri) ||
        new Set(registeredUris).size !== registeredUris.length ||
        registeredUris.some(uri => uri !== redirectUri && uri !== localhostAlias)) {
      throw new McpOAuthError("connector_oauth_registration_failed");
    }
    authorize.search = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: "code", state, scope, resource,
      code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    writeMessage("\n" + authText(locale, "Approve the connector in your browser. Ctrl-C cancels.") + "\n");
    const opened = await Promise.resolve().then(() => openBrowser(authorize.href, flowSignal)).catch(() => false);
    flowSignal.throwIfAborted();
    if (!opened) writeMessage(authText(locale, "Open this link in a browser on this computer:") + "\n" + authorize.href + "\n");
    const code = await callback.result();
    const exchangedAt = now();
    const exchange = await verifiedJson(request, token.href, {
      method: "POST", signal: flowSignal, headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri,
        code, code_verifier: verifier, resource,
      }).toString(),
    }, 200, "connector_oauth_exchange_failed");
    const fields = oauthTokenFields(exchange, resource, scopes, exchangedAt);
    if (!fields || fields.expiresAt <= now()) throw new McpOAuthError("connector_oauth_exchange_failed");
    return { version: 1, generation: randomUUID(), resource, tokenEndpoint: token.href, clientId, scope, ...fields };
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) throw new McpOAuthError("connector_oauth_timeout");
    if (error instanceof McpOAuthError) throw error;
    throw new McpOAuthError("connector_oauth_callback_failed");
  } finally {
    callback.close();
  }
}
