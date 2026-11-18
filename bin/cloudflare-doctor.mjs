import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { cfCommand, credentialBindings, resolveWorkerTarget, signals, versionPattern } from "./auth.mjs";
import { CliError, exit, readTimeout } from "./cli-errors.mjs";
import { openCodeProviders } from "./opencode-settings.mjs";

const capabilities = [
  "SANDBOX_RUNNER_AUTH_STRATEGIES",
  "SANDBOX_RUNNER_CLAUDE_DEFAULTS",
  "SANDBOX_RUNNER_PROVIDER_CONTRACT",
];
const namespacePageSize = 1000; // Maximum page size of the Cloudflare Durable Object namespaces API.
const cfVersionPattern = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|dev)(?:[.-]\d+)*)?$/;
const namespaceIdPattern = /^[a-f0-9]{32}$/i;

function configurationFailure(code, message) {
  return new CliError(code, message, exit.configuration);
}

function readTarget(args, env) {
  let parsed;
  try {
    parsed = parseArgs({
      args, tokens: true,
      options: { account: { type: "string" }, worker: { type: "string" }, profile: { type: "string" } },
    });
    const options = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
    if (new Set(options).size !== options.length) throw new Error();
  } catch {
    throw new CliError("usage_error", "Doctor accepts --account, --worker and --profile once each.", exit.usage);
  }
  return resolveWorkerTarget(parsed.values, env, (code, message) => configurationFailure(code, message));
}

function bindingStatus(bindings, name, verify) {
  const found = bindings.filter(binding => binding?.name === name);
  if (found.length === 0) return "missing";
  return found.length === 1 && verify(found[0]) ? "present" : "invalid";
}

function bindingChecks(bindings) {
  const secret = binding => binding.type === "secret_text";
  const plain = text => binding => binding.type === "plain_text" && binding.text === text;
  const required = Object.fromEntries([
    ["SANDBOX_RUNNER_MODE", bindingStatus(bindings, "SANDBOX_RUNNER_MODE", plain("real"))],
    ["SANDBOX_RUNNER_TOKEN", bindingStatus(bindings, "SANDBOX_RUNNER_TOKEN", secret)],
    ...capabilities.map(name => [name, bindingStatus(bindings, name, plain("1"))]),
  ]);
  const credentials = Object.fromEntries([...credentialBindings.values()].map(name => [
    name, bindingStatus(bindings, name, secret),
  ]));
  const capability = bindingStatus(bindings, "SANDBOX_RUNNER_OPENCODE", plain("1"));
  const opencode = capability === "missing" ? undefined : {
    capability,
    credentials: Object.fromEntries([...openCodeProviders].map(([provider, { binding }]) => [provider, bindingStatus(bindings, binding, secret)])),
  };
  return { required, credentials, ...(opencode === undefined ? {} : { opencode }) };
}

async function runNamespace(read, worker) {
  for (let page = 1; ; page++) {
    const namespaces = await read("durable-objects", "namespaces", "list", "--page", String(page), "--per-page", String(namespacePageSize));
    if (!Array.isArray(namespaces)) return;
    const matches = namespaces.filter(namespace => namespace?.script === worker && namespace.class === "Run");
    if (matches.length === 1 && matches[0].use_sqlite === true && typeof matches[0].id === "string" &&
        namespaceIdPattern.test(matches[0].id)) {
      return matches[0].id;
    }
    if (matches.length !== 0 || namespaces.length < namespacePageSize) return;
  }
}

async function runtimeCheck(read, version, worker) {
  if (!Array.isArray(version.containers)) return;
  const containers = version.containers.filter(container => container?.class_name === "Run");
  const name = containers[0]?.name;
  if (containers.length !== 1 || typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) return;
  const base = containers[0].images?.base;
  if (typeof base !== "string" || base.length === 0) return;
  const namespaceId = await runNamespace(read, worker);
  if (!namespaceId) return;
  const applications = await read("containers", "applications", "list", "--name", name);
  if (!Array.isArray(applications)) return;
  const matches = applications.filter(application => application?.name === name);
  const application = matches[0];
  if (matches.length !== 1 || typeof application.id !== "string" ||
      !(namespaceIdPattern.test(application.id) || versionPattern.test(application.id)) ||
      application.scheduling_policy !== "durable_object" ||
      application.durable_objects?.namespace_id !== namespaceId) return;
  return {
    durableObject: "Run", storage: "sqlite", namespaceId, application: name, applicationId: application.id,
    baseImageDigest: base.match(/(?:^|@)(sha256:[a-f0-9]{64})$/)?.[1],
  };
}

