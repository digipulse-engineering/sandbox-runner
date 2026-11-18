import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request as requestHttps } from "node:https";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify } from "jose";
import { authText, sendAuthCallback, terminalAuthLocale } from "./auth-i18n.mjs";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const app = "sandbox-runner";
const dynamicClient = "dynamic_agent_client";
const planScopes = ["resource.invoke", "chatgpt.tokens.use.direct"];
const requestedScopes = ["openid", "profile", "email", "offline_access", ...planScopes];
const authorizationEndpoint = issuer + "/api/accounts/authorize";
const tokenEndpoint = issuer + "/api/accounts/oauth/token";
const keysEndpoint = issuer + "/.well-known/jwks.json";
const runFile = promisify(execFile);

const messages = {
  codex_auth_interactive_required: "Codex subscription authorization requires an interactive terminal and browser.",
  codex_auth_configuration: "Check the Cloudflare target and Codex authorization settings.",
  codex_auth_state: "Codex authorization could not access its private registration state.",
  codex_auth_busy: "Another Codex authorization registered this Worker. Retry to use its registration.",
  codex_auth_callback: "The local Codex authorization callback could not complete.",
  codex_auth_cancelled: "Codex authorization was cancelled.",
  codex_auth_timeout: "Timed out waiting for Codex authorization in the browser.",
  codex_auth_denied: "Codex authorization was denied in the browser.",
  codex_auth_browser: "Could not present the Codex authorization link.",
  codex_auth_token_exchange: "OpenAI did not complete the Codex authorization code exchange.",
  codex_auth_plan_required: "OpenAI did not grant ChatGPT plan usage for Codex.",
  codex_auth_identity: "Codex authorization could not verify the selected ChatGPT identity.",
  codex_auth_failed: "Codex subscription authorization failed.",
};

export class CodexAuthError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(messages, code) ? code : "codex_auth_failed";
    super(messages[safeCode]);
    this.name = "CodexAuthError";
    this.code = safeCode;
  }
}

function stateConfiguration(account, worker, env) {
  const explicitRoot = env.SANDBOX_RUNNER_SIWC_STATE_DIR;
  const stateHome = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  const root = explicitRoot ?? join(stateHome, app, "codex-auth");
  const timeoutValue = env.SANDBOX_RUNNER_SIWC_TIMEOUT_MS ?? "600000";
  const timeout = Number(timeoutValue);
  if (typeof account !== "string" || !/^[a-f0-9]{32}$/i.test(account) ||
      typeof worker !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(worker) ||
      !isAbsolute(root) || !/^\d+$/.test(timeoutValue) || timeout < 1 || timeout > 2_147_483_647) {
    throw new CodexAuthError("codex_auth_configuration");
  }
  const target = createHash("sha256").update(JSON.stringify([account.toLowerCase(), worker])).digest("hex");
  return { root, directory: join(root, target), timeout };
}

async function privateDirectory(path, recursive) {
  try {
    await mkdir(path, { recursive, mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) {
    throw new CodexAuthError("codex_auth_state");
  }
}

function validClientId(value) {
  return typeof value === "string" && /^[\x21-\x7e]+$/.test(value) && value !== dynamicClient;
}

async function readRegistration(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) {
      throw new CodexAuthError("codex_auth_state");
    }
    const registration = JSON.parse(await file.readFile("utf8"));
    if (Object.keys(registration).length !== 3 ||
        !/^urn:uuid:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(registration.hostId) ||
        !validClientId(registration.clientId) || typeof registration.sub !== "string" || !registration.sub) {
      throw new CodexAuthError("codex_auth_state");
    }
    return registration;
  } finally {
    await file.close();
  }
}

async function writeRegistration(path, registration) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(registration) + "\n", { mode: 0o600, flag: "wx" });
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function systemBrowser(url) {
  const command = { darwin: "/usr/bin/open", linux: "xdg-open" }[process.platform];
  if (!command) return false;
  await runFile(command, [url], { timeout: 10_000 });
  return true;
}

