import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { cfCommand, cloudflareEnv, signals, versionPattern } from "./auth.mjs";
import { CliError, exit, readTimeout } from "./cli-errors.mjs";
import { inspectBuild } from "./cloudflare-build-output.mjs";
import { dockerBuildEnv, dockerUploadEnv } from "./cloudflare-deploy-docker.mjs";
import { projectSettings } from "../worker/project-config.mjs";
import { cloudflareProjectTarget, installationLimitBinding, manifestName, workerTemplateFiles, workerVersionBinding } from "./cloudflare-project.mjs";

const control = "SANDBOX_RUNNER_TOKEN";
// Every new installation gets its admission guard with its first version, so the guard tracks every admission and
// cloudflare upgrade can freeze and drain runs before a version change. It cannot be added once runs exist.
const guard = "SANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN";
const guardTokenPattern = /^guard-[a-f0-9]{64}$/;
const workerPageSize = 100; // Workers API pagination parameter.
const namespacePageSize = 1000; // Durable Object namespaces API page maximum.
const namespaceId = /^[a-f0-9]{32}$/i;
const requiredProjectFiles = [
  ".dockerignore", "Dockerfile", "cloudflare.config.ts", "daemon.mjs", "daemon.ts", "package-lock.json",
  "package.json", "prepare-sdk.sh", "vite.config.ts", "worker.ts",
];

function configurationFailure(code, message) {
  return new CliError(code, message, exit.configuration);
}

function deployOptions(args) {
  try {
    const parsed = parseArgs({ args, tokens: true, allowPositionals: true,
      options: { "dry-run": { type: "boolean" }, "secrets-file": { type: "string" } } });
    const names = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
    if (parsed.positionals.length > 1 || parsed.positionals[0] === "" || new Set(names).size !== names.length ||
        parsed.values["secrets-file"] === "") throw new Error();
    return { directory: parsed.positionals[0] ?? ".", dryRun: parsed.values["dry-run"], secretPath: parsed.values["secrets-file"] };
  } catch {
    throw new CliError("usage_error", "Deploy accepts one project directory and the options --dry-run and --secrets-file.", exit.usage);
  }
}

async function firstSecrets(path) {
  const failure = () => configurationFailure("cloudflare_deploy_secret_invalid",
    `Provide --secrets-file with ${control} and ${guard} (guard- followed by 64 lowercase hexadecimal digits), ` +
    "distinct from each other, in JSON or dotenv format.");
  try {
    if (path === undefined) throw failure();
    const text = await readFile(resolve(path), "utf8");
    const values = text.trimStart().startsWith("{") ? JSON.parse(text) : parseEnv(text);
    if (!values || Object.keys(values).length !== 2 || typeof values[control] !== "string" ||
        !/^[A-Za-z0-9._~+\/-]+=*$/.test(values[control]) || typeof values[guard] !== "string" ||
        !guardTokenPattern.test(values[guard]) || values[guard] === values[control]) throw failure();
    return { [control]: values[control], [guard]: values[guard] };
  } catch {
    throw failure();
  }
}

function deployEnvironment(env, target) {
  const result = cloudflareEnv(env, target);
  for (const key of Object.keys(result)) {
    if (/^SANDBOX_RUNNER_.*FIXTURES$/.test(key)) delete result[key];
  }
  for (const key of [
    "CLOUDFLARE_CONTAINER_REGISTRY", "CLOUDFLARE_COMPLIANCE_REGION", "CLOUDFLARE_ZONE_ID", "CF_ZONE_ID",
    "WRANGLER_DOCKER_HOST", "FORCE_COLOR",
    // The project manifest records the remote MCP settings; ambient values from another project must not win.
    "SANDBOX_RUNNER_ACCESS_AUD", "SANDBOX_RUNNER_ACCESS_TEAM_DOMAIN",
  ]) delete result[key];
  result.NO_COLOR = "1";
  return result;
}

