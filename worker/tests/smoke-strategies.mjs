import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const base = process.env.SANDBOX_RUNNER_TEST_URL ?? "http://127.0.0.1:8904";
const timeoutMs = Number(process.env.SANDBOX_RUNNER_TEST_TIMEOUT_MS ?? 120_000);
const token = /^SANDBOX_RUNNER_TOKEN=(\S+)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
if (!token) throw new Error("Missing local fixture token");
const authorization = "Bearer " + token;
const strategy = "api-key-first-then-subscription";

async function call(path, input) {
  const response = await fetch(base + path, {
    headers: { authorization, ...(input ? { "content-type": "application/json" } : {}) },
    ...(input ? { method: "POST", body: JSON.stringify(input) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  return { code: response.status, body: await response.json() };
}

async function completed(id) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await call(`/v1/runs/${id}/result`);
    if (result.code === 200) return result.body;
    assert.deepEqual(result, { code: 409, body: { error: "run_in_progress" } });
    await sleep(1_000);
  }
  assert.fail("Local fixture run did not settle: " + id);
}

async function directControl() {
  const input = { operationId: randomUUID(), agent: "claude", authMode: "subscription", prompt: "J1 fixture success" };
  const accepted = await call("/v2/runs", input);
  assert.equal(accepted.code, 202);
  assert.equal(accepted.body.strategy, undefined);
  const result = await completed(input.operationId);
  assert.equal(result.status, "succeeded");
  assert.equal(result.cleanup, "destroyed");
  assert.equal(result.authMode, input.authMode);
  assert.equal(result.attempts, undefined);
  return { input, result };
}

async function configured() {
  const runs = [];
  for (const agent of ["codex", "claude"]) {
    const input = { operationId: randomUUID(), agent, prompt: "J1 fixture strategy quota" };
    const submissions = await Promise.all([call("/v1/runs", input), call("/v1/runs", input)]);
    const [accepted, repeated] = submissions;
    for (const response of submissions) {
      assert.equal(response.code, 202);
      assert.equal(response.body.id, input.operationId);
      assert.equal(response.body.authMode, "api-key");
      assert.equal(response.body.strategy, strategy);
      assert.equal(response.body.attempts.length, 1);
    }
    const firstId = accepted.body.attempts[0].operationId;
    assert.equal(repeated.body.attempts[0].operationId, firstId);
    assert.deepEqual(await call("/v2/runs", { ...input, authMode: "api-key" }), {
      code: 409, body: { error: "operation_conflict" },
    });
    assert.deepEqual(await call("/v1/runs", { ...input, prompt: "different prompt" }), {
      code: 409, body: { error: "operation_conflict" },
    });
    const result = await completed(input.operationId);
    assert.equal(result.id, input.operationId);
    assert.equal(result.strategy, strategy);
    assert.equal(result.authMode, "subscription");
    assert.equal(result.status, "succeeded");
    assert.equal(result.cleanup, "destroyed");
    assert.equal(result.output, agent === "codex" ? "Codex fixture complete." : "Claude fixture complete.");
    assert.equal(result.fallbackReason, "provider_quota_exhausted");
    assert.equal(result.attempts.length, 2);
    const secondId = result.attempts[1].operationId;
    assert.equal(new Set([input.operationId, firstId, secondId]).size, 3);
    assert.deepEqual(result.attempts, [
      { operationId: firstId, authMode: "api-key", status: "capacity", cleanup: "destroyed", reason: "provider_quota_exhausted" },
      { operationId: secondId, authMode: "subscription", status: "succeeded", cleanup: "destroyed" },
    ]);
    for (const attemptId of [firstId, secondId]) {
      assert.deepEqual(await call("/v1/runs/" + attemptId), { code: 404, body: { error: "run_not_found" } });
    }
    assert.deepEqual(await call("/v1/runs", input), { code: 202, body: result });
    runs.push({ input, result });
  }
  const input = { operationId: randomUUID(), agent: "codex", prompt: "J1 fixture quota" };
  assert.equal((await call("/v1/runs", input)).code, 202);
  const genericQuota = await completed(input.operationId);
  assert.equal(genericQuota.status, "capacity");
  assert.equal(genericQuota.reason, "provider_capacity");
  assert.equal(genericQuota.authMode, "api-key");
  assert.equal(genericQuota.attempts.length, 1);
  assert.equal(genericQuota.fallbackReason, undefined);
  return { runs, genericQuota, direct: await directControl() };
}

async function invalidated(previous) {
  for (const { input, result } of previous.runs) {
    assert.deepEqual(await call("/v1/runs", input), { code: 202, body: result });
    assert.deepEqual(await call(`/v1/runs/${input.operationId}/result`), { code: 200, body: result });
    assert.deepEqual(await call("/v2/runs", { ...input, authMode: "subscription" }), {
      code: 409, body: { error: "operation_conflict" },
    });
  }
  assert.deepEqual(await call("/v2/runs", previous.direct.input), { code: 202, body: previous.direct.result });
  const { authMode, ...historicalInput } = previous.direct.input;
  assert.deepEqual(await call("/v1/runs", historicalInput), { code: 202, body: previous.direct.result });
  const rejections = [];
  for (const agent of ["codex", "claude"]) {
    const input = { operationId: randomUUID(), agent, prompt: "J1 fixture success" };
    const rejected = await call("/v1/runs", input);
    assert.deepEqual(rejected, { code: 503, body: { error: "auth_strategy_invalid" } });
    assert.deepEqual(await call("/v1/runs/" + input.operationId), { code: 404, body: { error: "run_not_found" } });
    rejections.push({ agent, ...rejected });
  }
  return { replayed: previous.runs.map(({ input }) => input.operationId), rejections, direct: await directControl() };
}

// Start cf dev with SANDBOX_RUNNER_FIXTURES=1 and SANDBOX_RUNNER_STRATEGY_FIXTURES=1.
// Bind both agents to API-first for the first phase. Restart against the same
// persisted state with invalid strategies before the second phase.
const [phase, previousProof] = process.argv.slice(2);
const proof = phase === "configured" ? await configured()
  : phase === "invalidated" && previousProof ? await invalidated(JSON.parse(readFileSync(previousProof, "utf8")))
  : assert.fail("Specify configured, or invalidated with a configured proof file.");
console.log(JSON.stringify(proof));
