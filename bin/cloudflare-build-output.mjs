import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CliError, exit } from "./cli-errors.mjs";
import { installationLimitBinding, workerVersionBinding } from "./cloudflare-project.mjs";

const workerKeys = new Set([
  "compatibilityDate", "compatibilityFlags", "domains", "env", "exports", "manifest", "name", "observability", "previewUrls", "workersDev",
]);

export function invalidBuild() {
  return new CliError("cloudflare_build_unverified", "The prebuilt Cloudflare output does not match the project's Worker, control binding and Container applications.", exit.configuration);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(path) {
  if (!(await lstat(path)).isFile()) throw invalidBuild();
  return JSON.parse(await readFile(path, "utf8"));
}

async function entries(directory) {
  if (!(await lstat(directory)).isDirectory()) throw invalidBuild();
  return readdir(directory);
}

function localImage(reference, app) {
  if (typeof reference !== "string") return false;
  const match = /^cloudflare-build\/[a-f0-9]+\/([a-z0-9-]+):[a-f0-9]+$/.exec(reference);
  return match?.[1] === app || match?.[1] === app + "-base";
}

export async function inspectBuild(project, target) {
  const { worker: workerName, maxConcurrentRuns, applications, domain } = target;
  try {
    const root = join(project, ".cloudflare", "output", "v0");
    const settings = await readJson(join(root, "config.json"));
    if (settings.buildContext?.isPreview !== false || settings.buildContext.mode !== "production") throw invalidBuild();
    const workers = join(root, "workers");
    const workerDirectories = await entries(workers);
    if (workerDirectories.length !== 1 || workerDirectories[0] !== "default") throw invalidBuild();
    const directory = join(workers, "default");
    if (!(await lstat(directory)).isDirectory()) throw invalidBuild();
    const worker = await readJson(join(directory, "worker.config.json"));
    if (!record(worker) || worker.name !== workerName || worker.workersDev !== true || worker.previewUrls !== false ||
        Object.keys(worker).some(key => !workerKeys.has(key)) || !record(worker.env) || !record(worker.exports)) throw invalidBuild();
    // The only route a build may carry is the custom domain recorded in the manifest.
    if (domain === undefined ? worker.domains !== undefined
      : !Array.isArray(worker.domains) || worker.domains.length !== 1 || worker.domains[0] !== domain) throw invalidBuild();
    if (worker.env.SANDBOX_RUNNER_MODE?.type !== "text" || worker.env.SANDBOX_RUNNER_MODE.value !== "real" ||
        worker.env.SANDBOX_RUNNER_TOKEN?.type !== "secret" || Object.keys(worker.env.SANDBOX_RUNNER_TOKEN).length !== 1 ||
        Object.entries(worker.env).some(([name, binding]) => {
          if (name === "SANDBOX_RUNNER_TOKEN") return false;
          if (name === workerVersionBinding) return binding?.type !== "version-metadata" || Object.keys(binding).length !== 1;
          return name.endsWith("FIXTURES") || binding?.type !== "text" || typeof binding.value !== "string";
        })) throw invalidBuild();
    const limit = worker.env[installationLimitBinding];
    if (maxConcurrentRuns === undefined ? Object.hasOwn(worker.env, installationLimitBinding)
      : limit?.type !== "text" || limit.value !== String(maxConcurrentRuns) || !Object.hasOwn(worker.exports, "RunIndex")) {
      throw invalidBuild();
    }
    const apps = [{ name: applications.agent, className: "Run", schedulingPolicy: "durable-object" }];
    if (Object.hasOwn(worker.exports, "VitestRun")) apps.push({ name: applications.vitest, className: "VitestRun", schedulingPolicy: "default" });
    const namespaceClasses = apps.map(app => app.className);
    for (const app of apps) {
      const binding = worker.exports[app.className];
      if (binding?.type !== "durable-object" || binding.storage !== "sqlite" || binding.container !== app.name ||
          (binding.state !== undefined && binding.state !== "created")) throw invalidBuild();
    }
    for (const [name, binding] of Object.entries(worker.exports)) {
      if (namespaceClasses.includes(name)) continue;
      if (name === "RunIndex") {
        if (binding?.type !== "durable-object" || binding.storage !== "sqlite" ||
            (binding.state !== undefined && binding.state !== "created") ||
            Object.keys(binding).some(key => key !== "type" && key !== "storage" && key !== "state")) throw invalidBuild();
        namespaceClasses.push(name);
      } else if (binding?.type !== "worker") throw invalidBuild();
    }
    const containers = join(root, "containers");
    const containerDirectories = await entries(containers);
    if (containerDirectories.length !== apps.length || apps.some(app => !containerDirectories.includes(app.name))) throw invalidBuild();
    for (const app of apps) {
      const directory = join(containers, app.name);
      if (!(await lstat(directory)).isDirectory()) throw invalidBuild();
      const container = await readJson(join(directory, "container.config.json"));
      if (container?.name !== app.name || container.schedulingPolicy !== app.schedulingPolicy || container.unsafe !== undefined) throw invalidBuild();
      const image = app.schedulingPolicy === "default" ? container.image : container.images?.base;
      if (!localImage(image?.localReference, app.name) || Object.keys(image).length !== 1 ||
          (app.schedulingPolicy === "durable-object" && Object.keys(container.images).length !== 1)) throw invalidBuild();
    }
    return { apps, namespaceClasses, hasVersionMetadata: Object.hasOwn(worker.env, workerVersionBinding) };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw invalidBuild();
  }
}
