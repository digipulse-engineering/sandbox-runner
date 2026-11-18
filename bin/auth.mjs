import { execFile, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { authText, terminalAuthLocale } from "./auth-i18n.mjs";
import { captureClaudeSetupToken, claudeOAuthToken } from "./claude-setup-token.mjs";
import { openCodeProviders } from "./opencode-settings.mjs";
import { mcpOAuthBindingPrefix } from "../worker/mcp-oauth-format.mjs";

export const credentialBindings = new Map([
  ["claude:subscription", "CLAUDE_CODE_OAUTH_TOKEN"],
  ["claude:api-key", "ANTHROPIC_API_KEY"],
  ["codex:subscription", "OPENAI_SUBSCRIPTION_OAUTH_TOKEN"],
  ["codex:api-key", "OPENAI_API_KEY"],
]);
export const versionPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const signals = ["SIGINT", "SIGTERM", "SIGHUP"];

export async function readTerminalAnswer(prompt, signal) {
  signal.throwIfAborted();
  const input = process.stdin;
  const reader = createInterface({ input, terminal: false });
  const { promise, resolve, reject } = Promise.withResolvers();
  const abort = () => reject(signal.reason);
  try {
    reader.once("line", resolve);
    reader.once("close", () => resolve(undefined));
    reader.once("error", reject);
    signal.addEventListener("abort", abort, { once: true });
    process.stderr.write(prompt);
    const answer = await promise;
    signal.throwIfAborted();
    return answer?.trim();
  } finally {
    signal.removeEventListener("abort", abort);
    reader.close();
    input.pause();
  }
}
const claudeFallback = {
  unsupported_platform: "Automatic Claude setup-token requires macOS.",
  invalid_executable: "The configured Claude executable is invalid.",
  executable_not_found: "The Claude executable could not be found.",
  spawn_failed: "Could not start the Claude setup-token terminal.",
  setup_failed: "Could not prepare the Claude setup-token terminal.",
  timeout: "Claude setup-token timed out.",
  child_signaled: "Claude setup-token stopped before returning a credential.",
  child_exit: "Claude setup-token exited unsuccessfully.",
  output_unrecognized: "Claude setup-token did not return a verifiable credential.",
};

function parseTarget(args, env, fail) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      tokens: true,
      options: {
        mode: { type: "string" },
        "model-provider": { type: "string" },
        account: { type: "string" },
        worker: { type: "string" },
        profile: { type: "string" },
        stdin: { type: "boolean" },
        manual: { type: "boolean" },
      },
    });
  } catch {
    throw fail("usage_error", "Invalid auth arguments. Use sandbox-runner --help for usage.", "usage");
  }
  const names = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
  if (new Set(names).size !== names.length) {
    throw fail("usage_error", "Each auth option can be supplied once.", "usage");
  }
  const [agent] = parsed.positionals;
  const modelProvider = parsed.values["model-provider"];
  const openCode = agent === "opencode";
  const authMode = openCode ? "api-key" : parsed.values.mode;
  const binding = openCode ? openCodeProviders.get(modelProvider)?.binding : credentialBindings.get(agent + ":" + authMode);
  if (openCode ? !binding || parsed.values.mode !== undefined : modelProvider !== undefined) {
    throw fail("usage_error", "Use --model-provider openai or anthropic for OpenCode auth.", "usage");
  }
  if (parsed.positionals.length !== 1 || !binding) {
    throw fail("usage_error", "Auth requires one agent and --mode subscription or api-key.", "usage");
  }
  return {
    agent, authMode, binding, modelProvider, ...resolveWorkerTarget(parsed.values, env, fail),
    stdin: parsed.values.stdin === true, manual: parsed.values.manual === true,
  };
}

