import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { signals } from "./auth.mjs";
import { CliError, exit, readTimeout } from "./cli-errors.mjs";
import { cloudflareDeploy } from "./cloudflare-deploy.mjs";
import { cloudflareInit, loadCloudflareTemplate } from "./cloudflare-init.mjs";
import { cloudflareLogin } from "./cloudflare-login.mjs";
import { cloudflareProjectTarget, manifestName, parseInstallationLimit } from "./cloudflare-project.mjs";

function setupOptions(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, tokens: true, options: {
      account: { type: "string" }, worker: { type: "string" }, profile: { type: "string" },
      "max-concurrent-runs": { type: "string" },
      "dry-run": { type: "boolean" }, "no-browser": { type: "boolean" }, "secrets-file": { type: "string" },
    } });
    const names = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
    if (parsed.positionals.length !== 1 || !parsed.positionals[0] || new Set(names).size !== names.length ||
        Object.values(parsed.values).includes("")) throw new Error();
  } catch {
    throw new CliError("usage_error", "Cloudflare setup requires one directory. Use sandbox-runner --help for options.", exit.usage);
  }
  const { account, worker, profile, "dry-run": dryRun, "no-browser": noBrowser, "secrets-file": secretsFile } = parsed.values;
  if (!dryRun && secretsFile === undefined) {
    throw new CliError("cloudflare_deploy_secret_invalid", "Supply --secrets-file with SANDBOX_RUNNER_TOKEN, or use --dry-run.", exit.configuration);
  }
  return { directory: resolve(parsed.positionals[0]), account, worker, profile, dryRun, noBrowser, secretsFile,
    maxConcurrentRuns: parseInstallationLimit(parsed.values["max-concurrent-runs"]) };
}

