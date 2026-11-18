import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/sandbox-runner.mjs", import.meta.url));
const account = "0123456789abcdef0123456789abcdef";
const worker = "sandbox-runner-doctor-test";
const version = "e667b1d2-4a7b-4bc1-8d8f-e3d9ed0afe79";
const alternateVersion = "bca09d5b-e9cf-4679-b214-790f0d26e830";
const namespace = "fedcba9876543210fedcba9876543210";
const application = "a9fa5aa3-0801-417d-bab5-2cf6d1e8ca01";
const imageDigest = "sha256:" + "a".repeat(64);
const secret = "synthetic-do-not-print";
const control = "SANDBOX_RUNNER_TOKEN";
const mode = "SANDBOX_RUNNER_MODE";

async function fixture(t, { plan = "ok", timeout } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-runner-doctor-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "cf.mjs");
  const log = join(directory, "calls.jsonl");
  const script = `#!${process.execPath}\n` + String.raw`
import * as fs from "node:fs";
const { plan, log, account, worker, version, alternateVersion, namespace, application, imageDigest, secret, control, mode } = FIXTURE;
const args = process.argv.slice(2);
const profile = args[0] === "--profile" ? args.splice(0, 2)[1] : undefined;
const previous = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
const leaks = [control, "ANTHROPIC_API_KEY", "OPENAI_SUBSCRIPTION_OAUTH_TOKEN", "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_BASE_URL", "NODE_TLS_REJECT_UNAUTHORIZED", "DEBUG"].filter(name => process.env[name] !== undefined);
fs.appendFileSync(log, JSON.stringify({ args, profile, account: process.env.CLOUDFLARE_ACCOUNT_ID, cwd: process.cwd(), leaks }) + "\n");
process.stderr.write(secret + "\n");
const send = value => console.log(JSON.stringify(value));
if (args[0] === "--version") {
  if (plan === "timeout") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 100);
  } else console.log(plan === "invalid-cf" ? secret : "1.0.0-beta.29");
} else if (args.join(" ") === "accounts get") {
  if (plan === "denied-account") {
    console.log(secret);
    process.exitCode = 1;
  } else send({ id: plan === "wrong-account" ? namespace : account, name: secret });
} else if (args.join(" ") === "workers deployments list --worker " + worker) {
  const changed = plan === "raced-deployment" && previous.some(call => call.args[1] === "deployments");
  const versions = [{ version_id: changed ? alternateVersion : version, percentage: plan === "split" ? 60 : 100 }];
  if (plan === "split") versions.push({ version_id: alternateVersion, percentage: 40 });
  send({ deployments: [{ versions }] });
} else if (args.join(" ") === "workers versions get " + version + " --worker-id " + worker) {
  const bindings = [
    { name: mode, type: "plain_text", text: plan === "fixture-worker" ? "fixture" : "real" },
    { name: control, type: "secret_text", text: secret },
    { name: "SANDBOX_RUNNER_AUTH_STRATEGIES", type: "plain_text", text: "1" },
    { name: "SANDBOX_RUNNER_CLAUDE_DEFAULTS", type: "plain_text", text: "1" },
    { name: "SANDBOX_RUNNER_PROVIDER_CONTRACT", type: "plain_text", text: "1" },
    { name: "unknown-binding-" + secret, type: "secret_text", text: secret },
  ];
  if (plan !== "no-credentials" && plan !== "opencode") {
    bindings.push({ name: "ANTHROPIC_API_KEY", type: plan === "wrong-credential-type" ? "plain_text" : "secret_text", text: secret });
  }
  if (plan === "opencode") {
    bindings.push({ name: "SANDBOX_RUNNER_OPENCODE", type: "plain_text", text: "1" },
      { name: "SANDBOX_RUNNER_OPENCODE_OPENAI_API_KEY", type: "secret_text", text: secret });
  }
  if (plan === "duplicate-binding") bindings.push({ name: control, type: "secret_text", text: secret });
  const containers = [{ class_name: plan === "wrong-class" ? "Other" : "Run", name: worker,
    images: { base: plan === "missing-image" ? null : secret + "@" + imageDigest } }];
  send({ id: plan === "wrong-version" ? alternateVersion : version, number: 7, bindings, containers });
} else if (args.slice(0, 3).join(" ") === "durable-objects namespaces list") {
  if (plan === "pagination" && args[4] === "1") send(Array.from({ length: 1000 }, () => ({ script: "other", class: "Run" })));
  else send([{ script: plan === "wrong-namespace" ? "other" : worker, class: "Run", id: namespace, use_sqlite: true }]);
} else if (args.join(" ") === "containers applications list --name " + worker) {
  const app = { id: application, name: worker, scheduling_policy: "durable_object", configuration: { secret },
    durable_objects: { namespace_id: plan === "wrong-container" ? account : namespace } };
  send(plan === "ambiguous-container" ? [app, { ...app, id: alternateVersion }] : [app]);
} else {
  throw new Error("Unexpected Cloudflare command");
}
`;
  const data = { plan, log, account, worker, version, alternateVersion, namespace, application, imageDigest, secret, control, mode };
  await writeFile(executable, script.replace("FIXTURE", JSON.stringify(data)), { mode: 0o700 });
  return {
    async run(args = ["--account", account, "--worker", worker, "--profile", "selected"], env = {}) {
      const processResult = spawnSync(process.execPath, [bin, "cloudflare", "doctor", ...args], {
        encoding: "utf8",
        env: {
          ...process.env, CLOUDFLARE_ACCOUNT_ID: namespace, SANDBOX_RUNNER_WORKER: "other", SANDBOX_RUNNER_CF_PROFILE: "other",
          SANDBOX_RUNNER_CF_BIN: executable, SANDBOX_RUNNER_TIMEOUT_MS: timeout ?? "10000",
          SANDBOX_RUNNER_TOKEN: secret, ANTHROPIC_API_KEY: secret, OPENAI_SUBSCRIPTION_OAUTH_TOKEN: secret,
          CLOUDFLARE_API_TOKEN: secret, CLOUDFLARE_API_BASE_URL: "https://invalid.example", DEBUG: "*", ...env,
        },
      });
      assert.ifError(processResult.error);
      assert.equal(processResult.stderr, "");
      assert.doesNotMatch(processResult.stdout, new RegExp(secret));
      const calls = existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse) : [];
      assert(calls.every(call => call.leaks.length === 0 && !existsSync(call.cwd)));
      return { code: processResult.status, output: JSON.parse(processResult.stdout), calls };
    },
  };
}