async function projectFileExists(directory, path) {
  const components = path.split("/");
  for (const [index, component] of components.entries()) {
    directory = join(directory, component);
    const entry = await lstat(directory).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!entry) return false;
    if (index === components.length - 1 ? !entry.isFile() : !entry.isDirectory()) {
      throw new Error("Invalid project file");
    }
  }
  return true;
}

async function stageProject(target, directory) {
  const failure = configurationFailure("cloudflare_project_unprepared",
    "Prepare the initialized Cloudflare project with npm ci before deployment.");
  try {
    await mkdir(directory, { mode: 0o700 });
    // Older reviewed projects may predate newly added modules. The build checks
    // their imports and image contexts using only the files in their own tree.
    const files = new Set([...requiredProjectFiles, ...workerTemplateFiles.map(file => file.slice("worker/".length))]);
    for (const path of files) {
      if (!await projectFileExists(target.directory, path)) {
        if (requiredProjectFiles.includes(path)) throw failure;
        continue;
      }
      const source = join(target.directory, path);
      const dest = join(directory, path);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(source, dest, constants.COPYFILE_EXCL);
    }
    // The Worker config reads the remote MCP (Access) settings that `cloudflare access enable` recorded here.
    await copyFile(join(target.directory, manifestName), join(directory, manifestName), constants.COPYFILE_EXCL);
    if (target.usesInstallationSettings &&
        !(await readFile(join(directory, "cloudflare.config.ts"), "utf8")).includes("resolveProjectSettings(")) {
      throw configurationFailure("cloudflare_project_outdated",
        "The project's Worker template predates installation settings. Run cloudflare upgrade to replace them before using settings or containers.");
    }
    const prepare = await readFile(join(directory, "prepare-sdk.sh"), "utf8");
    if (prepare.match(/^pin=([a-f0-9]{40})$/m)?.[1] !== target.sdkCommit) {
      throw configurationFailure("cloudflare_sdk_pin_mismatch", "The project's ContainerHarness pin does not match its manifest.");
    }
    const pinned = join(target.directory, "pinned-src");
    if (!(await lstat(pinned)).isDirectory()) throw failure;
    await cp(pinned, join(directory, "pinned-src"), { recursive: true, errorOnExist: true, force: false });
    const dependencies = await realpath(join(target.directory, "node_modules"));
    await symlink(dependencies, join(directory, "node_modules"), "dir");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw failure;
  }
}

async function rejectDotenv(directory) {
  const files = await readdir(directory);
  if (files.some(file => /^(?:\.env|\.dev\.vars)(?:\.|$)/.test(file))) {
    throw configurationFailure("cloudflare_deploy_dotenv", "Unexpected dotenv files appeared in the isolated Cloudflare build.");
  }
}

async function targetAbsent(read, target, apps) {
  const alreadyExists = () => configurationFailure("cloudflare_target_exists",
    "The Worker or a Container application already exists. Use cloudflare upgrade for an existing installation.");
  const uncertainRead = () => configurationFailure("cloudflare_target_unverified", "Could not verify that the Worker and Container applications are new.");
  try {
    for (let page = 1; ; page++) {
      const workers = await read("workers", "list", "--page", String(page), "--per-page", String(workerPageSize));
      if (!Array.isArray(workers) || workers.some(worker => typeof worker?.name !== "string" && typeof worker?.id !== "string")) throw uncertainRead();
      if (workers.some(worker => worker.name === target.worker || worker.id === target.worker)) throw alreadyExists();
      if (workers.length < workerPageSize) break;
    }
    for (const app of apps) {
      const candidates = await read("containers", "applications", "list", "--name", app.name);
      if (!Array.isArray(candidates) || candidates.some(candidate => typeof candidate?.name !== "string")) throw uncertainRead();
      if (candidates.some(candidate => candidate.name === app.name)) throw alreadyExists();
    }
    if (target.maxConcurrentRuns !== undefined) {
      for (let page = 1; ; page++) {
        const namespaces = await read("durable-objects", "namespaces", "list", "--page", String(page), "--per-page", String(namespacePageSize));
        if (!Array.isArray(namespaces)) throw uncertainRead();
        if (namespaces.some(namespace => namespace?.script === target.worker)) throw alreadyExists();
        if (namespaces.length < namespacePageSize) break;
      }
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw uncertainRead();
  }
}

export async function verifyActive(read, target, versionId) {
  const deployment = await read("workers", "deployments", "list", "--worker", target.worker);
  const versions = deployment?.deployments?.[0]?.versions;
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0]?.version_id !== versionId ||
      versions[0].percentage !== 100) throw new Error();
}

