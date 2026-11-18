import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { authText, terminalAuthLocale } from "./auth-i18n.mjs";
import { authProgress, cfCommand, readTerminalAnswer, resolveWorkerTarget, signals, updateSecret, workerVersion } from "./auth.mjs";
import { authorizeMcpResource, McpOAuthError } from "./mcp-oauth.mjs";
import { isMcpOAuthBinding, oauthHttpsUrl, oauthObject, oauthScopes } from "../worker/mcp-oauth-format.mjs";

export function findOAuthConnector(registry, name, mode) {
  try {
    const connectors = oauthObject(JSON.parse(registry));
    if (!connectors || !Object.hasOwn(connectors, name)) return;
    const connector = oauthObject(connectors[name]);
    const resource = connector?.url;
    const binding = mode === "read-only" ? connector?.readAuth : mode === "read-write" ? connector?.writeAuth : undefined;
    if (oauthHttpsUrl(resource) && isMcpOAuthBinding(binding)) return { resource, binding };
  } catch {
    return;
  }
}

function parseLogin(args, env, fail) {
  const invalid = () => fail("usage_error", "Use connector login NAME --mode read-only|read-write --scope SCOPES.", "usage");
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, tokens: true, options: {
      mode: { type: "string" }, scope: { type: "string" }, account: { type: "string" },
      worker: { type: "string" }, profile: { type: "string" },
    } });
  } catch {
    throw invalid();
  }
  const [name] = parsed.positionals;
  const { mode, scope } = parsed.values;
  const options = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
  if (parsed.positionals.length !== 1 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) ||
      (mode !== "read-only" && mode !== "read-write") || !oauthScopes(scope) || new Set(options).size !== options.length) {
    throw invalid();
  }
  // Use the same consent window and Node timer range as the existing Codex browser flow.
  const rawTimeout = env.SANDBOX_RUNNER_MCP_OAUTH_TIMEOUT_MS ?? "600000";
  const consentTimeout = Number(rawTimeout);
  if (!/^\d+$/.test(rawTimeout) || consentTimeout < 1 || consentTimeout > 2_147_483_647) {
    throw fail("configuration_error", "SANDBOX_RUNNER_MCP_OAUTH_TIMEOUT_MS must be between 1 and 2147483647.", "configuration");
  }
  return { name, mode, scope, consentTimeout, ...resolveWorkerTarget(parsed.values, env, fail) };
}

function matchesWorkerOrigin(details, worker, origin) {
  if (details?.name !== worker) return false;
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.port || !url.hostname.endsWith(".workers.dev")) return false;
  // Custom Domains can be origins behind another Worker's path-specific Route.
  // The enabled canonical workers.dev URL identifies the responding Worker.
  const labels = url.hostname.split(".");
  return labels.length === 4 && labels[0] === worker && details.subdomain?.enabled === true &&
    (details.subdomain.url === url.origin || details.subdomain.url === url.href);
}

