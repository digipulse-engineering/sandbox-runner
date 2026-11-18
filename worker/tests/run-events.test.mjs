import assert from "node:assert/strict";
import test from "node:test";
import { appendRunEvents, parseEventsCursor, pendingVitestEventsPage, runEventsPage } from "../run-events.ts";

const run = {
  id: "12b712d0-f53d-45e3-9128-17d3667c5487", agent: "claude", status: "queued", cleanup: "pending",
  prompt: "PRIVATE_PROMPT", output: "PRIVATE_OUTPUT", reason: "PRIVATE_REASON", repository: "PRIVATE_REPOSITORY",
};
const vitest = {
  id: run.id, kind: "test", suite: "vitest", sandboxProvider: "cloudflare", status: "queued", phase: "queued", cleanup: "pending",
  repository: { slug: "PRIVATE_REPO", sha: "PRIVATE_SHA" }, stdout: { text: "PRIVATE_STDOUT" }, stderr: { text: "PRIVATE_STDERR" },
  reason: "PRIVATE_REASON", lockSha256: "PRIVATE_LOCK", credential: "PRIVATE_CREDENTIAL",
};

function journal(snapshot = []) {
  const state = new Map(structuredClone(snapshot));
  return {
    async get(key) { return structuredClone(state.get(key)); },
    async put(key, value) { state.set(key, structuredClone(value)); },
    snapshot() { return [...state]; },
  };
}

test("persists direct admission, execution, terminal state and cleanup for resumable reads", async () => {
  let storage = journal();
  const running = { ...run, status: "running" };
  const completed = { ...run, status: "succeeded" };
  const cleaned = { ...completed, cleanup: "destroyed" };
  await appendRunEvents(storage, undefined, run);
  await appendRunEvents(storage, run, running);
  const first = await runEventsPage(storage, running, 0);
  assert.equal(first.nextCursor, 2);
  storage = journal(storage.snapshot());
  await appendRunEvents(storage, running, completed);
  await appendRunEvents(storage, completed, cleaned);
  await appendRunEvents(storage, cleaned, { ...cleaned, output: "ignored" });
  const resumed = await runEventsPage(storage, cleaned, first.nextCursor);
  assert.deepEqual([...first.events, ...resumed.events], [
    { cursor: 1, type: "admitted", status: "queued", cleanup: "pending" },
    { cursor: 2, type: "state", status: "running" },
    { cursor: 3, type: "state", status: "succeeded" },
    { cursor: 4, type: "cleanup", cleanup: "destroyed" },
  ]);
  assert.deepEqual(await runEventsPage(storage, cleaned, 2), resumed);
  assert.deepEqual(await runEventsPage(storage, cleaned, 4), { ...resumed, events: [] });
  assert.equal(await runEventsPage(storage, cleaned, 5), "invalid_cursor");
  assert.doesNotMatch(JSON.stringify([first, resumed]), /PRIVATE_/);
});

test("reads a stable legacy snapshot without writing and preserves its cursor across cancellation", async () => {
  const storage = journal();
  const before = { ...run, status: "running" };
  const after = { ...before, status: "cancelled" };
  const first = await runEventsPage(storage, before, 0);
  assert.deepEqual(first.events, [{ type: "snapshot", cursor: 1, status: "running", cleanup: "pending" }]);
  assert.equal(first.nextCursor, 1);
  assert.deepEqual(storage.snapshot(), []);
  await appendRunEvents(storage, before, after);
  await appendRunEvents(storage, after, after);
  const resumed = await runEventsPage(storage, after, 1);
  assert.deepEqual(resumed.events, [{ type: "cancellation_requested", cursor: 2 }, { type: "state", status: "cancelled", cursor: 3 }]);
  assert.deepEqual((await runEventsPage(storage, after, 0)).events, [...first.events, ...resumed.events]);
});

test("records connector diagnostics once and exposes them through the existing event cursor", async () => {
  const storage = journal();
  const connectorIssue = { connector: "acme-staging", mode: "read-only", code: "mcp_connector_reauth_required" };
  const observed = { ...run, connectorIssues: [connectorIssue] };
  await appendRunEvents(storage, undefined, run);
  await appendRunEvents(storage, run, observed);
  await appendRunEvents(storage, observed, { ...observed, connectorIssues: [{ ...connectorIssue }] });
  const { events, nextCursor } = await runEventsPage(storage, observed, 1);
  assert.deepEqual(events, [{ cursor: 2, type: "state", status: "queued", connectorIssue }]);
  assert.equal(nextCursor, 2);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
});

