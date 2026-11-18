import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const bin = fileURLToPath(new URL("../bin/sandbox-runner.mjs", import.meta.url));
const account = "12345678123456781234567812345678";
const worker = "sandbox-runner-setup-test";
const profile = "chosen";
const oldVersion = "c3982431-3622-428d-a21f-c6f4c9ea20f9";
const draftVersion = "4cd1b6a1-8d39-4fa3-8157-837ce31b4004";
const claudeStrategy = "SANDBOX_RUNNER_CLAUDE_AUTH_STRATEGY";
const codexStrategy = "SANDBOX_RUNNER_CODEX_AUTH_STRATEGY";
const claudeModel = "SANDBOX_RUNNER_CLAUDE_MODEL";
const claudeEffort = "SANDBOX_RUNNER_CLAUDE_EFFORT";
const defaultSandboxProvider = "SANDBOX_RUNNER_DEFAULT_SANDBOX_PROVIDER";
const claudeOAuth = "sk-ant-oat01-synthetic-Masked_Claude";
const claudeApiKey = "sk-ant-usr-synthetic-Masked_Claude";
const exec = promisify(execFile);

async function fakeCf(t, { bindings = [], plan = "ok", draft = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-runner-setup-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cf = join(directory, "cf");
  const state = join(directory, "state.json");
  const log = join(directory, "calls.jsonl");
  const versions = [{ id: oldVersion, number: 3 }];
  if (draft) versions.unshift({ id: draftVersion, number: 4 });
  await writeFile(state, JSON.stringify({ id: oldVersion, bindings, versions }));
  const script = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { dirname } = require("node:path");
const args = process.argv.slice(2);
const prefix = args[0] === "--profile" ? args.splice(0, 2) : [];
const [resource, area, action, value] = args;
const statePath = process.env.FAKE_SETUP_STATE;
const log = process.env.FAKE_SETUP_LOG;
const plan = process.env.FAKE_SETUP_PLAN;
const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
const previous = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
const call = {
  args, prefix, account: process.env.CLOUDFLARE_ACCOUNT_ID, cwd: process.cwd(),
  leaks: ["SANDBOX_RUNNER_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLOUDFLARE_API_TOKEN",
    "NODE_OPTIONS", "CLOUDFLARE_API_BASE_URL", "SANDBOX_RUNNER_CLAUDE_MODEL",
    "SANDBOX_RUNNER_CLAUDE_EFFORT", "SANDBOX_RUNNER_DEFAULT_SANDBOX_PROVIDER"].filter(name => process.env[name]),
};
const record = () => fs.appendFileSync(log, JSON.stringify(call) + "\n");
const reply = body => console.log(JSON.stringify(body));
const newVersion = triggeredBy => ({
  id: randomUUID(), number: saved.versions[0].number + 1, annotations: { "workers/triggered_by": triggeredBy },
});
if (resource !== "workers") throw Error("wrong resource");
if (area === "deployments" && action === "list") {
  const reads = previous.filter(item => item.args[1] === "deployments");
  if (plan === "changed" && reads.length === 1) {
    saved.id = randomUUID();
    fs.writeFileSync(statePath, JSON.stringify(saved));
  }
  record();
  reply({ deployments: [{ versions: [{ version_id: saved.id, percentage: plan === "rollout" ? 70 : 100 }] }] });
} else if (area === "versions" && action === "list") {
  record();
  if (plan === "unreconciledHead") {
    reply([{ id: randomUUID(), number: saved.versions[0].number }]);
  } else if (plan === "malformedHead") {
    reply({ items: saved.versions });
  } else {
    reply(saved.versions.slice(0, 2));
  }
} else if (area === "versions" && action === "get") {
  record();
  const bindings = [
    { name: "SANDBOX_RUNNER_MODE", type: "plain_text", text: "real" },
    { name: "SANDBOX_RUNNER_TOKEN", type: "secret_text" },
  ];
  if (plan !== "legacy" && !(plan === "lostCapability" && previous.some(item => item.body))) {
    const cap = { name: "SANDBOX_RUNNER_AUTH_STRATEGIES", type: "plain_text", text: plan === "badCapability" ? "2" : "1" };
    bindings.push(cap);
    if (plan === "duplicateCapability") bindings.push(cap);
  }
  if (plan !== "legacyDefaults" && !(plan === "lostDefaultsCapability" && previous.some(item => item.args[2] === "bulk"))) {
    const cap = { name: "SANDBOX_RUNNER_CLAUDE_DEFAULTS", type: "plain_text", text: plan === "badDefaultsCapability" ? "2" : "1" };
    bindings.push(cap);
    if (plan === "duplicateDefaultsCapability") bindings.push(cap);
  }
  if (plan !== "legacyProvider" && !(plan === "lostProviderCapability" && previous.some(item => item.args[2] === "bulk"))) {
    const cap = { name: "SANDBOX_RUNNER_PROVIDER_CONTRACT", type: "plain_text", text: plan === "badProviderCapability" ? "2" : "1" };
    bindings.push(cap);
    if (plan === "duplicateProviderCapability") bindings.push(cap);
  }
  bindings.push(...saved.bindings.map(name => ({ name, type: plan === "wrongBindingType" ? "plain_text" : "secret_text" })));
  reply({ ...saved.versions.find(version => version.id === value), id: value, bindings });
} else if (area === "secrets" && action === "bulk") {
  const path = args[args.indexOf("--body") + 1].slice(1);
  const patch = JSON.parse(fs.readFileSync(path, "utf8"));
  call.body = {
    path, mode: fs.statSync(path).mode & 511, dirMode: fs.statSync(dirname(path)).mode & 511, patch,
  };
  record();
  process.stderr.write("synthetic-private-cf-output\n");
  if (plan === "updateFailed") process.exit(1);
  if (plan === "concurrentHead") saved.versions.unshift(newVersion("upload"));
  if (plan !== "sameVersion") {
    const version = newVersion(plan === "wrongVersionSource" ? "upload" : "secret");
    saved.versions.unshift(version);
    if (plan !== "rolledBackAfterBulk") saved.id = version.id;
  }
  if (plan === "replacedPreviousVersion") saved.versions[1].id = randomUUID();
  const patched = [...new Set([...saved.bindings, ...Object.keys(patch.secrets)])];
  if (plan !== "missingDefaultBinding") saved.bindings = patched;
  fs.writeFileSync(statePath, JSON.stringify(saved));
  const receipt = Object.fromEntries(["SANDBOX_RUNNER_TOKEN", ...patched].map(name => [name, { name, type: "secret_text" }]));
  const [name] = Object.keys(patch.secrets);
  if (plan === "missingReceipt") delete receipt[name];
  if (plan === "wrongReceiptName") receipt[name].name = "unrelated-binding";
  if (plan === "wrongReceiptType") receipt[name].type = "plain_text";
  receipt.SANDBOX_RUNNER_TOKEN.text = "synthetic-private-cf-output";
  reply(receipt);
} else if (area === "secrets" && action === "update") {
  const path = args[args.indexOf("--body") + 1].slice(1);
  const body = JSON.parse(fs.readFileSync(path, "utf8"));
  const policy = value.endsWith("_AUTH_STRATEGY");
  call.body = {
    path, mode: fs.statSync(path).mode & 511, dirMode: fs.statSync(dirname(path)).mode & 511,
    name: body.name, type: body.type,
    ...(policy ? { policy: JSON.parse(body.text) } : {
      expectedCredential: body.text === (value === "ANTHROPIC_API_KEY" ? process.env.FAKE_SETUP_API : process.env.FAKE_SETUP_OAUTH),
    }),
  };
  record();
  // Private subprocess output must never leak into either public CLI stream.
  process.stderr.write(body.text + "\n");
  if (plan === "updateFailed") process.exit(1);
  if (plan !== "sameVersion") saved.id = randomUUID();
  if (plan !== "missingPolicy") saved.bindings = [...new Set([...saved.bindings, value])];
  if (plan === "lostCredential") saved.bindings = saved.bindings.filter(name => name !== "CLAUDE_CODE_OAUTH_TOKEN");
  fs.writeFileSync(statePath, JSON.stringify(saved));
  reply(body);
} else throw Error("wrong command");
`;
  await writeFile(cf, script, { mode: 0o700 });
  return {
    env: {
      PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ""),
      TERM: "dumb",
      CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
      SANDBOX_RUNNER_WORKER: "wrong-worker",
      SANDBOX_RUNNER_CF_PROFILE: "wrong-profile",
      SANDBOX_RUNNER_CF_BIN: cf,
      SANDBOX_RUNNER_TOKEN: "ambient-control",
      ANTHROPIC_API_KEY: "ambient-claude",
      OPENAI_API_KEY: "ambient-openai",
      SANDBOX_RUNNER_CLAUDE_MODEL: "ambient-model",
      SANDBOX_RUNNER_CLAUDE_EFFORT: "ambient-effort",
      SANDBOX_RUNNER_DEFAULT_SANDBOX_PROVIDER: "ambient-provider",
      CLOUDFLARE_API_TOKEN: "ambient-cloudflare",
      CLOUDFLARE_API_BASE_URL: "https://wrong.invalid",
      NODE_OPTIONS: "--no-warnings",
      SANDBOX_RUNNER_CLAUDE_BIN: join(directory, "missing-claude"),
      FAKE_SETUP_STATE: state, FAKE_SETUP_LOG: log, FAKE_SETUP_PLAN: plan,
      FAKE_SETUP_OAUTH: claudeOAuth, FAKE_SETUP_API: claudeApiKey,
    },
    async calls() {
      if (!existsSync(log)) return [];
      return (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    },
  };
}

function command(agent, ...options) {
  return [agent, "setup", "--account", account, "--worker", worker, "--profile", profile, ...options];
}

async function invoke(fixture, args) {
  const child = spawn(process.execPath, [bin, ...args], { env: fixture.env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdin.end();
  const [code] = await once(child, "close");
  assert.equal(stdout.trim().split("\n").length, 1);
  return { code, output: JSON.parse(stdout), stderr };
}

test("publishes each exact strategy to the selected agent binding using the verified Cloudflare target", async t => {
  const cases = [
    ["claude", "subscription-only", ["CLAUDE_CODE_OAUTH_TOKEN"], claudeStrategy, false],
    ["claude", "api-key-first-then-subscription", ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"], claudeStrategy, true],
    ["codex", "api-key-only", ["OPENAI_API_KEY", codexStrategy], codexStrategy, true],
    ["codex", "subscription-first-then-api-key", ["OPENAI_SUBSCRIPTION_OAUTH_TOKEN", "OPENAI_API_KEY"], codexStrategy, true],
  ];
  for (const [agent, strategy, bindings, binding, confirmed] of cases) {
    const fixture = await fakeCf(t, { bindings });
    const args = command(agent, "--strategy", strategy, ...(confirmed ? ["--confirm-api-spend-cap"] : []));
    const result = await invoke(fixture, args);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const policy = confirmed ? { strategy, apiSpendCapConfirmed: true } : { strategy };
    assert.deepEqual(result.output, {
      status: "configured", agent, ...policy, account, worker, binding, versionId: result.output.versionId,
    });
    assert.notEqual(result.output.versionId, oldVersion);
    assert.match(result.output.versionId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    const calls = await fixture.calls();
    assert.deepEqual(calls.map(call => call.args.slice(0, 3).join(" ")), [
      "workers deployments list", "workers versions get", "workers deployments list", "workers versions get",
      "workers secrets update", "workers deployments list", "workers versions get",
    ]);
    for (const call of calls) {
      assert.deepEqual(call.prefix, ["--profile", profile]);
      assert.equal(call.account, account);
      assert.deepEqual(call.leaks, []);
      assert(call.args.includes(worker));
    }
    const update = calls[4];
    assert.deepEqual(update.body, {
      path: update.body.path, mode: 0o600, dirMode: 0o700, name: binding, type: "secret_text", policy,
    });
    assert.equal(existsSync(update.body.path), false);
    assert.equal(existsSync(update.cwd), false);
  }
});

test("requires explicit strategy and spend attestation in noninteractive setup before cf", async t => {
  const fixture = await fakeCf(t);
  for (const [args, expected] of [
    [[], "usage_error"],
    [["--strategy", "automatic"], "usage_error"],
    [["--strategy", "subscription-only", "--strategy", "api-key-only"], "usage_error"],
    [["--strategy", "api-key-only"], "api_spend_cap_confirmation_required"],
    [["--strategy", "subscription-only", "--confirm-api-spend-cap"], "usage_error"],
  ]) {
    const result = await invoke(fixture, command("claude", ...args));
    assert.equal(result.output.error, expected);
  }
  assert.deepEqual(await fixture.calls(), []);
});

test("honors the environment target and reports required connections without prompting or writing", async t => {
  const fixture = await fakeCf(t, { bindings: ["OPENAI_API_KEY"] });
  Object.assign(fixture.env, { CLOUDFLARE_ACCOUNT_ID: account, SANDBOX_RUNNER_WORKER: worker, SANDBOX_RUNNER_CF_PROFILE: profile });
  const result = await invoke(fixture, ["codex", "setup", "--strategy", "subscription-first-then-api-key", "--confirm-api-spend-cap"]);
  assert.equal(result.code, 3);
  assert.equal(result.output.error, "auth_strategy_credentials_missing");
  assert.match(result.output.message, /sandbox-runner auth codex --mode subscription/);
  const calls = await fixture.calls();
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.account === account && call.prefix[1] === profile && !call.body));
});

test("fails closed on old or malformed Workers and targets changed before publication", async t => {
  for (const [plan, error] of [
    ["legacy", "auth_strategies_unsupported"],
    ["badCapability", "auth_strategies_unsupported"],
    ["duplicateCapability", "auth_strategies_unsupported"],
    ["rollout", "worker_target_unverified"],
    ["wrongBindingType", "worker_target_unverified"],
    ["changed", "worker_target_changed"],
  ]) {
    const fixture = await fakeCf(t, { plan, bindings: ["CLAUDE_CODE_OAUTH_TOKEN"] });
    const result = await invoke(fixture, command("claude", "--strategy", "subscription-only"));
    assert.equal(result.code, 3);
    assert.equal(result.output.error, error);
    assert((await fixture.calls()).every(call => !call.body));
  }
});

test("verifies the post-update capability, binding and required credentials without retrying", async t => {
  for (const plan of ["updateFailed", "sameVersion", "missingPolicy", "lostCapability", "lostCredential"]) {
    const fixture = await fakeCf(t, { plan, bindings: ["CLAUDE_CODE_OAUTH_TOKEN"] });
    const result = await invoke(fixture, command("claude", "--strategy", "subscription-only"));
    assert.equal(result.code, 6);
    assert.equal(result.output.error, "cloudflare_update_unverified");
    assert.equal(result.output.uncertain, true);
    assert.equal(result.stderr, "");
    const updates = (await fixture.calls()).filter(call => call.body);
    assert.equal(updates.length, 1);
    assert.equal(existsSync(updates[0].body.path), false);
    assert.equal(existsSync(updates[0].cwd), false);
  }
});

test("publishes only supplied Claude defaults in one verified merge patch without configuring auth", async t => {
  for (const [options, settings, expectedPatch, bindings] of [
    [["--model", "opus[1m]"], { model: "opus[1m]" }, { [claudeModel]: "opus[1m]" }, [claudeEffort]],
    [["--effort", "xhigh"], { effort: "xhigh" }, { [claudeEffort]: "xhigh" }, [claudeModel]],
    [["--model", "claude-opus-4-8", "--effort", "max"], { model: "claude-opus-4-8", effort: "max" },
      { [claudeModel]: "claude-opus-4-8", [claudeEffort]: "max" }, []],
  ]) {
    const fixture = await fakeCf(t, { bindings: [...bindings, claudeStrategy, "OPENAI_API_KEY"] });
    const result = await invoke(fixture, command("claude", ...options));
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.output, {
      status: "configured", agent: "claude", ...settings, account, worker, versionId: result.output.versionId,
    });
    assert.notEqual(result.output.versionId, oldVersion);
    const calls = await fixture.calls();
    assert.deepEqual(calls.map(call => call.args.slice(0, 3).join(" ")), [
      "workers deployments list", "workers versions get", "workers versions list", "workers deployments list",
      "workers versions get", "workers secrets bulk", "workers versions list", "workers deployments list", "workers versions get",
    ]);
    assert(calls.every(call => call.account === account && call.prefix[1] === profile &&
      call.args.includes(worker) && call.leaks.length === 0));
    const history = ["workers", "versions", "list", "--worker-id", worker, "--per-page", "2", "-q"];
    assert.deepEqual(calls[2].args, history);
    assert.deepEqual(calls[6].args, history);
    const update = calls[5];
    const { body } = update;
    assert.deepEqual(update.args, ["workers", "secrets", "bulk", "--worker", worker, "--body", "@" + body.path]);
    assert.equal(body.mode, 0o600);
    assert.equal(body.dirMode, 0o700);
    assert.deepEqual(Object.keys(body.patch), ["secrets"]);
    assert.deepEqual(body.patch.secrets, Object.fromEntries(Object.entries(expectedPatch).map(([name, text]) =>
      [name, { name, type: "secret_text", text }])));
    assert.equal(existsSync(body.path), false);
    assert.equal(existsSync(update.cwd), false);
  }
});

test("rejects invalid or mixed Claude setup settings before checking the Worker", async t => {
  const fixture = await fakeCf(t);
  for (const args of [
    command("codex", "--model", "sonnet"),
    command("claude", "--model", "claude-opus-4-8\n"),
    command("claude", "--model", "haiku[1m]"),
    command("claude", "--model", "claude-" + "a".repeat(4_994)),
    command("claude", "--effort", "minimal"),
    command("claude", "--model", "sonnet", "--strategy", "subscription-only"),
    command("claude", "--effort", "high", "--confirm-api-spend-cap"),
    command("claude", "--effort", "low", "--effort", "high"),
  ]) {
    const result = await invoke(fixture, args);
    assert.equal(result.code, 2);
    assert.equal(result.output.error, "usage_error");
  }
  assert.deepEqual(await fixture.calls(), []);
});

test("checks the exact Claude defaults capability and active version before a bulk update", async t => {
  for (const [plan, error] of [
    ["legacyDefaults", "claude_defaults_unsupported"],
    ["badDefaultsCapability", "claude_defaults_unsupported"],
    ["duplicateDefaultsCapability", "claude_defaults_unsupported"],
    ["wrongBindingType", "worker_target_unverified"],
    ["rollout", "worker_target_unverified"],
    ["changed", "worker_target_changed"],
    ["malformedHead", "worker_target_unverified"],
    ["unreconciledHead", "worker_target_unverified"],
  ]) {
    const fixture = await fakeCf(t, { plan, bindings: [claudeModel] });
    const result = await invoke(fixture, command("claude", "--model", "sonnet"));
    assert.equal(result.code, 3);
    assert.equal(result.output.error, error);
    assert((await fixture.calls()).every(call => !call.body && !existsSync(call.cwd)));
  }
});

test("refuses a Claude defaults update when the latest Worker version is a draft", async t => {
  const fixture = await fakeCf(t, { draft: true, bindings: [claudeModel] });
  const result = await invoke(fixture, command("claude", "--effort", "high"));
  assert.equal(result.code, 3);
  assert.equal(result.output.error, "worker_latest_version_not_deployed");
  assert.match(result.output.message, /latest Worker version to be active/);
  assert((await fixture.calls()).every(call => !call.body && !existsSync(call.cwd)));
});

test("leaves a Claude defaults update uncertain if the receipt, active bindings or version history disagree", async t => {
  for (const plan of ["updateFailed", "sameVersion", "missingDefaultBinding", "lostDefaultsCapability",
    "missingReceipt", "wrongReceiptName", "wrongReceiptType", "wrongVersionSource", "concurrentHead",
    "rolledBackAfterBulk", "replacedPreviousVersion"]) {
    const bindings = plan === "missingDefaultBinding" ? [] : [claudeModel];
    const fixture = await fakeCf(t, { plan, bindings });
    const result = await invoke(fixture, command("claude", "--model", "sonnet"));
    assert.equal(result.code, 6, plan);
    assert.equal(result.output.error, "cloudflare_update_unverified");
    assert.equal(result.output.uncertain, true);
    assert.equal(result.stderr, "");
    assert(!JSON.stringify(result.output).includes("synthetic-private-cf-output"));
    const updates = (await fixture.calls()).filter(call => call.body);
    assert.equal(updates.length, 1);
    assert.equal(existsSync(updates[0].body.path), false);
    assert.equal(existsSync(updates[0].cwd), false);
  }
});

test("sets the default sandbox provider on the selected Worker in one verified merge patch", async t => {
  const fixture = await fakeCf(t, { plan: "legacyDefaults", bindings: [claudeModel, "OPENAI_API_KEY"] });
  const result = await invoke(fixture, ["setup", "--default-sandbox-provider", "cloudflare",
    "--account", account, "--worker", worker, "--profile", profile]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const { versionId } = result.output;
  assert.notEqual(versionId, oldVersion);
  assert.deepEqual(result.output, {
    status: "configured", sandboxProvider: "cloudflare", account, worker, binding: defaultSandboxProvider, versionId,
  });
  const calls = await fixture.calls();
  assert(calls.every(call => call.account === account && call.prefix[1] === profile &&
    call.args.includes(worker) && call.leaks.length === 0));
  const updates = calls.filter(call => call.body);
  assert.equal(updates.length, 1);
  const [update] = updates;
  assert.deepEqual(update.args, ["workers", "secrets", "bulk", "--worker", worker, "--body", "@" + update.body.path]);
  assert.deepEqual(update.body.patch, {
    secrets: { [defaultSandboxProvider]: { name: defaultSandboxProvider, type: "secret_text", text: "cloudflare" } },
  });
  assert.equal(update.body.mode, 0o600);
  assert.equal(update.body.dirMode, 0o700);
  assert.equal(existsSync(update.body.path), false);
  assert.equal(existsSync(update.cwd), false);
});

test("checks provider setup arguments and capability before a Cloudflare mutation", async t => {
  const fixture = await fakeCf(t);
  const flags = ["--account", account, "--worker", worker, "--profile", profile];
  for (const args of [
    ["setup"],
    ["setup", "--default-sandbox-provider", "local"],
    ["setup", "--default-sandbox-provider", "cloudflare", "--default-sandbox-provider", "cloudflare"],
    ["setup", "--default-sandbox-provider", "cloudflare", "--model", "opus"],
    ["claude", "setup", "--default-sandbox-provider", "cloudflare"],
  ]) {
    const result = await invoke(fixture, [...args, ...flags]);
    assert.equal(result.code, 2);
    assert.equal(result.output.error, "usage_error");
  }
  assert.deepEqual(await fixture.calls(), []);

  const args = ["setup", "--default-sandbox-provider", "cloudflare", ...flags];
  for (const plan of ["legacyProvider", "badProviderCapability", "duplicateProviderCapability"]) {
    const oldWorker = await fakeCf(t, { plan });
    const result = await invoke(oldWorker, args);
    assert.equal(result.code, 3);
    assert.equal(result.output.error, "sandbox_provider_setup_unsupported");
    assert((await oldWorker.calls()).every(call => !call.body));
  }

  const changingWorker = await fakeCf(t, { plan: "lostProviderCapability" });
  const uncertain = await invoke(changingWorker, args);
  assert.equal(uncertain.code, 6);
  assert.equal(uncertain.output.error, "cloudflare_update_unverified");
  assert.equal(uncertain.output.uncertain, true);
  assert.equal(uncertain.stderr, "");
  const updates = (await changingWorker.calls()).filter(call => call.body);
  assert.equal(updates.length, 1);
  assert.equal(existsSync(updates[0].cwd), false);
});

const ptyDriver = String.raw`
import errno, fcntl, json, os, pty, select, signal, struct, sys, termios, time
node, command, credentials = sys.argv[1:]
credentials = json.loads(credentials)
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    os.execv(node, [node] + json.loads(command))
deadline = time.monotonic() + 20
captured = b""
offset = 0
def read_chunk():
    remaining = deadline - time.monotonic()
    if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
        raise TimeoutError("setup PTY did not finish")
    try:
        return os.read(fd, 65536)
    except OSError as error:
        if error.errno == errno.EIO: return b""
        raise
def wait_for(prompt):
    global captured, offset
    while prompt not in captured[offset:]:
        data = read_chunk()
        if not data: raise RuntimeError("setup ended before the expected prompt")
        captured += data
    offset = captured.index(prompt, offset) + len(prompt)
try:
    wait_for(b"Strategy number: ")
    os.write(fd, b"4\n")
    wait_for(b"Type yes to continue: ")
    os.write(fd, b"yes\n")
    masked = []
    for credential in credentials:
        wait_for(b"then press Enter and Ctrl-D.")
        masked.append(not bool(termios.tcgetattr(fd)[3] & termios.ECHO))
        os.write(fd, credential.encode() + b"\n\x04")
    while True:
        data = read_chunk()
        if not data: break
        captured += data
    _, status = os.waitpid(pid, 0)
    pid = None
    text = captured.decode(errors="replace")
    json_lines = [json.loads(line) for line in text.splitlines() if line.startswith("{")]
    print(json.dumps({"code":os.waitstatus_to_exitcode(status), "json":json_lines,
        "masked":all(masked), "exposed":any(credential in text for credential in credentials),
        "publishingProgress":"Publishing auth strategy" in text}))
finally:
    if pid is not None:
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        os.waitpid(pid, 0)
    os.close(fd)
`;

const havePty = process.platform !== "win32" && spawnSync("python3", ["-c", "import pty"]).status === 0;

test("interactive setup uses separate terminal children only for missing credentials before publishing", { skip: !havePty }, async t => {
  for (const [bindings, credentials, expectedUpdates] of [
    [[], [claudeOAuth, claudeApiKey], ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", claudeStrategy]],
    [["CLAUDE_CODE_OAUTH_TOKEN"], [claudeApiKey], ["ANTHROPIC_API_KEY", claudeStrategy]],
  ]) {
    const fixture = await fakeCf(t, { bindings });
    const { stdout } = await exec("python3", [
      "-c", ptyDriver, process.execPath, JSON.stringify([bin, ...command("claude")]), JSON.stringify(credentials),
    ], { env: fixture.env });
    const result = JSON.parse(stdout);
    assert.equal(result.code, 0);
    assert.equal(result.masked, true);
    assert.equal(result.exposed, false);
    assert.equal(result.publishingProgress, true);
    assert.equal(result.json.length, 1);
    assert.equal(result.json[0].strategy, "subscription-first-then-api-key");
    const updates = (await fixture.calls()).filter(call => call.body);
    assert.deepEqual(updates.map(call => call.body.name), expectedUpdates);
    assert(updates.slice(0, -1).every(call => call.body.expectedCredential));
    assert(updates.every(call => call.account === account && call.prefix[1] === profile && call.args.includes(worker)));
    assert(updates.every(call => !existsSync(call.body.path) && !existsSync(call.cwd)));
  }
});
