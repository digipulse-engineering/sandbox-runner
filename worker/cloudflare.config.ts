import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import { resolveProjectSettings } from "./project-config.mjs";
import * as entrypoint from "./worker.ts" with { type: "cf-worker" };

// Every installation builds this file unmodified: its settings come from the project manifest written by
// `sandbox-runner cloudflare init` (cf runs builds from the project directory). See project-config.mjs.
const manifestPath = join(process.cwd(), "sandbox-runner.project.json");
const project = resolveProjectSettings(process.env, existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : undefined);
const { fixture, settings, access } = project;
const installationLimit = fixture ? process.env.SANDBOX_RUNNER_TEST_MAX_CONCURRENT_RUNS
  : project.maxConcurrentRuns === undefined ? undefined : String(project.maxConcurrentRuns);
const strategyFixture = fixture && process.env.SANDBOX_RUNNER_STRATEGY_FIXTURES === "1";
const claudeDefaultsFixture = fixture && process.env.SANDBOX_RUNNER_CLAUDE_DEFAULTS_FIXTURES === "1";
const providerFixture = fixture && process.env.SANDBOX_RUNNER_PROVIDER_FIXTURES === "1";
const githubFixture = fixture && process.env.SANDBOX_RUNNER_GITHUB_FIXTURES === "1";
// Failure-containment ceilings, not performance targets: work that finishes earlier is unaffected.
// - API bounds each call the Worker makes to GitHub or an MCP connector (reference resolution, connector preflight,
//   branch publication). Some run inside a client request, so it stays below the CLI's 30-second request timeout.
// - Checkout bounds the container's Git fetch, which no request waits on; real repositories may need minutes.
// - A real Vitest run needs minutes for a cold checkout, npm ci and the suite. Cloudflare caps a container's
//   inactivity at six hours.
// The fixtures keep the short values their smoke runs expect.
const deadlines = fixture ? { api: "25000", checkout: "25000", vitest: "120000" }
  : { api: "25000", checkout: "600000", vitest: "900000" };
const name = githubFixture ? "sandbox-runner-j2-github-fixtures"
  : fixture ? `${project.worker}-fixtures` : project.worker;
// Containers hold run credentials and output: no SSH access (Cloudflare enables it by default) and no log collection.
const container = defineContainer({
  name: project.containers.agent.name ?? name,
  schedulingPolicy: "durable-object",
  images: { base: { dockerfile: "./Dockerfile" } },
  ssh: { enabled: false },
  observability: { enabled: false },
});
const vitest = defineContainer({
  name: `${name}-vitest`,
  schedulingPolicy: "default",
  image: { dockerfile: "./vitest/Dockerfile", buildContext: "." },
  instanceType: "basic",
  ssh: { enabled: false },
  observability: { enabled: false },
});

export default defineConfig({
  worker: {
    name,
    compatibilityDate: "2026-11-11",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    workersDev: !fixture,
    previewUrls: false,
    observability: { enabled: false },
    exports: {
      Run: exports.durableObject({ storage: "sqlite", container }),
      RunIndex: exports.durableObject({ storage: "sqlite" }),
      ProviderEgress: exports.worker(),
      GithubEgress: exports.worker(),
      McpEgress: exports.worker(),
      VitestRun: exports.durableObject({ storage: "sqlite", container: vitest }),
      VitestEgress: exports.worker(),
    },
    env: {
      SANDBOX_RUNNER_VERSION: bindings.versionMetadata(),
      SANDBOX_RUNNER_MODE: bindings.text(fixture ? "fixture" : "real"),
      SANDBOX_RUNNER_AUTH_STRATEGIES: bindings.text("1"),
      SANDBOX_RUNNER_CLAUDE_DEFAULTS: bindings.text("1"),
      SANDBOX_RUNNER_PROVIDER_CONTRACT: bindings.text("1"),
      ...(settings.SANDBOX_RUNNER_OPENCODE === "1" ? { SANDBOX_RUNNER_OPENCODE: bindings.text("1") } : {}),
      SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS: bindings.text(settings.SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS ?? deadlines.checkout),
      SANDBOX_RUNNER_API_TIMEOUT_MS: bindings.text(settings.SANDBOX_RUNNER_API_TIMEOUT_MS ?? deadlines.api),
      SANDBOX_RUNNER_GITHUB_PUBLICATION_MAX_BYTES: bindings.text(settings.SANDBOX_RUNNER_GITHUB_PUBLICATION_MAX_BYTES ?? ""),
      SANDBOX_RUNNER_VITEST_TIMEOUT_MS: bindings.text(settings.SANDBOX_RUNNER_VITEST_TIMEOUT_MS ?? deadlines.vitest),
      ...Object.fromEntries(["SANDBOX_RUNNER_AGENT_TIMEOUT_MS", "SANDBOX_RUNNER_MCP_CONNECTORS", "SANDBOX_RUNNER_GITHUB_ALLOWLIST"]
        .filter(key => settings[key] !== undefined).map(key => [key, bindings.text(settings[key])])),
      ...(access === undefined ? {} : {
        SANDBOX_RUNNER_ACCESS_AUD: bindings.text(access.aud),
        SANDBOX_RUNNER_ACCESS_TEAM_DOMAIN: bindings.text(access.teamDomain),
      }),
      ...(installationLimit === undefined ? {} : { SANDBOX_RUNNER_INSTALLATION_MAX_RUNS: bindings.text(installationLimit) }),
      SANDBOX_RUNNER_TOKEN: bindings.secret(),
      // cf dev only loads declared secrets. Production defaults and policies
      // are installed independently so absent settings can stay absent.
      ...(strategyFixture ? {
        SANDBOX_RUNNER_CLAUDE_AUTH_STRATEGY: bindings.secret(),
        SANDBOX_RUNNER_CODEX_AUTH_STRATEGY: bindings.secret(),
      } : {}),
      ...(claudeDefaultsFixture ? {
        SANDBOX_RUNNER_CLAUDE_MODEL: bindings.secret(),
        SANDBOX_RUNNER_CLAUDE_EFFORT: bindings.secret(),
      } : {}),
      ...(providerFixture ? { SANDBOX_RUNNER_DEFAULT_SANDBOX_PROVIDER: bindings.secret() } : {}),
      ...(githubFixture ? { SANDBOX_RUNNER_GITHUB_FIXTURES: bindings.text("1") } : {}),
    },
  },
  containers: [container, vitest],
});
