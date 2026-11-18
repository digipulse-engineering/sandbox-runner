import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
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
const waitMs = Number(process.env.TEST_COMMAND_SMOKE_WAIT_MS ?? "180000");
const repository = { slug: "fixture/vitest", sha: vitestFixtureData.entries.command.sha };
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

const options = id => ["--repo", repository.slug, "--sha", repository.sha, "--operation-id", id];
const start = (id, argv) => cli("test", ...options(id), "--", ...argv);
const wait = id => cli("wait", id, "--timeout-ms", String(waitMs));

async function completed(name, argv, expected) {
  const id = randomUUID();
  const submitted = await start(id, argv);
  receipt[name] = { submitted };
  assert.equal(submitted.code, 0);
  assert.equal(submitted.output.suite, "command");
  assert.deepEqual(submitted.output.repository, repository);
  const result = await wait(id);
  receipt[name].result = result;
  assert.equal(result.output.cleanup, "destroyed");
  assert.equal(result.output.checkoutSha, repository.sha);
  assert.deepEqual(Object.keys(result.output.versions).sort(), ["nodeVersion", "npmVersion"]);
  for (const [field, value] of Object.entries(expected)) assert.equal(result[field] ?? result.output[field], value);
  return result.output;
}

const hostile = ["node", "fixture-command.mjs", "--kill-after=1s", "--no-new-privs", "", "a b", "$(touch SHELL_INJECTION)",
  "; touch SHELL_INJECTION", "`touch SHELL_INJECTION`", "é\n🚀"];
const waiting = ["node", "fixture-command.mjs", "wait"];

try {
  const passed = await completed("pass", hostile, { code: 0, status: "succeeded", exitCode: 0 });
  assert.match(passed.stdout.text, /FIXTURE_COMMAND_ARGV_AND_SEALED_ROUTES/);
  const replay = await start(passed.id, hostile);
  assert.deepEqual(replay.output, passed);
  assert.equal((await start(passed.id, [...hostile, "one change"])).output.error, "operation_conflict");
  assert.equal((await cli("vitest", "start", ...options(passed.id))).output.error, "operation_conflict");
  const eventsUrl = new URL(`/v4/runs/${passed.id}/events`, origin);
  const eventsResponse = await fetch(eventsUrl, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(waitMs) });
  assert.equal(eventsResponse.status, 200);
  const rawEvents = await eventsResponse.text();
  for (const excluded of [token, repository.slug, repository.sha, "SHELL_INJECTION", "FIXTURE_COMMAND_ARGV_AND_SEALED_ROUTES", '"argv"', '"stdout"', '"stderr"']) {
    assert(!rawEvents.includes(excluded));
  }
  const page = JSON.parse(rawEvents);
  assert.equal(page.suite, "command");
  assert.deepEqual(page.events.filter(event => event.type === "phase").map(event => event.phase), ["checkout", "lockfile", "install", "test"]);
  assert.deepEqual((await cli("events", passed.id)).output, page);
  assert.deepEqual((await cli("events", passed.id, "--after", String(page.nextCursor))).output.events, []);
  receipt.pass.events = { page, rawContainsOnlyLifecycleFields: true };

  const failed = await completed("failed", ["node", "fixture-command.mjs", "exit", "125"],
    { code: 1, status: "failed", reason: "test_command_failed", exitCode: 125 });
  assert.match(failed.stdout.text, /FIXTURE_COMMAND_EXIT/);
  assert.match(failed.stderr.text, /FIXTURE_COMMAND_STDERR/);
  const format = await completed("noShebang", ["./fixture-no-shebang"],
    { code: 6, status: "failed", reason: "test_command_invalid_executable" });
  assert.equal(format.exitCode, undefined);
  assert.equal(format.stdout, undefined);
  const missing = await completed("missing", ["sandbox-runner-fixture-command-absent"],
    { code: 6, status: "failed", reason: "test_command_not_found" });
  assert.equal(missing.exitCode, undefined);
  await completed("signal", ["node", "fixture-command.mjs", "signal"],
    { code: 1, status: "failed", reason: "test_command_signaled", signal: 15 });

  const cancelledId = randomUUID();
  const submitted = await start(cancelledId, waiting);
  receipt.cancelled = { submitted };
  assert.equal(submitted.code, 0);
  const signal = AbortSignal.timeout(waitMs);
  for (;;) {
    signal.throwIfAborted();
    const status = await cli("status", cancelledId);
    assert(["queued", "running"].includes(status.output.status));
    if (status.output.phase === "test") break;
    await sleep(400, undefined, { signal });
  }
  const stop = await cli("cancel", cancelledId);
  receipt.cancelled.accepted = stop;
  assert.equal(stop.code, 0);
  const cancelled = await wait(cancelledId);
  receipt.cancelled.result = cancelled;
  assert.equal(cancelled.code, 1);
  assert.equal(cancelled.output.status, "cancelled");
  assert.equal(cancelled.output.cleanup, "destroyed");
  assert.equal(cancelled.output.phase, "test");

  await completed("timeout", waiting, { code: 5, status: "failed", reason: "test_timed_out", phase: "test" });
} finally {
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
}
