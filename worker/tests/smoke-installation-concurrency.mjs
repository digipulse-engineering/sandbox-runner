import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { githubFixtureData } from "../github-fixture-data.ts";
import { vitestFixtureData } from "../vitest/fixture-data.ts";

const [origin, tokenPath, mode = "guarded", previousPath] = process.argv.slice(2);
assert.equal(new URL(origin).hostname, "127.0.0.1");
const handle = await open(tokenPath, "r");
let token;
try {
  const metadata = await handle.stat();
  assert(metadata.isFile() && (metadata.mode & 0o077) === 0);
  token = (await handle.readFile("utf8")).trim();
} finally {
  await handle.close();
}
assert(/^[a-f0-9]{64}$/.test(token));
const timeout = Number(process.env.SANDBOX_RUNNER_TEST_TIMEOUT_MS ?? "120000");
const api = "/v4/runs";
const report = {};
const direct = (operationId = randomUUID()) => ({ kind:"agent", agent:"claude", operationId,
  prompt:"J1 fixture cancellation", authMode:"api-key" });
const test = (operationId = randomUUID()) => ({ kind:"test", suite:"vitest", operationId,
  repository:{slug:"fixture/vitest", sha:vitestFixtureData.entries.pass.sha} });
const review = (operationId = randomUUID()) => ({ kind:"agent", agent:"codex", reviewProducer:"claude",
  operationId, authMode:"api-key", prompt:"J2 fixture review verdict",
  repository:{slug:"fixture/private", sha:githubFixtureData.sha} });

async function request(path, input, authorized = true) {
  const response = await fetch(new URL(path, origin), {
    method:input === undefined ? "GET" : "POST", redirect:"error", signal:AbortSignal.timeout(timeout),
    headers:{"content-type":"application/json", ...(authorized ? {authorization:"Bearer " + token} : {})},
    ...(input === undefined ? {} : {body:JSON.stringify(input)}),
  });
  const raw = await response.text();
  assert(!raw.includes(token));
  return {status:response.status, body:JSON.parse(raw)};
}

async function until(action) {
  const signal = AbortSignal.timeout(timeout);
  for (;;) {
    signal.throwIfAborted();
    const result = await action();
    if (result !== undefined) return result;
    await sleep(300, undefined, {signal});
  }
}

async function terminal(id) {
  return until(async () => {
    const result = await request("/v1/runs/" + id + "/result");
    if (result.status === 409) return;
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.id, id);
    assert.equal(result.body.cleanup, "destroyed");
    return result.body;
  });
}

async function capacity(path, input) {
  const refused = await request(path, input);
  assert.equal(refused.status, 429, JSON.stringify(refused.body));
  assert.deepEqual(refused.body, {error:"installation_capacity", operationId:input.operationId});
  assert.equal((await request("/v1/runs/" + input.operationId)).status, 404);
}

async function reserveWhenOpen(input) {
  return until(async () => {
    const response = await request(api, input);
    if (response.status === 429) return;
    assert.equal(response.status, 202, JSON.stringify(response.body));
    assert.equal(response.body.id, input.operationId);
    return response.body;
  });
}

try {
  if (mode === "guarded") {
    const first = direct();
    assert.equal((await request(api, first, false)).status, 404);
    const duplicates = await Promise.all([request(api, first), request(api, first)]);
    for (const result of duplicates) {
      assert.equal(result.status, 202, JSON.stringify(result.body));
      assert.equal(result.body.id, first.operationId);
    }
    const legacy = {agent:"claude", prompt:"J1 fixture success"};
    for (const [path, input] of [
      ["/v1/runs", {...legacy, operationId:randomUUID()}],
      ["/v2/runs", {...legacy, authMode:"api-key", operationId:randomUUID()}],
      ["/v3/runs", {...legacy, effort:"medium", operationId:randomUUID()}],
      [api, direct()],
      [api, review()],
      [api, test()],
    ]) await capacity(path, input);
    assert.equal((await request(api, {...first,prompt:"different"})).status, 409);
    assert.equal((await request(api, test(first.operationId))).status, 409);
    assert.equal((await request(api, first)).status, 202);
    assert.equal((await request(api)).body.runs.filter(run => run.id === first.operationId).length, 1);
    await until(async () => {
      const status = await request("/v1/runs/" + first.operationId);
      assert.equal(status.status, 200);
      if (status.body.status === "running") return true;
      assert.equal(status.body.status, "queued");
    });
    assert.equal((await request(api + "/" + first.operationId + "/cancel", {})).status, 202);
    assert.equal((await terminal(first.operationId)).status, "cancelled");
    report.direct = {id:first.operationId, replayed:true, refusedRoutes:6, status:"cancelled", cleanup:"destroyed"};

    const strategy = {kind:"agent", agent:"claude", operationId:randomUUID(), prompt:"J1 fixture strategy quota"};
    await reserveWhenOpen(strategy);
    const strategyResult = await terminal(strategy.operationId);
    assert.equal(strategyResult.status, "succeeded");
    assert.deepEqual(strategyResult.attempts.map(({authMode,status,cleanup}) => ({authMode,status,cleanup})), [
      {authMode:"api-key",status:"capacity",cleanup:"destroyed"},
      {authMode:"subscription",status:"succeeded",cleanup:"destroyed"},
    ]);
    const entries = (await request(api)).body.runs;
    assert(!entries.some(item => strategyResult.attempts.some(attempt => attempt.operationId === item.id)));
    report.strategy = {id:strategy.operationId, attempts:strategyResult.attempts, status:"succeeded", cleanup:"destroyed"};

    for (const [kind, input] of [["review", review()], ["test", test()]]) {
      await reserveWhenOpen(input);
      const run = await terminal(input.operationId);
      assert.equal(run.status, "succeeded", JSON.stringify(run));
      if (kind === "review") assert.equal(run.review.verdict, "PASS");
      else assert.equal(run.kind, "test");
      report[kind] = {id:run.id, status:run.status, cleanup:run.cleanup};
    }
  } else if (mode === "legacy") {
    const input = {kind:"agent", agent:"claude", operationId:randomUUID(), prompt:"J1 fixture success", authMode:"api-key"};
    const concurrent = {...input, agent:"codex", operationId:randomUUID()};
    const accepted = await Promise.all([request(api, input), request(api, concurrent)]);
    for (const run of accepted) {
      assert.equal(run.status, 202, JSON.stringify(run.body));
      assert(["queued", "running"].includes(run.body.status));
    }
    for (const id of [input.operationId, concurrent.operationId]) assert.equal((await terminal(id)).status, "succeeded");
    report.legacy = {input, concurrent:concurrent.operationId, status:"succeeded", cleanup:"destroyed"};
  } else if (mode === "legacy-configured" || mode === "guarded-unconfigured") {
    const previous = JSON.parse(await readFile(previousPath, "utf8"));
    const replay = mode === "legacy-configured" ? previous.legacy.input : direct(previous.direct.id);
    const repeated = await request(api, replay);
    assert.equal(repeated.status, 202, JSON.stringify(repeated.body));
    assert.equal(repeated.body.id, replay.operationId);
    const fresh = await request(api, direct());
    assert.equal(fresh.status, 503, JSON.stringify(fresh.body));
    const expected = mode === "legacy-configured" ? "legacy_unverified" : "installation_admission_invalid";
    assert.equal(fresh.body.error, expected);
    report.replay = {id:replay.operationId, state:repeated.body.status, freshError:expected};
  } else {
    throw new Error("Unknown smoke mode");
  }
} finally {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
