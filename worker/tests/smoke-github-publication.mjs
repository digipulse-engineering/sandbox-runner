import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { githubFixtureData } from "../github-fixture-data.ts";

const url = process.env.SANDBOX_RUNNER_TEST_URL ?? "http://127.0.0.1:8912";
const timeout = Number(process.env.SANDBOX_RUNNER_TEST_TIMEOUT_MS ?? 120_000);
const token = /^SANDBOX_RUNNER_TOKEN=(\S+)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
if (!token) throw new Error("Missing synthetic control token");
const cliBin = fileURLToPath(new URL("../../bin/sandbox-runner.mjs", import.meta.url));
const exec = promisify(execFile);
const repository = { slug: "fixture/private", sha: githubFixtureData.sha };
const prompt = "J2 fixture GitHub publication";

async function cli(args, expectedExit = 0) {
  const result = await exec(process.execPath, [cliBin, ...args], {
    env: { SANDBOX_RUNNER_URL: url, SANDBOX_RUNNER_TOKEN: token },
  }).catch(error => {
    assert.equal(error.code, expectedExit);
    return error;
  });
  assert.equal(result.code ?? 0, expectedExit);
  assert(!result.stdout.includes(token) && !result.stderr.includes(token));
  return JSON.parse(result.stdout);
}

function start(agent, id, prompt, authMode) {
  return [agent, "start", "--operation-id", id, "--repo", repository.slug, "--sha", repository.sha,
    ...(authMode ? ["--auth", authMode] : []), "--publish", prompt];
}

function wait(id, expectedExit = 0) {
  return cli(["wait", id, "--timeout-ms", String(timeout)], expectedExit);
}

function expectedTree() {
  const gitHash = (kind, bytes) => createHash("sha1").update(kind + " " + bytes.length + "\0").update(bytes).digest();
  const root = githubFixtureData.trees[githubFixtureData.baseTree]
    .filter(entry => entry.path !== ".gitattributes" && entry.path !== "witness.txt")
    .map(entry => ({ ...entry, hash: Buffer.from(entry.sha, "hex") }));
  for (const [path, mode, text] of [
    ["witness.txt", "100755", "sandbox-runner publication fixture\n"],
    ["created.txt", "100644", "new synthetic publication file\n"],
  ]) root.push({ path, mode, type: "blob", hash: gitHash("blob", Buffer.from(text)) });
  const sortKey = ({ path, type }) => Buffer.from(path + (type === "tree" ? "/" : ""));
  root.sort((left, right) => sortKey(left).compare(sortKey(right)));
  return gitHash("tree", Buffer.concat(root.flatMap(({ mode, path, hash }) => [
    Buffer.from((mode === "040000" ? "40000" : mode) + " " + path + "\0"), hash,
  ]))).toString("hex");
}

const invalidId = randomUUID();
const invalidResponse = await fetch(url + "/v4/runs", {
  method: "POST", redirect: "error",
  headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: JSON.stringify({ operationId: invalidId, kind: "agent", agent: "claude", reviewProducer: "codex",
    publish: true, repository, prompt: "Read-only fixture" }),
});
assert.equal(invalidResponse.status, 400);
assert.deepEqual(await invalidResponse.json(), { error: "invalid_request" });
const unadmitted = await fetch(url + "/v1/runs/" + invalidId, {
  headers: { authorization: "Bearer " + token }, redirect: "error",
});
assert.equal(unadmitted.status, 404);
assert.deepEqual(await unadmitted.json(), { error: "run_not_found" });
console.log(JSON.stringify({ mode: "review_publish_rejected", id: invalidId, http: 400, admitted: false }));

for (const [mode, agent, auth] of [["direct", "claude", "api-key"], ["strategy", "claude", undefined],
  ["codex_changes", "codex", "api-key"]]) {
  const id = randomUUID();
  const args = start(agent, id, mode === "strategy" ? prompt + " fallback" : prompt, auth);
  const accepted = await cli(args);
  assert.equal(accepted.id, id);
  assert.deepEqual(accepted.publication, { status: "pending" });
  assert.equal(accepted.publicationState, undefined);
  const result = await wait(id);
  console.log(JSON.stringify({ mode, result }));
  assert.equal(result.status, "succeeded");
  assert.equal(result.cleanup, "destroyed");
  assert.equal(result.output, "publication fixture edits verified");
  assert.equal(result.publication.status, "published");
  assert.equal(result.publication.branch, "sandbox-runner/" + id);
  assert.equal(result.publication.treeSha, expectedTree());
  assert.match(result.publication.commitSha, /^[a-f0-9]{40}$/u);
  assert.notEqual(result.publication.commitSha, repository.sha);
  if (mode === "strategy") {
    assert.equal(result.attempts.length, 2);
    assert.notEqual(result.attempts[0].operationId, id);
    assert.notEqual(result.attempts[1].operationId, id);
    assert.equal(result.attempts[0].status, "capacity");
    assert.equal(result.attempts[0].cleanup, "destroyed");
    assert.equal(result.attempts[1].authMode, "subscription");
    assert.equal(result.fallbackReason, "provider_quota_exhausted");
  } else {
    assert.equal(result.attempts, undefined);
  }
  assert.deepEqual(await cli(args), result);
  const conflict = await cli(args.filter(argument => argument !== "--publish"), 6);
  assert.equal(conflict.error, "operation_conflict");
}

const unchangedId = randomUUID();
await cli(start("codex", unchangedId, "J1 fixture success", "api-key"));
const unchanged = await wait(unchangedId);
console.log(JSON.stringify({ mode: "no_changes", result: unchanged }));
assert.equal(unchanged.cleanup, "destroyed");
assert.equal(unchanged.output, "Codex fixture complete.");
assert.deepEqual(unchanged.publication, { status: "no_changes" });

const readonlyId = randomUUID();
await cli(start("claude", readonlyId, "J1 fixture success", "api-key").filter(argument => argument !== "--publish"));
const readonly = await wait(readonlyId);
console.log(JSON.stringify({ mode: "read_only", result: readonly }));
assert.equal(readonly.publication, undefined);
assert.equal(readonly.cleanup, "destroyed");

const cancelledId = randomUUID();
await cli(start("claude", cancelledId, "J1 fixture cancellation", "api-key"));
const deadline = Date.now() + timeout;
let status;
while (Date.now() < deadline) {
  status = await cli(["status", cancelledId]);
  if (status.status === "running") break;
  assert.equal(status.status, "queued");
  await sleep(1_000);
}
assert.equal(status?.status, "running");
await cli(["cancel", cancelledId]);
const cancelled = await wait(cancelledId, 1);
console.log(JSON.stringify({ mode: "cancelled", result: cancelled }));
assert.equal(cancelled.status, "cancelled");
assert.equal(cancelled.cleanup, "destroyed");
assert.deepEqual(cancelled.publication, { status: "cancelled" });
