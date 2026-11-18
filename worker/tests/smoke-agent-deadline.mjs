import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const [origin, tokenPath, mode, capText, holdText, originalPath] = process.argv.slice(2);
const tokenFile = await open(tokenPath, "r");
let token;
try {
  const stat = await tokenFile.stat();
  assert(stat.isFile() && (stat.mode & 0o077) === 0, "Use a private synthetic token file");
  token = (await tokenFile.readFile("utf8")).trim();
} finally {
  await tokenFile.close();
}
assert(/^[a-f0-9]{64}$/.test(token));
const cap = Number(capText);
const holdMs = Number(holdText);
const clientWaitMs = Number(process.env.SANDBOX_RUNNER_TEST_TIMEOUT_MS ?? 120_000);
const bin = fileURLToPath(new URL("../../bin/sandbox-runner.mjs", import.meta.url));
const env = { PATH: process.env.PATH, SANDBOX_RUNNER_URL: origin, SANDBOX_RUNNER_TOKEN: token };
const evidence = {};

async function cli(args, expectedExit = 0) {
  let result;
  try {
    result = await exec(process.execPath, [bin, ...args], { env });
    assert.equal(expectedExit, 0);
  } catch (error) {
    assert.equal(error.code, expectedExit);
    result = error;
  }
  assert(!result.stdout.includes(token) && !result.stderr.includes(token));
  return JSON.parse(result.stdout);
}

function startArgs(id, agent, prompt, { auth, timeoutMs } = {}) {
  return [agent, "start", "--operation-id", id,
    ...(auth ? ["--auth", auth] : []),
    ...(timeoutMs === undefined ? [] : ["--run-timeout-ms", String(timeoutMs)]),
    prompt];
}

async function wait(id, exit) {
  const result = await cli(["wait", id, "--timeout-ms", String(clientWaitMs)], exit);
  assert.equal(result.id, id);
  assert.equal(result.cleanup, "destroyed");
  return result;
}

async function waitRunning(id, deadlineAt, expectedAttempts = 0) {
  while (Date.now() < deadlineAt) {
    const state = await cli(["status", id]);
    const count = state.attempts?.length ?? 0;
    if (state.status === "running" && count === expectedAttempts) return state;
    assert(["queued", "running", "capacity"].includes(state.status), `Unexpected state ${state.status}`);
    await sleep(200);
  }
  assert.fail("The fixture did not reach the expected running state before the execution deadline");
}

function assertExpired(run, deadlineAt) {
  assert.equal(run.status, "timed_out");
  assert.equal(run.reason, "run_timed_out");
  assert.equal(run.deadlineAt, deadlineAt);
  assert.equal(run.output, undefined);
}

async function replay(id, agent, prompt, options, expectedDeadline) {
  const repeated = await cli(startArgs(id, agent, prompt, options));
  assert.equal(repeated.id, id);
  assert.equal(repeated.deadlineAt, expectedDeadline);
  return repeated;
}