test("doctor projects an exact account, active version and linked Run runtime using only cf reads", async t => {
  const { run } = await fixture(t);
  const { code, output, calls } = await run();
  assert.equal(code, 0);
  assert.equal(output.status, "ready");
  assert.equal(output.account, account);
  assert.equal(output.worker, worker);
  assert.equal(output.cfVersion, "1.0.0-beta.29");
  assert.deepEqual(output.version, { id: version, percentage: 100, number: 7 });
  assert.equal(output.bindings.credentials.ANTHROPIC_API_KEY, "present");
  assert.equal(output.bindings.credentials.OPENAI_API_KEY, "missing");
  assert.equal(output.runtime.namespaceId, namespace);
  assert.equal(output.runtime.applicationId, application);
  assert.equal(output.runtime.baseImageDigest, imageDigest);
  assert.deepEqual(output.issues, []);
  assert(calls.every(call => call.account === account && call.profile === "selected"));
  assert.deepEqual(calls.map(call => call.args), [
    ["--version"], ["accounts", "get"], ["workers", "deployments", "list", "--worker", worker],
    ["workers", "versions", "get", version, "--worker-id", worker],
    ["durable-objects", "namespaces", "list", "--page", "1", "--per-page", "1000"],
    ["containers", "applications", "list", "--name", worker], ["workers", "deployments", "list", "--worker", worker],
  ]);
});

