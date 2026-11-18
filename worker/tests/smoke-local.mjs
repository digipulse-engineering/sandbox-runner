import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const base = process.env.SANDBOX_RUNNER_TEST_URL ?? "http://127.0.0.1:8903";
const timeoutMs = Number(process.env.SANDBOX_RUNNER_TEST_TIMEOUT_MS ?? 120_000);
const token = /^SANDBOX_RUNNER_TOKEN=(\S+)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
if (!token) throw new Error("Missing local fixture token");
const auth = { authorization: "Bearer " + token };
const bin = fileURLToPath(new URL("../../bin/sandbox-runner.mjs", import.meta.url));
const exec = promisify(execFile);

async function cli(...args) {
  const result = await exec(process.execPath, [bin, ...args], {
    env: { SANDBOX_RUNNER_URL: base, SANDBOX_RUNNER_TOKEN: token },
  }).then(
    value => ({ ...value, code: 0 }),
    error => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }),
  );
  assert(result.stdout && !result.stdout.includes(token));
  assert(!result.stderr.includes(token));
  if (args[0] === "result" && result.code !== 0) assert(result.stderr.trim());
  else assert.equal(result.stderr, "");
  return { code: result.code, body: JSON.parse(result.stdout) };
}

function cliSubmit({ agent, authMode, operationId, prompt }) {
  return cli("run", "--agent", agent, "--auth", authMode, "--operation-id", operationId, prompt);
}

async function call(path, options = {}) {
  const response = await fetch(base + path, {
    ...options, redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  return { code: response.status, body: await response.json() };
}

async function submit(input, version = "v2") {
  return call("/" + version + "/runs", {
    method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(input),
  });
}

async function completed(id) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await call("/v1/runs/" + id + "/result", { headers: auth });
    if (result.code === 200) return result.body;
    assert.deepEqual(result, { code: 409, body: { error: "run_in_progress" } });
    await sleep(1_000);
  }
  assert.fail("Local fixture run did not settle: " + id);
}

assert.deepEqual(await call("/v1/runs", { method: "POST", body: "not JSON" }), {
  code: 404, body: { error: "not_found" },
});
assert.deepEqual(await call("/v1/runs/" + randomUUID(), { headers: auth }), {
  code: 404, body: { error: "run_not_found" },
});

const example = { operationId: randomUUID(), agent: "claude", prompt: "Invalid endpoint combination" };
assert.deepEqual(await submit(example), { code: 400, body: { error: "invalid_request" } });
assert.deepEqual(await submit({ ...example, authMode: "api-key" }, "v1"), {
  code: 400, body: { error: "invalid_request" },
});
const modes = [
  ["claude", "subscription"],
  ["claude", "api-key"],
  ["codex", "api-key"],
  ["codex", "subscription"],
];
for (const [agent, authMode] of modes) {
  const operationId = randomUUID();
  const input = { operationId, agent, authMode, prompt: "J1 fixture success" };
  const [first, duplicate] = await Promise.all([submit(input), submit(input)]);
  for (const response of [first, duplicate]) {
    assert.equal(response.code, 202);
    assert.equal(response.body.id, operationId);
    assert.equal(response.body.agent, agent);
    assert.equal(response.body.authMode, authMode);
  }
  assert.deepEqual(await submit({ ...input, prompt: "different prompt" }), {
    code: 409, body: { error: "operation_conflict" },
  });
  assert.deepEqual(await submit({ ...input, agent: agent === "claude" ? "codex" : "claude" }), {
    code: 409, body: { error: "operation_conflict" },
  });
  assert.deepEqual(await submit({ ...input, authMode: authMode === "subscription" ? "api-key" : "subscription" }), {
    code: 409, body: { error: "operation_conflict" },
  });
  const result = await completed(operationId);
  assert.deepEqual(result, {
    id: operationId, agent, authMode, status: "succeeded", cleanup: "destroyed",
    output: agent === "claude" ? "Claude fixture complete." : "Codex fixture complete.",
  });
  assert.deepEqual(await submit(input), { code: 202, body: result });
  assert.deepEqual(await cliSubmit(input), { code: 0, body: result });
  assert.deepEqual(await call("/v1/runs/" + operationId, { headers: auth }), { code: 200, body: result });
  assert.deepEqual(await cli("result", operationId), { code: 0, body: result });
  console.log(JSON.stringify(result));
}

async function terminalFixture(agent, authMode, prompt, status, reason, exitCode) {
  const operationId = randomUUID();
  const accepted = await cliSubmit({ operationId, agent, authMode, prompt });
  assert.equal(accepted.code, 0);
  assert.equal(accepted.body.id, operationId);
  const result = await completed(operationId);
  assert.deepEqual(result, { id: operationId, agent, authMode, cleanup: "destroyed", status, reason });
  assert.deepEqual(await cli("result", operationId), { code: exitCode, body: result });
  console.log(JSON.stringify(result));
}

for (const [agent, authMode] of modes) {
  await terminalFixture(agent, authMode, "J1 fixture quota", "capacity", "provider_capacity", 4);
}
await terminalFixture("claude", "subscription", "J1 fixture auth", "auth_required", "provider_auth_required", 3);
await terminalFixture("codex", "api-key", "J1 fixture permission", "failed", "provider_permission_denied", 1);
await terminalFixture("claude", "api-key", "J1 fixture overloaded", "capacity", "provider_overloaded", 4);
await terminalFixture("claude", "subscription", "J1 fixture Claude SSE quota", "capacity", "provider_capacity", 4);
await terminalFixture("claude", "api-key", "J1 fixture Claude SSE overloaded", "capacity", "provider_overloaded", 4);
await terminalFixture("codex", "api-key", "J1 fixture SSE quota", "capacity", "provider_quota_exhausted", 4);
await terminalFixture("codex", "api-key", "J1 fixture SSE failure", "failed", "run_failed", 1);
await terminalFixture("codex", "subscription", "J1 fixture SSE quota", "failed", "run_failed", 1);
