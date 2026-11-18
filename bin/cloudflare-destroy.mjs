import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { cfCommand, signals, versionPattern } from "./auth.mjs";
import { CliError, exit, readTimeout } from "./cli-errors.mjs";
import { matchesDeployedContainers } from "./cloudflare-deploy.mjs";
import { cloudflareProjectTarget } from "./cloudflare-project.mjs";

const namespaceId = /^[a-f0-9]{32}$/i;
const workerIdPattern = /^[a-f0-9]{32}$/;
const workerPageSize = 100; // Workers API page size.
const namespacePageSize = 1000; // Durable Object namespaces API page maximum.

function destroyOptions(args) {
  try {
    const parsed = parseArgs({ args, tokens: true, allowPositionals: true,
      options: { receipt: { type: "string" }, "dry-run": { type: "boolean" } } });
    const names = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
    if (parsed.positionals.length > 1 || parsed.positionals[0] === "" || new Set(names).size !== names.length ||
        !parsed.values.receipt) throw new Error();
    return { directory: parsed.positionals[0] ?? ".", dryRun: parsed.values["dry-run"], receipt: parsed.values.receipt };
  } catch {
    throw new CliError("usage_error", "Destroy accepts one project directory, a required --receipt file and optional --dry-run.", exit.usage);
  }
}

async function readReceipt(path, target) {
  const invalid = new CliError("cloudflare_destroy_receipt_invalid",
    "The deployment receipt does not identify this project's account, profile, Worker, version and Container applications.", exit.configuration);
  const { account, worker, profile, sdkCommit } = target;
  try {
    const receipt = JSON.parse(await readFile(path, "utf8"));
    const version = receipt?.version;
    if (receipt?.status !== "deployed" || receipt.account !== account || receipt.worker !== worker || receipt.profile !== profile ||
        receipt.sdkCommit !== sdkCommit || typeof version?.id !== "string" || !versionPattern.test(version.id) ||
        !Number.isSafeInteger(version.number) || version.number < 1 || version.percentage !== 100 ||
        !Array.isArray(receipt.applications) || ![1, 2].includes(receipt.applications.length)) throw invalid;

    const expected = [{ name: target.applications.agent, className: "Run", schedulingPolicy: "durable-object" }];
    if (receipt.applications.length === 2) expected.push({ name: target.applications.vitest, className: "VitestRun", schedulingPolicy: "default" });
    const applications = expected.map(app => {
      const matched = receipt.applications.filter(candidate => candidate?.className === app.className);
      const candidate = matched[0];
      if (matched.length !== 1 || candidate.name !== app.name || candidate.schedulingPolicy !== app.schedulingPolicy ||
          typeof candidate.id !== "string" || !(namespaceId.test(candidate.id) || versionPattern.test(candidate.id)) ||
          typeof candidate.namespaceId !== "string" || !namespaceId.test(candidate.namespaceId)) throw invalid;
      return { ...app, id: candidate.id, namespaceId: candidate.namespaceId };
    });
    const { runIndexNamespaceId } = receipt;
    const namespaceIds = applications.map(app => app.namespaceId.toLowerCase());
    if (runIndexNamespaceId !== undefined) {
      if (typeof runIndexNamespaceId !== "string" || runIndexNamespaceId.length !== 32 || !namespaceId.test(runIndexNamespaceId)) throw invalid;
      namespaceIds.push(runIndexNamespaceId.toLowerCase());
    }
    if (new Set(applications.map(app => app.id.toLowerCase())).size !== applications.length ||
        new Set(namespaceIds).size !== namespaceIds.length) throw invalid;
    return { account, worker, profile, sdkCommit, version: { id: version.id, number: version.number, percentage: 100 }, applications,
      ...(runIndexNamespaceId === undefined ? {} : { runIndexNamespaceId }) };
  } catch {
    throw invalid;
  }
}

function targetUnverified() {
  return new CliError("cloudflare_destroy_target_unverified",
    "Cloudflare could not confirm the receipt's Worker version history and the identities of its active installation.", exit.configuration);
}

async function workerInventory(read, name, expectedId) {
  const seen = new Set();
  let matchedId;
  for (let page = 1; ; page++) {
    const workers = await read("workers", "list", "--page", String(page), "--per-page", String(workerPageSize));
    if (!Array.isArray(workers)) throw targetUnverified();
    for (const worker of workers) {
      if (typeof worker?.name !== "string" || typeof worker.id !== "string" || seen.has(worker.id)) throw targetUnverified();
      seen.add(worker.id);
      if (worker.name !== name && worker.id !== expectedId) continue;
      if (matchedId !== undefined || worker.name !== name || worker.id === name || !workerIdPattern.test(worker.id) ||
          (expectedId !== undefined && worker.id !== expectedId)) throw targetUnverified();
      matchedId = worker.id;
    }
    if (workers.length < workerPageSize) return matchedId;
  }
}