test("doctor reports an enabled OpenCode provider independently of the legacy credentials", async t => {
  const { run } = await fixture(t, { plan: "opencode" });
  const { code, output } = await run();
  assert.equal(code, 0);
  assert.equal(output.status, "ready");
  assert.deepEqual(output.bindings.opencode, { capability: "present", credentials: { openai: "present", anthropic: "missing" } });
  assert(Object.values(output.bindings.credentials).every(status => status === "missing"));
});

test("doctor supports environment target values and a later Durable Object namespace page", async t => {
  const { run } = await fixture(t, { plan: "pagination" });
  const { code, calls } = await run([], { CLOUDFLARE_ACCOUNT_ID: account, SANDBOX_RUNNER_WORKER: worker });
  assert.equal(code, 0);
  assert(calls.every(call => call.account === account && call.profile === "other"));
  assert(calls.some(call => call.args[0] === "durable-objects" && call.args[4] === "2"));
});

for (const [plan, error, reads] of [
  ["invalid-cf", "cf_unavailable", 1],
  ["wrong-account", "cloudflare_account_unverified", 2],
  ["denied-account", "cloudflare_account_unverified", 2],
  ["split", "worker_target_unverified", 3],
  ["wrong-version", "worker_target_unverified", 4],
  ["wrong-class", "cloudflare_runtime_unverified", 4],
  ["missing-image", "cloudflare_runtime_unverified", 4],
  ["wrong-namespace", "cloudflare_runtime_unverified", 5],
  ["wrong-container", "cloudflare_runtime_unverified", 6],
  ["ambiguous-container", "cloudflare_runtime_unverified", 6],
  ["raced-deployment", "worker_target_unverified", 7],
]) {
  test(`doctor rejects ${plan} without exposing raw cf output`, async t => {
    const { run } = await fixture(t, { plan });
    const { code, output, calls } = await run();
    assert.equal(code, 3);
    assert.equal(output.error, error);
    assert.equal(calls.length, reads);
  });
}

for (const [plan, issue, group, binding, status] of [
  ["fixture-worker", "worker_bindings_unverified", "required", mode, "invalid"],
  ["duplicate-binding", "worker_bindings_unverified", "required", control, "invalid"],
  ["no-credentials", "provider_credentials_missing", "credentials", "ANTHROPIC_API_KEY", "missing"],
  ["wrong-credential-type", "provider_bindings_invalid", "credentials", "ANTHROPIC_API_KEY", "invalid"],
]) {
  test(`doctor reports ${plan} as requiring setup`, async t => {
    const { run } = await fixture(t, { plan });
    const { code, output } = await run();
    assert.equal(code, 3);
    assert.equal(output.status, "needs_setup");
    assert(output.issues.includes(issue));
    assert.equal(output.bindings[group][binding], status);
  });
}

test("doctor reports a missing cf binary and rejects invalid options before any read", async t => {
  const { run } = await fixture(t);
  const missing = await run(undefined, { SANDBOX_RUNNER_CF_BIN: join(tmpdir(), "absent-doctor-cf-executable") });
  assert.equal(missing.code, 3);
  assert.equal(missing.output.error, "cf_unavailable");
  const duplicate = await run(["--worker", worker, "--worker", worker]);
  assert.equal(duplicate.code, 2);
  assert.deepEqual(duplicate.calls, []);
});

test("doctor times out a hanging cf read and removes its temporary working directory", async t => {
  // The fake read never answers, so the deadline only needs to outlast process startup on a loaded machine.
  const { run } = await fixture(t, { plan: "timeout", timeout: "5000" });
  const { code, output, calls } = await run();
  assert.equal(code, 5);
  assert.equal(output.error, "timeout");
  assert.equal(calls.length, 1);
});
