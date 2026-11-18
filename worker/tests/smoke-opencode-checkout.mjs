import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { githubFixtureData } from "../github-fixture-data.ts";

const url = process.env.SANDBOX_RUNNER_TEST_URL ?? "http://127.0.0.1:8925";
const timeout = process.env.SANDBOX_RUNNER_TEST_TIMEOUT_MS ?? "120000";
const token = /^SANDBOX_RUNNER_TOKEN=(\S+)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
if (!token) throw new Error("Missing synthetic control token");
const bin = fileURLToPath(new URL("../../bin/sandbox-runner.mjs", import.meta.url));
const exec = promisify(execFile);
const repository = { slug: "fixture/OpenCode", sha: githubFixtureData.opencode.sha };
const reference = process.env.SANDBOX_RUNNER_TEST_SOURCE === "ref";
const referenceFor = provider => provider === "openai" ? "refs/heads/reference/main" : "refs/tags/annotated";
const sourceFor = provider => reference ? { slug: repository.slug, ref: referenceFor(provider) } : repository;
const prompt = "OpenCode fixture checkout";
const body = { kind: "agent", agent: "opencode", authMode: "api-key", modelProvider: "openai",
  repository: sourceFor("openai"), prompt };
const auth = { authorization: "Bearer " + token };
assert.notEqual(repository.sha, githubFixtureData.opencode.tip);

async function call(path, options) {
  const response = await fetch(url + path, { ...options, redirect: "error", signal: AbortSignal.timeout(Number(timeout)) });
  const text = await response.text();
  assert(!text.includes(token));
  return { code: response.status, body: JSON.parse(text) };
}

function submit(input, version = "v4") {
  return call("/" + version + "/runs", {
    method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(input),
  });
}

async function cli(args, expectedExit = 0) {
  const result = await exec(process.execPath, [bin, ...args], {
    env: { SANDBOX_RUNNER_URL: url, SANDBOX_RUNNER_TOKEN: token },
  }).catch(error => {
    assert.equal(error.code, expectedExit);
    return error;
  });
  assert.equal(result.code ?? 0, expectedExit);
  assert(!result.stdout.includes(token));
  assert(!result.stderr.includes(token));
  return JSON.parse(result.stdout);
}

async function rejected(label, fields, code, error, version) {
  const id = randomUUID();
  assert.deepEqual(await submit({ ...body, ...fields, operationId: id }, version), { code, body: { error } });
  assert.deepEqual(await call(`/v1/runs/${id}`, { headers: auth }), { code: 404, body: { error: "run_not_found" } });
  console.log(JSON.stringify({ case: label, operationId: id, code, error, runRecordAbsent: true }));
}

assert.deepEqual(await call("/v4/runs", { method: "POST", body: "invalid JSON" }), {
  code: 404, body: { error: "not_found" },
});
await rejected("noncanonical-case", { repository: { ...body.repository, slug: repository.slug.toLowerCase() } }, 403,
  "github_repository_not_allowed");
await rejected("not-allowlisted", { repository: { ...body.repository, slug: "fixture/not-admitted" } }, 403,
  "github_repository_not_allowed");
await rejected("invalid-sha", { repository: { ...repository, sha: "main" } }, 400, "invalid_request");
await rejected("publish-rejected", { publish: true }, 400, "invalid_request");
await rejected("review-rejected", { reviewProducer: "claude" }, 400, "invalid_request");
await rejected("legacy-v2-rejected", {}, 400, "invalid_request", "v2");

