import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { versionPattern } from "./auth.mjs";
import { accessServiceHeaders } from "./access-service-token.mjs";
import { CliError, exit, readTimeout } from "./cli-errors.mjs";
import { installedApplications, matchesDeployedContainers, rejectExportedSettings, reportedVersion, verifyActive,
  withVerifiedBuild } from "./cloudflare-deploy.mjs";
import { loadCloudflareTemplate, templateDigest } from "./cloudflare-init.mjs";
import { cloudflareProjectTarget, installationLimitBinding, manifestName, workerVersionBinding } from "./cloudflare-project.mjs";
import { prepareDependencies } from "./cloudflare-setup.mjs";
import release from "../package.json" with { type: "json" };

const control = "SANDBOX_RUNNER_TOKEN";
const guardBinding = "SANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN";
const guardPath = "/v4/admissions/guard";
const guardTokenPattern = /^guard-[a-f0-9]{64}$/;
const upgradeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const generationPattern = /^[1-9][0-9]*$/;

function configurationFailure(code, message) {
  return new CliError(code, message, exit.configuration);
}

function upgradeOptions(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, tokens: true, allowPositionals: true, options: {
      "dry-run": { type: "boolean" }, "guard-url": { type: "string" }, "guard-token-file": { type: "string" },
      "upgrade-id": { type: "string" }, "without-guard": { type: "boolean" },
    } });
    const names = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
    if (parsed.positionals.length > 1 || parsed.positionals[0] === "" || new Set(names).size !== names.length) throw new Error();
  } catch {
    throw new CliError("usage_error", "Upgrade accepts one project directory and the options --dry-run, --guard-url, " +
      "--guard-token-file, --upgrade-id and --without-guard.", exit.usage);
  }
  const values = parsed.values;
  const guard = values["guard-url"] !== undefined || values["guard-token-file"] !== undefined;
  if ((guard && (values["guard-url"] === undefined || values["guard-token-file"] === undefined)) ||
      (guard && values["without-guard"]) || (values["upgrade-id"] !== undefined && !guard) ||
      (values["upgrade-id"] !== undefined && !upgradeIdPattern.test(values["upgrade-id"]))) {
    throw new CliError("usage_error", "Pass --guard-url and --guard-token-file together, --upgrade-id (a lowercase UUID) only with them, " +
      "and --without-guard only for an installation without an admission guard.", exit.usage);
  }
  return { directory: parsed.positionals[0] ?? ".", dryRun: values["dry-run"] === true, withoutGuard: values["without-guard"] === true,
    guardUrl: values["guard-url"] === undefined ? undefined : guardOrigin(values["guard-url"]),
    guardTokenPath: values["guard-token-file"], upgradeId: values["upgrade-id"] };
}

// The guard is an operator route: an HTTPS ingress of the installation, or a loopback bridge to it.
function guardOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  const loopback = url && (url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname));
  if (!url || !/^https?:\/\/[^/\s@?#\\]+\/?$/iu.test(value) || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new CliError("usage_error", "--guard-url must be an HTTPS origin or an HTTP loopback origin.", exit.usage);
  }
  return url.origin;
}

async function guardToken(path) {
  const failure = () => configurationFailure("cloudflare_upgrade_guard_token_invalid",
    `Provide --guard-token-file with the guard token, alone or as ${guardBinding} in JSON or dotenv format.`);
  let text;
  try {
    text = await readFile(resolve(path), "utf8");
  } catch {
    throw failure();
  }
  let token = text.replace(/\r?\n$/, "");
  if (!guardTokenPattern.test(token)) {
    try {
      const values = text.trimStart().startsWith("{") ? JSON.parse(text) : parseEnv(text);
      token = values?.[guardBinding];
    } catch {
      token = undefined;
    }
  }
  if (typeof token !== "string" || !guardTokenPattern.test(token)) throw failure();
  return token;
}

