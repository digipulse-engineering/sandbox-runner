import { createHash } from "node:crypto";
import { mkdir, open, readFile, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveWorkerTarget } from "./auth.mjs";
import { CliError, exit } from "./cli-errors.mjs";
import { manifestName, parseInstallationLimit, workerTemplateFiles } from "./cloudflare-project.mjs";
import release from "../package.json" with { type: "json" };

const sourceRoot = new URL("../", import.meta.url);

function configurationFailure(code, message) {
  return new CliError(code, message, exit.configuration);
}

function parseInit(args, env) {
  let parsed;
  try {
    parsed = parseArgs({
      args, tokens: true, allowPositionals: true,
      options: { account: { type: "string" }, worker: { type: "string" }, profile: { type: "string" },
        "max-concurrent-runs": { type: "string" } },
    });
    const options = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
    if (parsed.positionals.length !== 1 || !parsed.positionals[0] || new Set(options).size !== options.length) throw new Error();
  } catch {
    throw new CliError("usage_error", "Init requires one directory. Use sandbox-runner --help for options.", exit.usage);
  }
  const { account, worker, profile } = resolveWorkerTarget(parsed.values, env, configurationFailure);
  // The generated Worker is reachable on a workers.dev DNS label.
  if (worker.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(worker)) {
    throw configurationFailure("configuration_error", "Provide a Worker name that is a lowercase DNS label.");
  }
  return { directory: resolve(parsed.positionals[0]), account, worker, profile,
    maxConcurrentRuns: parseInstallationLimit(parsed.values["max-concurrent-runs"]) };
}

/**
 * Identifies a template. The manifest records it once the project's files and prepared dependencies come from
 * that template, so `cloudflare upgrade` reinstalls until a refresh has fully succeeded.
 */
export function templateDigest(files) {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) hash.update(name + "\0" + files.get(name).length + "\0").update(files.get(name));
  return hash.digest("hex");
}

// Every installation receives the template unmodified; the Worker config reads its settings from the manifest.
export async function loadCloudflareTemplate() {
  const failure = () => configurationFailure("worker_template_unavailable", "The installed Sandbox Runner Worker template is incomplete.");
  let files;
  try {
    files = new Map(await Promise.all(workerTemplateFiles.map(async path => {
      const name = path.slice("worker/".length);
      if (name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..")) throw failure();
      const content = await readFile(new URL(path, sourceRoot)).catch(error => {
        // npm renames .gitignore to .npmignore when extracting an installed tarball.
        if (name === ".gitignore" && error.code === "ENOENT") return readFile(new URL("worker/.npmignore", sourceRoot));
        throw error;
      });
      return [name, content];
    })));
  } catch {
    throw failure();
  }
  const config = files.get("cloudflare.config.ts")?.toString("utf8");
  const sdkCommit = files.get("prepare-sdk.sh")?.toString("utf8").match(/^pin=([a-f0-9]{40})$/m)?.[1];
  if (!config || !config.includes("resolveProjectSettings(") || !sdkCommit) throw failure();
  return { files, sdkCommit };
}

export async function cloudflareInit(args, env) {
  const { directory, account, worker, profile, maxConcurrentRuns } = parseInit(args, env);
  const { files, sdkCommit } = await loadCloudflareTemplate();
  const project = { schemaVersion: 1, cliVersion: release.version, sdkCommit, templateDigest: templateDigest(files), account, worker, profile,
    ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }) };
  files.set(manifestName, JSON.stringify(project, null, 2) + "\n");
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw configurationFailure("project_directory_exists", "The destination already exists. Choose a new directory.");
    }
    throw configurationFailure("cloudflare_init_failed", "Could not create the Cloudflare project directory.");
  }
  const directories = new Set([directory]);
  const written = [];
  async function createDirectory(path) {
    if (directories.has(path)) return;
    await createDirectory(dirname(path));
    await mkdir(path);
    directories.add(path);
  }
  try {
    for (const [name, content] of files) {
      const destination = join(directory, name);
      await createDirectory(dirname(destination));
      const file = await open(destination, "wx");
      written.push(destination);
      try {
        await file.writeFile(content);
      } finally {
        await file.close();
      }
    }
  } catch {
    for (const path of written.reverse()) await unlink(path).catch(() => {});
    for (const path of [...directories].reverse()) await rmdir(path).catch(() => {});
    throw configurationFailure("cloudflare_init_failed", "Could not write the Cloudflare project.");
  }
  return { status: "initialized", directory, manifest: manifestName, ...project };
}
