import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { acquireInstallationAdmission, checkInstallationIndexWrite, claimInstallationReconciliation, expediteInstallationReconciliation, fenceInstallationAdmission,
  finishInstallationReconciliation, initializeInstallationAdmission, installationFenceAllows, scheduleInstallationReconciliation,
  validAdmissionGeneration } from "../installation-admission.ts";
import { initializeRunIndex, pendingRunIndex, publishPendingRun, recordRunIndex } from "../run-index.ts";
import { changeAdmissionGuard, parseGuardAction, readAdmissionGuard, readGuardOperation, validGuardToken } from "../admission-guard.ts";
import { installationGuardUnverified, prepareInstallationGuard, updateInstallationGuard } from "../installation-admission.ts";

function database(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings).map(row => ({ ...row }));
      return { toArray: () => rows, one: () => {
        assert.equal(rows.length, 1);
        return rows[0];
      } };
    },
  };
  initializeRunIndex(sql);
  initializeInstallationAdmission(sql);
  return sql;
}

function guard(t) {
  const sql = database(t);
  let alarm;
  return {
    sql,
    acquire: (id, limit = "1") => acquireInstallationAdmission(sql, id, limit, 30),
    claim: (now = 30) => claimInstallationReconciliation(sql, now, now + 30),
    finish: (claim, result) => finishInstallationReconciliation(sql, claim, result),
    async nextAlarm() {
      await scheduleInstallationReconciliation(sql, {
        setAlarm: async time => { alarm = time; },
        deleteAlarm: async () => { alarm = undefined; },
      });
      return alarm;
    },
    record(id, generation) {
      checkInstallationIndexWrite(sql, id, generation);
      recordRunIndex(sql, id);
    },
  };
}

test("preserves installations with no configured limit and refuses activation over known legacy admissions", t => {
  const legacy = guard(t);
  assert.equal(acquireInstallationAdmission(legacy.sql, "previous", undefined, 30), "unconfigured");
  assert.equal(legacy.acquire("second"), "legacy_unverified"); // The previous owner's write can still be in flight.
  const older = guard(t);
  recordRunIndex(older.sql, "older");
  assert.equal(older.acquire("new"), "legacy_unverified");
  assert.equal(older.acquire("older"), "existing");
  assert.equal(acquireInstallationAdmission(older.sql, "without-limit", undefined, 30), "unconfigured");
});

test("expedites reconciliation only for the fenced generation named by the owner", async t => {
  const gate = guard(t);
  const first = gate.acquire("same");
  assert(expediteInstallationReconciliation(gate.sql, "same", first.generation, 5));
  assert.equal(await gate.nextAlarm(), 5);
  const claim = gate.claim(5);
  assert.equal(claim.generation, first.generation);
  assert(gate.finish(claim, "fenced"));
  const next = gate.acquire("same");
  assert.notEqual(next.generation, first.generation);
  assert.equal(expediteInstallationReconciliation(gate.sql, "same", first.generation, 7), false);
  assert.equal(await gate.nextAlarm(), 30);
  assert.equal(gate.claim(7), undefined);
});

test("acquires a single durable ticket for each UUID and preserves the first accepted policy", async t => {
  const gate = guard(t);
  for (const bad of ["", "0", "-1", "+1", "01", "1\n", "1e2", "9007199254740992"]) {
    assert.equal(gate.acquire("fresh", bad), "installation_admission_invalid");
  }
  const results = await Promise.all(["fresh", "fresh", "second", "third"].map(id => Promise.resolve().then(() => gate.acquire(id, "2"))));
  assert.deepEqual(results, [{generation:"1"}, {generation:"1"}, {generation:"2"}, "installation_capacity"]);
  assert.equal(await gate.nextAlarm(), 30);
  assert.equal(gate.acquire("fourth", "3"), "installation_admission_invalid");
  assert.equal(acquireInstallationAdmission(gate.sql, "fourth", undefined, 30), "installation_admission_invalid");
  assert.deepEqual(gate.acquire("fresh", "3"), results[0]);
});