async function applicationInventory(read, apps) {
  // With no pagination flags, cf requests all apps. Match by ID as well as by name to catch renamed apps.
  const candidates = await read("containers", "applications", "list");
  if (!Array.isArray(candidates) || candidates.some(app => typeof app?.id !== "string" || typeof app.name !== "string")) throw targetUnverified();
  return apps.filter(app => {
    const matched = candidates.filter(candidate => candidate.id === app.id || candidate.name === app.name ||
      candidate.durable_objects?.namespace_id === app.namespaceId);
    if (matched.length === 0) return false;
    if (matched.length !== 1 || matched[0].id !== app.id || matched[0].name !== app.name ||
        matched[0].scheduling_policy !== app.schedulingPolicy.replace("-", "_") ||
        matched[0].durable_objects?.namespace_id !== app.namespaceId) throw targetUnverified();
    return true;
  });
}

async function namespaceInventory(read, worker, apps, runIndexNamespaceId) {
  const expected = [...apps, ...(runIndexNamespaceId === undefined ? [] : [{ className: "RunIndex", namespaceId: runIndexNamespaceId }])];
  const found = [];
  const seen = new Set();
  for (let page = 1; ; page++) {
    const namespaces = await read("durable-objects", "namespaces", "list", "--page", String(page), "--per-page", String(namespacePageSize));
    if (!Array.isArray(namespaces)) throw targetUnverified();
    for (const candidate of namespaces) {
      if (typeof candidate?.id !== "string" || typeof candidate.script !== "string" || seen.has(candidate.id)) throw targetUnverified();
      seen.add(candidate.id);
      const namespace = expected.find(item => item.namespaceId === candidate.id);
      if (!namespace && (candidate.script !== worker || !expected.some(item => item.className === candidate.class))) continue;
      if (!namespace || candidate.script !== worker || candidate.class !== namespace.className || candidate.use_sqlite !== true) throw targetUnverified();
      found.push(candidate.id);
    }
    if (namespaces.length < namespacePageSize) return found;
  }
}

async function readVersion(read, workerId, id, applications) {
  const details = await read("workers", "versions", "get", id, "--worker-id", workerId);
  if (details?.id !== id || !Number.isSafeInteger(details.number) || details.number < 1 || !Array.isArray(details.bindings) ||
      !matchesDeployedContainers(details.containers, applications)) throw targetUnverified();
  const mode = details.bindings.filter(binding => binding?.name === "SANDBOX_RUNNER_MODE");
  const control = details.bindings.filter(binding => binding?.name === "SANDBOX_RUNNER_TOKEN");
  if (mode.length !== 1 || mode[0].type !== "plain_text" || mode[0].text !== "real" ||
      control.length !== 1 || control[0].type !== "secret_text") throw targetUnverified();
  return { id, number: details.number, percentage: 100 };
}

async function readActiveVersionId(read, worker) {
  const deployments = await read("workers", "deployments", "list", "--worker", worker);
  const active = deployments?.deployments?.[0]?.versions;
  if (!Array.isArray(active) || active.length !== 1 || active[0]?.percentage !== 100 ||
      typeof active[0].version_id !== "string" || !versionPattern.test(active[0].version_id)) throw targetUnverified();
  return active[0].version_id;
}

async function verifyVersion(read, receipt, workerId) {
  const { worker, version, applications } = receipt;
  // Secret and settings changes can activate a new version without replacing the installation.
  const original = await readVersion(read, workerId, version.id, applications);
  if (original.number !== version.number) throw targetUnverified();
  const activeId = await readActiveVersionId(read, worker);
  if (activeId === original.id) return original;
  const active = await readVersion(read, workerId, activeId, applications);
  if (await readActiveVersionId(read, worker) !== active.id) throw targetUnverified();
  return active;
}

async function inventory(read, receipt, expectedWorkerId) {
  const { worker, applications, runIndexNamespaceId } = receipt;
  const workerId = await workerInventory(read, worker, expectedWorkerId);
  const apps = await applicationInventory(read, applications);
  const namespaces = await namespaceInventory(read, worker, applications, runIndexNamespaceId);
  return { workerId, apps, namespaces };
}

function unconfirmed(error) {
  return new CliError("cloudflare_destroy_unconfirmed",
    "Cloudflare deletion could not be confirmed. Inspect the installation with destroy --dry-run and the same receipt.",
    error?.code === "timeout" ? exit.timeout : exit.requestFailure, { uncertain: true });
}

