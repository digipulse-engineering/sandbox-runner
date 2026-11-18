import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import pin from "./fixture-pin.json" with { type: "json" };
import { witnessPath } from "./witness.mjs";

const [, , origin, tokenPath, operationId = randomUUID()] = process.argv;
const url = new URL(origin);
assert(!url.username && !url.password && url.pathname === "/" && !url.search && !url.hash, "Use a Worker origin");
assert(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"), "Use HTTPS or HTTP loopback");
assert(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(operationId), "Use a lowercase UUID");

const tokenFile = await open(tokenPath, "r");
let token;
try {
  const metadata = await tokenFile.stat();
  assert(metadata.isFile() && (metadata.mode & 0o077) === 0, "Use a private token file");
  token = (await tokenFile.readFile("utf8")).trim();
} finally {
  await tokenFile.close();
}
assert(/^[a-f0-9]{64}$/.test(token), "Use a synthetic token from openssl rand -hex 32");

const requestDeadline = Number(process.env.VITEST_QUALIFICATION_VERIFY_TIMEOUT_MS ?? 240_000);
const signal = AbortSignal.timeout(requestDeadline);
const headers = { authorization: "Bearer " + token };
const request = (path, method = "GET", auth = headers) => fetch(new URL(path, url), { method, headers: auth, redirect: "error", signal });
const path = `/v1/runs/${operationId}`;
const hidden = await request(path, "GET", {});
assert.equal(hidden.status, 404);
await hidden.body?.cancel();
if (url.protocol === "https:") {
  const witness = await request(await witnessPath(token, operationId, "mac"), "GET", {});
  assert.equal(witness.status, 200);
  assert.deepEqual(await witness.json(), { received: true });
}
const submitted = await request(path, "POST");
assert.equal(submitted.status, 202);
assert.equal((await submitted.json()).id, operationId);

let response = await request(path + "/result");
while (response.status === 409) {
  await response.body?.cancel();
  await setTimeout(1000, undefined, { signal });
  response = await request(path + "/result");
}
assert.equal(response.status, 200);
const report = await response.json();
const status = await request(path);
assert.equal(status.status, 200);
assert.deepEqual(await status.json(), report);
const replay = await request(path, "POST");
assert.equal(replay.status, 202);
assert.deepEqual(await replay.json(), report);
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

assert.equal(report.id, operationId);
assert.equal(report.status, "succeeded");
assert.equal(report.cleanup, "destroyed");
assert.equal(report.sourceScope, "image-preseeded-synthetic-git");
assert.equal(report.fixtureCommit, pin.commit);
assert.match(report.nodeVersion, /^v24\.\d+\.\d+$/);
assert.equal(report.vitestVersion, pin.vitest);
assert.equal(report.internetAtStart, false);
assert.equal(report.registrySealed, true);
assert(report.registryRequests > 0);
assert.equal(report.install.exitCode, 0);
assert.equal(report.pass.exitCode, 0);
assert.equal(report.fail.exitCode, 1);
if (url.protocol === "https:") assert.deepEqual(report.witness, { macReached: true, vitestReached: false });
