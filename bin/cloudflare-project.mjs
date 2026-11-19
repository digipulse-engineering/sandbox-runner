import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { resolveWorkerTarget } from "./auth.mjs";
import { CliError, exit } from "./cli-errors.mjs";
import { resolveProjectSettings } from "../worker/project-config.mjs";
import release from "../package.json" with { type: "json" };

export const manifestName = "sandbox-runner.project.json";
export const workerTemplateFiles = release.files.filter(path => path.startsWith("worker/"));
export const installationLimitBinding = "SANDBOX_RUNNER_INSTALLATION_MAX_RUNS";
export const workerVersionBinding = "SANDBOX_RUNNER_VERSION";

function validInstallationLimit(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function parseInstallationLimit(value) {
  if (value === undefined) return;
  const limit = Number(value);
  if (value.trim() !== value || !/^[1-9][0-9]*$/.test(value) || !validInstallationLimit(limit)) {
    throw new CliError("usage_error", "--max-concurrent-runs requires a positive integer.", exit.usage);
  }
  return limit;
}

export async function cloudflareProjectTarget(path, env) {
  const directory = resolve(path);
  const invalid = () => new CliError("cloudflare_project_invalid",
    "Select a directory initialized with sandbox-runner cloudflare init.", exit.configuration);
  let project;
  let text;
  try {
    text = await readFile(join(directory, manifestName), "utf8");
    project = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (project?.schemaVersion !== 1 || typeof project.cliVersion !== "string" ||
      typeof project.sdkCommit !== "string" || !/^[a-f0-9]{40}$/.test(project.sdkCommit) ||
      typeof project.account !== "string" || typeof project.worker !== "string" ||
      (project.maxConcurrentRuns !== undefined && !validInstallationLimit(project.maxConcurrentRuns)) ||
      (project.profile !== undefined && typeof project.profile !== "string")) {
    throw invalid();
  }
  let installation;
  try {
    // The same check the Worker config runs at build time, reported before anything is built.
    installation = resolveProjectSettings({}, text);
  } catch (error) {
    throw new CliError("cloudflare_project_invalid", error.message, exit.configuration);
  }
  const target = resolveWorkerTarget({ account: project.account, worker: project.worker, profile: project.profile ?? "default" },
    env, (code, message) => new CliError(code, message, exit.configuration));
  const { agentContainer } = installation;
  return { ...target, directory, sdkCommit: project.sdkCommit, maxConcurrentRuns: project.maxConcurrentRuns,
    ...(installation.domain === undefined ? {} : { domain: installation.domain }),
    applications: { agent: agentContainer, vitest: target.worker + "-vitest" },
    // Projects initialized before installation settings carry a rewritten config that ignores these blocks.
    usesInstallationSettings: project.settings !== undefined || project.containers !== undefined };
}
