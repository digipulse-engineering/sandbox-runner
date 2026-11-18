import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { authProgress, cfCommand, cloudflareEnv, credentialBindings, readTerminalAnswer, resolveWorkerTarget, signals, updateSecret, versionPattern, workerVersion } from "./auth.mjs";
import { authStrategies } from "./auth-strategies.mjs";
import { claudeOptionsError } from "./claude-options.mjs";
import { CliError, exit } from "./cli-errors.mjs";
import { configureWorkerDefaults } from "./worker-defaults.mjs";

const childEntry = fileURLToPath(new URL("./setup-auth.mjs", import.meta.url));
const strategyOptions = [...authStrategies.keys()];

function fail(code, message, category, uncertain) {
  return new CliError(code, message, exit[category], { uncertain });
}

function parseSetup(args, options) {
  let parsed;
  try {
    parsed = parseArgs({
      args, tokens: true,
      options: {
        ...options,
        account: { type: "string" },
        worker: { type: "string" },
        profile: { type: "string" },
      },
    });
  } catch {
    throw fail("usage_error", "Invalid setup arguments. Use sandbox-runner --help for usage.", "usage");
  }
  const names = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
  if (new Set(names).size !== names.length) {
    throw fail("usage_error", "Each setup option can be supplied once.", "usage");
  }
  return parsed.values;
}

function parseAgentSetup(agent, args, env) {
  const values = parseSetup(args, {
    strategy: { type: "string" }, "confirm-api-spend-cap": { type: "boolean" },
    model: { type: "string" }, effort: { type: "string" },
  });
  const { strategy, "confirm-api-spend-cap": confirmed, model, effort } = values;
  const settingsError = claudeOptionsError(agent, { model, effort });
  if (settingsError) throw fail("usage_error", settingsError, "usage");
  const settings = model !== undefined || effort !== undefined ? { model, effort } : undefined;
  if (settings && (strategy !== undefined || confirmed)) {
    throw fail("usage_error", "Configure Claude defaults and auth strategy in separate setup commands.", "usage");
  }
  if (strategy !== undefined && !authStrategies.has(strategy)) {
    throw fail("usage_error", "Choose one of the four supported auth strategies. Use sandbox-runner --help for usage.", "usage");
  }
  return { target: resolveWorkerTarget(values, env, fail), strategy, confirmed, settings };
}

export async function setupSandboxProvider(args, env, timeout) {
  const options = parseSetup(args, { "default-sandbox-provider": { type: "string" } });
  const sandboxProvider = options["default-sandbox-provider"];
  if (sandboxProvider !== "cloudflare") {
    throw fail("usage_error", "Setup requires --default-sandbox-provider cloudflare.", "usage");
  }
  const target = resolveWorkerTarget(options, env, fail);
  const binding = "SANDBOX_RUNNER_DEFAULT_SANDBOX_PROVIDER";
  const versionId = await configureWorkerDefaults(target, env, timeout, {
    values: { [binding]: sandboxProvider }, label: "the default sandbox provider", versionOptions: { requireProviderContract: true },
  });
  return { status: "configured", sandboxProvider, account: target.account, worker: target.worker, binding, versionId };
}

async function terminalAnswer(prompt, signal) {
  const answer = await readTerminalAnswer(prompt, signal);
  if (answer === undefined) throw fail("setup_cancelled", "Setup was interrupted.", "configuration");
  return answer;
}

async function chooseStrategy({ strategy, confirmed }, interactive, signal) {
  if (!strategy) {
    if (!interactive) {
      throw fail("usage_error", "Pass --strategy when setup runs without an interactive terminal.", "usage");
    }
    const options = strategyOptions.map((value, index) => `  ${index + 1}. ${value}`).join("\n");
    const answer = await terminalAnswer("Choose an auth strategy\n" + options + "\nStrategy number: ", signal);
    strategy = strategyOptions.find((_value, index) => String(index + 1) === answer);
    if (!strategy) throw fail("usage_error", "Choose a strategy number from the menu.", "usage");
  }
  const modes = authStrategies.get(strategy);
  if (!modes.includes("api-key")) {
    if (confirmed) throw fail("usage_error", "--confirm-api-spend-cap applies to strategies that use an API key.", "usage");
    return { policy: { strategy }, modes };
  }
  if (!confirmed && interactive) {
    const answer = await terminalAnswer("Confirm you configured a spending cap enforced by the API provider. Type yes to continue: ", signal);
    confirmed = answer.toLowerCase() === "yes";
  }
  if (!confirmed) {
    throw fail("api_spend_cap_confirmation_required", "Configure an enforced spending cap with the API provider, then confirm it interactively or pass --confirm-api-spend-cap.", "configuration");
  }
  return { policy: { strategy, apiSpendCapConfirmed: true }, modes };
}

