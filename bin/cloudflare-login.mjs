import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { cfCommand, cloudflareEnv, signals } from "./auth.mjs";
import { CliError, exit, readTimeout } from "./cli-errors.mjs";
import { cloudflareProjectTarget } from "./cloudflare-project.mjs";

function loginOptions(args) {
  try {
    const parsed = parseArgs({ args, tokens: true, allowPositionals: true,
      options: { force: { type: "boolean" }, "no-browser": { type: "boolean" } } });
    const names = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
    if (parsed.positionals.length > 1 || parsed.positionals[0] === "" || new Set(names).size !== names.length) throw new Error();
    return { directory: parsed.positionals[0] ?? ".", force: parsed.values.force, noBrowser: parsed.values["no-browser"] };
  } catch {
    throw new CliError("usage_error", "Login accepts one project directory and the options --force and --no-browser.", exit.usage);
  }
}

function missingCf() {
  return new CliError("cf_unavailable", "Could not start the Cloudflare cf CLI. Install cf or set SANDBOX_RUNNER_CF_BIN.", exit.configuration);
}

function loginWithCf(target, cwd, env, signal, { force, noBrowser }) {
  const args = target.profile === "default"
    ? ["--profile", target.profile, "auth", "login", ...(force ? ["--force"] : [])]
    : ["auth", "create", target.profile];
  if (noBrowser) args.push("--no-browser");
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    // Keep cf's authorization prompts on stderr so stdout is a single receipt.
    const child = spawn(target.cfBin, args, { cwd, env: cloudflareEnv(env, target), stdio: ["inherit", 2, 2] });
    const stop = () => child.kill("SIGKILL");
    let launchFailed = false;
    signal.addEventListener("abort", stop, { once: true });
    child.once("error", () => { launchFailed = true; });
    child.once("close", code => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(signal.reason);
      else if (launchFailed) reject(missingCf());
      else if (code === 0) resolve();
      else reject(new CliError("cloudflare_login_failed", "Cloudflare sign-in did not complete.", exit.configuration));
    });
  });
}

async function accountAccess(cf, account, signal) {
  const unverified = () => new CliError("cloudflare_account_unverified",
    "Could not verify access to the project's Cloudflare account with the selected profile.", exit.configuration);
  let raw;
  try {
    raw = await cf("accounts", "get");
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof CliError) throw error;
    if (error.code === "ENOENT" || error.code === "EACCES") throw missingCf();
    return false;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw unverified();
  }
  if (typeof value?.id !== "string" || value.id.toLowerCase() !== account) throw unverified();
  return true;
}

export async function cloudflareLogin(args, env) {
  const options = loginOptions(args);
  const target = await cloudflareProjectTarget(options.directory, env);
  const timeout = readTimeout(env);
  const controller = new AbortController();
  const { signal } = controller;
  const interrupt = () => controller.abort(new CliError("cloudflare_login_interrupted",
    "Cloudflare sign-in was interrupted.", exit.requestFailure));
  const timeoutError = () => new CliError("timeout", "The Cloudflare account check timed out.", exit.timeout);
  const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-cloudflare-login-"));
  for (const name of signals) process.on(name, interrupt);
  try {
    const cf = cfCommand(target, scratch, env, { signal, timeout, onTimeout: timeoutError, killSignal: "SIGKILL" });
    if (options.force || !await accountAccess(cf, target.account, signal)) {
      await loginWithCf(target, scratch, env, signal, options);
      if (!await accountAccess(cf, target.account, signal)) {
        throw new CliError("cloudflare_account_unverified",
          "The Cloudflare profile could not access the project's account after sign-in.", exit.configuration);
      }
    }
    signal.throwIfAborted();
    return { status: "authenticated", account: target.account, profile: target.profile, worker: target.worker };
  } finally {
    for (const name of signals) process.removeListener(name, interrupt);
    await rm(scratch, { recursive: true, force: true });
  }
}
