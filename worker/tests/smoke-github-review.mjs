import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { githubFixtureData } from "../github-fixture-data.ts";

const runCli = promisify(execFile);
const bin = process.env.SANDBOX_RUNNER_TEST_BIN ?? fileURLToPath(new URL("../../bin/sandbox-runner.mjs", import.meta.url));
const base = process.env.SANDBOX_RUNNER_TEST_URL ?? "http://127.0.0.1:8915";
const token = /^SANDBOX_RUNNER_TOKEN=(\S+)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
if (!token) throw new Error("Missing synthetic control token");
const timeout = process.env.SANDBOX_RUNNER_TEST_TIMEOUT_MS ?? "120000";
const repo = "fixture/private";
const sha = githubFixtureData.sha;

async function cli(args, expectedExit = 0) {
  const result = await runCli(process.execPath, [bin, ...args], {
    env: { SANDBOX_RUNNER_URL: base, SANDBOX_RUNNER_TOKEN: token },
  }).catch(error => {
    assert.equal(error.code, expectedExit);
    return error;
  });
  assert.equal(result.code ?? 0, expectedExit);
  assert(!result.stdout.includes(token));
  assert(!result.stderr.includes(token));
  return JSON.parse(result.stdout);
}

for (const [agent, producer, criteria, expected] of [
  ["codex", "claude", "J2 fixture review verdict", "passed"],
  ["claude", "codex", "J2 fixture GitHub workspace", "read-only"],
  ["codex", "claude", "Return the ordinary fixture response", "invalid"],
]) {
  const id = randomUUID();
  const args = ["review", "--agent", agent, "--producer-agent", producer, "--repo", repo, "--sha", sha,
    "--auth", "api-key", "--operation-id", id, criteria];
  const admission = await cli(args);
  assert.equal(admission.id, id);
  assert.deepEqual(admission.repository, { slug: repo, sha });
  assert.deepEqual(admission.review, { producerAgent: producer });
  const result = await cli(["wait", id, "--timeout-ms", timeout], expected === "invalid" ? 1 : 0);
  assert.equal(result.cleanup, "destroyed");
  assert.equal(result.output, undefined);
  assert.deepEqual(await cli(args), result);
  assert.deepEqual(await cli(["result", id], expected === "invalid" ? 1 : 0), result);
  if (expected === "invalid") {
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "review_verdict_invalid");
    assert.deepEqual(result.review, { producerAgent: producer });
  } else {
    assert.equal(result.status, "succeeded");
    assert.equal(result.review.verdict, "PASS");
    if (expected === "read-only") assert.match(result.review.findings[0], /both returned HTTP 403/);
  }
  const { events } = await cli(["events", id]);
  assert(events.some(event => event.type === "cleanup" && event.cleanup === "destroyed"));
  assert(!JSON.stringify(events).includes("findings"));
  console.log(JSON.stringify({ expected, result }));
}
