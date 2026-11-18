import assert from "node:assert/strict";
import { test } from "node:test";
import { untilRunStops } from "../vitest/runtime.ts";
import { createVitestState, finishVitest, recordVitestCleanup, setVitestPhase, startVitest, terminateVitest, vitestView } from "../vitest/state.ts";

const admitted = createVitestState("c3982431-3622-428d-a21f-c6f4c9ea20f9",
  { slug: "owner/fixture", sha: "a".repeat(40) }, 1000, 2000);
const output = { text: "FAILED assertion", bytes: 16, truncated: false };

test("records the command result before teardown and preserves it across late cancellation", () => {
  const running = startVitest(admitted, 1500);
  assert.equal(setVitestPhase(running, "test"), undefined);
  const ready = setVitestPhase(setVitestPhase(setVitestPhase(running, "lockfile"), "install"), "test");
  const finished = finishVitest(ready, { status: "failed", phase: "test", durationMs: 100, reason: "test_failed",
    command: { exitCode: 1, stdout: output, stderr: output } });
  assert.equal(finished.cleanup, "pending");
  assert.equal(terminateVitest(finished, "run_cancelled", 1700), finished);
  const terminal = vitestView(recordVitestCleanup(finished, "destroyed"));
  assert.equal(terminal.cleanup, "destroyed");
  assert.equal(terminal.reason, "test_failed");
  assert.equal(terminal.exitCode, 1);
  assert.deepEqual(terminal.stdout, output);
  assert(!Object.hasOwn(terminal, "deadlineAt"));
});

test("cancellation and eviction fence stale execution and retain the pending cleanup", () => {
  const running = startVitest(admitted, 1200);
  for (const reason of ["run_cancelled", "test_runtime_lost", "test_timed_out"]) {
    const stopped = terminateVitest(running, reason, 1800);
    assert.equal(stopped.cleanup, "pending");
    assert.equal(stopped.reason, reason);
    assert.equal(setVitestPhase(stopped, "lockfile"), undefined);
    assert.equal(finishVitest(stopped, { status: "succeeded", phase: "checkout", durationMs: 700 }), stopped);
    assert.equal(recordVitestCleanup(stopped, "failed").cleanup, "failed");
  }
  assert.equal(startVitest(admitted, admitted.deadlineAt).reason, "test_timed_out");
  assert.equal(recordVitestCleanup(running, "destroyed"), running);
});

test("a run stop signal rejects a pending native call and prevents starting a new one", async () => {
  const controller = new AbortController();
  const pending = untilRunStops(() => new Promise(() => {}), controller.signal);
  const reason = new Error("cancelled");
  controller.abort(reason);
  await assert.rejects(pending, reason);
  let started = false;
  await assert.rejects(untilRunStops(async () => { started = true; }, controller.signal), reason);
  assert.equal(started, false);
});