export async function readNamespaces(read, worker, namespaceClasses) {
  const names = new Set(namespaceClasses);
  const found = new Map();
  for (let page = 1; ; page++) {
    const namespaces = await read("durable-objects", "namespaces", "list", "--page", String(page), "--per-page", String(namespacePageSize));
    if (!Array.isArray(namespaces)) throw new Error();
    for (const candidate of namespaces) {
      if (candidate?.script !== worker || !names.has(candidate.class)) continue;
      if (found.has(candidate.class) || candidate.use_sqlite !== true ||
          typeof candidate.id !== "string" || candidate.id.length !== 32 || !namespaceId.test(candidate.id) ||
          [...found.values()].some(id => id.toLowerCase() === candidate.id.toLowerCase())) throw new Error();
      found.set(candidate.class, candidate.id);
    }
    if (found.size === names.size) return found;
    if (namespaces.length < namespacePageSize) throw new Error();
  }
}

export function matchesDeployedContainers(containers, apps) {
  return Array.isArray(containers) && containers.length === apps.length && apps.every(app =>
    containers.filter(container => container?.class_name === app.className && container.name === app.name).length === 1);
}

/** The Durable Object namespaces of the Worker and the Container application bound to each, or throws. */
export async function installedApplications(read, target, apps, namespaceClasses) {
  const namespaces = await readNamespaces(read, target.worker, namespaceClasses);
  const applications = [];
  for (const app of apps) {
    const candidates = await read("containers", "applications", "list", "--name", app.name);
    if (!Array.isArray(candidates)) throw new Error();
    const matched = candidates.filter(candidate => candidate?.name === app.name);
    const id = matched[0]?.id;
    const expectedNamespace = namespaces.get(app.className);
    if (matched.length !== 1 || typeof id !== "string" || !(namespaceId.test(id) || versionPattern.test(id)) ||
        matched[0].scheduling_policy !== app.schedulingPolicy.replace("-", "_") ||
        matched[0].durable_objects?.namespace_id !== expectedNamespace) throw new Error();
    applications.push({ ...app, id, namespaceId: expectedNamespace });
  }
  return { namespaces, applications };
}

async function deployedVersion(read, target, { apps, namespaceClasses, hasVersionMetadata }, versionId, message) {
  await verifyActive(read, target, versionId);
  const version = await read("workers", "versions", "get", versionId, "--worker-id", target.worker);
  if (version?.id !== versionId || version.number !== 1 || version.annotations?.["workers/message"] !== message ||
      !Array.isArray(version.bindings) || !matchesDeployedContainers(version.containers, apps)) throw new Error();
  const mode = version.bindings.filter(binding => binding?.name === "SANDBOX_RUNNER_MODE");
  const secrets = version.bindings.filter(binding => binding?.type === "secret_text");
  const limit = version.bindings.filter(binding => binding?.name === installationLimitBinding);
  const metadata = version.bindings.filter(binding => binding?.name === workerVersionBinding);
  if (mode.length !== 1 || mode[0].type !== "plain_text" || mode[0].text !== "real" ||
      secrets.length !== 2 || !secrets.some(secret => secret.name === control) || !secrets.some(secret => secret.name === guard) ||
      version.bindings.filter(binding => binding?.name === control).length !== 1) throw new Error();
  if (target.maxConcurrentRuns === undefined ? limit.length !== 0
    : limit.length !== 1 || limit[0].type !== "plain_text" || limit[0].text !== String(target.maxConcurrentRuns)) throw new Error();
  if (hasVersionMetadata ? metadata.length !== 1 || metadata[0].type !== "version_metadata" : metadata.length !== 0) throw new Error();
  const { namespaces, applications } = await installedApplications(read, target, apps, namespaceClasses);
  await verifyActive(read, target, versionId);
  const runIndexNamespaceId = namespaces.get("RunIndex");
  return { version: { id: versionId, number: version.number, percentage: 100 }, applications,
    ...(runIndexNamespaceId === undefined ? {} : { runIndexNamespaceId }) };
}