async function fileState(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function ensureProject(options, env) {
  const { directory, account, worker, profile, maxConcurrentRuns } = options;
  const state = await fileState(directory);
  if (!state) {
    const flags = Object.entries({ account, worker, profile, "max-concurrent-runs": maxConcurrentRuns }).filter(([, value]) => value !== undefined)
      .map(([name, value]) => `--${name}=${value}`);
    await cloudflareInit([directory, ...flags], env);
  } else if (!state.isDirectory() || !(await fileState(join(directory, manifestName)))?.isFile()) {
    throw new CliError("cloudflare_project_invalid", "Select a new directory or an initialized Cloudflare project.", exit.configuration);
  }
  const target = await cloudflareProjectTarget(directory, env);
  if ((account !== undefined && account.toLowerCase() !== target.account) ||
      (worker !== undefined && worker !== target.worker) || (profile !== undefined && profile !== target.profile) ||
      (maxConcurrentRuns !== undefined && maxConcurrentRuns !== target.maxConcurrentRuns)) {
    throw new CliError("cloudflare_project_target_mismatch",
      "The account, Worker, profile or concurrency limit differs from the initialized project.", exit.configuration);
  }
  return target;
}

async function verifySetupTemplate({ directory, sdkCommit }) {
  const mismatch = new CliError("cloudflare_setup_template_mismatch",
    "Setup expects the template from this CLI version. Use a new directory or prepare and deploy your reviewed project directly.", exit.configuration);
  const template = await loadCloudflareTemplate();
  if (sdkCommit !== template.sdkCommit) throw mismatch;
  try {
    // Setup executes the template's npm lifecycle and later loads its cf config.
    for (const [name, expected] of template.files) {
      const path = join(directory, name);
      if (!(await lstat(path)).isFile() || !(await readFile(path)).equals(expected)) throw mismatch;
    }
    for (const name of [".npmrc", ".npm-extension"]) {
      if (await fileState(join(directory, name))) throw mismatch;
    }
    for (const name of ["node_modules", "pinned-src"]) {
      const stat = await fileState(join(directory, name));
      if (stat && !stat.isDirectory()) throw mismatch;
    }
    const daemon = await fileState(join(directory, "daemon.mjs"));
    if (daemon && !daemon.isFile()) throw mismatch;
  } catch {
    throw mismatch;
  }
}

const packageEnvironment = new Set([
  "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TMPDIR", "TMP", "TEMP", "LANG",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO",
  "npm_config_cache", "NPM_CONFIG_CACHE",
]);

export function prepareDependencies(directory, env, timeout) {
  // Dependency lifecycle scripts need the toolchain and network configuration.
  // Cloudflare and provider credentials are used only by the later steps.
  const installerEnv = Object.fromEntries(Object.entries(env).filter(([key]) => packageEnvironment.has(key) ||
    key.startsWith("LC_") || ["http_proxy", "https_proxy", "all_proxy", "no_proxy"].includes(key)));
  if (env.SANDBOX_RUNNER_SDK_CHECKOUT) installerEnv.SANDBOX_RUNNER_SDK_CHECKOUT = resolve(env.SANDBOX_RUNNER_SDK_CHECKOUT);
  return new Promise((done, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn("npm", ["ci", `--prefix=${directory}`, "--workspaces=false", "--include=dev", "--ignore-scripts=false", "--no-audit", "--no-fund"], {
      cwd: directory, env: installerEnv, detached: grouped, stdio: "ignore",
    });
    let failure;
    const stop = error => {
      if (failure) return;
      failure = error;
      if (child.pid === undefined) return;
      try {
        if (grouped) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (killError) {
        if (killError.code !== "ESRCH") child.kill("SIGKILL");
      }
    };
    const interrupt = () => stop(new CliError("cloudflare_setup_interrupted", "Cloudflare setup was interrupted during npm ci.", exit.requestFailure));
    for (const signal of signals) process.on(signal, interrupt);
    const timer = timeout === undefined ? undefined : setTimeout(() => {
      stop(new CliError("timeout", "Preparing the Cloudflare project with npm ci timed out.", exit.timeout));
    }, timeout);
    child.once("error", () => {
      failure ??= new CliError("npm_unavailable", "Could not start npm. Install Node.js 24 or later with npm.", exit.configuration);
    });
    child.once("close", code => {
      clearTimeout(timer);
      for (const signal of signals) process.removeListener(signal, interrupt);
      if (failure) reject(failure);
      else if (code !== 0) reject(new CliError("cloudflare_setup_prepare_failed",
        "npm ci could not prepare the Cloudflare project. Run npm ci in the project directory to see the dependency error.", exit.configuration));
      else done();
    });
  });
}

function progress(message) {
  if (process.stderr.isTTY) process.stderr.write(`\n${message}\n\n`);
}

export async function cloudflareSetup(args, env) {
  const options = setupOptions(args);
  const timeout = env.SANDBOX_RUNNER_TIMEOUT_MS === undefined ? undefined : readTimeout(env);
  const target = await ensureProject(options, env);
  await verifySetupTemplate(target);
  const { directory } = target;
  progress("Preparing the Cloudflare project with npm ci…");
  await prepareDependencies(directory, env, timeout);
  const cfEnv = env.SANDBOX_RUNNER_CF_BIN === undefined
    ? { ...env, SANDBOX_RUNNER_CF_BIN: join(directory, "node_modules", ".bin", "cf") } : env;
  progress("Verifying the Cloudflare profile and account…");
  await cloudflareLogin([directory, ...(options.noBrowser ? ["--no-browser"] : [])], cfEnv);
  progress(options.dryRun ? "Building and checking the Cloudflare dry-run…" : "Building and deploying the Cloudflare Worker…");
  const receipt = await cloudflareDeploy([directory, ...(options.dryRun ? ["--dry-run"] : []),
    ...(options.secretsFile === undefined ? [] : [`--secrets-file=${options.secretsFile}`])], cfEnv);
  return { ...receipt, directory, manifest: manifestName };
}
