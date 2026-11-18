import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { vitestFixtureData } from "../vitest/fixture-data.ts";

const [, , origin, tokenPath] = process.argv;
const handle = await open(tokenPath, "r");
let token;
try {
  const metadata = await handle.stat();
  assert(metadata.isFile() && (metadata.mode & 0o077) === 0, "Use a private synthetic token file");
  token = (await handle.readFile("utf8")).trim();
} finally {
  await handle.close();
}
assert(/^[a-f0-9]{64}$/.test(token), "Use a synthetic openssl token");
const env = { PATH: process.env.PATH, SANDBOX_RUNNER_URL: origin, SANDBOX_RUNNER_TOKEN: token };
const bin = fileURLToPath(new URL("../../bin/sandbox-runner.mjs", import.meta.url));
const waitMs = Number(process.env.VITEST_SMOKE_WAIT_MS ?? "240000");
const receipt = {};

function cli(...args) {
  return new Promise((resolve, reject) => execFile(process.execPath, [bin, ...args], { env }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") return reject(error);
    try {
      assert(!stdout.includes(token) && !stderr.includes(token));
      resolve({ code: error?.code ?? 0, output: JSON.parse(stdout), stderr });
    } catch (failure) {
      reject(failure);
    }
  }));
}

const repo = "fixture/vitest";
const start = (id, sha) => cli("vitest", "start", "--repo", repo, "--sha", sha, "--operation-id", id);
const wait = id => cli("wait", id, "--timeout-ms", String(waitMs));

const eventFields = {
  admitted: ["cleanup", "status"],
  state: ["status"],
  phase: ["phase"],
  cancellation_requested: [],
  cleanup: ["cleanup"],
};

async function rawEvents(id, after = 0, agent) {
  const url = new URL(`/v4/runs/${id}/events?after=${after}`, origin);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(waitMs) });
  assert.equal(response.status, 200);
  const raw = await response.text();
  for (const excluded of [token, repo, "SANDBOX_RUNNER_VITEST_", "EXPECTED_FIXTURE", "J1 fixture success", "Claude fixture complete.",
    ...Object.values(vitestFixtureData.entries).map(entry => entry.sha)]) {
    assert(!raw.includes(excluded), "The raw journal contained run content");
  }
  const page = JSON.parse(raw);
  const { events, nextCursor, ...identity } = page;
  assert.deepEqual(identity, agent ? { id, kind: "agent", sandboxProvider: "cloudflare", agent }
    : { id, kind: "test", sandboxProvider: "cloudflare", suite: "vitest" });
  for (const [index, event] of events.entries()) {
    assert(Object.hasOwn(eventFields, event.type));
    assert.deepEqual(Object.keys(event).sort(), ["cursor", "type", ...eventFields[event.type]].sort());
    assert.equal(event.cursor, after + index + 1);
  }
  assert.equal(nextCursor, after + events.length);
  return page;
}

async function finalEvents(id, before, status, agent) {
  const history = await rawEvents(id, 0, agent);
  const resumed = await rawEvents(id, before.nextCursor, agent);
  assert.deepEqual([...before.events, ...resumed.events], history.events);
  assert.equal(resumed.nextCursor, history.nextCursor);
  assert.deepEqual((await cli("events", id, "--after", String(before.nextCursor))).output, resumed);
  assert.deepEqual(await rawEvents(id, history.nextCursor, agent), { ...history, events: [] });
  assert.deepEqual(history.events[0], { cursor: 1, type: "admitted", status: "queued", cleanup: "pending" });
  assert.deepEqual(history.events.slice(-2).map(({ cursor, ...event }) => event),
    [{ type: "state", status }, { type: "cleanup", cleanup: "destroyed" }]);
  return { before, resumed, nextCursor: history.nextCursor, rawContainsOnlyLifecycleFields: true };
}

const visitedPhases = ({ before, resumed }) => [...before.events, ...resumed.events]
  .filter(event => event.type === "phase").map(event => event.phase);

