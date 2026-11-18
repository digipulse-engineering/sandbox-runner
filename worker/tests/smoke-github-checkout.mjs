import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { githubFixtureData } from "../github-fixture-data.ts";

const base = process.env.SANDBOX_RUNNER_TEST_URL ?? "http://127.0.0.1:8910";
const timeout = Number(process.env.SANDBOX_RUNNER_TEST_TIMEOUT_MS ?? 120_000);
const token = /^SANDBOX_RUNNER_TOKEN=(\S+)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
if (!token) throw new Error("Missing synthetic control token");
const auth = { authorization: "Bearer " + token };
const bin = fileURLToPath(new URL("../../bin/sandbox-runner.mjs", import.meta.url));
const exec = promisify(execFile);
const sha = githubFixtureData.sha;
assert.notEqual(sha, githubFixtureData.tip);

async function call(path, options) {
  const response = await fetch(base + path, { ...options, redirect: "error", signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  assert(!text.includes(token));
  return { code: response.status, body: JSON.parse(text) };
}

function submit(input, version = "v4") {
  return call("/" + version + "/runs", {
    method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(input),
  });
}

async function completed(id) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await call("/v1/runs/" + id + "/result", { headers: auth });
    if (result.code === 200) return result.body;
    assert.deepEqual(result, { code: 409, body: { error: "run_in_progress" } });
    await sleep(1_000);
  }
  assert.fail("Fixture run did not settle: " + id);
}

async function invokeCli(args, expectedExit = 0) {
  const result = await exec(process.execPath, [bin, ...args], {
    env: { SANDBOX_RUNNER_URL: base, SANDBOX_RUNNER_TOKEN: token },
  }).catch(error => {
    assert.equal(error.code, expectedExit);
    return error;
  });
  assert.equal(result.code ?? 0, expectedExit);
  if (expectedExit === 0) assert.equal(result.stderr, "");
  assert(!result.stdout.includes(token));
  assert(!result.stderr.includes(token));
  return { output: JSON.parse(result.stdout), stderr: result.stderr };
}

const cli = async (...args) => (await invokeCli(args)).output;

const input = (agent, slug, requestedSha, prompt) => ({
  kind: "agent", operationId: randomUUID(), agent, authMode: "api-key", prompt, repository: { slug, sha: requestedSha },
});

assert.deepEqual(await call("/v4/runs", { method: "POST", body: "invalid JSON" }), {
  code: 404, body: { error: "not_found" },
});
const denied = input("claude", "fixture/not-admitted", sha, "J2 fixture GitHub workspace");
assert.deepEqual(await submit(denied), { code: 403, body: { error: "github_repository_not_allowed" } });
assert.deepEqual(await call("/v1/runs/" + denied.operationId, { headers: auth }), {
  code: 404, body: { error: "run_not_found" },
});
assert.deepEqual(await submit({ ...denied, repository: { slug: "fixture/private", sha } }, "v2"), {
  code: 400, body: { error: "invalid_request" },
});

const exact = input("claude", "fixture/private", sha, "J2 fixture GitHub workspace");
const cliArgs = ["claude", "start", "--auth", exact.authMode, "--operation-id", exact.operationId,
  "--repo", exact.repository.slug, "--sha", sha.toUpperCase(), exact.prompt];
const [accepted, replay] = await Promise.all([cli(...cliArgs), submit(exact)]);
assert.deepEqual(accepted.repository, exact.repository);
assert.equal(replay.code, 202);
assert.equal(replay.body.id, exact.operationId);
assert.deepEqual(replay.body.repository, exact.repository);
assert.deepEqual(await submit({ ...exact, repository: { ...exact.repository, sha: githubFixtureData.tip } }), {
  code: 409, body: { error: "operation_conflict" },
});
const exactResult = await cli("wait", exact.operationId, "--timeout-ms", String(timeout));
console.log(JSON.stringify({ case: "non-tip", result: exactResult }));
assert.equal(exactResult.status, "succeeded");
assert.equal(exactResult.cleanup, "destroyed");
const witness = JSON.parse(exactResult.output);
const { capEff, capPrm, capAmb, directDns, directIpTls, directTcpConnected, directIpPeerPresented,
  receivePackStatus, otherRepositoryStatus, ...workspace } = witness;