if (reference) {
  await rejected("subscription-rejected", { authMode: "subscription" }, 400, "invalid_request");
  const missingId = randomUUID();
  assert.deepEqual(await submit({ ...body, operationId: missingId, repository: {
    slug: repository.slug, ref: "refs/heads/reference/missing",
  } }), { code: 404, body: { error: "github_reference_not_found", operationId: missingId } });
  assert.deepEqual(await call(`/v1/runs/${missingId}`, { headers: auth }), { code: 404, body: { error: "run_not_found" } });
  console.log(JSON.stringify({ case: "reference-missing", operationId: missingId, code: 404, runRecordAbsent: true }));
}
for (const provider of ["openai", "anthropic"]) {
  const id = randomUUID();
  const settings = provider === "anthropic" ? { effort: "high" } : {};
  const flags = ["--repo", repository.slug, ...(reference ? ["--ref", referenceFor(provider)] : ["--sha", repository.sha.toUpperCase()])];
  const start = ["opencode", "start", "--model-provider", provider, "--operation-id", id, ...flags,
    ...(settings.effort ? ["--effort", settings.effort] : []), prompt];
  const admission = await cli(start);
  assert.equal(admission.id, id);
  assert.deepEqual(admission.repository, repository);
  const result = await cli(["wait", id, "--timeout-ms", timeout]);
  assert.deepEqual(await cli(start), result);
  assert.deepEqual(await cli(["result", id]), result);
  const { code, body: raw } = await call(`/v1/runs/${id}/result`, { headers: auth });
  assert.equal(code, 200);
  assert.equal(result.status, "succeeded");
  assert.equal(result.cleanup, "destroyed");
  assert.equal(result.output, "OPENCODE_FIXTURE_COMPLETE");
  assert.equal(result.modelProvider, provider);
  assert.equal(result.effort, settings.effort);
  assert.deepEqual(result.repository, repository);
  assert.deepEqual(raw.repository, repository);
  const { fixtureNetwork } = raw;
  assert.equal(fixtureNetwork.unprivileged, true);
  assert.equal(fixtureNetwork.keysAbsent, true);
  assert.equal(fixtureNetwork.placeholderPresent, true);
  assert.match(fixtureNetwork.dns, /^(negative|timed_out)$/);
  assert.match(fixtureNetwork.ip, /^(tcp_failed|tcp_timed_out|tls_failed|tls_timed_out)$/);
  assert.deepEqual(fixtureNetwork.refusals, { method: 403, query: 403, path: 403, credential: 403 });
  assert.deepEqual(fixtureNetwork.checkout, {
    capabilitiesCleared: true, rootRegained: false, trustedFilesWritable: false,
    refusals: { receivePack: 403, otherRepository: 403, wrongCase: 403 },
  });
  const changedSources = [
    { ...repository, sha: githubFixtureData.opencode.tip },
    { ...sourceFor(provider), slug: repository.slug.toLowerCase() },
  ];
  if (reference) changedSources.push(repository, { slug: repository.slug, ref: "refs/heads/reference/missing" });
  for (const changed of changedSources) {
    assert.deepEqual(await submit({ ...body, ...settings, operationId: id, modelProvider: provider, repository: changed }), {
      code: 409, body: { error: "operation_conflict" },
    });
  }
  console.log(JSON.stringify({ case: provider, operationId: id, status: result.status, cleanup: result.cleanup, repository,
    ...(reference ? { requestedRef: referenceFor(provider) } : {}),
    advertisedTip: githubFixtureData.opencode.tip, model: result.model, ...settings, exactReplay: true, resultAfterDestroy: true,
    workspaceWitnessVerified: true, fixtureNetwork }));
}

const badId = randomUUID();
assert.equal((await submit({ ...body, operationId: badId, repository: { ...repository, sha: "f".repeat(40) } })).code, 202);
const bad = await cli(["wait", badId, "--timeout-ms", timeout], 1);
assert.equal(bad.status, "failed");
assert.equal(bad.cleanup, "destroyed");
assert.equal(bad.reason, "github_checkout_failed");
assert.equal(bad.output, undefined);
console.log(JSON.stringify({ case: "unreachable-sha", operationId: badId, status: bad.status, cleanup: bad.cleanup, reason: bad.reason }));

const cancelId = randomUUID();
assert.equal((await submit({ ...body, operationId: cancelId, prompt: "OpenCode fixture cancellation" })).code, 202);
await cli(["cancel", cancelId]);
const cancelled = await cli(["wait", cancelId, "--timeout-ms", timeout], 1);
assert.equal(cancelled.status, "cancelled");
assert.equal(cancelled.cleanup, "destroyed");
console.log(JSON.stringify({ case: "cancel", operationId: cancelId, status: cancelled.status, cleanup: cancelled.cleanup }));

const deadlineId = randomUUID();
assert.equal((await submit({ ...body, operationId: deadlineId, timeoutMs: 1 })).code, 202);
const timedOut = await cli(["wait", deadlineId, "--timeout-ms", timeout], 5);
assert.equal(timedOut.status, "timed_out");
assert.equal(timedOut.cleanup, "destroyed");
console.log(JSON.stringify({ case: "deadline", operationId: deadlineId, status: timedOut.status, cleanup: timedOut.cleanup }));