export function resolveWorkerTarget(options, env, fail) {
  const account = options.account ?? env.CLOUDFLARE_ACCOUNT_ID;
  if (typeof account !== "string" || !/^[0-9a-f]{32}$/i.test(account)) {
    throw fail("configuration_error", "Provide a Cloudflare account ID with --account or CLOUDFLARE_ACCOUNT_ID.", "configuration");
  }
  const worker = options.worker ?? env.SANDBOX_RUNNER_WORKER;
  if (typeof worker !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(worker)) {
    throw fail("configuration_error", "Provide a Worker name with --worker or SANDBOX_RUNNER_WORKER.", "configuration");
  }
  const profile = options.profile ?? env.SANDBOX_RUNNER_CF_PROFILE;
  if (profile !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) {
    throw fail("configuration_error", "Provide a valid Cloudflare profile name.", "configuration");
  }
  const cfBin = env.SANDBOX_RUNNER_CF_BIN ?? "cf";
  if (!cfBin || cfBin.includes("\0")) {
    throw fail("configuration_error", "SANDBOX_RUNNER_CF_BIN must identify a cf executable.", "configuration");
  }
  return {
    account: account.toLowerCase(), worker, profile,
    cfBin: cfBin.includes("/") ? resolve(cfBin) : cfBin,
  };
}

export function normalizeCredential(value, agent, mode) {
  if (agent === "claude" && mode === "subscription") {
    const token = value.replace(/[\p{White_Space}\uFEFF]+/gu, "");
    return claudeOAuthToken.test(token) ? token : undefined;
  }
  // Strip the single newline produced by Enter or a line-oriented pipe.
  const token = value.replace(/\r?\n$/, "");
  if (/[\p{White_Space}\uFEFF]/u.test(token)) return;
  if (agent === "claude" && mode === "api-key") {
    return /^sk-ant-(?:api[0-9]+|usr)-[A-Za-z0-9_-]+$/.test(token) ? token : undefined;
  }
  if (agent === "codex" && mode === "api-key") {
    return /^sk-(?!ant-)[A-Za-z0-9_-]+$/.test(token) ? token : undefined;
  }
}

export function cloudflareEnv(env, target) {
  const childEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: target.account, CLOUDFLARE_SEND_METRICS: "false" };
  for (const binding of credentialBindings.values()) delete childEnv[binding];
  for (const { binding } of openCodeProviders.values()) delete childEnv[binding];
  delete childEnv.SANDBOX_RUNNER_TOKEN;
  delete childEnv.SANDBOX_RUNNER_CLAUDE_MODEL;
  delete childEnv.SANDBOX_RUNNER_CLAUDE_EFFORT;
  delete childEnv.SANDBOX_RUNNER_DEFAULT_SANDBOX_PROVIDER;
  const ignored = new Set([
    "CLOUDFLARE_API_BASE_URL", "CF_API_BASE_URL", "CLOUDFLARE_API_HEADERS", "CLOUDFLARE_CLIENT_ID",
    "CLOUDFLARE_ACCESS_CLIENT_ID", "CLOUDFLARE_ACCESS_CLIENT_SECRET", "WRANGLER_CF_AUTHORIZATION_TOKEN",
    "WRANGLER_AUTH_DOMAIN", "WRANGLER_AUTH_URL", "WRANGLER_TOKEN_URL", "WRANGLER_REVOKE_URL", "WRANGLER_API_ENVIRONMENT",
    "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_OPTIONS",
    "DEBUG", "CF_DEBUG", "CF_LOG_LEVEL", "CLOUDFLARE_LOG_LEVEL",
  ]);
  for (const name of Object.keys(childEnv)) {
    if (ignored.has(name) || name.startsWith("NODE_DEBUG") || name.startsWith("WRANGLER_LOG") ||
        name.startsWith(mcpOAuthBindingPrefix)) {
      delete childEnv[name];
    }
  }
  // The CLI gives environment credentials precedence over a named profile.
  if (target.profile) {
    delete childEnv.CLOUDFLARE_AUTH_PROFILE;
    delete childEnv.CLOUDFLARE_API_TOKEN;
    delete childEnv.CF_API_TOKEN;
    delete childEnv.CLOUDFLARE_API_KEY;
    delete childEnv.CLOUDFLARE_EMAIL;
  }
  return childEnv;
}