test("an ambiguous RPC retains the ticket until the owner stores a monotone fence", async t => {
  const gate = guard(t);
  const first = gate.acquire("operation");
  const old = gate.claim();
  assert.deepEqual(old, {id:"operation", ...first});
  assert.equal(await gate.nextAlarm(), 60);
  assert.equal(gate.claim(59), undefined);
  assert.equal(gate.acquire("other"), "installation_capacity");
  assert.deepEqual(gate.claim(60), old); // The first owner reply was lost.
  assert.equal(gate.finish(old, "held"), false);
  assert.equal(await gate.nextAlarm(), 90);
  const state = new Map();
  const owner = { get: async key => state.get(key), put: async (key, value) => state.set(key, value) };
  assert.equal(await installationFenceAllows(owner, old.generation), true);
  await fenceInstallationAdmission(owner, old.generation);
  await fenceInstallationAdmission(owner, old.generation); // Fence reply also lost.
  assert.equal(await installationFenceAllows(owner, old.generation), false);
  assert.equal(gate.finish(old, "fenced"), true);
  assert.equal(await gate.nextAlarm(), undefined);
  const replacement = gate.acquire("operation");
  assert.notEqual(replacement.generation, old.generation);
  assert.equal(await installationFenceAllows(owner, replacement.generation), true);
  assert.equal(gate.finish(old, "fenced"), false);
  assert.equal(gate.acquire("other"), "installation_capacity");
});

test("guarded index acknowledgement can be lost and replayed after a settled owner releases its slot", async t => {
  const gate = guard(t);
  const acquired = gate.acquire("root");
  const due = gate.claim();
  assert.equal(gate.finish(due, "settled"), false, "index write still pending");
  assert.equal(gate.acquire("next"), "installation_capacity");
  assert.throws(() => gate.record("root", "42"), /ticket does not match/);
  const data = new Map([[pendingRunIndex, { id:"root", generation:acquired.generation }]]);
  const owner = { get: async key => data.get(key), delete: async key => data.delete(key) };
  assert.equal(await publishPendingRun(owner, async (id, generation) => {
    gate.record(id, generation);
    throw new Error("index response lost after commit");
  }), false);
  assert.equal(gate.finish(due, "fenced"), false, "an indexed run needs a destruction receipt");
  assert.equal(gate.finish(due, "settled"), true);
  assert.equal(gate.finish(due, "settled"), false, "release reply lost after commit");
  assert.equal(gate.acquire("root"), "existing");
  assert.deepEqual(gate.acquire("next"), {generation:"2"});
  assert.equal(await publishPendingRun(owner, async (id, generation) => gate.record(id, generation)), true);
  assert.equal(data.has(pendingRunIndex), false);
});

test("a deadline on the guarded outbox preserves its ticket generation through late acknowledgement", async t => {
  const gate = guard(t);
  const acquired = gate.acquire("root");
  const due = gate.claim();
  const receipt = { id: "root", generation: acquired.generation };
  const data = new Map([[pendingRunIndex, receipt]]);
  const owner = { get: async key => data.get(key), delete: async key => data.delete(key) };
  const start = Promise.withResolvers();
  const remote = Promise.withResolvers();
  const inserted = Promise.withResolvers();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const attempt = publishPendingRun(owner, async (id, generation) => {
    assert.deepEqual({ id, generation }, receipt);
    start.resolve();
    await remote.promise;
    gate.record(id, generation);
    inserted.resolve();
  }, 10_010);
  await start.promise;
  t.mock.timers.tick(10);
  assert.equal(await attempt, false);
  assert.equal(gate.finish(due, "settled"), false, "the owner's cleanup precedes the pending index commit");
  assert.equal(gate.acquire("other"), "installation_capacity");
  remote.resolve();
  await inserted.promise;
  assert.equal(data.get(pendingRunIndex), receipt);
  assert.equal(gate.finish(due, "settled"), true);
  assert.deepEqual(gate.acquire("other"), { generation: "2" });
  assert.equal(await publishPendingRun(owner, async (id, generation) => gate.record(id, generation), 10_020), true);
  assert.equal(data.has(pendingRunIndex), false);
});