assert.deepEqual(workspace, {
  sha, cwd: true, witness: true, submoduleNotInitialized: true, filterUnexecuted: true, hookUnexecuted: true,
  secretsAbsent: true, uid: 10001, gid: 10001, binaryWritable: false, caWritable: false, rootRegained: false,
});
for (const cap of [capEff, capPrm, capAmb]) assert.match(cap, /^0+$/);
assert.match(directDns, /^(ENOTFOUND|ENODATA|EREFUSED|ESERVFAIL|ECONNREFUSED|ETIMEOUT)$/);
assert.match(directIpTls, /^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EACCES|ETIMEDOUT|ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE|ERR_SSL_WRONG_VERSION_NUMBER|ERR_SSL_UNEXPECTED_EOF_WHILE_READING)$/);
assert.equal(typeof directTcpConnected, "boolean");
assert.equal(directIpPeerPresented, false);
assert.equal(receivePackStatus, 403);
assert.equal(otherRepositoryStatus, 403);
assert.deepEqual(await cli(...cliArgs), exactResult);
console.log(JSON.stringify({ case: "agent-witness", witness }));

const fallback = input("codex", "fixture/fallback", sha, "J1 fixture success");
assert.equal((await submit(fallback)).code, 202);
const fallbackResult = await completed(fallback.operationId);
console.log(JSON.stringify({ case: "same-repository-branch-fallback", result: fallbackResult }));
assert.equal(fallbackResult.status, "succeeded");
assert.equal(fallbackResult.cleanup, "destroyed");
assert.equal(fallbackResult.output, "Codex fixture complete.");
assert.deepEqual(fallbackResult.repository, fallback.repository);

const missing = input("claude", "fixture/private", "f".repeat(40), "J1 fixture quota");
assert.equal((await submit(missing)).code, 202);
const missingResult = await completed(missing.operationId);
console.log(JSON.stringify({ case: "unreachable-sha", result: missingResult }));
assert.equal(missingResult.status, "failed");
assert.equal(missingResult.cleanup, "destroyed");
assert.equal(missingResult.reason, "github_checkout_failed");
assert.equal(missingResult.output, undefined);

const cancellation = input("claude", "fixture/private", sha, "J1 fixture cancellation");
delete cancellation.authMode;
const submitted = await submit(cancellation);
assert.equal(submitted.code, 202);
assert.equal(submitted.body.strategy, "api-key-first-then-subscription");
const deadline = Date.now() + timeout;
let running;
while (Date.now() < deadline) {
  running = await cli("status", cancellation.operationId);
  if (running.status === "running") break;
  assert.equal(running.status, "queued");
  await sleep(1_000);
}
assert.equal(running?.status, "running");
const cancelled = await cli("cancel", cancellation.operationId);
assert.equal(cancelled.cancellationRequested, true);
const waited = await invokeCli(["wait", cancellation.operationId, "--timeout-ms", String(timeout)], 1);
assert.match(waited.stderr, /cancelled/i);
assert.equal(waited.output.status, "cancelled");
assert.equal(waited.output.cleanup, "destroyed");
assert.equal(waited.output.reason, "run_cancelled");
assert.equal(waited.output.attempts.length, 1);
assert.equal(waited.output.attempts[0].operationId, running.attempts[0].operationId);
assert.equal(waited.output.output, undefined);
assert.deepEqual(waited.output.repository, cancellation.repository);
assert.deepEqual(await cli("cancel", cancellation.operationId), waited.output);
console.log(JSON.stringify({ case: "strategy-cancel", result: waited.output }));