export function cfCommand(target, cwd, env, { signal, timeout, onTimeout, killSignal, includeStderr }) {
  const childEnv = cloudflareEnv(env, target);
  const profileArgs = target.profile ? ["--profile", target.profile] : [];
  return (...args) => new Promise((resolveCommand, reject) => {
    const options = killSignal ? { timeout, killSignal } : { timeout, signal };
    const child = execFile(target.cfBin, [...profileArgs, ...args], { cwd, env: childEnv, ...options }, (error, stdout, stderr) => {
      if (killSignal) signal.removeEventListener("abort", terminate);
      if (killSignal && signal.aborted) reject(signal.reason);
      else if (error) reject(error.killed && !signal.aborted ? onTimeout() : error);
      else resolveCommand(includeStderr ? { stdout, stderr } : stdout);
    });
    const terminate = () => child.kill(killSignal);
    if (killSignal) {
      // execFile's AbortSignal sends SIGTERM regardless of its timeout killSignal.
      if (signal.aborted) terminate();
      else signal.addEventListener("abort", terminate, { once: true });
    }
    child.stdin?.end();
  });
}

export async function workerVersion(cf, target, fail, {
  bindingsToCheck = [target.binding],
  requireStrategies = false,
  requireClaudeDefaults = false,
  requireProviderContract = false,
  requireOpenCode = false,
  requireMcpConnectors = false,
} = {}) {
  const deployments = JSON.parse(await cf("workers", "deployments", "list", "--worker", target.worker));
  // The first deployment in this API's list is the one serving traffic.
  const versions = deployments?.deployments?.[0]?.versions;
  const current = versions?.[0];
  const id = current?.version_id;
  if (!Array.isArray(versions) || versions.length !== 1 || current?.percentage !== 100 ||
      typeof id !== "string" || !versionPattern.test(id)) {
    throw fail("worker_target_unverified", "Auth requires a single Worker version serving 100% of traffic.", "configuration");
  }
  const version = JSON.parse(await cf("workers", "versions", "get", id, "--worker-id", target.worker));
  const bindings = version?.bindings;
  const named = name => bindings.filter(binding => binding?.name === name);
  if (version?.id !== id || !Array.isArray(bindings)) {
    throw fail("worker_target_unverified", "The active Worker version could not be verified.", "configuration");
  }
  const mode = named("SANDBOX_RUNNER_MODE");
  const control = named("SANDBOX_RUNNER_TOKEN");
  if (mode.length !== 1 || mode[0].type !== "plain_text" || mode[0].text !== "real" ||
      control.length !== 1 || control[0].type !== "secret_text") {
    throw fail("worker_target_unverified", "The active Worker does not have the required Sandbox Runner bindings.", "configuration");
  }
  if (requireStrategies) {
    const capability = named("SANDBOX_RUNNER_AUTH_STRATEGIES");
    if (capability.length !== 1 || capability[0].type !== "plain_text" || capability[0].text !== "1") {
      throw fail("auth_strategies_unsupported", "The active Worker does not support auth strategies. Deploy a strategy-capable Sandbox Runner Worker and try setup again.", "configuration");
    }
  }
  if (requireClaudeDefaults) {
    const capability = named("SANDBOX_RUNNER_CLAUDE_DEFAULTS");
    if (capability.length !== 1 || capability[0].type !== "plain_text" || capability[0].text !== "1") {
      throw fail("claude_defaults_unsupported", "The active Worker does not support Claude defaults. Deploy a Worker with Claude defaults support and try setup again.", "configuration");
    }
  }
  if (requireProviderContract) {
    const capability = named("SANDBOX_RUNNER_PROVIDER_CONTRACT");
    if (capability.length !== 1 || capability[0].type !== "plain_text" || capability[0].text !== "1") {
      throw fail("sandbox_provider_setup_unsupported", "The active Worker does not support sandbox provider setup. Deploy a Worker with provider-aware runs and try setup again.", "configuration");
    }
  }
  if (requireOpenCode) {
    const capability = named("SANDBOX_RUNNER_OPENCODE");
    if (capability.length !== 1 || capability[0].type !== "plain_text" || capability[0].text !== "1") {
      throw fail("opencode_disabled", "The active Worker has not enabled OpenCode.", "configuration");
    }
  }
  let mcpConnectors;
  if (requireMcpConnectors) {
    const registry = named("SANDBOX_RUNNER_MCP_CONNECTORS");
    if (registry.length !== 1 || registry[0].type !== "plain_text" || typeof registry[0].text !== "string") {
      throw fail("mcp_connectors_unsupported", "The active Worker has no MCP connector registry.", "configuration");
    }
    mcpConnectors = registry[0].text;
  }
  const present = new Set();
  for (const name of bindingsToCheck) {
    const found = named(name);
    if (found.length > 1 || (found.length === 1 && found[0].type !== "secret_text")) {
      throw fail("worker_target_unverified", "The active Worker does not have the required Sandbox Runner bindings.", "configuration");
    }
    if (found.length === 1) present.add(name);
  }
  return {
    id, number: version.number, triggeredBy: version.annotations?.["workers/triggered_by"],
    present, hasCredential: present.has(target.binding),
    ...(mcpConnectors === undefined ? {} : { mcpConnectors }),
  };
}

