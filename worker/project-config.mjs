/**
 * Installation settings. An installation is one project directory made by `sandbox-runner cloudflare init`:
 * an unmodified copy of the Worker template next to `sandbox-runner.project.json`. Every build of the project
 * reads the installation's settings from that manifest, so one template serves every installation and taking a
 * new release only replaces template files. Without a manifest the build is a repository build, the only kind
 * that may enable fixtures.
 */
import { resolveAccessSettings } from "./access-config.mjs";

export const defaultWorkerName = "sandbox-runner-j1";
// The Worker and its Container applications are named by DNS labels (workers.dev host names).
export const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const decimal = (minimum, maximum) => value => /^[0-9]+$/.test(value) && Number(value) >= minimum && Number(value) <= maximum;
const json = value => {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};
const text = () => true;

/**
 * Plain-text Worker settings an installation records under `settings`. A project build reads them from its manifest
 * only, so values exported for another installation cannot leak in. A repository build, without a manifest, reads
 * them from the environment under the same names. The Worker validates the free-form values itself at run admission.
 */
export const projectSettings = Object.freeze({
  SANDBOX_RUNNER_OPENCODE: value => value === "1",
  SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS: decimal(1, 2_147_483_647),
  SANDBOX_RUNNER_API_TIMEOUT_MS: decimal(1, 2_147_483_647),
  SANDBOX_RUNNER_GITHUB_PUBLICATION_MAX_BYTES: text,
  // Cloudflare container inactivity timeouts are capped at six hours.
  SANDBOX_RUNNER_VITEST_TIMEOUT_MS: decimal(1, 21_600_000),
  SANDBOX_RUNNER_AGENT_TIMEOUT_MS: text,
  SANDBOX_RUNNER_MCP_CONNECTORS: json,
  // Usually a Worker secret. An installation that records it here must not also set the secret.
  SANDBOX_RUNNER_GITHUB_ALLOWLIST: json,
});
const jsonSettings = new Set(["SANDBOX_RUNNER_MCP_CONNECTORS", "SANDBOX_RUNNER_GITHUB_ALLOWLIST"]);
// Never read from the environment: an operator may export the allowlist to provision the secret of the same name.
const manifestOnlySettings = new Set(["SANDBOX_RUNNER_GITHUB_ALLOWLIST"]);

function environmentSetting(env, name) {
  if (manifestOnlySettings.has(name)) return;
  const value = env[name];
  // Earlier releases enabled OpenCode only for "1"; keep "0" and an empty value meaning off.
  if (name === "SANDBOX_RUNNER_OPENCODE" && (value === "0" || value === "")) return;
  return value;
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));

function invalid(detail) {
  return new Error(`The project manifest has an invalid ${detail}. See "Installation settings" in the README.`);
}

function settingValue(name, value) {
  // JSON settings may be written as JSON in the manifest; the Worker receives their text.
  const textValue = jsonSettings.has(name) && (isObject(value) || Array.isArray(value)) ? JSON.stringify(value) : value;
  if (typeof textValue !== "string" || !projectSettings[name](textValue)) throw invalid(`setting ${name}`);
  return textValue;
}

// Every installation builds its images from the template, so they always match its Worker: Cloudflare tags a build by
// its content and reuses an image it already holds. The only per-installation choice is the agent application's name,
// for an installation created before applications were named after the Worker.
function containerSettings(value) {
  if (value === undefined) return { agent: {} };
  if (!isObject(value) || !onlyKeys(value, ["agent"])) throw invalid("containers block: only containers.agent.name is accepted; images are built from the template, so remove any image entries");
  const agent = value.agent ?? {};
  if (!isObject(agent) || !onlyKeys(agent, ["name"])) throw invalid("agent container: only name is accepted; images are built from the template, so remove containers.agent.image");
  if (agent.name !== undefined && (typeof agent.name !== "string" || !dnsLabelPattern.test(agent.name))) {
    throw invalid("agent container name");
  }
  return { agent: agent.name === undefined ? {} : { name: agent.name } };
}

/**
 * @param {Record<string, string | undefined>} env the build environment
 * @param {string | undefined} manifestText the project manifest, when the build runs inside a project
 */
export function resolveProjectSettings(env, manifestText) {
  let manifest;
  if (manifestText !== undefined) {
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      throw new Error("The project manifest is not valid JSON.");
    }
    if (!isObject(manifest)) throw new Error("The project manifest is not a JSON object.");
    if (env.SANDBOX_RUNNER_FIXTURES === "1") {
      throw new Error("Fixture builds run from the repository checkout, not from a project: unset SANDBOX_RUNNER_FIXTURES.");
    }
  }
  const worker = manifest === undefined ? defaultWorkerName : manifest.worker;
  if (typeof worker !== "string" || !dnsLabelPattern.test(worker)) throw invalid("Worker name");
  const limit = manifest?.maxConcurrentRuns;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw invalid("concurrency limit");
  const recorded = manifest?.settings ?? {};
  if (!isObject(recorded) || !onlyKeys(recorded, Object.keys(projectSettings))) throw invalid("settings block");
  const settings = {};
  for (const name of Object.keys(projectSettings)) {
    const value = manifest === undefined ? environmentSetting(env, name) : recorded[name];
    if (value !== undefined) settings[name] = settingValue(name, value);
  }
  return {
    fixture: manifest === undefined && env.SANDBOX_RUNNER_FIXTURES === "1",
    // The agent Container application, and the Vitest one, as the deployment and destroy commands verify them.
    agentContainer: manifest?.containers?.agent?.name ?? worker,
    worker,
    maxConcurrentRuns: limit,
    containers: containerSettings(manifest?.containers),
    settings,
    access: resolveAccessSettings(env, manifestText),
  };
}