async function deleteAndReadback(cf, read, receipt, workerId, args, stillPresent) {
  let failure;
  try {
    await cf(...args);
  } catch (error) {
    failure = error;
  }
  // A successful response alone does not establish deletion. After a lost response use the same inventory checks.
  const current = await inventory(read, receipt, workerId);
  if (stillPresent(current)) throw unconfirmed(failure);
  return current;
}

export async function cloudflareDestroy(args, env) {
  const options = destroyOptions(args);
  const target = await cloudflareProjectTarget(options.directory, env);
  const receipt = await readReceipt(options.receipt, target);
  const timeout = readTimeout(env);
  if (env.SANDBOX_RUNNER_CF_BIN === undefined) {
    const installed = join(target.directory, "node_modules", ".bin", "cf");
    if (await access(installed, constants.X_OK).then(() => true, () => false)) target.cfBin = installed;
  }
  const controller = new AbortController();
  const { signal } = controller;
  const interrupt = () => controller.abort(new CliError("interrupted", "Cloudflare destroy was interrupted.", exit.requestFailure));
  const onTimeout = () => new CliError("timeout", "The Cloudflare command timed out.", exit.timeout);
  const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-cloudflare-destroy-"));
  for (const name of signals) process.on(name, interrupt);
  let attempted = false;
  try {
    const childEnv = { ...env, NO_COLOR: "1" };
    delete childEnv.CLOUDFLARE_COMPLIANCE_REGION;
    delete childEnv.CLOUDFLARE_ZONE_ID;
    delete childEnv.CF_ZONE_ID;
    delete childEnv.FORCE_COLOR;
    const cf = cfCommand(target, scratch, childEnv, { signal, timeout, onTimeout, killSignal: "SIGKILL" });
    const read = async (...commandArgs) => {
      signal.throwIfAborted();
      return JSON.parse(await cf(...commandArgs));
    };
    const account = await read("accounts", "get");
    if (typeof account?.id !== "string" || account.id.toLowerCase() !== receipt.account) {
      throw new CliError("cloudflare_account_unverified", "Could not verify the project's Cloudflare account with the selected profile.", exit.configuration);
    }
    let current = await inventory(read, receipt);
    const { workerId } = current;
    let activeVersion;
    if (workerId !== undefined) {
      const namespaceCount = receipt.applications.length + Number(receipt.runIndexNamespaceId !== undefined);
      if (current.apps.length !== receipt.applications.length || current.namespaces.length !== namespaceCount) throw targetUnverified();
      activeVersion = await verifyVersion(read, receipt, workerId);
      const details = await read("workers", "get", workerId);
      if (details?.id !== workerId || details.name !== receipt.worker) throw targetUnverified();
    }
    const summary = { ...receipt, workerId, activeVersion, images: "retained" };
    if (options.dryRun) {
      return { status: "dry_run", ...summary, workerPresent: workerId !== undefined,
        applicationsPresent: current.apps.map(app => app.id), namespacesPresent: current.namespaces };
    }

    if (workerId !== undefined) {
      signal.throwIfAborted();
      attempted = true;
      // In cf beta.29, --force skips the prompt. --delete-with-references is the separate API override.
      current = await deleteAndReadback(cf, read, receipt, workerId, ["workers", "delete", workerId, "--force"], state => state.workerId !== undefined);
    }
    for (const app of receipt.applications) {
      if (!current.apps.includes(app)) continue;
      signal.throwIfAborted();
      attempted = true;
      current = await deleteAndReadback(cf, read, receipt, workerId, ["containers", "applications", "delete", app.id, "--force"],
        state => state.workerId !== undefined || state.apps.includes(app));
    }
    if (current.namespaces.length > 0 || current.apps.length > 0) throw unconfirmed();
    return { status: attempted ? "destroyed" : "already_destroyed", ...summary };
  } catch (error) {
    if (attempted && error?.code !== "cloudflare_destroy_unconfirmed") throw unconfirmed(error);
    signal.throwIfAborted();
    if (error instanceof CliError) throw error;
    if (error?.code === "ENOENT" || error?.code === "EACCES") {
      throw new CliError("cf_unavailable", "Could not start cf. Install the project dependencies or set SANDBOX_RUNNER_CF_BIN.", exit.configuration);
    }
    throw targetUnverified();
  } finally {
    try {
      await rm(scratch, { recursive: true, force: true });
    } finally {
      for (const name of signals) process.removeListener(name, interrupt);
    }
  }
}