function configureMissingCredential(agent, mode, binding, target, version, env, signal) {
  signal.throwIfAborted();
  const args = [childEntry, version, agent, "--mode", mode, "--account", target.account, "--worker", target.worker];
  if (target.profile) args.push("--profile", target.profile);
  const child = spawn(process.execPath, args, {
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...cloudflareEnv(env, target), SANDBOX_RUNNER_CF_BIN: target.cfBin },
    signal,
  });
  let stdout = "";
  let failed = false;
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.on("error", () => { failed = true; });
  return new Promise((resolve, reject) => {
    child.once("close", code => {
      try {
        signal.throwIfAborted();
        const result = JSON.parse(stdout);
        if (!failed && code === 0 && result?.status === "configured" && result.agent === agent &&
            result.authMode === mode && result.account === target.account && result.worker === target.worker &&
            result.binding === binding && versionPattern.test(result.versionId) && result.versionId !== version) {
          return resolve(result.versionId);
        }
        if (!failed && [exit.usage, exit.configuration, exit.timeout, exit.requestFailure].includes(code) &&
            typeof result?.error === "string" && typeof result.message === "string") {
          return reject(new CliError(result.error, result.message, code, { uncertain: result.uncertain === true }));
        }
        throw new Error("Invalid auth child result");
      } catch (error) {
        if (signal.aborted) return reject(signal.reason);
        reject(fail("setup_credential_unverified", "Could not verify credential setup. Check the active Worker before trying again.", "requestFailure", true));
      }
    });
  });
}

export async function setupAgent(agent, args, env, timeout) {
  const options = parseAgentSetup(agent, args, env);
  const { target } = options;
  if (options.settings) {
    const { model, effort } = options.settings;
    const versionId = await configureWorkerDefaults(target, env, timeout, {
      values: { SANDBOX_RUNNER_CLAUDE_MODEL: model, SANDBOX_RUNNER_CLAUDE_EFFORT: effort },
      label: "Claude defaults", versionOptions: { requireClaudeDefaults: true },
    });
    return { status: "configured", agent, ...options.settings, account: target.account, worker: target.worker, versionId };
  }
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const progress = (label, action) => authProgress(interactive, env.TERM, label, action);
  const binding = `SANDBOX_RUNNER_${agent.toUpperCase()}_AUTH_STRATEGY`;
  const controller = new AbortController();
  const { signal } = controller;
  let mutationAttempted = false;
  let provisioning = false;
  const interrupt = () => controller.abort(fail(
    "setup_cancelled", "Setup was interrupted.", "configuration", mutationAttempted || provisioning,
  ));
  for (const name of signals) process.on(name, interrupt);
  let scratch;
  try {
    const { policy, modes } = await chooseStrategy(options, interactive, signal);
    const required = modes.map(mode => credentialBindings.get(agent + ":" + mode));
    scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-setup-"));
    const cf = cfCommand(target, scratch, env, {
      signal, timeout, onTimeout: () => fail("timeout", "The Cloudflare command timed out.", "timeout", mutationAttempted),
    });
    const readVersion = async () => {
      try {
        return await workerVersion(cf, { ...target, binding }, fail, {
          requireStrategies: true, bindingsToCheck: [binding, ...required],
        });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CliError) throw error;
        throw fail("cloudflare_read_failed", "Could not verify the Worker with cf. Check Cloudflare login, account, and Worker name.", "requestFailure");
      }
    };
    let version = await progress("Checking Cloudflare Worker…", readVersion);
    const missing = modes.filter((_mode, index) => !version.present.has(required[index]));
    if (missing.length && !interactive) {
      const commands = missing.map(mode => `sandbox-runner auth ${agent} --mode ${mode}`).join(" or ");
      throw fail("auth_strategy_credentials_missing", `Configure the missing credentials for this Worker with ${commands}, or run setup in a terminal.`, "configuration");
    }
    for (const [index, mode] of modes.entries()) {
      const credential = required[index];
      if (version.present.has(credential)) continue;
      provisioning = true;
      const configuredVersion = await configureMissingCredential(agent, mode, credential, target, version.id, env, signal);
      provisioning = false;
      const observed = await progress("Verifying configured credential…", readVersion);
      if (observed.id !== configuredVersion || !observed.present.has(credential) ||
          !required.every(name => !version.present.has(name) || observed.present.has(name))) {
        throw fail("worker_target_changed", "The active Worker or its credentials changed during setup. Restart setup to verify the current target.", "configuration");
      }
      process.stderr.write("Credential configured. Active Worker version verified.\n");
      version = observed;
    }
    const current = await progress("Rechecking Cloudflare Worker…", readVersion);
    if (current.id !== version.id || !required.every(name => current.present.has(name))) {
      throw fail("worker_target_changed", "The active Worker or its credentials changed during setup. Restart setup to verify the current target.", "configuration");
    }
    try {
      await updateSecret(cf, target, scratch, binding, JSON.stringify(policy), signal, action => {
        mutationAttempted = true;
        return progress("Publishing auth strategy…", action);
      });
      const after = await progress("Verifying active Worker version…", readVersion);
      if (after.id === current.id || !after.present.has(binding) || !required.every(name => after.present.has(name))) {
        throw new Error("Unverified strategy update");
      }
      return { status: "configured", agent, ...policy, account: target.account, worker: target.worker, binding, versionId: after.id };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof CliError && error.code === "timeout") throw error;
      if (mutationAttempted) {
        throw fail("cloudflare_update_unverified", "Could not confirm the strategy update. Check the active Cloudflare Worker version before trying again.", "requestFailure", true);
      }
      throw fail("setup_secret_file_failed", "Could not prepare the private strategy file.", "configuration");
    }
  } finally {
    try {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    } finally {
      for (const name of signals) process.removeListener(name, interrupt);
    }
  }
}
