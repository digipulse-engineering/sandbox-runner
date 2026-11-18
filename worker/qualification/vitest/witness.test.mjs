import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { witnessPath } from "./witness.mjs";

test("the witness nonce is tied to the run and observer without exposing the control token", async () => {
  const control = "01".repeat(32);
  const id = "c3982431-3622-428d-a21f-c6f4c9ea20f9";
  const nonce = createHmac("sha256", control).update(`vitest-witness/${id}/mac`).digest("hex");
  assert.equal(await witnessPath(control, id, "mac"), `/witness/${id}/mac/${nonce}`);
  const vitest = await witnessPath(control, id, "vitest");
  assert(!vitest.includes(nonce) && !vitest.includes(control));
  assert(!(await witnessPath(control, "1053dd32-0e6b-4877-ace6-0eb6f785527e", "mac")).includes(nonce));
});