export async function updateSecret(cf, target, scratch, binding, text, signal, attempt) {
  const body = join(scratch, "binding.json");
  try {
    await writeFile(body, JSON.stringify({ name: binding, type: "secret_text", text }), {
      mode: 0o600, flag: "wx",
    });
    signal.throwIfAborted();
    await attempt(() => cf("workers", "secrets", "update", binding, "--worker", target.worker, "--body", "@" + body));
  } finally {
    rmSync(body, { force: true });
  }
}

async function readText(input, signal) {
  signal.throwIfAborted();
  if (input.readableEnded) return "";
  input.setEncoding("utf8");
  let value = "";
  let done;
  let failed;
  const append = chunk => { value += chunk; };
  const interrupt = () => failed(signal.reason);
  const inputError = error => failed(error);
  const end = () => done(value);
  try {
    return await new Promise((resolveInput, rejectInput) => {
      done = resolveInput;
      failed = rejectInput;
      signal.addEventListener("abort", interrupt, { once: true });
      input.once("end", end);
      input.once("error", inputError);
      input.on("data", append);
      input.resume();
    });
  } finally {
    input.pause();
    input.removeListener("data", append);
    input.removeListener("end", end);
    input.removeListener("error", inputError);
    signal.removeEventListener("abort", interrupt);
  }
}

async function maskedTerminal(signal, fail, action) {
  const stty = (...args) => spawnSync("stty", args, { encoding: "utf8", stdio: [0, "pipe", "ignore"] });
  const original = stty("-g");
  if (original.status !== 0 || !original.stdout?.trim()) {
    throw fail("auth_terminal_failed", "Could not read terminal settings for masked input.", "configuration");
  }
  const settings = original.stdout.trim();
  try {
    if (stty("icanon", "isig", "-echo", "-echonl").status !== 0) {
      throw fail("auth_terminal_failed", "Could not enable masked input.", "configuration");
    }
    return await action();
  } finally {
    if (stty(settings).status !== 0 && !signal.aborted) {
      throw fail("auth_terminal_failed", "Could not restore terminal settings.", "configuration");
    }
    process.stderr.write("\n");
  }
}

async function manualCredential(target, signal, fail, text) {
  if (target.stdin) return await readText(process.stdin, signal);
  return await maskedTerminal(signal, fail, async () => {
    const subscription = target.binding === "CLAUDE_CODE_OAUTH_TOKEN";
    if (process.stderr.isTTY) {
      process.stderr.write("\n" + text("Credential input") + "\n");
      if (subscription) process.stderr.write("  " + text("Run claude setup-token in a private terminal.") + "\n");
      const prompt = subscription ? "Paste the token, then press Enter and Ctrl-D."
        : "Paste the API key, then press Enter and Ctrl-D.";
      process.stderr.write("  " + text(prompt) + "\n  " + text("Input is hidden. Ctrl-C cancels.") + "\n");
    } else {
      const prompt = subscription
        ? "Run claude setup-token in a private terminal. Paste the token here, then press Enter and Ctrl-D."
        : "Paste the API key here, then press Enter and Ctrl-D.";
      process.stderr.write(text(prompt) + "\n");
    }
    return await readText(process.stdin, signal);
  });
}