function guardClient(origin, token, timeout) {
  const unavailable = () => new CliError("cloudflare_upgrade_guard_unavailable",
    "Could not read the admission guard. Check --guard-url, the guard token and the installation's ingress.", exit.requestFailure);
  async function call(method, body) {
    let response;
    try {
      response = await fetch(origin + guardPath, {
        method, redirect: "manual", signal: AbortSignal.timeout(timeout),
        headers: { authorization: `Bearer ${token}`, ...accessServiceHeaders(),
          ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw unavailable();
    }
    if (response.status === 409) {
      throw configurationFailure("cloudflare_upgrade_guard_conflict", "The admission guard holds another closure. Pass its --upgrade-id or wait for its operator.");
    }
    let state;
    try {
      state = response.ok ? await response.json() : undefined;
    } catch {
      state = undefined;
    }
    if (!state || state.protocolVersion !== 1 || typeof state.status !== "string" ||
        (state.upgradeId !== null && !upgradeIdPattern.test(state.upgradeId)) ||
        (state.generation !== null && !generationPattern.test(state.generation))) throw unavailable();
    return state;
  }
  return { read: () => call("GET"), close: upgradeId => call("POST", { action: "close", upgradeId }) };
}

/** Template files of this CLI that the project lacks or holds with different content. */
async function templateChanges(directory, template) {
  const changed = [];
  for (const [name, expected] of template.files) {
    const current = await readFile(join(directory, name)).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!current?.equals(expected)) changed.push(name);
  }
  return changed;
}

async function replaceFile(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.upgrade-${process.pid}`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

/**
 * Writes the template files, prepares the dependencies, then records the template in the manifest. Until that
 * last write the manifest names the earlier template, so a failure is repaired by running upgrade again.
 */
async function applyTemplate(directory, template, digest, changed, env, timeout) {
  // npm ci empties node_modules before installing. Through a link, that would empty the directory it points to.
  if ((await lstat(join(directory, "node_modules")).catch(() => undefined))?.isSymbolicLink()) {
    throw configurationFailure("cloudflare_upgrade_shared_dependencies",
      "The project's node_modules is a link to another directory, which npm ci would empty. Replace it with the project's own install.");
  }
  for (const name of changed) await replaceFile(join(directory, name), template.files.get(name));
  await prepareDependencies(directory, env, timeout);
  const manifestPath = join(directory, manifestName);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await replaceFile(manifestPath, JSON.stringify({ ...manifest, cliVersion: release.version, sdkCommit: template.sdkCommit,
    templateDigest: digest }, null, 2) + "\n");
}

function binding(version, name) {
  return version.bindings.filter(candidate => candidate?.name === name);
}

/** The single version serving all traffic and the facts the upgrade must preserve. */
async function activeVersion(read, target) {
  const unverified = () => configurationFailure("cloudflare_upgrade_target_unverified",
    "Could not verify one Sandbox Runner version serving all traffic on the project's Worker. Use cloudflare deploy for a new installation.");
  try {
    const deployment = await read("workers", "deployments", "list", "--worker", target.worker);
    const versions = deployment?.deployments?.[0]?.versions;
    if (!Array.isArray(versions) || versions.length !== 1 || versions[0]?.percentage !== 100 ||
        typeof versions[0].version_id !== "string" || !versionPattern.test(versions[0].version_id)) throw new Error();
    const id = versions[0].version_id;
    const version = await read("workers", "versions", "get", id, "--worker-id", target.worker);
    if (version?.id !== id || !Number.isSafeInteger(version.number) || !Array.isArray(version.bindings)) throw new Error();
    const mode = binding(version, "SANDBOX_RUNNER_MODE");
    const token = binding(version, control);
    if (mode.length !== 1 || mode[0].type !== "plain_text" || mode[0].text !== "real" ||
        token.length !== 1 || token[0].type !== "secret_text") throw new Error();
    const guard = binding(version, guardBinding);
    if (guard.length > 1 || (guard.length === 1 && guard[0].type !== "secret_text")) throw new Error();
    return { id, number: version.number, guard: guard.length === 1 };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw unverified();
  }
}

function sameApplications(before, after) {
  return before.length === after.length && before.every(app => after.some(candidate =>
    candidate.className === app.className && candidate.name === app.name && candidate.id === app.id && candidate.namespaceId === app.namespaceId));
}

async function verifyUpgrade(read, target, buildOutput, versionId, message, previous, before) {
  await verifyActive(read, target, versionId);
  const version = await read("workers", "versions", "get", versionId, "--worker-id", target.worker);
  const { apps, namespaceClasses, hasVersionMetadata } = buildOutput;
  if (version?.id !== versionId || version.number <= previous.number || version.annotations?.["workers/message"] !== message ||
      !Array.isArray(version.bindings) || !matchesDeployedContainers(version.containers, apps)) throw new Error();
  const mode = binding(version, "SANDBOX_RUNNER_MODE");
  const token = binding(version, control);
  const guard = binding(version, guardBinding);
  const limit = binding(version, installationLimitBinding);
  const metadata = binding(version, workerVersionBinding);
  if (mode.length !== 1 || mode[0].type !== "plain_text" || mode[0].text !== "real" ||
      token.length !== 1 || token[0].type !== "secret_text" ||
      guard.length !== (previous.guard ? 1 : 0) || (previous.guard && guard[0].type !== "secret_text")) throw new Error();
  if (target.maxConcurrentRuns === undefined ? limit.length !== 0
    : limit.length !== 1 || limit[0].type !== "plain_text" || limit[0].text !== String(target.maxConcurrentRuns)) throw new Error();
  if (hasVersionMetadata ? metadata.length !== 1 || metadata[0].type !== "version_metadata" : metadata.length !== 0) throw new Error();
  // The run state lives in these Durable Objects: an upgrade must keep every namespace and Container application.
  const after = await installedApplications(read, target, apps, namespaceClasses);
  if (!sameApplications(before.applications, after.applications) ||
      after.namespaces.get("RunIndex") !== before.namespaces.get("RunIndex")) throw new Error();
  await verifyActive(read, target, versionId);
  return { id: versionId, number: version.number, percentage: 100 };
}

function frozen(error, closure) {
  const note = ` Admissions stay frozen by upgrade ${closure.upgradeId}` +
    (closure.generation ? ` (generation ${closure.generation})` : "") + `: run upgrade again with --upgrade-id ${closure.upgradeId}, or reopen them.`;
  if (error instanceof CliError) {
    return new CliError(error.code, error.message + note, error.exitCode, { uncertain: error.uncertain });
  }
  return new CliError("cloudflare_upgrade_interrupted", "The upgrade stopped before switching versions." + note, exit.requestFailure);
}

/**
 * Without a guard nothing freezes admissions, so the switch must find no run in flight: no container instance active,
 * assigned, starting or being scheduled. Prewarmed idle instances do not count. A run admitted after this read can
 * still be interrupted; only a guard closes that window.
 */
async function busyInstances(read, applications) {
  let busy = 0;
  for (const app of applications) {
    const listed = await read("containers", "applications", "list", "--name", app.name);
    const matched = (Array.isArray(listed) ? listed : []).filter(candidate => candidate?.name === app.name);
    const instances = matched.length === 1 ? matched[0].health?.instances : undefined;
    // An application whose instance health cannot be read cannot prove it is idle.
    if (instances === null || typeof instances !== "object" || !Number.isSafeInteger(instances.active)) {
      throw configurationFailure("cloudflare_upgrade_instances_unverified",
        `Could not read the instance health of ${app.name}, so the upgrade cannot prove no run is in flight.`);
    }
    for (const state of ["active", "assigned", "starting", "scheduling"]) {
      const count = instances[state] ?? 0;
      if (!Number.isSafeInteger(count) || count < 0) {
        throw configurationFailure("cloudflare_upgrade_instances_unverified", `Unreadable instance health for ${app.name}.`);
      }
      busy += count;
    }
  }
  return busy;
}

/** Reads the guard until the new version answers for the same drained closure, within the command timeout. */
async function guardAfterSwitch(guard, closure, versionId, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await guard.read();
    if (state.upgradeId !== closure.upgradeId || state.generation !== closure.generation || state.status !== "drained") throw new Error();
    if (state.workerVersionId === versionId) return state;
    if (Date.now() >= deadline) throw new Error();
    await new Promise(done => setTimeout(done, 1000));
  }
}

export async function cloudflareUpgrade(args, env) {
  const options = upgradeOptions(args);
  accessServiceHeaders(env);
  const target = await cloudflareProjectTarget(options.directory, env);
  rejectExportedSettings(env);
  const timeout = readTimeout(env);
  const token = options.guardTokenPath === undefined ? undefined : await guardToken(options.guardTokenPath);
  const guard = token === undefined ? undefined : guardClient(options.guardUrl, token, timeout);
  const summary = () => ({ account: target.account, worker: target.worker, profile: target.profile, sdkCommit: target.sdkCommit });
  const template = await loadCloudflareTemplate();
  const digest = templateDigest(template.files);
  const manifest = JSON.parse(await readFile(join(target.directory, manifestName), "utf8"));
  const changed = await templateChanges(target.directory, template);
  // A manifest without this template's digest has not finished a refresh: prepare its dependencies again.
  const refresh = changed.length > 0 || manifest.templateDigest !== digest;

  // 1. Read the installation before changing anything, including the project.
  const preflight = async ({ read }) => {
    const previous = await activeVersion(read, target);
    if (previous.guard && !guard) {
      throw configurationFailure("cloudflare_upgrade_guard_required",
        "This installation has an admission guard. Pass --guard-url and --guard-token-file so the upgrade can freeze admissions.");
    }
    if (!previous.guard && (guard || !options.withoutGuard)) {
      throw configurationFailure("cloudflare_upgrade_guard_absent",
        "This installation has no admission guard. Pass --without-guard to switch versions without freezing admissions.");
    }
    let state;
    if (guard) {
      state = await guard.read();
      if (state.workerVersionId !== previous.id) {
        throw configurationFailure("cloudflare_upgrade_guard_unverified", "The guard did not answer from the version serving all traffic.");
      }
      if (state.status === "legacy_unverified" || state.status === "cleanup_failed") {
        throw configurationFailure("cloudflare_upgrade_guard_blocked",
          `The admission guard reports ${state.status}. Resolve it with the guard API before changing versions.`);
      }
      if (state.status !== "open" && state.upgradeId !== options.upgradeId && !options.dryRun) {
        throw configurationFailure("cloudflare_upgrade_guard_closed",
          `The admission guard is already closed by ${state.upgradeId}. Pass --upgrade-id ${state.upgradeId} if this upgrade owns that closure.`);
      }
    }
    const report = { ...summary(), templateChanges: changed, previousVersion: { id: previous.id, number: previous.number },
      guard: state ? { status: state.status, upgradeId: state.upgradeId, generation: state.generation } : { status: "absent" } };
    if (refresh) {
      if (options.dryRun) return { result: { output: { status: "dry_run", ...report, built: false }, exitCode: exit.success } };
      // 2. Bring the project to this CLI's template. Its settings stay in the manifest.
      await applyTemplate(target.directory, template, digest, changed, env, env.SANDBOX_RUNNER_TIMEOUT_MS === undefined ? undefined : timeout);
      target.sdkCommit = template.sdkCommit;
      report.sdkCommit = template.sdkCommit;
    }
    return { context: { previous, report } };
  };

  return withVerifiedBuild(target, env, "upgrade", async ({ read, buildOutput, upload: uploader, signal, context }) => {
    const { previous, report } = context;
    let before;
    try {
      before = await installedApplications(read, target, buildOutput.apps, buildOutput.namespaceClasses);
    } catch {
      throw configurationFailure("cloudflare_upgrade_topology_changed",
        "The installed Durable Objects and Container applications differ from this build: the manifest names other ones, or the release adds " +
        "one. Upgrade only switches versions of an unchanged topology.");
    }
    if (options.dryRun) {
      return { output: { status: "dry_run", ...report, built: true, applications: before.applications }, exitCode: exit.success };
    }

    // 3. Freeze admissions: close the guard, or adopt the closure named by --upgrade-id.
    let closure;
    if (guard) {
      let state = await guard.read();
      if (state.workerVersionId !== previous.id) {
        throw configurationFailure("cloudflare_upgrade_guard_unverified", "The guard did not answer from the version serving all traffic.");
      }
      if (state.status === "open") {
        const upgradeId = options.upgradeId ?? randomUUID();
        try {
          state = await guard.close(upgradeId);
        } catch (error) {
          // A conflict is a definite refusal; any other failure may have closed the guard.
          if (error.code === "cloudflare_upgrade_guard_conflict") throw error;
          throw new CliError(error.code ?? "cloudflare_upgrade_guard_unavailable", `${error.message} The close request for upgrade ${upgradeId} ` +
            `may have frozen admissions: read the guard, then run upgrade again with --upgrade-id ${upgradeId}.`,
          error.exitCode ?? exit.requestFailure, { uncertain: true });
        }
      } else if (state.upgradeId !== options.upgradeId) {
        throw configurationFailure("cloudflare_upgrade_guard_closed",
          `The admission guard is already closed by ${state.upgradeId}. Pass --upgrade-id ${state.upgradeId} if this upgrade owns that closure.`);
      }
      closure = { upgradeId: state.upgradeId, generation: state.generation };
      if (state.status !== "drained") {
        if (state.status !== "draining") throw frozen(configurationFailure("cloudflare_upgrade_guard_blocked", `The admission guard reports ${state.status}.`), closure);
        // Admissions are frozen; runs already admitted finish on the current version.
        return { output: { status: "draining", ...report, guard: { status: state.status, ...closure, pendingCount: state.pendingCount } },
          exitCode: exit.capacity };
      }
    }

    // 4. Switch versions, then check that the installation kept its state.
    let upload;
    try {
      upload = await uploader();
      // Recheck right before the switch: the same version serves all traffic and the same closure is still drained.
      await verifyActive(read, target, previous.id);
      if (!closure) {
        const busy = await busyInstances(read, before.applications);
        if (busy > 0) {
          throw configurationFailure("cloudflare_upgrade_runs_active",
            `${busy} container instance(s) are running. Without an admission guard, upgrade switches versions only when no run is in flight; retry later.`);
        }
      }
      if (closure) {
        const state = await guard.read();
        if (state.upgradeId !== closure.upgradeId || state.generation !== closure.generation || state.status !== "drained" ||
            state.workerVersionId !== previous.id) {
          throw configurationFailure("cloudflare_upgrade_guard_changed", "The admission guard changed before the version switch.");
        }
      }
      signal.throwIfAborted();
    } catch (error) {
      if (closure) throw frozen(error, closure);
      if (error instanceof CliError) throw error;
      throw configurationFailure("cloudflare_upgrade_target_unverified", "The Worker changed before the version switch.");
    }
    const marker = "Sandbox Runner upgrade " + randomUUID();
    let version;
    try {
      const { stdout, stderr } = await upload("deploy", "--prebuilt", "--message", marker);
      const versionId = reportedVersion(stdout + "\n" + stderr);
      if (versionId === undefined) throw new Error();
      version = await verifyUpgrade(read, target, buildOutput, versionId, marker, previous, before);
      if (closure) await guardAfterSwitch(guard, closure, versionId, timeout);
    } catch (error) {
      throw new CliError("cloudflare_upgrade_unconfirmed",
        `The upgrade could not be verified. Check the Worker before reopening admissions; the previous version is ${previous.id}.` +
        (closure ? ` Admissions stay frozen by upgrade ${closure.upgradeId} (generation ${closure.generation}).` : ""),
        error?.code === "timeout" ? exit.timeout : exit.requestFailure, { uncertain: true });
    }
    return { output: {
      status: "upgraded", ...report, version, applications: before.applications,
      // Upgrade checks the deployment; a canary run checks the Worker, container runtime and agent together.
      next: "Run sandbox-runner cloudflare canary once admissions are open.",
      ...(before.namespaces.has("RunIndex") ? { runIndexNamespaceId: before.namespaces.get("RunIndex") } : {}),
      guard: closure ? { status: "drained", ...closure,
        reopen: { method: "POST", path: guardPath, body: { action: "open", upgradeId: closure.upgradeId, generation: closure.generation } } }
        : { status: "absent" },
    }, exitCode: exit.success };
  }, preflight);
}