test("a cleanup failure holds its slot and a late legacy outbox disables new guarded admissions", async t => {
  const gate = guard(t);
  const initial = gate.acquire("failed");
  gate.record("failed", initial.generation);
  const due = gate.claim();
  assert.equal(gate.finish(due, "cleanup_failed"), true);
  assert.equal(await gate.nextAlarm(), undefined);
  assert.equal(gate.claim(300), undefined);
  assert.deepEqual(gate.acquire("failed"), initial);
  assert.equal(gate.acquire("next"), "installation_capacity");
  gate.record("legacy-outbox");
  assert.equal(gate.acquire("legacy-outbox"), "existing");
  assert.equal(gate.acquire("next"), "legacy_unverified");
});

test("does not round a ticket generation stored beyond JavaScript integer precision", async t => {
  const gate = guard(t);
  gate.sql.exec("INSERT INTO installation_tickets (sequence, id) VALUES (CAST(? AS INTEGER), ?)", "9007199254740993", "other");
  assert.deepEqual(gate.acquire("new"), {generation:"9007199254740994"});
  assert.equal(validAdmissionGeneration("9223372036854775807"), true);
  for (const invalid of ["", "0", "01", "9223372036854775808"]) assert.equal(validAdmissionGeneration(invalid), false);
  const values = new Map();
  const owner = { get: async key => values.get(key), put: async (key, value) => values.set(key, value) };
  await fenceInstallationAdmission(owner, "9007199254740993");
  assert.equal(await installationFenceAllows(owner, "9007199254740994"), true);
  assert.equal(await installationFenceAllows(owner, "9007199254740992"), false);
});

const upgradeId = "e8c1beed-f5ec-4286-9a72-758e16220335";
const otherUpgradeId = "1be36f62-f82c-416f-9427-75c571b8a236";
const close = { action: "close", upgradeId };
const open = { action: "open", upgradeId, generation: "1" };

test("guard credentials and actions have a disjoint and canonical syntax", () => {
  assert(validGuardToken("guard-" + "a".repeat(64)));
  for (const token of ["a".repeat(64), "guard-" + "A".repeat(64), "guard-" + "a".repeat(64) + "\n"]) {
    assert.equal(validGuardToken(token), false);
  }
  for (const action of [close, open]) assert.deepEqual(parseGuardAction(action, validAdmissionGeneration), action);
  for (const action of [{ ...close, generation: "1" }, { ...open, generation: "0" }, { ...close, upgradeId: "short" }]) {
    assert.equal(parseGuardAction(action, validAdmissionGeneration), undefined);
  }
});

