import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { initializeRunIndex, parseRunListQuery, pendingRunIndex, publishPendingRun, readRunIndex, recordRunIndex } from "../run-index.ts";

function database(t, legacy = false) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  };
  if (legacy) {
    sql.exec("CREATE TABLE logical_runs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE)");
  } else initializeRunIndex(sql);
  return sql;
}

test("migrates the legacy index and filters OpenCode before page limits without changing cursors", t => {
  const sql = database(t, true);
  sql.exec("INSERT INTO logical_runs (sequence, id) VALUES (1, 'oldest'), (2, 'legacy')");
  initializeRunIndex(sql);
  initializeRunIndex(sql);
  recordRunIndex(sql, "first-opencode", true);
  recordRunIndex(sql, "newer");
  recordRunIndex(sql, "second-opencode", true);
  recordRunIndex(sql, "first-opencode");
  const legacy = readRunIndex(sql, { limit: 1 });
  assert.deepEqual(legacy, { ids: ["newer"], nextCursor: "4" });
  assert.deepEqual(readRunIndex(sql, { cursor: legacy.nextCursor, limit: 2 }), {
    ids: ["legacy", "oldest"], nextCursor: null,
  });
  assert.deepEqual(readRunIndex(sql, { cursor: "2", limit: 2 }), { ids: ["oldest"], nextCursor: null });
  assert.deepEqual(readRunIndex(sql, { limit: 2, includeOpenCode: true }), {
    ids: ["second-opencode", "newer"], nextCursor: "4",
  });
  assert.deepEqual(readRunIndex(sql, { cursor: legacy.nextCursor, limit: 2, includeOpenCode: true }), {
    ids: ["first-opencode", "legacy"], nextCursor: "2",
  });
});

test("an OpenCode outbox replay keeps its agent classification and original sequence", async t => {
  const sql = database(t);
  const pending = { id: "opencode-run", generation: "41", opencode: true };
  const data = new Map([[pendingRunIndex, pending]]);
  const storage = { get: async key => data.get(key), delete: async key => data.delete(key) };
  assert.equal(await publishPendingRun(storage, async (id, generation, opencode) => {
    assert.equal(generation, pending.generation);
    recordRunIndex(sql, id, opencode);
    throw new Error("ack lost");
  }), false);
  assert.equal(data.get(pendingRunIndex), pending);
  recordRunIndex(sql, "later");
  assert.equal(await publishPendingRun(storage, async (id, generation, opencode) => {
    assert.equal(generation, pending.generation);
    recordRunIndex(sql, id, opencode);
  }), true);
  assert.deepEqual(readRunIndex(sql, { limit: 2 }), { ids: ["later"], nextCursor: null });
  assert.deepEqual(readRunIndex(sql, { limit: 1, includeOpenCode: true }), { ids: ["later"], nextCursor: "2" });
  assert.deepEqual(readRunIndex(sql, { cursor: "2", limit: 1, includeOpenCode: true }), { ids: ["opencode-run"], nextCursor: null });
});

test("resumes old SQLite pages after new admissions and duplicate replays", t => {
  const sql = database(t);
  assert.deepEqual(readRunIndex(sql, { limit: 2 }), { ids: [], nextCursor: null });
  for (const id of ["a", "b", "c", "c"]) recordRunIndex(sql, id);
  const first = readRunIndex(sql, { limit: 2 });
  assert.deepEqual(first.ids, ["c", "b"]);
  assert.equal(first.nextCursor, "2");
  for (const id of ["d", "e", "a"]) recordRunIndex(sql, id);
  assert.deepEqual(readRunIndex(sql, { cursor: first.nextCursor, limit: 2 }), { ids: ["a"], nextCursor: null });
  assert.deepEqual(readRunIndex(sql, { limit: 24 }), { ids: ["e", "d", "c", "b", "a"], nextCursor: null });
});

test("preserves cursor precision through the signed SQLite integer range", t => {
  const sql = database(t);
  sql.exec("INSERT INTO logical_runs (sequence, id) VALUES (CAST(? AS INTEGER), ?)", "9007199254740993", "large");
  recordRunIndex(sql, "larger");
  const first = readRunIndex(sql, { limit: 1 });
  assert.deepEqual(first, { ids: ["larger"], nextCursor: "9007199254740994" });
  assert.deepEqual(readRunIndex(sql, { cursor: first.nextCursor, limit: 1 }), { ids: ["large"], nextCursor: null });
});