async function receiveCode({ hostId, clientId, verifier, nonce, timeout, signal, openBrowser, writeMessage, env }) {
  const state = randomBytes(32).toString("base64url");
  const { promise, resolve, reject } = Promise.withResolvers();
  const cancel = () => reject(new CodexAuthError("codex_auth_cancelled"));
  let callback;
  let used = false;
  let settled = false;
  let timer;
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
    try {
      url = new URL(request.url, callback);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const params = url.searchParams;
    if (url.origin !== callback.origin || url.pathname !== callback.pathname ||
        params.getAll("state").length !== 1 || params.get("state") !== state) {
      response.writeHead(400).end();
      return;
    }
    used = true;
    const code = params.get("code");
    const returnedClient = params.get("client_id") ?? clientId;
    if (params.has("error") || params.getAll("code").length !== 1 || !code ||
        params.getAll("client_id").length > 1 || !validClientId(returnedClient) ||
        (clientId && clientId !== returnedClient)) {
      const error = params.get("error") === "access_denied" ? "codex_auth_denied" : "codex_auth_callback";
      sendAuthCallback(request, response, env, 400, "Codex authorization did not complete.",
        () => reject(new CodexAuthError(error)));
      return;
    }
    sendAuthCallback(request, response, env, 200, "Authorization received. Return to sandbox-runner.", () => {
      resolve({ code, clientId: returnedClient, redirectUri: callback.href });
    });
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    server.once("error", () => reject(new CodexAuthError("codex_auth_callback")));
    callback = new URL("http://127.0.0.1:" + server.address().port + "/auth/callback");
    const authorize = new URL(authorizationEndpoint);
    authorize.search = new URLSearchParams({
      client_id: clientId ?? dynamicClient,
      ...(clientId ? {} : { agent_name_hint: app }),
      ext_agent_host_id: hostId,
      response_type: "code",
      redirect_uri: callback.href,
      scope: requestedScopes.join(" "),
      resource,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    timer = setTimeout(() => reject(new CodexAuthError("codex_auth_timeout")), timeout);
    if (signal) signal.addEventListener("abort", cancel, { once: true });
    else process.once("SIGINT", cancel);
    if (signal?.aborted) {
      cancel();
    } else {
      Promise.resolve().then(() => !signal?.aborted && openBrowser(authorize.href)).catch(() => false).then(opened => {
        if (!opened && !settled) {
          const message = authText(terminalAuthLocale(env), "Open this link in a browser on this computer:");
          writeMessage(message + " " + authorize.href + "\n");
        }
      }).catch(() => reject(new CodexAuthError("codex_auth_browser")));
    }
    return await promise;
  } catch (error) {
    if (error instanceof CodexAuthError) throw error;
    throw new CodexAuthError("codex_auth_callback");
  } finally {
    settled = true;
    if (signal) signal.removeEventListener("abort", cancel);
    else process.removeListener("SIGINT", cancel);
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

// Keep the OAuth transport on the system's verified TLS path, with no redirects.
function requestOpenAI(url, { method, body, headers, signal }) {
  return new Promise((resolve, reject) => {
    const request = requestHttps(url, {
      method, headers: Object.fromEntries(new Headers(headers)), signal, agent: false, rejectUnauthorized: true,
    }, async incoming => {
      try {
        if (incoming.statusCode !== 200) {
          incoming.destroy();
          resolve(new Response(null, { status: incoming.statusCode }));
          return;
        }
        const chunks = [];
        for await (const chunk of incoming) chunks.push(chunk);
        resolve(new Response(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
    request.end(body?.toString());
  });
}

function hasPlanScopes(scope) {
  return typeof scope === "string" && planScopes.every(item => scope.split(/\s+/).includes(item));
}

async function exchangeCode(callback, verifier, nonce, expectedSubject, request) {
  let grant;
  try {
    const response = await request(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: callback.clientId,
        code: callback.code,
        code_verifier: verifier,
        redirect_uri: callback.redirectUri,
        resource,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) throw new CodexAuthError("codex_auth_token_exchange");
    grant = await response.json();
    if (!grant || typeof grant.access_token !== "string" || !/^bearer$/i.test(grant.token_type ?? "")) {
      throw new CodexAuthError("codex_auth_token_exchange");
    }
  } catch {
    throw new CodexAuthError("codex_auth_token_exchange");
  }
  if (!hasPlanScopes(grant.scope)) throw new CodexAuthError("codex_auth_plan_required");

  let sub;
  try {
    const keys = createRemoteJWKSet(new URL(keysEndpoint), { [customFetch]: request });
    const { payload } = await jwtVerify(grant.id_token, keys, {
      issuer, audience: callback.clientId, algorithms: ["RS256"], requiredClaims: ["sub", "exp", "nonce"],
    });
    if (payload.nonce !== nonce || typeof payload.sub !== "string" || !payload.sub ||
        (expectedSubject !== undefined && payload.sub !== expectedSubject)) {
      throw new CodexAuthError("codex_auth_identity");
    }
    sub = payload.sub;
  } catch {
    throw new CodexAuthError("codex_auth_identity");
  }

  // This token comes directly from the verified token endpoint. OpenAI validates
  // its signature on use. Check that it carries the intended grant before upload.
  try {
    const access = decodeJwt(grant.access_token);
    const audiences = Array.isArray(access.aud) ? access.aud : [access.aud];
    if (access.iss !== issuer || !audiences.some(audience => audience === resource) || access.client_id !== callback.clientId ||
        !Number.isSafeInteger(access.exp) || access.exp <= Date.now() / 1000 || !hasPlanScopes(access.scope)) {
      throw new CodexAuthError("codex_auth_plan_required");
    }
  } catch {
    throw new CodexAuthError("codex_auth_plan_required");
  }
  return { sub, accessToken: grant.access_token };
}

export async function authorizeCodex(
  { account, worker, env = process.env, publish, signal },
  {
    interactive = process.stdin.isTTY && process.stderr.isTTY,
    openBrowser = systemBrowser,
    writeMessage = message => process.stderr.write(message),
    request = requestOpenAI,
  } = {},
) {
  if (!interactive) throw new CodexAuthError("codex_auth_interactive_required");
  if (typeof publish !== "function") throw new CodexAuthError("codex_auth_configuration");
  const checkCancelled = () => {
    if (signal?.aborted) throw new CodexAuthError("codex_auth_cancelled");
  };
  checkCancelled();
  const { root, directory, timeout } = stateConfiguration(account, worker, env);
  const path = join(directory, "registration.json");
  let saved;
  try {
    await privateDirectory(root, true);
    await privateDirectory(directory, false);
    saved = await readRegistration(path);
  } catch {
    throw new CodexAuthError("codex_auth_state");
  }
  const hostId = saved?.hostId ?? "urn:uuid:" + randomUUID();
  const verifier = randomBytes(48).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const callback = await receiveCode({
    hostId, clientId: saved?.clientId, verifier, nonce, timeout, signal, openBrowser, writeMessage, env,
  });
  checkCancelled();
  const abortableRequest = signal ? (url, options) => request(url, {
    ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
  }) : request;
  let grant;
  try {
    grant = await exchangeCode(callback, verifier, nonce, saved?.sub, abortableRequest);
  } catch (error) {
    checkCancelled();
    throw error;
  }
  checkCancelled();
  if (!saved) {
    // A concurrent first authorization must win the registration before it can publish.
    try {
      await writeRegistration(path, { hostId, clientId: callback.clientId, sub: grant.sub });
    } catch (error) {
      throw new CodexAuthError(error.code === "EEXIST" ? "codex_auth_busy" : "codex_auth_state");
    }
  }
  checkCancelled();
  return publish(grant.accessToken);
}