export async function connectorLogin(args, env, { CliError, exit, timeout, recovery }) {
  const fail = (code, message, category, uncertain) => new CliError(code, message, exit[category], { uncertain });
  const target = parseLogin(args, env, fail);
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw fail("usage_error", "Connector login requires an interactive terminal and browser.", "usage");
  }
  const locale = terminalAuthLocale(env);
  const text = message => authText(locale, message);
  const progress = (label, action) => authProgress(true, env.TERM, text(label), action);
  const controller = new AbortController();
  const signal = controller.signal;
  const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-connector-"));
  let mutationAttempted = false;
  let recoveryWorkerId;
  const interrupt = () => controller.abort(fail("auth_cancelled", "Connector login was interrupted.", "configuration", mutationAttempted));
  for (const name of signals) process.on(name, interrupt);

  try {
    const cf = cfCommand(target, scratch, env, {
      signal, timeout,
      onTimeout: () => fail("timeout", "The Cloudflare command timed out.", "timeout", mutationAttempted),
    });
    async function readVersion(binding) {
      try {
        const version = await workerVersion(cf, { ...target, binding }, fail, {
          requireMcpConnectors: true, bindingsToCheck: binding ? [binding] : [],
        });
        if (binding && recovery) {
          const details = JSON.parse(await cf("workers", "get", target.worker, "-q"));
          if (typeof details?.id !== "string" || !/^[a-f0-9]{32}$/u.test(details.id) ||
              (recoveryWorkerId !== undefined && details.id !== recoveryWorkerId) ||
              !matchesWorkerOrigin(details, target.worker, recovery.origin)) {
            throw fail("connector_reconnect_origin_unverified", "Cloudflare did not confirm the Runner URL belongs to this Worker.", "configuration");
          }
          recoveryWorkerId = details.id;
        }
        return version;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CliError) throw error;
        throw fail("cloudflare_read_failed", "Could not verify the Worker with cf. Check Cloudflare login, account, and Worker name.", "requestFailure");
      }
    }

    process.stderr.write(`${target.name} · ${text(target.mode)}\nWorker ${target.worker}\n\n`);
    const before = await progress("Checking Cloudflare Worker…", () => readVersion());
    if (recovery && before.id.toLowerCase() !== recovery.versionId) {
      throw fail("connector_reconnect_target_unverified", "The configured Cloudflare Worker does not match the Worker that rejected this run.", "configuration");
    }
    const connector = findOAuthConnector(before.mcpConnectors, target.name, target.mode);
    if (!connector) {
      throw fail("connector_oauth_not_configured", "The Worker has no OAuth credential binding for this connector and mode.", "configuration");
    }
    const { binding, resource } = connector;
    // Verify the secret binding type before starting browser consent.
    const ready = await readVersion(binding);
    if (ready.id !== before.id) throw fail("worker_target_changed", "The active Worker changed. Start connector login again.", "configuration");
    if (recovery) {
      if (!ready.hasCredential) {
        throw fail("connector_reconnect_target_unverified", "The verified Worker has no existing grant for this connector and mode.", "configuration");
      }
      process.stderr.write(`Runner ${recovery.origin}\n${text("Resource")} ${resource}\n${text("OAuth scopes")} ${target.scope}\n`);
      const answer = await readTerminalAnswer(text("Reconnect in the browser and retry this run? [y/N] "), signal);
      if (!answer || !["y", "yes", ...(locale === "fr" ? ["o", "oui"] : [])].includes(answer.toLowerCase())) return;
    }
    let grant;
    try {
      grant = await authorizeMcpResource({ resource, scope: target.scope, timeout: target.consentTimeout, signal, env });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof McpOAuthError) {
        throw fail(error.code, error.message, error.code === "connector_oauth_timeout" ? "timeout" : "configuration");
      }
      throw fail("connector_oauth_failed", "Could not complete connector authorization.", "requestFailure");
    }

    const current = await progress("Rechecking Cloudflare Worker…", () => readVersion(binding));
    if (current.id !== before.id || current.mcpConnectors !== before.mcpConnectors) {
      throw fail("worker_target_changed", "The active Worker changed during consent. Start connector login again.", "configuration");
    }
    try {
      await updateSecret(cf, target, scratch, binding, JSON.stringify(grant), signal, action => {
        mutationAttempted = true;
        return progress("Publishing connector credential…", action);
      });
      const after = await progress("Verifying active Worker version…", () => readVersion(binding));
      if (after.id === before.id || !after.hasCredential || after.mcpConnectors !== before.mcpConnectors) throw new Error();
      return { status: "configured", connector: target.name, mode: target.mode, worker: target.worker, binding, versionId: after.id };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof CliError && error.code === "timeout") throw error;
      if (mutationAttempted) {
        throw fail("cloudflare_update_unverified", "Could not confirm the credential update. Check the active Cloudflare Worker version before trying again.", "requestFailure", true);
      }
      throw fail("auth_secret_file_failed", "Could not prepare the private credential file.", "configuration");
    }
  } finally {
    try {
      await rm(scratch, { recursive: true, force: true });
    } finally {
      for (const name of signals) process.removeListener(name, interrupt);
    }
  }
}
