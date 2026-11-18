import assert from "node:assert/strict";
import test from "node:test";
import { defaultWorkerName, resolveProjectSettings } from "../project-config.mjs";

const digest = "a".repeat(64);
const manifest = extra => JSON.stringify({ schemaVersion: 1, worker: "team-runner", ...extra });

test("a repository build keeps the default name and may enable fixtures", () => {
  const settings = resolveProjectSettings({ SANDBOX_RUNNER_FIXTURES: "1" }, undefined);
  assert.equal(settings.worker, defaultWorkerName);
  assert.equal(settings.fixture, true);
  assert.deepEqual(settings.containers, { agent: {} });
});

test("a project build takes its name and limit from the manifest and refuses fixtures", () => {
  const settings = resolveProjectSettings({}, manifest({ maxConcurrentRuns: 2 }));
  assert.equal(settings.worker, "team-runner");
  assert.equal(settings.agentContainer, "team-runner");
  assert.equal(settings.maxConcurrentRuns, 2);
  assert.equal(settings.fixture, false);
  assert.throws(() => resolveProjectSettings({ SANDBOX_RUNNER_FIXTURES: "1" }, manifest()), /unset SANDBOX_RUNNER_FIXTURES/);
  for (const value of [0, 1.5, "2"]) {
    assert.throws(() => resolveProjectSettings({}, manifest({ maxConcurrentRuns: value })), /concurrency limit/);
  }
  assert.throws(() => resolveProjectSettings({}, manifest({ worker: "Team_Runner" })), /Worker name/);
  assert.throws(() => resolveProjectSettings({}, "{"), /not valid JSON/);
});

test("a project build reads settings from its manifest only", () => {
  const settings = resolveProjectSettings(
    { SANDBOX_RUNNER_OPENCODE: "1", SANDBOX_RUNNER_VITEST_TIMEOUT_MS: "5000", SANDBOX_RUNNER_MCP_CONNECTORS: '{"other":{}}' },
    manifest({ settings: { SANDBOX_RUNNER_VITEST_TIMEOUT_MS: "900000", SANDBOX_RUNNER_MCP_CONNECTORS: { github: { url: "https://example.com/mcp" } } } }));
  assert.deepEqual(settings.settings, {
    SANDBOX_RUNNER_VITEST_TIMEOUT_MS: "900000",
    SANDBOX_RUNNER_MCP_CONNECTORS: '{"github":{"url":"https://example.com/mcp"}}',
  });
});

test("a repository build reads settings from the environment, where OpenCode 0 or empty means off", () => {
  assert.deepEqual(resolveProjectSettings({ SANDBOX_RUNNER_OPENCODE: "1", SANDBOX_RUNNER_VITEST_TIMEOUT_MS: "5000" }, undefined).settings,
    { SANDBOX_RUNNER_OPENCODE: "1", SANDBOX_RUNNER_VITEST_TIMEOUT_MS: "5000" });
  for (const value of ["0", ""]) assert.deepEqual(resolveProjectSettings({ SANDBOX_RUNNER_OPENCODE: value }, undefined).settings, {});
  assert.throws(() => resolveProjectSettings({ SANDBOX_RUNNER_VITEST_TIMEOUT_MS: "x" }, undefined), /SANDBOX_RUNNER_VITEST_TIMEOUT_MS/);
});

test("the allowlist comes from the manifest only, keeping a secret of the same name possible", () => {
  assert.deepEqual(resolveProjectSettings({ SANDBOX_RUNNER_GITHUB_ALLOWLIST: '{"o/r":1}' }, undefined).settings, {});
  assert.deepEqual(resolveProjectSettings({}, manifest({ settings: { SANDBOX_RUNNER_GITHUB_ALLOWLIST: { "o/r": 1 } } })).settings,
    { SANDBOX_RUNNER_GITHUB_ALLOWLIST: '{"o/r":1}' });
});

test("settings are checked by name and value", () => {
  for (const settings of [
    { SANDBOX_RUNNER_TOKEN: "x" },
    { SANDBOX_RUNNER_OPENCODE: "true" },
    { SANDBOX_RUNNER_VITEST_TIMEOUT_MS: "21600001" },
    { SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS: "0" },
    { SANDBOX_RUNNER_MCP_CONNECTORS: "{" },
    { SANDBOX_RUNNER_AGENT_TIMEOUT_MS: 60000 },
  ]) {
    assert.throws(() => resolveProjectSettings({}, manifest({ settings })), /invalid setting|settings block/);
  }
});

test("containers accept only the agent application's name", () => {
  assert.equal(resolveProjectSettings({}, manifest({ containers: { agent: { name: "team-runner-agent" } } })).agentContainer, "team-runner-agent");
  for (const containers of [
    { agent: { image: `registry.cloudflare.com/acct/agent@sha256:${digest}` } },
    { vitest: { image: `registry.cloudflare.com/acct/vitest@sha256:${digest}` } },
    { agent: { name: "Agent" } },
    { worker: {} },
  ]) {
    assert.throws(() => resolveProjectSettings({}, manifest({ containers })), /invalid/);
  }
});