export async function authProgress(enabled, term, label, action) {
  if (!enabled) return action();
  const output = process.stderr;
  if (!term || term === "dumb" || !(output.columns > label.length + 2)) {
    output.write(label + "\n");
    return action();
  }
  const frames = ["|", "/", "-", "\\"];
  const clear = "\r\x1b[2K";
  let frame = 0;
  const draw = () => {
    const text = frames[frame] + " " + label;
    output.write(clear + text.slice(0, Math.max(0, output.columns - 1)));
    frame = (frame + 1) % frames.length;
  };
  draw();
  const timer = setInterval(draw, 120);
  timer.unref();
  try {
    return await action();
  } finally {
    clearInterval(timer);
    output.write(clear);
  }
}

function readClaudeSetupTimeout(env, fail) {
  // Use the same ten-minute consent window as the Codex OAuth flow.
  const value = env.SANDBOX_RUNNER_CLAUDE_SETUP_TIMEOUT_MS ?? "600000";
  const timeout = Number(value);
  if (!/^\d+$/.test(value) || timeout < 1 || timeout > 2_147_483_647) {
    throw fail("configuration_error", "SANDBOX_RUNNER_CLAUDE_SETUP_TIMEOUT_MS must be between 1 and 2147483647.", "configuration");
  }
  return timeout;
}