/** A project build reads its settings from the manifest only. Refuse rather than drop a value exported for it. */
export function rejectExportedSettings(env) {
  // The allowlist may be exported to provision the Worker secret of the same name.
  const exported = Object.keys(projectSettings).filter(name => name !== "SANDBOX_RUNNER_GITHUB_ALLOWLIST" && env[name] !== undefined);
  if (exported.length > 0) {
    throw configurationFailure("cloudflare_setting_in_environment",
      `Record ${exported.join(", ")} under "settings" in ${manifestName} and unset it: a project build ignores the environment.`);
  }
}

/**
 * Runs `work` with a verified account, an isolated copy of the project built by cf and checked against the
 * manifest, and a validated `cf deploy --prebuilt --dry-run`. The scratch directory is removed afterwards.
 * `beforeBuild` runs once the account is verified and before the project is copied; it may return
 * `{ result }` to finish without building, or `{ context }` to pass to `work`.
 */
export async function withVerifiedBuild(target, env, label, work, beforeBuild) {
  const timeout = readTimeout(env);
  const buildTimeout = env.SANDBOX_RUNNER_TIMEOUT_MS === undefined ? 0 : timeout;
  const controller = new AbortController();
  const { signal } = controller;
  const interrupt = () => controller.abort(new CliError("interrupted", `Cloudflare ${label} was interrupted.`, exit.requestFailure));
  const onTimeout = () => new CliError("timeout", "The Cloudflare command timed out.", exit.timeout);
  const scratch = await mkdtemp(join(tmpdir(), `sandbox-runner-cloudflare-${label}-`));
  for (const name of signals) process.on(name, interrupt);
  try {
    const project = join(scratch, "project");
    // Prefer the project's cf. Checked again after beforeBuild, which may reinstall the dependencies.
    const fallbackCf = target.cfBin;
    const projectCf = async () => {
      if (env.SANDBOX_RUNNER_CF_BIN !== undefined) return;
      const installed = join(target.directory, "node_modules", ".bin", "cf");
      target.cfBin = await access(installed, constants.X_OK).then(() => installed, () => fallbackCf);
    };
    await projectCf();
    const sanitized = deployEnvironment(env, target);
    const command = (cwd, childEnv, deadline, includeStderr) => cfCommand(target, cwd, childEnv, {
      signal, timeout: deadline, onTimeout, killSignal: "SIGKILL", includeStderr,
    });
    const checked = async (step, code, message) => {
      try {
        signal.throwIfAborted();
        return await step();
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CliError) throw error;
        if (error.code === "ENOENT" || error.code === "EACCES") {
          throw configurationFailure("cf_unavailable", "Could not start cf. Install the project dependencies or set SANDBOX_RUNNER_CF_BIN.");
        }
        throw configurationFailure(code, message);
      }
    };
    const metadata = command(scratch, sanitized, timeout);
    const read = async (...commandArgs) => JSON.parse(await metadata(...commandArgs));
    await checked(async () => {
      const account = await read("accounts", "get");
      if (account?.id?.toLowerCase() !== target.account) throw new Error();
    }, "cloudflare_account_unverified", "Could not verify the project's Cloudflare account. Run cloudflare login first.");
    const prepared = beforeBuild === undefined ? {} : await beforeBuild({ read, signal, checked });
    if (Object.hasOwn(prepared, "result")) return prepared.result;
    await projectCf();
    await stageProject(target, project);
    const docker = await dockerBuildEnv(sanitized, scratch, signal, timeout);
    const build = command(project, docker, buildTimeout, true);
    await checked(() => build("build"), "cloudflare_build_failed", "Cloudflare could not build the isolated project. Check Docker and the prepared Worker dependencies.");
    const buildOutput = await inspectBuild(project, target);
    await rejectDotenv(project);
    await checked(async () => {
      const { stdout, stderr } = await build("deploy", "--prebuilt", "--dry-run");
      if (!(stdout + "\n" + stderr).includes("--dry-run: exiting now.")) throw new Error();
    }, "cloudflare_dry_run_failed", "Cloudflare could not validate the prebuilt deployment.");
    await rejectDotenv(project);
    const upload = async () => command(project, await dockerUploadEnv(docker, scratch), buildTimeout, true);
    return await work({ read, buildOutput, upload, scratch, signal, checked, context: prepared.context });
  } finally {
    try {
      await rm(scratch, { recursive: true, force: true });
    } finally {
      for (const name of signals) process.removeListener(name, interrupt);
    }
  }
}