try {
  for (const [name, expectedExit] of [["pass", 0], ["fail", 1]]) {
    const sha = vitestFixtureData.entries[name].sha;
    const id = randomUUID();
    const submitted = await start(id, sha);
    receipt[name] = { submitted };
    assert.equal(submitted.code, 0);
    assert.equal(submitted.output.id, id);
    assert.equal(submitted.output.kind, "test");
    const initial = await rawEvents(id);
    const result = await wait(id);
    receipt[name].result = result;
    assert.equal(result.code, expectedExit);
    assert.equal(result.output.exitCode, expectedExit);
    assert.equal(result.output.cleanup, "destroyed");
    assert.equal(result.output.checkoutSha, sha);
    assert.equal(result.output.versions.vitestVersion, "5.1.0");
    assert.match(result.output.stdout.text, new RegExp(`SANDBOX_RUNNER_VITEST_${name.toUpperCase()}`));
    if (name === "fail") assert.match(result.output.stderr.text, /EXPECTED_FIXTURE/);
    if (process.env.VITEST_SMOKE_REQUIRE_IMAGE_DIGEST === "1") assert.match(result.output.imageDigest, /^sha256:[a-f0-9]{64}$/);
    receipt[name].events = await finalEvents(id, initial, result.output.status);
    assert.deepEqual(visitedPhases(receipt[name].events), ["checkout", "lockfile", "install", "test"]);
    assert.deepEqual((await start(id, sha)).output, result.output);
    assert.equal((await start(id, vitestFixtureData.entries.cancel.sha)).output.error, "operation_conflict");
    assert.equal((await cli("claude", "start", "--operation-id", id, "This UUID is already reserved.")).output.error, "operation_conflict");
  }

  const id = randomUUID();
  const submitted = await start(id, vitestFixtureData.entries.cancel.sha);
  receipt.cancel = { submitted };
  assert.equal(submitted.code, 0);
  const signal = AbortSignal.timeout(waitMs);
  for (;;) {
    signal.throwIfAborted();
    const status = await cli("status", id);
    receipt.cancel.before = status.output;
    assert.equal(status.code, 0);
    assert(["queued", "running"].includes(status.output.status), "The cancel fixture completed before cancellation");
    if (status.output.phase === "test") break;
    await setTimeout(500, undefined, { signal });
  }
  const beforeCancel = await rawEvents(id);
  const stop = await cli("cancel", id);
  receipt.cancel.accepted = stop;
  assert.equal(stop.code, 0);
  assert.equal(stop.output.status, "cancelled");
  const result = await wait(id);
  receipt.cancel.result = result;
  assert.equal(result.code, 1);
  assert.equal(result.output.reason, "run_cancelled");
  assert.equal(result.output.cleanup, "destroyed");
  assert.equal(result.output.checkoutSha, vitestFixtureData.entries.cancel.sha);
  assert.equal(result.output.versions.vitestVersion, "5.1.0");
  receipt.cancel.events = await finalEvents(id, beforeCancel, "cancelled");
  assert.deepEqual(visitedPhases(receipt.cancel.events), ["checkout", "lockfile", "install", "test"]);
  assert.equal(receipt.cancel.events.resumed.events[0].type, "cancellation_requested");

  const earlyId = randomUUID();
  const early = await start(earlyId, vitestFixtureData.entries.cancel.sha);
  receipt.earlyCancel = { submitted: early };
  assert.equal(early.code, 0);
  const earlyStop = await cli("cancel", earlyId);
  receipt.earlyCancel.accepted = earlyStop;
  assert.equal(earlyStop.code, 0);
  assert.equal(earlyStop.output.status, "cancelled");
  assert(["queued", "checkout", "lockfile"].includes(earlyStop.output.phase), "Early cancellation did not precede the dependency install");
  const earlyResult = await wait(earlyId);
  receipt.earlyCancel.result = earlyResult;
  assert.equal(earlyResult.code, 1);
  assert.equal(earlyResult.output.reason, "run_cancelled");
  assert.equal(earlyResult.output.cleanup, "destroyed");
  assert.equal(earlyResult.output.phase, earlyStop.output.phase);
  receipt.earlyCancel.events = await finalEvents(earlyId, { events: [], nextCursor: 0 }, "cancelled");
  assert.equal(receipt.earlyCancel.events.resumed.events.at(-3).type, "cancellation_requested");

  if (process.env.VITEST_SMOKE_AGENT === "1") {
    const agentId = randomUUID();
    const agent = "claude";
    const submitted = await cli(agent, "start", "--operation-id", agentId, "J1 fixture success");
    receipt.agent = { submitted };
    assert.equal(submitted.code, 0);
    const initial = await rawEvents(agentId, 0, agent);
    const result = await wait(agentId);
    receipt.agent.result = result;
    assert.equal(result.code, 0);
    assert.equal(result.output.status, "succeeded");
    assert.equal(result.output.cleanup, "destroyed");
    assert.equal(result.output.output, "Claude fixture complete.");
    receipt.agent.events = await finalEvents(agentId, initial, "succeeded", agent);
    assert.deepEqual(visitedPhases(receipt.agent.events), []);
  }
} finally {
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
}
