import assert from "node:assert/strict";
import test from "node:test";
import { claimConnectorWrite, closeConnectorWrites, settleConnectorWrite } from "../mcp-write.ts";
import { mcpWriteClaimed } from "../mcp-run-access.ts";

function storage(snapshot = []) {
  const state = new Map(snapshot);
  return {
    get: async key => state.get(key),
    put: async (key, value) => state.set(key, value),
    delete: async key => state.delete(key),
    snapshot: () => [...state],
  };
}

test("an unfinished write survives restart and fences fresh request ids", async () => {
  const first = storage();
  assert.equal(await claimConnectorWrite(first, "acme-staging", 1, "attempt-one"), true);
  const recovered = storage(first.snapshot());
  assert.equal(await recovered.get(mcpWriteClaimed), true);
  assert.equal(await claimConnectorWrite(recovered, "acme-staging", 2, "attempt-one"), false);
  assert.equal(await claimConnectorWrite(recovered, "acme-staging", 2, "attempt-two"), false);
  assert.equal(await claimConnectorWrite(recovered, "acme-work", 2, "attempt-one", ["acme-staging", "acme-work"]), false);
  assert.equal(await settleConnectorWrite(recovered, "acme-staging", 1, "attempt-two"), false);
  assert.equal(await claimConnectorWrite(recovered, "github", 2, "attempt-one"), true);
  assert.equal(await settleConnectorWrite(recovered, "github", 2, "attempt-one"), true);
  assert.deepEqual(await closeConnectorWrites(recovered, ["acme-staging", "github"], "attempt-one"),
    [{ code: "mcp_connector_write_unconfirmed", connector: "acme-staging", mode: "read-write" }]);
  assert.equal(await claimConnectorWrite(recovered, "github", 3, "attempt-one"), false);
  assert.equal(await settleConnectorWrite(recovered, "acme-staging", 1, "attempt-one", true), false);
});

test("a confirmed write permits a fresh request while keeping the original id claimed", async () => {
  const state = storage();
  assert.equal(await claimConnectorWrite(state, "acme-staging", 1), true);
  assert.equal(await settleConnectorWrite(state, "acme-staging", 1), true);
  assert.equal(await claimConnectorWrite(state, "acme-staging", 1), false);
  assert.equal(await claimConnectorWrite(state, "acme-staging", 2), true);
  assert.equal(await settleConnectorWrite(state, "acme-staging", 1), false);
  assert.equal(await settleConnectorWrite(state, "acme-staging", 2), true);
  assert.deepEqual(await closeConnectorWrites(state, ["acme-staging"]), []);
});