function deploymentId(value) {
  const versions = value?.deployments?.[0]?.versions;
  const current = versions?.[0];
  if (Array.isArray(versions) && versions.length === 1 && current?.percentage === 100 &&
      typeof current.version_id === "string" && versionPattern.test(current.version_id)) return current.version_id;
}

export async function cloudflareDoctor(args, env) {
  const target = readTarget(args, env);
  const timeout = readTimeout(env);
  const controller = new AbortController();
  const timeoutError = new CliError("timeout", "The Cloudflare diagnostic timed out.", exit.timeout);
  const interrupt = () => controller.abort(new CliError("interrupted", "The Cloudflare diagnostic was interrupted.", exit.requestFailure));
  const timer = setTimeout(() => controller.abort(timeoutError), timeout);
  for (const name of signals) process.on(name, interrupt);
  let scratch;
  try {
    // A local Cloudflare project could run code during configuration discovery.
    scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-cloudflare-doctor-"));
    const cf = cfCommand(target, scratch, env, {
      signal: controller.signal, timeout, onTimeout: () => timeoutError, killSignal: "SIGKILL",
    });
    const check = async (failure, read) => {
      try {
        controller.signal.throwIfAborted();
        const value = await read();
        controller.signal.throwIfAborted();
        if (value !== undefined) return value;
      } catch (error) {
        controller.signal.throwIfAborted();
        if (error === timeoutError) throw error;
      }
      throw failure;
    };
    const json = async (...command) => JSON.parse(await cf(...command));
    const cfVersion = await check(configurationFailure("cf_unavailable", "Could not verify the Cloudflare cf CLI. Install cf or set SANDBOX_RUNNER_CF_BIN."), async () => {
      const version = (await cf("--version")).trim();
      if (cfVersionPattern.test(version)) return version;
    });
    const accountFailure = configurationFailure("cloudflare_account_unverified", "Could not verify access to the selected Cloudflare account. Check the account and cf credentials.");
    await check(accountFailure, async () => {
      const account = await json("accounts", "get");
      if (typeof account?.id === "string" && account.id.toLowerCase() === target.account) return true;
    });
    const deployment = () => json("workers", "deployments", "list", "--worker", target.worker);
    const workerFailure = configurationFailure("worker_target_unverified", "Could not verify a single active Worker version serving 100% of traffic.");
    const id = await check(workerFailure, async () => deploymentId(await deployment()));
    const version = await check(workerFailure, async () => {
      const value = await json("workers", "versions", "get", id, "--worker-id", target.worker);
      if (value?.id === id && Array.isArray(value.bindings)) return value;
    });
    const bindings = bindingChecks(version.bindings);
    const issues = [];
    const openCodeCredentials = Object.values(bindings.opencode?.credentials ?? {});
    if (Object.values(bindings.required).some(status => status !== "present")) issues.push("worker_bindings_unverified");
    if (bindings.opencode?.capability === "invalid") issues.push("opencode_capability_invalid");
    if ([...Object.values(bindings.credentials), ...openCodeCredentials].includes("invalid")) issues.push("provider_bindings_invalid");
    if (Object.values(bindings.credentials).every(status => status !== "present") &&
        !(bindings.opencode?.capability === "present" && openCodeCredentials.includes("present"))) issues.push("provider_credentials_missing");
    const runtimeFailure = configurationFailure("cloudflare_runtime_unverified", "Could not verify the active Worker's Run Durable Object and linked Container application.");
    const runtime = await check(runtimeFailure, () => runtimeCheck(json, version, target.worker));
    await check(workerFailure, async () => deploymentId(await deployment()) === id ? id : undefined);
    return {
      output: {
        status: issues.length === 0 ? "ready" : "needs_setup",
        account: target.account,
        worker: target.worker,
        cfVersion,
        version: { id, percentage: 100, number: Number.isSafeInteger(version.number) ? version.number : undefined },
        bindings,
        runtime,
        issues,
      },
      exitCode: issues.length === 0 ? exit.success : exit.configuration,
    };
  } finally {
    clearTimeout(timer);
    try {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    } finally {
      for (const name of signals) process.removeListener(name, interrupt);
    }
  }
}