export async function authenticate(args, env, { CliError, exit, timeout, expectedVersion }) {
  const fail = (code, message, category, uncertain) => new CliError(code, message, exit[category], { uncertain });
  const target = parseTarget(args, env, fail);
  const browser = target.binding === "OPENAI_SUBSCRIPTION_OAUTH_TOKEN";
  const claude = target.binding === "CLAUDE_CODE_OAUTH_TOKEN";
  if (target.manual && (!claude || target.stdin)) {
    throw fail("usage_error", "--manual requires interactive Claude subscription auth.", "usage");
  }
  if (target.stdin && (browser || process.stdin.isTTY)) {
    throw fail("usage_error", "--stdin requires redirected input and a manual credential mode.", "usage");
  }
  if (!target.stdin && !process.stdin.isTTY) {
    throw fail("usage_error", "Use a terminal for masked auth or --stdin for redirected manual credentials.", "usage");
  }
  const claudeSetupTimeout = claude && !target.stdin && !target.manual ? readClaudeSetupTimeout(env, fail) : undefined;
  const interactive = !target.stdin && process.stderr.isTTY;
  const locale = terminalAuthLocale(env);
  const text = message => authText(locale, message);
  const progress = (label, action) => authProgress(interactive, env.TERM, text(label), action);

  const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-auth-"));
  const controller = new AbortController();
  let mutationAttempted = false;
  const cancelled = () => fail("auth_cancelled", "Auth was interrupted.", "configuration", mutationAttempted);
  const interrupt = () => controller.abort(cancelled());
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  for (const name of signals) process.on(name, interrupt);
  try {
    if (interactive) {
      const agent = target.agent === "claude" ? "Claude Code" : target.agent === "opencode" ? "OpenCode " + target.modelProvider : "Codex";
      const mode = text(target.authMode === "api-key" ? "API key" : "Subscription");
      process.stderr.write(`${agent} · ${mode}\nWorker ${target.worker}\n`);
    }
    const signal = controller.signal;
    const cf = cfCommand(target, scratch, env, {
      signal, timeout,
      onTimeout: () => fail("timeout", "The Cloudflare command timed out.", "timeout", mutationAttempted),
    });
    const versionOptions = { requireStrategies: expectedVersion !== undefined, requireOpenCode: target.agent === "opencode" };
    async function readVersion() {
      try {
        return await workerVersion(cf, target, fail, versionOptions);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CliError) throw error;
        throw fail("cloudflare_read_failed", "Could not verify the Worker with cf. Check Cloudflare login, account, and Worker name.", "requestFailure");
      }
    }
    const before = await progress("Checking Cloudflare Worker…", readVersion);
    if (expectedVersion !== undefined && (before.id !== expectedVersion || before.hasCredential)) {
      throw fail("worker_target_changed", "The active Worker or its credentials changed during setup. Restart setup to verify the current target.", "configuration");
    }

    async function publish(token) {
      signal.throwIfAborted();
      if (mutationAttempted) throw fail("cloudflare_update_unverified", "A credential update was already attempted.", "requestFailure", true);
      if (browser && (typeof token !== "string" || !token || /[\p{White_Space}\uFEFF\x00-\x1f\x7f]/u.test(token) || /^sk-/i.test(token))) {
        throw fail("auth_credential_invalid", "Codex did not return a subscription access token.", "configuration");
      }
      const current = await progress("Rechecking Cloudflare Worker…", readVersion);
      if (current.id !== before.id || (expectedVersion !== undefined && current.hasCredential)) {
        throw fail("worker_target_changed", "The active Worker changed during auth. Start auth again for the current version.", "configuration");
      }
      try {
        await updateSecret(cf, target, scratch, target.binding, token, signal, action => {
          mutationAttempted = true;
          return progress("Publishing credential…", action);
        });
        const after = await progress("Verifying active Worker version…", () => workerVersion(cf, target, fail, versionOptions));
        if (after.id === before.id || !after.hasCredential) throw new Error("Unverified credential update");
        const { agent, authMode, account, worker, binding } = target;
        return { status: "configured", agent, authMode, account, worker, binding, versionId: after.id,
          ...(target.modelProvider === undefined ? {} : { modelProvider: target.modelProvider }) };
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CliError && error.code === "timeout") throw error;
        if (mutationAttempted) {
          throw fail("cloudflare_update_unverified", "Could not confirm the credential update. Check the active Cloudflare Worker version before trying again.", "requestFailure", true);
        }
        throw fail("auth_secret_file_failed", "Could not prepare the private credential file.", "configuration");
      }
    }

    if (browser) {
      let module;
      try {
        module = await import("./codex-oauth.mjs");
        return await module.authorizeCodex({ account: target.account, worker: target.worker, env, publish, signal });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CliError) throw error;
        if (module && error instanceof module.CodexAuthError) {
          throw fail(error.code, error.message, error.code === "codex_auth_timeout" ? "timeout" : "configuration");
        }
        throw fail("codex_auth_failed", "Could not complete Codex subscription auth.", "requestFailure");
      }
    }
    if (claudeSetupTimeout !== undefined) {
      let capture = { reason: "setup_failed" };
      try {
        capture = await maskedTerminal(signal, fail, async () => {
          process.stderr.write("\n" + text("Approve Claude in your browser.") +
            "\n  " + text("If it provides an authorization code, paste it in full and press Enter.") +
            "\n  " + text("Input is hidden. Ctrl-C cancels.") + "\n");
          return await captureClaudeSetupToken({ env, cwd: scratch, signal, cancelled, timeout: claudeSetupTimeout });
        });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CliError) throw error;
      }
      const { credential, ...diagnostics } = capture;
      if (credential) {
        process.stderr.write(text("Claude setup-token returned a credential.") + "\n");
        return { ...await publish(credential), credentialSource: "claude-setup-token" };
      }
      if (env.SANDBOX_RUNNER_CLAUDE_SETUP_DIAGNOSTICS === "1") {
        process.stderr.write(text("Claude setup-token diagnostic: ") + JSON.stringify(diagnostics) + "\n");
      }
      process.stderr.write(text(claudeFallback[diagnostics.reason]) + " " + text("Continue with masked input.") + "\n");
    }
    let raw;
    try {
      raw = await manualCredential(target, signal, fail, text);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof CliError) throw error;
      throw fail("auth_input_failed", "Could not read the credential.", "configuration");
    }
    const credentialAgent = target.agent === "opencode" ? target.modelProvider === "anthropic" ? "claude" : "codex" : target.agent;
    const credential = normalizeCredential(raw, credentialAgent, target.authMode);
    if (!credential) {
      throw fail("auth_credential_invalid", "The credential format does not match the selected agent and mode.", "configuration");
    }
    return await publish(credential);
  } finally {
    try {
      cleanup();
    } finally {
      for (const name of signals) process.removeListener(name, interrupt);
    }
  }
}