try {
  if (mode === "unconfigured") {
    const id = randomUUID();
    const accepted = await cli(startArgs(id, "codex", "J1 fixture success", { auth: "api-key" }));
    assert.equal(accepted.deadlineAt, undefined);
    const result = await wait(id, 0);
    assert.equal(result.deadlineAt, undefined);
    evidence.unconfigured = { id, status: result.status, cleanup: result.cleanup, deadlineOmitted: true };
    const early = randomUUID();
    const acceptedEarly = await cli(startArgs(early, "codex", "J1 fixture success", { auth: "api-key", timeoutMs: 1 }));
    const expired = await wait(early, 5);
    assertExpired(expired, acceptedEarly.deadlineAt);
    evidence.explicitWithoutDefault = { id: early, status: expired.status, cleanup: expired.cleanup, deadlineAt: expired.deadlineAt };
  } else if (mode === "configured") {
    assert(cap > holdMs && holdMs > 0);
    if (originalPath) {
      const { unconfigured } = JSON.parse(await readFile(originalPath, "utf8"));
      const same = await replay(unconfigured.id, "codex", "J1 fixture success", { auth: "api-key" }, undefined);
      assert.equal(same.status, "succeeded");
      evidence.unconfiguredReplay = { id: same.id, deadlineOmitted: true, status: same.status };
    }
    const above = await cli(startArgs(randomUUID(), "claude", "J1 fixture success", { timeoutMs: cap + 1 }), 2);
    assert.equal(above.error, "run_timeout_exceeds_limit");
    evidence.cap = { rejected: true, id: above.operationId };

    const defaultId = randomUUID();
    const before = Date.now();
    const automatic = await cli(startArgs(defaultId, "claude", "J1 fixture provider timeout", { auth: "api-key" }));
    assert(automatic.deadlineAt >= before + cap && automatic.deadlineAt <= Date.now() + cap);
    const provider = await wait(defaultId, 1);
    assert.equal(provider.status, "failed");
    assert.equal(provider.reason, "provider_timeout");
    assert.equal(provider.deadlineAt, automatic.deadlineAt);
    evidence.provider = { id: defaultId, status: provider.status, reason: provider.reason, deadlineAt: provider.deadlineAt };

    const directId = randomUUID();
    const directOptions = { auth: "api-key", timeoutMs: holdMs };
    const directPrompt = "J1 fixture cancellation";
    const direct = await cli(startArgs(directId, "codex", directPrompt, directOptions));
    await waitRunning(directId, direct.deadlineAt);
    const localWait = await cli(["wait", directId, "--timeout-ms", "1"], 5);
    assert.equal(localWait.error, "wait_timeout");
    const finished = await wait(directId, 5);
    assertExpired(finished, direct.deadlineAt);
    assertExpired(await replay(directId, "codex", directPrompt, directOptions, direct.deadlineAt), direct.deadlineAt);
    const conflict = await cli(startArgs(directId, "codex", directPrompt, { ...directOptions, timeoutMs: holdMs + 1 }), 6);
    assert.equal(conflict.error, "operation_conflict");
    evidence.direct = { id: directId, status: finished.status, cleanup: finished.cleanup, deadlineAt: finished.deadlineAt,
      localWaitCode: localWait.error, replayMatched: true, changedDurationConflict: true };

    const strategyId = randomUUID();
    const strategy = await cli(startArgs(strategyId, "claude", "J1 fixture strategy deadline", { timeoutMs: holdMs }));
    const fallback = await waitRunning(strategyId, strategy.deadlineAt, 2);
    assert.equal(fallback.deadlineAt, strategy.deadlineAt);
    assert.equal(fallback.fallbackReason, "provider_quota_exhausted");
    const terminal = await wait(strategyId, 5);
    assertExpired(terminal, strategy.deadlineAt);
    assert.deepEqual(terminal.attempts.map(item => item.operationId), fallback.attempts.map(item => item.operationId));
    assert.equal(terminal.attempts[0].status, "capacity");
    assert.equal(terminal.attempts[0].cleanup, "destroyed");
    assert.equal(terminal.attempts[1].status, "timed_out");
    assert.equal(terminal.attempts[1].cleanup, "destroyed");
    evidence.strategy = { id: strategyId, status: terminal.status, cleanup: terminal.cleanup, deadlineAt: terminal.deadlineAt,
      fallbackReason: terminal.fallbackReason, attempts: terminal.attempts };

    const listing = await cli(["list"]);
    assert(!listing.runs.some(run => run.id === above.operationId || terminal.attempts.some(item => run.id === item.operationId)));
    for (const id of [directId, strategyId]) {
      assert(listing.runs.some(run => run.id === id && run.status === "timed_out" && run.cleanup === "destroyed"));
      const journal = await cli(["events", id]);
      assert(journal.events.some(event => event.type === "state" && event.status === "timed_out"));
      assert(journal.events.some(event => event.type === "cleanup" && event.cleanup === "destroyed"));
    }
    evidence.listAndEventsMatched = true;
  } else if (mode === "rotated") {
    const original = JSON.parse(await readFile(originalPath, "utf8"));
    assert(cap < holdMs);
    const same = await replay(original.direct.id, "codex", "J1 fixture cancellation", { auth: "api-key", timeoutMs: holdMs }, original.direct.deadlineAt);
    assertExpired(same, original.direct.deadlineAt);
    const rejected = await cli(startArgs(randomUUID(), "codex", "J1 fixture cancellation", { auth: "api-key", timeoutMs: holdMs }), 2);
    assert.equal(rejected.error, "run_timeout_exceeds_limit");
    evidence.rotation = { replayId: same.id, deadlineAt: same.deadlineAt, sameOverrideRejectedForNewId: true };
  } else {
    assert.fail("Expected smoke mode unconfigured, configured, or rotated");
  }
} finally {
  process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
}