test("accepts one canonical cursor and rejects ambiguous query strings", () => {
  assert.equal(parseEventsCursor(new URLSearchParams()), 0);
  assert.equal(parseEventsCursor(new URLSearchParams("after=0")), 0);
  assert.equal(parseEventsCursor(new URLSearchParams("after=18")), 18);
  for (const query of ["after=-1", "after=01", "after=", "after=9007199254740992", "after=1&after=2", "other=1"]) {
    assert.equal(parseEventsCursor(new URLSearchParams(query)), undefined);
  }
});

test("continues from the pending Vitest cursor through child admission and phase changes", async () => {
  const storage = journal();
  const pending = pendingVitestEventsPage(vitest.id, 0);
  const identity = { id: vitest.id, kind: "test", sandboxProvider: "cloudflare", suite: "vitest" };
  assert.deepEqual(pending, { ...identity, events: [], nextCursor: 0 });
  assert.equal(pendingVitestEventsPage(vitest.id, 1), "invalid_cursor");
  await appendRunEvents(storage, undefined, vitest);
  const admitted = await runEventsPage(storage, vitest, pending.nextCursor);
  assert.deepEqual(admitted, { ...identity, events: [{ cursor: 1, type: "admitted", status: "queued", cleanup: "pending" }], nextCursor: 1 });
  let current = vitest;
  for (const phase of ["checkout", "lockfile", "install", "test"]) {
    const running = { ...current, phase, status: "running" };
    await appendRunEvents(storage, current, running);
    await appendRunEvents(storage, running, { ...running, checkoutSha: "PRIVATE_CHECKOUT" });
    current = running;
  }
  const finished = { ...current, status: "succeeded" };
  const cleaned = { ...finished, cleanup: "destroyed" };
  await appendRunEvents(storage, current, finished);
  await appendRunEvents(storage, finished, cleaned);
  const resumed = await runEventsPage(storage, cleaned, admitted.nextCursor);
  assert.deepEqual(resumed, { ...identity, nextCursor: 8, events: [
    { cursor: 2, type: "state", status: "running" },
    ...["checkout", "lockfile", "install", "test"].map((phase, i) => ({ cursor: i + 3, type: "phase", phase })),
    { cursor: 7, type: "state", status: "succeeded" }, { cursor: 8, type: "cleanup", cleanup: "destroyed" },
  ] });
  assert.deepEqual((await runEventsPage(storage, cleaned, 0)).events, [...admitted.events, ...resumed.events]);
  assert.deepEqual(await runEventsPage(storage, cleaned, 8), { ...identity, events: [], nextCursor: 8 });
  assert.doesNotMatch(JSON.stringify([admitted, resumed]), /PRIVATE_/);
});

test("records a Vitest cancellation tombstone before the child has an admission record", async () => {
  const storage = journal();
  const cancelled = { ...vitest, status: "cancelled" };
  const cleaned = { ...cancelled, cleanup: "destroyed" };
  await appendRunEvents(storage, undefined, cancelled);
  await appendRunEvents(storage, cancelled, cancelled);
  await appendRunEvents(storage, cancelled, cleaned);
  assert.deepEqual((await runEventsPage(storage, cleaned, 0)).events, [
    { cursor: 1, type: "admitted", status: "queued", cleanup: "pending" },
    { cursor: 2, type: "cancellation_requested" },
    { cursor: 3, type: "state", status: "cancelled" },
    { cursor: 4, type: "cleanup", cleanup: "destroyed" },
  ]);
});

test("keeps the historical Vitest snapshot cursor when the child next writes", async () => {
  const storage = journal();
  const running = { ...vitest, status: "running", phase: "install" };
  const first = await runEventsPage(storage, running, 0);
  assert.deepEqual(first.events, [{ cursor: 1, type: "snapshot", status: "running", cleanup: "pending", phase: "install" }]);
  assert.deepEqual(storage.snapshot(), []);
  const testing = { ...running, phase: "test" };
  await appendRunEvents(storage, running, testing);
  const next = await runEventsPage(storage, testing, first.nextCursor);
  assert.deepEqual(next.events, [{ cursor: 2, type: "phase", phase: "test" }]);
  assert.deepEqual((await runEventsPage(storage, testing, 0)).events, [...first.events, ...next.events]);
});