test("an outbox survives an index error and a lost acknowledgement and skips legacy records", async t => {
  const sql = database(t);
  const data = new Map([[pendingRunIndex, "first"]]);
  const storage = { get: async key => data.get(key), delete: async key => data.delete(key) };
  assert.equal(await publishPendingRun(storage, async () => { throw new Error("unavailable"); }), false);
  assert.equal(data.get(pendingRunIndex), "first");
  assert.deepEqual(readRunIndex(sql, { limit: 24 }).ids, []);
  assert.equal(await publishPendingRun(storage, async id => {
    recordRunIndex(sql, id);
    throw new Error("ack lost after SQL commit");
  }), false);
  recordRunIndex(sql, "newer");
  const recovered = await Promise.all([publishPendingRun(storage, async id => recordRunIndex(sql, id)),
    publishPendingRun(storage, async id => recordRunIndex(sql, id))]);
  assert.deepEqual(recovered, [true, true]);
  assert(!data.has(pendingRunIndex));
  assert.deepEqual(readRunIndex(sql, { limit: 24 }).ids, ["newer", "first"]);
  data.set("run", { id: "legacy" });
  assert.equal(await publishPendingRun(storage, async () => assert.fail("legacy backfill")), true);
  assert.deepEqual(readRunIndex(sql, { limit: 24 }).ids, ["newer", "first"]);
});

test("a late index acknowledgement cannot erase the local outbox", async t => {
  const sql = database(t);
  const data = new Map([[pendingRunIndex, "first"]]);
  const storage = { get: async key => data.get(key), delete: async key => data.delete(key) };
  const started = Promise.withResolvers();
  const remote = Promise.withResolvers();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const attempt = publishPendingRun(storage, async id => {
    started.resolve();
    await remote.promise;
    recordRunIndex(sql, id);
  }, 10_010);
  await started.promise;
  t.mock.timers.tick(10);
  assert.equal(await attempt, false);
  assert.equal(data.get(pendingRunIndex), "first");
  assert.equal(await publishPendingRun(storage, () => assert.fail("RPC invoked after budget"), 10_010), false);
  remote.resolve();
  await remote.promise;
  assert.equal(data.get(pendingRunIndex), "first");
  assert.deepEqual(readRunIndex(sql, { limit: 24 }).ids, ["first"]);
  assert.equal(await publishPendingRun(storage, async id => recordRunIndex(sql, id), 10_020), true);
  assert(!data.has(pendingRunIndex));
  assert.deepEqual(readRunIndex(sql, { limit: 24 }).ids, ["first"]);
});

test("validates unique canonical query parameters and the fan-out budget", () => {
  const parse = raw => parseRunListQuery(new URLSearchParams(raw));
  assert.deepEqual(parse(""), { limit: 24 });
  assert.deepEqual(parse("cursor=9223372036854775807&limit=1"), { cursor: "9223372036854775807", limit: 1 });
  for (const cursor of ["", "0", "-1", "01", "9223372036854775808", "1%0A", "1&cursor=2"]) {
    assert.equal(parse("cursor=" + cursor), "invalid_cursor");
  }
  for (const limit of ["", "0", "25", "1e1", "1%0A", "01", "1&limit=2"]) assert.equal(parse("limit=" + limit), "invalid_limit");
  assert.equal(parse("other=1"), "invalid_query");
});

test("pages by owner before the limit, retains the owner on replay and hides private legacy runs", t => {
  const sql = database(t, true);
  sql.exec("INSERT INTO logical_runs (id) VALUES ('legacy')");
  initializeRunIndex(sql);
  recordRunIndex(sql, "lead-old", false, "lead-engineering");
  recordRunIndex(sql, "product", false, "lead-product");
  recordRunIndex(sql, "lead-new", true, "lead-engineering");
  recordRunIndex(sql, "lead-new", false, "lead-product");
  assert.deepEqual(readRunIndex(sql, { limit: 1, clientId: "lead-engineering", includeOpenCode: true }),
    { ids: ["lead-new"], nextCursor: "4" });
  assert.deepEqual(readRunIndex(sql, { limit: 1, cursor: "4", clientId: "lead-engineering", includeOpenCode: true }),
    { ids: ["lead-old"], nextCursor: null });
  assert.deepEqual(readRunIndex(sql, { limit: 24, clientId: "lead-product", includeOpenCode: true }),
    { ids: ["product"], nextCursor: null });
  assert.deepEqual(readRunIndex(sql, { limit: 24, includeOpenCode: true }),
    { ids: ["lead-new", "product", "lead-old", "legacy"], nextCursor: null });
});