test("freeze closes new tickets, fences uncertain UUIDs and waits for the exact client index", async t => {
  const gate = guard(t);
  const { sql } = gate;
  const alpha = { enabled: true, clientId: "alpha" };
  const beta = { enabled: true, clientId: "beta" };
  const submit = (id, client = alpha) => acquireInstallationAdmission(sql, id, undefined, 30, client);
  assert.deepEqual(submit("uncertain"), { generation: "1" });
  assert.deepEqual(submit("admitted"), { generation: "2" }, "tracking imposes no implicit concurrency ceiling");
  assert.equal(submit("admitted", beta), "operation_conflict");
  assert.equal(submit("invalid-guard", { enabled: false, invalid: true }), "installation_admission_invalid");
  assert(changeAdmissionGuard(sql, close));
  assert(changeAdmissionGuard(sql, close));
  assert.equal(changeAdmissionGuard(sql, { ...close, upgradeId: otherUpgradeId }), false);
  assert.equal(submit("new"), "installation_maintenance");
  assert.equal(submit("new", { enabled: false }), "installation_maintenance", "freeze survives missing operator credential");
  assert.equal(acquireInstallationAdmission(sql, "old-now", undefined, 30), "installation_maintenance");
  assert.equal(submit("admitted"), "frozen_pending");
  assert.equal(submit("uncertain", beta), "operation_conflict");
  assert.deepEqual(readAdmissionGuard(sql, installationGuardUnverified(sql), 1), {
    status: "draining", upgradeId, generation: "1", pendingCount: 2, nextCursor: "1",
    pending: [{ operationId: "uncertain", clientId: "alpha", generation: "1", state: "pending" }],
  });
  const uncertain = gate.claim();
  const owner = new Map();
  const storage = { get: async key => owner.get(key), put: async (key, value) => owner.set(key, value) };
  await fenceInstallationAdmission(storage, uncertain.generation);
  assert.equal(await installationFenceAllows(storage, uncertain.generation), false);
  assert(gate.finish(uncertain, "fenced"));
  assert.deepEqual(readGuardOperation(sql, "uncertain"), { operationId: "uncertain", clientId: "alpha", generation: "1", state: "fenced" });
  assert.equal(readGuardOperation(sql, "never-sent"), null);
  assert.equal(submit("uncertain"), "installation_maintenance");
  const admitted = gate.claim();
  assert.equal(gate.finish(admitted, "settled"), false, "owner cleanup before index publication is insufficient");
  assert.throws(() => checkInstallationIndexWrite(sql, "admitted", "2", "beta"), /guard owner/);
  checkInstallationIndexWrite(sql, "admitted", "2", "alpha");
  recordRunIndex(sql, "admitted", false, "alpha");
  assert(gate.finish(admitted, "settled"));
  assert.deepEqual(readGuardOperation(sql, "admitted"), { operationId: "admitted", clientId: "alpha", generation: "2", state: "indexed_and_destroyed" });
  assert.equal(readAdmissionGuard(sql, installationGuardUnverified(sql), 1).status, "drained");
  assert.equal(submit("admitted"), "existing");
  assert.equal(changeAdmissionGuard(sql, { ...open, generation: "2" }), false);
  assert(changeAdmissionGuard(sql, open));
  assert(changeAdmissionGuard(sql, open));
  assert.equal(changeAdmissionGuard(sql, close), false, "lost old close cannot refreeze a reopened installation");
  assert.deepEqual(submit("uncertain"), { generation: "3" });
  assert.equal(gate.finish(uncertain, "fenced"), false, "stale reconciliation cannot release a new generation");
  assert(changeAdmissionGuard(sql, { ...close, upgradeId: otherUpgradeId }));
  assert.equal(changeAdmissionGuard(sql, open), false);
});

test("a wrong owner row, cleanup failure or unticketed history cannot certify drainage", t => {
  const gate = guard(t);
  const { sql } = gate;
  const alpha = { enabled: true, clientId: "alpha" };
  acquireInstallationAdmission(sql, "operation", undefined, 30, alpha);
  assert(changeAdmissionGuard(sql, close));
  const claim = gate.claim();
  recordRunIndex(sql, claim.id); // Simulate the unsupported old binary losing clientId.
  assert.throws(() => checkInstallationIndexWrite(sql, claim.id, claim.generation, "alpha"), /existing run index row/);
  assert.equal(gate.finish(claim, "settled"), false);
  assert.equal(readAdmissionGuard(sql, installationGuardUnverified(sql), 10).status, "draining");
  assert(gate.finish(claim, "cleanup_failed"));
  assert.equal(readAdmissionGuard(sql, installationGuardUnverified(sql), 10).status, "cleanup_failed");

  const legacy = guard(t).sql;
  acquireInstallationAdmission(legacy, "historic", undefined, 30);
  assert.equal(prepareInstallationGuard(legacy), false);
  assert.equal(acquireInstallationAdmission(legacy, "normal-open", undefined, 30, alpha), "unconfigured");
  assert(changeAdmissionGuard(legacy, close));
  assert.equal(acquireInstallationAdmission(legacy, "paused", undefined, 30, alpha), "installation_maintenance");
  assert.equal(readAdmissionGuard(legacy, installationGuardUnverified(legacy), 10).status, "legacy_unverified");

  const oldTicket = guard(t);
  oldTicket.acquire("pre-guard");
  assert.equal(prepareInstallationGuard(oldTicket.sql), false);
  assert(changeAdmissionGuard(oldTicket.sql, close));
  assert.equal(readAdmissionGuard(oldTicket.sql, installationGuardUnverified(oldTicket.sql), 10).status, "legacy_unverified");
});

