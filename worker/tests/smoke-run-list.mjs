import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { open, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { vitestFixtureData } from "../vitest/fixture-data.ts";

const [, , origin, tokenPath, legacyPath] = process.argv;
const handle = await open(tokenPath, "r");
let token;
try {
  const metadata = await handle.stat();
  assert(metadata.isFile() && (metadata.mode & 0o077) === 0, "Use a private synthetic token file");
  token = (await handle.readFile("utf8")).trim();
} finally {
  await handle.close();
}
assert(/^[a-f0-9]{64}$/.test(token));
const legacy = legacyPath === undefined ? undefined : JSON.parse(await readFile(legacyPath, "utf8"));
const bin = fileURLToPath(new URL("../../bin/sandbox-runner.mjs", import.meta.url));
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const timeout = Number(process.env.RUN_LIST_SMOKE_TIMEOUT_MS ?? "120000");
const receipt = {};

function cli(url, ...args) {
  const env = { PATH: process.env.PATH, SANDBOX_RUNNER_URL: url, SANDBOX_RUNNER_TOKEN: token };
  return new Promise((resolve, reject) => execFile(process.execPath, [bin, ...args], { env }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") return reject(error);
    try {
      assert(!stdout.includes(token) && !stderr.includes(token));
      resolve({ code: error?.code ?? 0, output: JSON.parse(stdout) });
    } catch (failure) {
      reject(failure);
    }
  }));
}

async function request(path, input) {
  const response = await fetch(new URL(path, origin), {
    headers, method: input ? "POST" : "GET", body: input && JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(timeout),
  });
  const raw = await response.text();
  assert(!raw.includes(token));
  return { status: response.status, body: JSON.parse(raw), raw };
}

async function terminal(id) {
  const signal = AbortSignal.timeout(timeout);
  for (;;) {
    signal.throwIfAborted();
    const result = await request(`/v1/runs/${id}/result`);
    if (result.status === 200) {
      assert.equal(result.body.cleanup, "destroyed");
      return result.body;
    }
    assert.equal(result.status, 409);
    await sleep(500, undefined, { signal });
  }
}

function summary(run) {
  const { id, agent, status, cleanup, suite } = run;
  const sandboxProvider = "cloudflare";
  return suite ? { id, kind: "test", suite, sandboxProvider, status, cleanup }
    : { id, kind: "agent", agent, sandboxProvider, status, cleanup };
}

async function page(query = "") {
  const result = await request("/v4/runs" + query);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ["nextCursor", "runs"]);
  for (const row of result.body.runs) assert.deepEqual(row, summary(row));
  for (const excluded of ["J1 fixture", "fixture/vitest", "SHELL_INJECTION", "FIXTURE_COMMAND", "secret", '"argv"', '"repository"', '"output"', '"attempts"']) {
    assert(!result.raw.includes(excluded));
  }
  return result.body;
}

async function submit(input, path = "/v4/runs") {
  const accepted = await request(path, input);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.id, input.operationId);
  return terminal(input.operationId);
}

async function lostAdmission(id) {
  let upstreamStatus;
  let upstreamError;
  const proxy = createServer(async (incoming, outgoing) => {
    try {
      assert.equal(incoming.method, "POST");
      assert.equal(incoming.url, "/v4/runs");
      incoming.setEncoding("utf8");
      let body = "";
      for await (const chunk of incoming) body += chunk;
      const accepted = await request(incoming.url, JSON.parse(body));
      upstreamStatus = accepted.status;
      assert.equal(accepted.body.id, id);
    } catch (error) {
      upstreamError = error;
    } finally {
      outgoing.destroy();
    }
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  try {
    const lost = await cli(`http://127.0.0.1:${proxy.address().port}`, "claude", "start", "--auth", "subscription", "--operation-id", id, "J1 fixture success");
    if (upstreamError) throw upstreamError;
    assert.equal(upstreamStatus, 202);
    assert.equal(lost.output.error, "network_error");
    assert.equal(lost.output.operationId, id);
    assert.equal(lost.output.uncertain, true);
    return { upstreamStatus, clientError: lost.output.error, uncertain: true };
  } finally {
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
  }
}

try {
  assert.equal((await fetch(new URL("/v4/runs", origin))).status, 404);
  for (const [query, error] of [["?limit=25", "invalid_limit"], ["?cursor=01", "invalid_cursor"], ["?cursor=1&cursor=2", "invalid_cursor"], ["?other=1", "invalid_query"]]) {
    const invalid = await request("/v4/runs" + query);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, error);
  }
  if (legacy) {
    const legacyResult = await terminal(legacy.id);
    assert.equal(legacyResult.status, legacy.status);
    assert.equal((await request("/v4/runs", legacy.request)).status, 202);
  }
  const initialPage = await page();
  assert.deepEqual(initialPage, { runs: [], nextCursor: null });
  if (legacy) receipt.legacy = { id: legacy.id, readable: true, replayed: true, initialPage };
  else receipt.initialPage = initialPage;

  const claudeId = randomUUID();
  receipt.lost = await lostAdmission(claudeId);
  assert.deepEqual((await page()).runs.map(run => run.id), [claudeId]);
  const claude = await submit({ operationId: claudeId, kind: "agent", agent: "claude", authMode: "subscription", prompt: "J1 fixture success" });
  assert.equal((await request("/v4/runs", { operationId: claudeId, kind: "agent", agent: "claude", authMode: "subscription", prompt: "changed input" })).status, 409);
  const codex = await submit({ operationId: randomUUID(), agent: "codex", prompt: "J1 fixture success" }, "/v1/runs");
  const vitest = await submit({ operationId: randomUUID(), kind: "test", suite: "vitest",
    repository: { slug: "fixture/vitest", sha: vitestFixtureData.entries.pass.sha } });
  for (const run of [claude, codex, vitest]) assert.equal(run.status, "succeeded");
  const first = await page("?limit=2");
  assert.deepEqual(first.runs, [summary(vitest), summary(codex)]);
  assert.equal(typeof first.nextCursor, "string");
  receipt.first = first;

  const command = await submit({ operationId: randomUUID(), kind: "test", suite: "command", argv: ["semver", "1.2.3"],
    repository: { slug: "fixture/vitest", sha: vitestFixtureData.entries.command.sha } });
  const strategy = await submit({ operationId: randomUUID(), kind: "agent", agent: "claude", prompt: "J1 fixture strategy quota" });
  assert.equal(command.status, "succeeded");
  assert.equal(strategy.status, "succeeded");
  assert.equal(strategy.attempts.length, 2);
  const resumed = await page(`?limit=2&cursor=${first.nextCursor}`);
  assert.deepEqual(resumed, { runs: [summary(claude)], nextCursor: null });
  assert.deepEqual(await cli(origin, "list", "--limit=2", `--cursor=${first.nextCursor}`), { code: 0, output: resumed });
  const fresh = await page();
  assert.deepEqual(fresh, { runs: [strategy, command, vitest, codex, claude].map(summary), nextCursor: null });
  for (const attempt of strategy.attempts) assert(!fresh.runs.some(run => run.id === attempt.operationId));
  receipt.resumed = resumed;
  receipt.fresh = fresh;
  receipt.strategyAttemptIds = strategy.attempts.map(attempt => attempt.operationId);
  receipt.rawListContainsOnlySummaryFields = true;
} finally {
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
}
