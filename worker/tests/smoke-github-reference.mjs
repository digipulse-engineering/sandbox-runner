import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { githubFixtureData } from "../github-fixture-data.ts";
import { vitestFixtureData } from "../vitest/fixture-data.ts";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../../bin/sandbox-runner.mjs", import.meta.url));
const origin = new URL(process.env.SANDBOX_RUNNER_URL);
assert.equal(origin.hostname, "127.0.0.1");
const token = process.env.SANDBOX_RUNNER_TOKEN;
assert(token);
// Wait through one existing 30-second index reconciliation while the configured
// 37-second checkout lookup remains live. No extra model or provider call.
const reconciliationMs = 30_000;
const requestTimeout = 120_000; // The configured Vitest fixture deadline.
const fixtureRef = "refs/heads/reference/main";
const repo = "fixture/private";

async function request(path, body) {
  const response = await fetch(new URL(path, origin), {
    method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(requestTimeout),
    headers: { authorization: "Bearer " + token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function cli(args, exitCode = 0) {
  const result = await exec(process.execPath, [bin, ...args], {
    env: { SANDBOX_RUNNER_URL: origin.origin, SANDBOX_RUNNER_TOKEN: token }, timeout: requestTimeout,
  }).catch(error => error);
  assert.equal(result.code ?? 0, exitCode);
  assert(!result.stdout.includes(token) && !result.stderr.includes(token));
  return JSON.parse(result.stdout);
}

function submission(id, ref, slug = repo) {
  return { kind: "agent", agent: "claude", operationId: id, prompt: "J2 fixture GitHub workspace", repository: { slug, ref } };
}

async function until(probe, done, timeout = requestTimeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const observed = await probe();
    if (done(observed)) return observed;
    if (Date.now() >= deadline) throw Error("Fixture state did not settle");
    await sleep(100);
  }
}

const submit = input => request("/v4/runs", input);
const read = id => request("/v1/runs/" + id);
const submitWhenFree = input => until(() => submit(input), reply => reply.status !== 429);

const blockedId = randomUUID();
const blocked = submission(blockedId, "refs/heads/reference/blocked");
const startedAt = Date.now();
const pending = submit(blocked);
const pendingView = await until(() => read(blockedId), reply => reply.status !== 404);
assert.deepEqual(pendingView, { status: 409, body: { error: "admission_in_progress", operationId: blockedId } });
assert.deepEqual(await request("/v4/runs/" + blockedId + "/cancel", {}), pendingView);
assert.deepEqual(await request("/v1/runs/" + blockedId + "/result"), {
  status: 409, body: { error: "run_in_progress", operationId: blockedId },
});
assert.deepEqual(await submit(blocked), { status: 503, body: { error: "admission_unconfirmed", operationId: blockedId } });
for (const repository of [{ slug: repo, ref: fixtureRef }, { slug: repo, sha: githubFixtureData.sha }]) {
  assert.deepEqual(await submit({ ...blocked, repository }), { status: 409, body: { error: "operation_conflict" } });
}
const nextId = randomUUID();
const missing = submission(nextId, "refs/heads/reference/missing");
assert.deepEqual(await submit(missing), { status: 429, body: { error: "installation_capacity", operationId: nextId } });
await sleep(Math.max(0, startedAt + reconciliationMs + 500 - Date.now()));
assert.deepEqual(await read(blockedId), pendingView);
assert.deepEqual(await pending, { status: 503, body: { error: "admission_unconfirmed", operationId: blockedId } });
assert.deepEqual(await read(blockedId), { status: 404, body: { error: "run_not_found" } });
assert.deepEqual(await submitWhenFree(missing), { status: 404, body: { error: "github_reference_not_found", operationId: nextId } });
assert.deepEqual(await read(nextId), { status: 404, body: { error: "run_not_found" } });
const deniedId = randomUUID();
assert.deepEqual(await submitWhenFree(submission(deniedId, fixtureRef, "fixture/denied")), {
  status: 403, body: { error: "github_repository_not_allowed" },
});
const before = await request("/v4/runs");
assert.deepEqual(before, { status: 200, body: { runs: [], nextCursor: null } });
console.log(JSON.stringify({ case: "pending-expiry-cap", blockedId, missingId: nextId, deniedId,
  cancelHttp: 409, sameRequestHttp: 503, incompatibleRequestHttp: 409, capHttp: 429,
  heldAfterFirstReconciliation: true, expired: true, missingHttp: 404, allowlistHttp: 403, indexed: 0 }));

async function qualify({ label, command, slug, ref, expectedSha, tail = [], settings = [], fallback = false }) {
  const id = randomUUID();
  const start = [...command, "--operation-id", id, "--repo", slug, "--ref", ref, ...settings, ...tail];
  const admitted = await until(async () => {
    const result = await exec(process.execPath, [bin, ...start], {
      env: { SANDBOX_RUNNER_URL: origin.origin, SANDBOX_RUNNER_TOKEN: token }, timeout: requestTimeout,
    }).catch(error => error);
    assert(!result.stdout.includes(token) && !result.stderr.includes(token));
    const body = JSON.parse(result.stdout);
    if (body.error !== "installation_capacity") assert.equal(result.code ?? 0, 0, body.error);
    return body;
  }, result => result.error !== "installation_capacity");
  assert.equal(admitted.id, id);
  assert.deepEqual(admitted.repository, { slug, sha: expectedSha });
  const result = await cli(["wait", id, "--timeout-ms", String(requestTimeout)]);
  assert.deepEqual(result.repository, admitted.repository);
  assert.equal(result.status, "succeeded");
  assert.equal(result.cleanup, "destroyed");
  assert.deepEqual(await cli(start), result);
  if (fallback) {
    assert.equal(result.attempts.length, 2);
    assert.equal(result.fallbackReason, "provider_quota_exhausted");
    assert(result.attempts.every(attempt => attempt.cleanup === "destroyed"));
  }
  const shaStart = start.slice();
  shaStart.splice(shaStart.indexOf("--ref"), 2, "--sha", expectedSha);
  assert.equal((await cli(shaStart, 6)).error, "operation_conflict");
  console.log(JSON.stringify({ case: label, id, repository: result.repository, cleanup: result.cleanup, status: result.status,
    ...(fallback ? { attempts: result.attempts.length, fallbackReason: result.fallbackReason } : {}), replayMatched: true,
    equivalentShaConflict: true }));
}

await qualify({ label: "claude-branch", command: ["claude", "start"], slug: repo, ref: fixtureRef,
  expectedSha: githubFixtureData.sha, settings: ["--auth", "api-key"], tail: ["J2 fixture GitHub workspace"] });
await qualify({ label: "codex-annotated-tag-fallback", command: ["codex", "start"], slug: repo, ref: "refs/tags/annotated",
  expectedSha: githubFixtureData.sha, tail: ["J1 fixture strategy quota"], fallback: true });
await qualify({ label: "vitest-lightweight-tag", command: ["vitest", "start"], slug: "fixture/vitest", ref: "refs/tags/lightweight",
  expectedSha: vitestFixtureData.entries.pass.sha });
await qualify({ label: "test-command-branch", command: ["test"], slug: "fixture/vitest", ref: "refs/heads/reference/command",
  expectedSha: vitestFixtureData.entries.command.sha, tail: ["--", "node", "--version"] });