test("an untracked ticket from a version without the guard invalidates a later drain", t => {
  const { sql } = guard(t);
  assert(prepareInstallationGuard(sql));
  assert(changeAdmissionGuard(sql, close));
  assert.equal(readAdmissionGuard(sql, installationGuardUnverified(sql), 10).status, "drained");
  sql.exec("INSERT INTO installation_tickets (id, retry_at) VALUES (?, ?)", "older-ticket", 30);
  sql.exec("UPDATE installation_admission SET active = active + 1 WHERE singleton = 1");
  assert.equal(installationGuardUnverified(sql), false);
  assert.equal(readAdmissionGuard(sql, installationGuardUnverified(sql), 10).status, "legacy_unverified");
});

test("the RunIndex guard update refuses to open with historical admissions and preserves the closure", t => {
  const { sql } = guard(t);
  assert.equal(acquireInstallationAdmission(sql, "historic", undefined, 30), "unconfigured");
  recordRunIndex(sql, "historic");
  const frozen = updateInstallationGuard(sql, close, 10);
  assert.deepEqual(frozen, {
    status: "legacy_unverified", upgradeId, generation: "1", pendingCount: 0, nextCursor: null, pending: [],
  });
  for (const request of [{ ...open, generation: "2" }, open, open]) {
    assert.equal(updateInstallationGuard(sql, request, 10), null);
    assert.deepEqual(readAdmissionGuard(sql, installationGuardUnverified(sql), 10), frozen);
  }
  const client = { enabled: true, clientId: "alpha" };
  assert.equal(acquireInstallationAdmission(sql, "new", undefined, 30, client), "installation_maintenance");
  assert.equal(acquireInstallationAdmission(sql, "new", "1", 30, client), "installation_maintenance");
  assert.equal(acquireInstallationAdmission(sql, "historic", undefined, 30, client), "existing");
});

test("the RunIndex guard update refuses to open with an orphan ticket after tracking starts", t => {
  const { sql } = guard(t);
  assert.equal(updateInstallationGuard(sql, close, 10).status, "drained");
  sql.exec("INSERT INTO installation_tickets (id, retry_at) VALUES (?, ?)", "older-ticket", 30);
  sql.exec("UPDATE installation_admission SET active = active + 1 WHERE singleton = 1");
  assert.equal(installationGuardUnverified(sql), false);
  assert.equal(updateInstallationGuard(sql, open, 10), null);
  const state = readAdmissionGuard(sql, installationGuardUnverified(sql), 10);
  assert.equal(state.status, "legacy_unverified");
  assert.equal(state.generation, "1");
  assert.equal(state.pendingCount, 0);
  const client = { enabled: true, clientId: "alpha" };
  assert.equal(acquireInstallationAdmission(sql, "new", undefined, 30, client), "installation_maintenance");
  assert.equal(acquireInstallationAdmission(sql, "older-ticket", undefined, 30, client), "frozen_pending");
});

test("the RunIndex guard update reopens a verified exact generation and reconciles the same request", t => {
  const { sql } = guard(t);
  assert.equal(updateInstallationGuard(sql, close, 10).status, "drained");
  assert.equal(updateInstallationGuard(sql, { ...open, generation: "2" }, 10), null);
  const result = updateInstallationGuard(sql, open, 10);
  assert.equal(result.status, "open");
  assert.deepEqual(updateInstallationGuard(sql, open, 10), result);
  const client = { enabled: true, clientId: "alpha" };
  assert.deepEqual(acquireInstallationAdmission(sql, "new", undefined, 30, client), { generation: "1" });
});
