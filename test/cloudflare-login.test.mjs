import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/sandbox-runner.mjs", import.meta.url));
const account = "0123456789abcdef0123456789abcdef";
const worker = "example-runner";
const sdkCommit = "1a450e71325c25ca1ec8b0013d756fe0c733b6f3";
const testSecret = "synthetic-secret-not-for-cf";
const cfOverrides = [
  "CLOUDFLARE_AUTH_PROFILE", "CLOUDFLARE_API_HEADERS", "CLOUDFLARE_CLIENT_ID", "WRANGLER_AUTH_DOMAIN",
  "WRANGLER_AUTH_URL", "WRANGLER_TOKEN_URL", "WRANGLER_REVOKE_URL", "WRANGLER_API_ENVIRONMENT",
  "CLOUDFLARE_ACCESS_CLIENT_ID", "CLOUDFLARE_ACCESS_CLIENT_SECRET", "WRANGLER_CF_AUTHORIZATION_TOKEN",
];

async function fixture(t, { plan = "existing", profile, schemaVersion = 1 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-runner-login-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "sandbox-runner.project.json");
  const fake = join(directory, "cf.mjs");
  const log = join(directory, "calls.jsonl");
  await writeFile(file, JSON.stringify({ schemaVersion, account, worker, profile, cliVersion: "0.1.0", sdkCommit }));
  await writeFile(fake, "#!" + process.execPath + "\n" + String.raw`
import * as fs from "node:fs";
const { log, account, plan, cfOverrides } = FIXTURE;
const args = process.argv.slice(2);
const previous = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
fs.appendFileSync(log, JSON.stringify({
  args, pid: process.pid, cwd: process.cwd(), account: process.env.CLOUDFLARE_ACCOUNT_ID,
  leaked: ["CLOUDFLARE_API_TOKEN", "SANDBOX_RUNNER_TOKEN", "ANTHROPIC_API_KEY", ...cfOverrides]
    .some(name => process.env[name] !== undefined),
}) + "\n");
if (args.slice(2).join(" ") === "accounts get") {
  const loggedIn = previous.some(call => call.args.includes("auth"));
  if (plan === "unavailable" || (plan === "new" && !loggedIn)) process.exitCode = 1;
  else console.log(JSON.stringify({ id: plan === "wrong" ? "a".repeat(32) : account, name: "private display name" }));
} else if (args.includes("auth")) {
  console.log("Cloudflare device sign-in");
  if (plan === "hold") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 100);
  }
} else {
  throw new Error("Unexpected cf command");
}
`.replace("FIXTURE", JSON.stringify({ log, account, plan, cfOverrides })), { mode: 0o700 });
  const env = {
    ...process.env, SANDBOX_RUNNER_CF_BIN: fake, SANDBOX_RUNNER_CF_PROFILE: "unrelated",
    CLOUDFLARE_ACCOUNT_ID: "b".repeat(32), CLOUDFLARE_API_TOKEN: testSecret, SANDBOX_RUNNER_TOKEN: testSecret,
    ANTHROPIC_API_KEY: testSecret,
    ...Object.fromEntries(cfOverrides.map(name => [name, "synthetic-override"])),
  };
  const invocation = (options = []) => [bin, "cloudflare", "login", directory, ...options];
  const calls = async () => existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse) : [];
  async function run(options, override) {
    const result = spawnSync(process.execPath, invocation(options), { cwd: directory, env: { ...env, ...override }, encoding: "utf8" });
    assert.ifError(result.error);
    assert(!result.stdout.includes(testSecret));
    const recorded = await calls();
    assert(recorded.every(call => call.account === account && !call.leaked && call.cwd !== directory && !existsSync(call.cwd)));
    return { code: result.status, output: JSON.parse(result.stdout), stderr: result.stderr, commands: recorded.map(call => call.args) };
  }
  return { run, calls, invocation, env };
}

test("login verifies and reuses the default project profile", async t => {
  const { run } = await fixture(t);
  const result = await run();
  assert.deepEqual(result, {
    code: 0, output: { status: "authenticated", account, profile: "default", worker }, stderr: "",
    commands: [["--profile", "default", "accounts", "get"]],
  });
});

test("login creates the project's named profile and confirms account access", async t => {
  const { run } = await fixture(t, { plan: "new", profile: "runner-team" });
  const result = await run(["--no-browser"]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.output, { status: "authenticated", account, profile: "runner-team", worker });
  assert.equal(result.stderr, "Cloudflare device sign-in\n");
  assert.deepEqual(result.commands, [
    ["--profile", "runner-team", "accounts", "get"],
    ["auth", "create", "runner-team", "--no-browser"],
    ["--profile", "runner-team", "accounts", "get"],
  ]);
});

test("login forces the default profile to sign in before reading the account", async t => {
  const { run } = await fixture(t);
  const result = await run(["--force", "--no-browser"]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.commands, [
    ["--profile", "default", "auth", "login", "--force", "--no-browser"],
    ["--profile", "default", "accounts", "get"],
  ]);
});

test("login rejects unexpected or unavailable Cloudflare account metadata", async t => {
  for (const plan of ["wrong", "unavailable"]) {
    const { run } = await fixture(t, { plan });
    const result = await run();
    assert.equal(result.code, 3);
    assert.equal(result.output.error, "cloudflare_account_unverified");
    if (plan === "wrong") assert.deepEqual(result.commands, [["--profile", "default", "accounts", "get"]]);
  }
});

test("login rejects invalid manifests, duplicate flags and a missing cf binary", async t => {
  const invalid = await fixture(t, { schemaVersion: 2 });
  assert.equal((await invalid.run()).output.error, "cloudflare_project_invalid");
  const valid = await fixture(t);
  assert.equal((await valid.run(["--force", "--force"])).code, 2);
  assert.equal((await valid.run([], { SANDBOX_RUNNER_CF_BIN: join(tmpdir(), "absent-sandbox-runner-login") })).output.error, "cf_unavailable");
  assert.deepEqual(await valid.calls(), []);
});

test("interruption terminates the cf sign-in process and removes scratch", { timeout: 10_000 }, async t => {
  const fixtureState = await fixture(t, { plan: "hold" });
  const child = spawn(process.execPath, fixtureState.invocation(["--force"]), { env: fixtureState.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  const closed = once(child, "close");
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", data => { stdout += data; });
  let call;
  await Promise.race([
    closed.then(() => assert.fail("Sign-in exited before accepting an interruption")),
    (async () => {
      while (!(call = (await fixtureState.calls())[0])) await sleep(10, undefined, { signal: t.signal });
    })(),
  ]);
  child.kill("SIGTERM");
  assert.deepEqual(await closed, [6, null]);
  assert.equal(JSON.parse(stdout).error, "cloudflare_login_interrupted");
  assert.throws(() => process.kill(call.pid, 0), { code: "ESRCH" });
  assert.equal(existsSync(call.cwd), false);
});