/** The version ID that `cf deploy` reports, or undefined. */
export function reportedVersion(output) {
  const matches = [...output.matchAll(/^[ \t│]*(?:Current )?Version ID:[ \t]*([a-f0-9-]{36})[ \t\r]*$/gim)];
  return matches.length === 1 && versionPattern.test(matches[0][1]) ? matches[0][1] : undefined;
}

export async function cloudflareDeploy(args, env) {
  const options = deployOptions(args);
  const target = await cloudflareProjectTarget(options.directory, env);
  rejectExportedSettings(env);
  const initial = !options.dryRun || options.secretPath !== undefined ? await firstSecrets(options.secretPath) : undefined;
  return withVerifiedBuild(target, env, "deploy", async ({ read, buildOutput, upload: uploader, scratch, signal }) => {
    const { apps } = buildOutput;
    const { account, worker, profile, sdkCommit, maxConcurrentRuns } = target;
    const summary = { account, worker, profile, sdkCommit, ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }) };
    if (options.dryRun) return { status: "dry_run", ...summary, applications: apps };

    const upload = await uploader();
    const secrets = join(scratch, "control.json");
    await writeFile(secrets, JSON.stringify(initial), { mode: 0o600, flag: "wx" });
    await targetAbsent(read, target, apps);
    const marker = "Sandbox Runner first deployment " + randomUUID();
    signal.throwIfAborted();
    try {
      const { stdout, stderr } = await upload("deploy", "--prebuilt", "--secrets-file", secrets, "--message", marker);
      const output = stdout + "\n" + stderr;
      const versionId = reportedVersion(output);
      if (versionId === undefined) throw new Error();
      const verified = await deployedVersion(read, target, buildOutput, versionId, marker);
      signal.throwIfAborted();
      const url = output.match(new RegExp(`^[ \\t│]*(https://${target.worker}\\.[a-z0-9-]+\\.workers\\.dev)[ \\t\\r]*$`, "m"))?.[1];
      return { status: "deployed", ...summary, ...verified, url };
    } catch (error) {
      throw new CliError("cloudflare_deploy_unconfirmed",
        "Cloudflare deployment could not be verified. Check the Worker and Container applications before another operation.",
        error?.code === "timeout" ? exit.timeout : exit.requestFailure, { uncertain: true });
    }
  });
}
