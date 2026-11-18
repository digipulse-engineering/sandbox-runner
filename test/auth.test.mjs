import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeCredential } from "../bin/auth.mjs";

const bin = fileURLToPath(new URL("../bin/sandbox-runner.mjs", import.meta.url));
const account = "12345678123456781234567812345678";
const worker = "sandbox-runner-auth-test";
const oldId = "c3982431-3622-428d-a21f-c6f4c9ea20f9";
const newId = "a90dd49e-ad89-4eaa-bba3-ed5e9887fd11";
const oauth = "sk-ant-oat01-synthetic-Masked_Claude";
const claudeApi = "sk-ant-api03-synthetic-Test_Claude";
const claudePersonalApi = "sk-ant-usr-synthetic-Test_Claude";
const codexApi = "sk-proj-synthetic-Test_Codex";
const exec = promisify(execFile);

function args(agent, mode, options = []) {
  return ["auth", agent, "--mode", mode, "--account", account, "--worker", worker, "--profile", "chosen", ...options];
}

async function fakeCf(t, plan, credential = oauth) {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-runner-auth-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "cf");
  const logPath = join(directory, "calls.jsonl");
  const statePath = join(directory, "state.json");
  const fake = [
    "#!/usr/bin/env node",
    'const { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } = require("node:fs");',
    'const { dirname } = require("node:path");',
    'const args = process.argv.slice(2);',
    'const log = process.env.FAKE_CF_LOG;',
    'const state = process.env.FAKE_CF_STATE;',
    'const plan = process.env.FAKE_CF_PLAN;',
    'const seen = existsSync(log) ? readFileSync(log, "utf8").trim().split("\\n").map(JSON.parse) : [];',
    'const saved = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : null;',
    'const prefix = args[0] === "--profile" ? args.splice(0, 2) : [];',
    'const [domain, area, action, value] = args;',
    'const call = { prefix, args, account: process.env.CLOUDFLARE_ACCOUNT_ID, cwd: process.cwd(), hasDotenv: existsSync(".env"),',
    '  ambientCredentials: ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "SANDBOX_RUNNER_TOKEN",',
    '    "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_SUBSCRIPTION_OAUTH_TOKEN",',
    '    "SANDBOX_RUNNER_OPENCODE_OPENAI_API_KEY", "SANDBOX_RUNNER_OPENCODE_ANTHROPIC_API_KEY"].filter(key => process.env[key]),',
    '  unsafeSettings: ["CLOUDFLARE_API_BASE_URL", "CF_API_BASE_URL", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_OPTIONS",',
    '    "DEBUG", "CF_DEBUG", "WRANGLER_LOG_PATH"].filter(key => process.env[key]) };',
    'const record = () => appendFileSync(log, JSON.stringify(call) + "\\n");',
    'const reply = value => process.stdout.write(JSON.stringify(value) + "\\n");',
    "const oldId = " + JSON.stringify(oldId) + ";",
    "const newId = " + JSON.stringify(newId) + ";",
    "const expected = " + JSON.stringify(credential) + ";",
    'const delayMs = Number(process.env.FAKE_CF_DELAY_MS || 0);',
    'if (delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);',
    'if (domain !== "workers") throw Error("Wrong command");',
    'if (area === "deployments" && action === "list") {',
    '  record();',
    '  const active = (plan === "targetChanged" && seen.length >= 2) || saved ? newId : oldId;',
    '  const versions = [{ version_id: active, percentage: plan === "rollout" ? 70 : 100 }];',
    '  if (plan === "rollout") versions.push({ version_id: newId, percentage: 30 });',
    '  reply({ deployments: [{ versions }] });',
    '} else if (area === "versions" && action === "get") {',
    '  record();',
    '  const bindings = [',
    '    { name: "SANDBOX_RUNNER_MODE", type: "plain_text", text: plan === "fixtureTarget" ? "fixture" : "real" },',
    '    { name: "SANDBOX_RUNNER_TOKEN", type: "secret_text" },',
    '  ];',
    '  if (plan === "opencode") bindings.push({ name: "SANDBOX_RUNNER_OPENCODE", type: "plain_text", text: "1" });',
    '  if (saved && plan !== "missingBinding") bindings.push({ name: saved.name, type: "secret_text" });',
    '  if (plan === "sameVersion") bindings.push({ name: "CLAUDE_CODE_OAUTH_TOKEN", type: "secret_text" });',
    '  reply({ id: value, bindings });',
    '} else if (area === "secrets" && action === "update") {',
    '  const atFile = args[args.indexOf("--body") + 1];',
    '  if (!atFile?.startsWith("@")) throw Error("Missing private body");',
    '  const bodyPath = atFile.slice(1);',
    '  const body = JSON.parse(readFileSync(bodyPath, "utf8"));',
    '  call.body = { path: bodyPath, mode: statSync(bodyPath).mode & 511, dirMode: statSync(dirname(bodyPath)).mode & 511,',
    '    correct: body.name === value && body.type === "secret_text" && body.text === expected };',
    '  record();',
    '  if (plan === "holdUpload") { setInterval(() => {}, 1000); }',
    '  else {',
    '    // An untrusted subprocess may echo values. They must stay off CLI stdout and stderr.',
    '    process.stderr.write(body.text + "\\n");',
    '    if (plan === "updateFailed") process.exit(1);',
    '    if (plan !== "sameVersion") writeFileSync(state, JSON.stringify({ name: body.name }));',
    '    reply(body);',
    '  }',
    '} else throw Error("Wrong command");',
  ].join("\n");
  await writeFile(path, fake, { mode: 0o700 });
  return {
    env: {
      PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ""),
      SANDBOX_RUNNER_CF_BIN: path,
      CLOUDFLARE_API_TOKEN: "ambient-cloudflare-token",
      CF_API_TOKEN: "ambient-cloudflare-token-alias",
      CLOUDFLARE_API_KEY: "ambient-cloudflare-key",
      CLOUDFLARE_EMAIL: "ambient@example.invalid",
      SANDBOX_RUNNER_TOKEN: "ambient-runner-token",
      CLAUDE_CODE_OAUTH_TOKEN: "ambient-claude-token",
      SANDBOX_RUNNER_OPENCODE_OPENAI_API_KEY: "ambient-opencode-openai",
      SANDBOX_RUNNER_OPENCODE_ANTHROPIC_API_KEY: "ambient-opencode-anthropic",
      CLOUDFLARE_API_BASE_URL: "https://wrong.invalid",
      CF_API_BASE_URL: "https://wrong.invalid",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NODE_OPTIONS: "--no-warnings",
      DEBUG: "cf:*",
      CF_DEBUG: "1",
      WRANGLER_LOG_PATH: directory,
      FAKE_CF_LOG: logPath,
      FAKE_CF_STATE: statePath,
      FAKE_CF_PLAN: plan,
    },
    async calls() {
      if (!existsSync(logPath)) return [];
      return (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    },
  };
}

function childAuth(command, fixture, input = "") {
  const child = spawn(process.execPath, [bin, ...command], { env: fixture.env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", value => { stdout += value; });
  child.stderr.setEncoding("utf8").on("data", value => { stderr += value; });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  return {
    child,
    result: once(child, "close").then(([code]) => {
      assert.equal(stdout.trim().split("\n").length, 1);
      return { code, output: JSON.parse(stdout), stdout, stderr };
    }),
  };
}

test("normalizes multiline Claude OAuth whitespace and keeps API keys strict", () => {
  const wrapped = " \uFEFFsk-ant-oat01-synthetic-\r\n\u00a0Masked_\u0085Claude\n";
  assert.equal(normalizeCredential(wrapped, "claude", "subscription"), oauth);
  assert.equal(normalizeCredential(claudeApi, "claude", "subscription"), undefined);
  assert.equal(normalizeCredential(claudePersonalApi, "claude", "subscription"), undefined);
  assert.equal(normalizeCredential(oauth, "claude", "api-key"), undefined);
  assert.equal(normalizeCredential("sk-ant-admin-synthetic", "claude", "api-key"), undefined);
  assert.equal(normalizeCredential("sk-ant-other-synthetic", "claude", "api-key"), undefined);
  assert.equal(normalizeCredential("sk-ant-usr-", "claude", "api-key"), undefined);
  assert.equal(normalizeCredential(claudePersonalApi + "=", "claude", "api-key"), undefined);
  assert.equal(normalizeCredential(claudePersonalApi + "\n\n", "claude", "api-key"), undefined);
  assert.equal(normalizeCredential(claudePersonalApi, "codex", "api-key"), undefined);
  assert.equal(normalizeCredential(oauth, "codex", "api-key"), undefined);
  assert.equal(normalizeCredential("part.payload.signature", "codex", "api-key"), undefined);
  assert.equal(normalizeCredential(codexApi + "\r\n", "codex", "api-key"), codexApi);
  assert.equal(normalizeCredential(codexApi + "\n\n", "codex", "api-key"), undefined);
  assert.equal(normalizeCredential(codexApi + "\u00a0", "codex", "api-key"), undefined);
});

test("publishes each manual credential using a private file and verifies the active version", async t => {
  for (const [agent, mode, binding, credential] of [
    ["claude", "subscription", "CLAUDE_CODE_OAUTH_TOKEN", oauth],
    ["claude", "api-key", "ANTHROPIC_API_KEY", claudeApi],
    ["claude", "api-key", "ANTHROPIC_API_KEY", claudePersonalApi],
    ["codex", "api-key", "OPENAI_API_KEY", codexApi],
  ]) {
    const fixture = await fakeCf(t, "success", credential);
    const result = await childAuth(args(agent, mode, ["--stdin"]), fixture, credential + "\n").result;
    assert.equal(result.code, 0);
    assert.deepEqual(result.output, { status: "configured", agent, authMode: mode, account, worker, binding, versionId: newId });
    assert(!result.stdout.includes(credential));
    assert.equal(result.stderr, "");
    const calls = await fixture.calls();
    assert.deepEqual(calls.map(call => call.args.slice(0, 3).join(" ")), [
      "workers deployments list", "workers versions get", "workers deployments list", "workers versions get",
      "workers secrets update", "workers deployments list", "workers versions get",
    ]);
    for (const call of calls) {
      assert.deepEqual(call.prefix, ["--profile", "chosen"]);
      assert.equal(call.account, account);
      assert.equal(call.hasDotenv, false);
      assert.deepEqual(call.ambientCredentials, []);
      assert.deepEqual(call.unsafeSettings, []);
      assert(!JSON.stringify(call.args).includes(credential));
    }
    const upload = calls[4];
    assert.deepEqual(upload.args, ["workers", "secrets", "update", binding, "--worker", worker, "--body", "@" + upload.body.path]);
    assert.deepEqual(upload.body, { path: upload.body.path, mode: 0o600, dirMode: 0o700, correct: true });
    assert.equal(existsSync(upload.body.path), false);
    assert.equal(existsSync(upload.cwd), false);
  }
});

test("uses environment target defaults and allows cf credentials when no profile is selected", async t => {
  const fixture = await fakeCf(t, "success");
  Object.assign(fixture.env, { CLOUDFLARE_ACCOUNT_ID: account, SANDBOX_RUNNER_WORKER: worker });
  const result = await childAuth(["auth", "claude", "--mode", "subscription", "--stdin"], fixture, oauth).result;
  assert.equal(result.code, 0);
  assert.equal(result.output.account, account);
  assert.equal(result.output.worker, worker);
  const upload = (await fixture.calls()).find(call => call.body);
  assert.deepEqual(upload.prefix, []);
  assert(upload.ambientCredentials.includes("CLOUDFLARE_API_TOKEN"));
  assert(!upload.ambientCredentials.includes("SANDBOX_RUNNER_TOKEN"));
  assert(!upload.ambientCredentials.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  assert.deepEqual(upload.unsafeSettings, []);
});

test("OpenCode auth publishes only the chosen dedicated binding on a capable Worker", async t => {
  const command = provider => ["auth", "opencode", "--model-provider", provider, "--account", account,
    "--worker", worker, "--profile", "chosen", "--stdin"];
  for (const [provider, credential, binding] of [
    ["openai", codexApi, "SANDBOX_RUNNER_OPENCODE_OPENAI_API_KEY"],
    ["anthropic", claudePersonalApi, "SANDBOX_RUNNER_OPENCODE_ANTHROPIC_API_KEY"],
  ]) {
    const fixture = await fakeCf(t, "opencode", credential);
    const result = await childAuth(command(provider), fixture, credential + "\n").result;
    assert.equal(result.code, 0);
    assert.deepEqual(result.output, { status: "configured", agent: "opencode", authMode: "api-key",
      modelProvider: provider, account, worker, binding, versionId: newId });
    const calls = await fixture.calls();
    assert(calls.every(call => call.ambientCredentials.length === 0));
    const writes = calls.filter(call => call.body);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].args[3], binding);
    assert.equal(writes[0].body.correct, true);
    assert.equal(writes[0].body.mode, 0o600);
    assert.equal(existsSync(writes[0].body.path), false);
    assert(!result.stdout.includes(credential));
    assert(!result.stderr.includes(credential));
  }
  const disabled = await fakeCf(t, "success", codexApi);
  assert.equal((await childAuth(command("openai"), disabled, codexApi).result).output.error, "opencode_disabled");
  assert((await disabled.calls()).every(call => call.args[1] !== "secrets"));
  const wrongProvider = await fakeCf(t, "opencode", codexApi);
  assert.equal((await childAuth(command("anthropic"), wrongProvider, codexApi).result).output.error, "auth_credential_invalid");
  assert((await wrongProvider.calls()).every(call => call.args[1] !== "secrets"));
});

test("preflights the Worker before credential input and refuses changed targets", async t => {
  for (const [plan, error] of [
    ["rollout", "worker_target_unverified"],
    ["fixtureTarget", "worker_target_unverified"],
    ["targetChanged", "worker_target_changed"],
  ]) {
    const fixture = await fakeCf(t, plan);
    const result = await childAuth(args("claude", "subscription", ["--stdin"]), fixture, oauth + "\n").result;
    assert.equal(result.code, 3);
    assert.equal(result.output.error, error);
    assert.equal(result.stderr, "");
    assert((await fixture.calls()).every(call => call.args[1] !== "secrets"));
  }
  const fixture = await fakeCf(t, "success");
  const invalid = await childAuth(args("claude", "subscription", ["--stdin"]), fixture, claudeApi).result;
  assert.equal(invalid.output.error, "auth_credential_invalid");
  assert((await fixture.calls()).every(call => call.args[1] !== "secrets"));
});

test("requires opt-in for pipes and rejects implicit modes before cf", async t => {
  const fixture = await fakeCf(t, "success");
  for (const command of [
    args("claude", "subscription"),
    args("codex", "subscription", ["--stdin"]),
    args("codex", "api-key", ["--stdin", "--manual"]),
    args("claude", "subscription", ["--stdin", "--manual"]),
    ["auth", "claude", "--stdin", "--account", account, "--worker", worker],
    args("claude", "subscription", ["--stdin", "--mode", "api-key"]),
  ]) {
    const result = await childAuth(command, fixture, oauth).result;
    assert.equal(result.code, 2);
    assert.equal(result.output.error, "usage_error");
  }
  assert.deepEqual(await fixture.calls(), []);
});

test("does not retry an unconfirmed update and erases the credential file", async t => {
  for (const plan of ["updateFailed", "sameVersion", "missingBinding"]) {
    const fixture = await fakeCf(t, plan);
    const result = await childAuth(args("claude", "subscription", ["--stdin"]), fixture, oauth).result;
    assert.equal(result.code, 6);
    assert.equal(result.output.error, "cloudflare_update_unverified");
    assert.equal(result.output.uncertain, true);
    assert(!result.stdout.includes(oauth));
    assert.equal(result.stderr, "");
    const updates = (await fixture.calls()).filter(call => call.body);
    assert.equal(updates.length, 1);
    assert.equal(existsSync(updates[0].body.path), false);
    assert.equal(existsSync(updates[0].cwd), false);
  }
});

test("interrupts an in-flight update without retaining a file or attempting another update", async t => {
  const fixture = await fakeCf(t, "holdUpload");
  const operation = childAuth(args("claude", "subscription", ["--stdin"]), fixture, oauth);
  t.after(() => operation.child.kill());
  const deadline = Date.now() + 15_000;
  while (!(await fixture.calls()).some(call => call.body)) {
    assert(Date.now() < deadline, "cf test did not reach the upload");
    await delay(30);
  }
  operation.child.kill("SIGTERM");
  const result = await operation.result;
  assert.equal(result.code, 3);
  assert.equal(result.output.error, "auth_cancelled");
  assert.equal(result.output.uncertain, true);
  const updates = (await fixture.calls()).filter(call => call.body);
  assert.equal(updates.length, 1);
  assert.equal(existsSync(updates[0].body.path), false);
  assert.equal(existsSync(updates[0].cwd), false);
});

test("uses the configured cf deadline and preserves uncertainty after a timed out update", async t => {
  const fixture = await fakeCf(t, "holdUpload");
  // The upload never answers; the deadline must still leave the earlier reads time to finish under load.
  fixture.env.SANDBOX_RUNNER_TIMEOUT_MS = "5000";
  const started = Date.now();
  const result = await childAuth(args("claude", "subscription", ["--stdin"]), fixture, oauth).result;
  // Well under the 30-second default: the configured deadline, not the default, ended the hanging upload.
  assert(Date.now() - started < 20_000, "the configured deadline applies");
  assert.equal(result.code, 5);
  assert.equal(result.output.error, "timeout");
  assert.equal(result.output.uncertain, true);
  const updates = (await fixture.calls()).filter(call => call.body);
  assert.equal(updates.length, 1);
  assert.equal(existsSync(updates[0].body.path), false);
  assert.equal(existsSync(updates[0].cwd), false);
});

const ptyDriver = [
  "import errno, fcntl, json, os, pty, select, signal, struct, sys, termios, time",
  "node, command, paste, interrupt, child_ready = sys.argv[1:]",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))",
  "    os.execv(node, [node] + json.loads(command))",
  "deadline = time.monotonic() + 15",
  "captured = b''",
  "def read_chunk():",
  "    remaining = deadline - time.monotonic()",
  "    if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:",
  "        raise TimeoutError('auth PTY did not complete')",
  "    try:",
  "        return os.read(fd, 65536)",
  "    except OSError as error:",
  "        if error.errno == errno.EIO: return b''",
  "        raise",
  "def echo_enabled():",
  "    return bool(termios.tcgetattr(fd)[3] & termios.ECHO)",
  "try:",
  "    masked = False",
  "    if interrupt != 'stdin':",
  "        automatic = interrupt in ('auto', 'auto-cancel', 'auto-code')",
  "        prompt = b'Approve Claude' if automatic else b'Ctrl-D.'",
  "        check_idle = os.environ.get('FAKE_CF_DELAY_MS') and interrupt != 'auto'",
  "        if check_idle: prompt = b'Ctrl-C cancels.\\r\\n'",
  "        while prompt not in captured:",
  "            chunk = read_chunk()",
  "            if not chunk: raise RuntimeError('auth did not reach masked input')",
  "            captured += chunk",
  "        masked = not echo_enabled()",
  "        if check_idle and select.select([fd], [], [], .4)[0]:",
  "            raise RuntimeError('terminal output continued during the input prompt')",
  "        if interrupt in ('auto-cancel', 'auto-code'):",
  "            while not os.path.exists(child_ready):",
  "                if time.monotonic() >= deadline: raise TimeoutError('Claude fixture did not start')",
  "                time.sleep(.02)",
  "            os.write(fd, b'\\x03' if interrupt == 'auto-cancel' else paste.encode('utf-8'))",
  "        elif not automatic:",
  "            os.write(fd, b'\\x03' if interrupt == 'yes' else paste.encode('utf-8') + b'\\x04')",
  "        if interrupt == 'progress-cancel':",
  "            def upload_started():",
  "                with open(os.environ['FAKE_CF_LOG'], 'rb') as log:",
  "                    return b'\"body\":' in log.read()",
  "            while b'/ Publishing credential' not in captured or not upload_started():",
  "                chunk = read_chunk()",
  "                if not chunk: raise RuntimeError('auth did not animate during upload')",
  "                captured += chunk",
  "            os.write(fd, b'\\x03')",
  "    while True:",
  "        chunk = read_chunk()",
  "        if not chunk: break",
  "        captured += chunk",
  "    restored = echo_enabled()",
  "    _, status = os.waitpid(pid, 0)",
  "    lines = captured.decode('utf-8').replace('\\x1b[2K', '').splitlines()",
  "    if sum(line.startswith('{') for line in lines) != 1:",
  "        raise RuntimeError('auth PTY did not produce exactly one JSON result')",
  "    print(json.dumps({'code': os.waitstatus_to_exitcode(status), 'masked': masked, 'restored': restored,",
  "                      'output': json.loads(lines[-1]), 'capture': captured.decode('utf-8')}))",
  "except BaseException:",
  "    try: os.kill(pid, signal.SIGKILL)",
  "    except ProcessLookupError: pass",
  "    try: os.waitpid(pid, 0)",
  "    except ChildProcessError: pass",
  "    raise",
  "finally:",
  "    os.close(fd)",
].join("\n");

const needsPty = {
  skip: process.platform === "win32" || spawnSync("python3", ["-c", "import pty, termios"]).status !== 0,
};
const needsClaudePty = { skip: needsPty.skip || process.platform !== "darwin" };

async function ptyAuth(command, fixture, input, mode, childReady = "") {
  const { stdout } = await exec("python3", [
    "-c", ptyDriver, process.execPath, JSON.stringify([bin, ...command]), input, mode, childReady,
  ], { env: fixture.env });
  return JSON.parse(stdout);
}

test("real terminal masks multiline paste and restores echo on EOF and Ctrl-C", {
  ...needsPty,
}, async t => {
  const pasted = "sk-ant-oat01-synthetic-\n\u00a0Masked_Claude\n";
  for (const interrupt of [false, true]) {
    const fixture = await fakeCf(t, "success");
    const result = await ptyAuth(args("claude", "subscription", ["--manual"]), fixture, pasted, interrupt ? "yes" : "no");
    assert.equal(result.masked, true);
    assert.equal(result.restored, true);
    assert(!result.capture.includes("synthetic-"));
    assert(!result.capture.includes("Masked_Claude"));
    if (interrupt) {
      assert.equal(result.code, 3);
      assert.equal(result.output.error, "auth_cancelled");
      assert((await fixture.calls()).every(call => !call.body));
    } else {
      assert.equal(result.code, 0);
      assert.equal(result.output.status, "configured");
      assert.equal((await fixture.calls()).find(call => call.body)?.body.correct, true);
    }
  }
  const fixture = await fakeCf(t, "success");
  const result = await ptyAuth(args("claude", "subscription", ["--stdin"]), fixture, "", "stdin");
  assert.equal(result.code, 2);
  assert.equal(result.output.error, "usage_error");
  assert.equal(result.restored, true);
  assert.deepEqual(await fixture.calls(), []);
});

test("auth animates each Cloudflare stage around quiet masked input", needsPty, async t => {
  const fixture = await fakeCf(t, "success", claudePersonalApi);
  Object.assign(fixture.env, { TERM: "xterm-256color", FAKE_CF_DELAY_MS: "320" });
  const result = await ptyAuth(args("claude", "api-key"), fixture, claudePersonalApi + "\n", "no");
  assert.equal(result.code, 0);
  assert.equal(result.masked, true);
  assert.equal(result.restored, true);
  assert.equal(result.output.status, "configured");
  assert.equal(result.output.versionId, newId);
  const clear = "\r\x1b[2K";
  const labels = [
    "Checking Cloudflare Worker…",
    "Rechecking Cloudflare Worker…",
    "Publishing credential…",
    "Verifying active Worker version…",
  ];
  for (const label of labels) {
    assert(result.capture.includes(clear + "| " + label));
    assert(result.capture.includes(clear + "/ " + label));
  }
  assert(result.capture.indexOf(labels[0]) < result.capture.indexOf("Credential input"));
  assert(result.capture.indexOf("Input is hidden.") < result.capture.indexOf(labels[1]));
  assert(result.capture.indexOf(labels[1]) < result.capture.indexOf(labels[2]));
  assert(result.capture.indexOf(labels[2]) < result.capture.indexOf(labels[3]));
  assert(result.capture.includes(clear + "\r\nCredential configured."));
  assertNoChildOutput(result);
  assert.equal((await fixture.calls()).find(call => call.body)?.body.correct, true);
  const terminal = result.capture
    .replace(/\r\x1b\[2K(?:[|/\\-] [^\r\n]*)?/g, "")
    .replaceAll("\r\n", "\n");
  const humanText = terminal.slice(0, terminal.indexOf("{")).trimEnd();
  assert.equal(humanText, [
    "Claude Code · API key",
    "Worker " + worker,
    "",
    "Credential input",
    "  Paste the API key, then press Enter and Ctrl-D.",
    "  Input is hidden. Ctrl-C cancels.",
    "",
    "",
    "Credential configured. Active Worker version verified.",
  ].join("\n"));
  t.diagnostic(humanText);
});

test("auth clears progress on publication error and Ctrl-C", needsPty, async t => {
  for (const [plan, interrupt, error, message, exit] of [
    ["updateFailed", "no", "cloudflare_update_unverified", "Could not confirm the credential update.", 6],
    ["holdUpload", "progress-cancel", "auth_cancelled", "Auth was interrupted.", 3],
  ]) {
    const fixture = await fakeCf(t, plan, claudeApi);
    Object.assign(fixture.env, { TERM: "xterm-256color", FAKE_CF_DELAY_MS: "320" });
    const result = await ptyAuth(args("claude", "api-key"), fixture, claudeApi + "\n", interrupt);
    assert.equal(result.code, exit);
    assert.equal(result.output.error, error);
    assert.equal(result.output.uncertain, true);
    assert.equal(result.restored, true);
    assert.match(result.capture, /\/ Publishing credential…/);
    assert(result.capture.includes("\r\x1b[2K\r\n" + message));
    assert.doesNotMatch(result.capture, /Verifying active Worker version|Credential configured/);
    assertNoChildOutput(result);
    const uploads = (await fixture.calls()).filter(call => call.body);
    assert.equal(uploads.length, 1);
    assert.equal(existsSync(uploads[0].body.path), false);
  }
});

test("auth localizes the masked prompt and terminal diagnostic while keeping JSON stable", needsPty, async t => {
  const fixture = await fakeCf(t, "updateFailed", claudeApi);
  Object.assign(fixture.env, { LANG: "fr_BE.UTF-8", TERM: "xterm-256color" });
  const result = await ptyAuth(args("claude", "api-key"), fixture, claudeApi + "\n", "no");
  assert.equal(result.code, 6);
  assert.equal(result.masked, true);
  assert.equal(result.restored, true);
  assert.match(result.capture, /Claude Code · Clé API/);
  assert.match(result.capture, /Saisie de l’identifiant/);
  assert.match(result.capture, /La saisie est masquée/);
  assert.match(result.capture, /Publication de l’identifiant…/);
  assert.match(result.capture, /Impossible de confirmer la mise à jour de l’identifiant\./);
  assert.equal(result.output.error, "cloudflare_update_unverified");
  assert.equal(result.output.message, "Could not confirm the credential update. Check the active Cloudflare Worker version before trying again.");
  assert.equal(result.output.uncertain, true);
  assertNoChildOutput(result);
});

test("auth shows plain progress on TERM=dumb and leaves piped use quiet", needsPty, async t => {
  const fixture = await fakeCf(t, "success", claudeApi);
  fixture.env.TERM = "dumb";
  const result = await ptyAuth(args("claude", "api-key"), fixture, claudeApi + "\n", "no");
  assert.equal(result.code, 0);
  assert.match(result.capture, /Checking Cloudflare Worker…\r\n/);
  assert.match(result.capture, /Publishing credential…\r\n/);
  assert.match(result.capture, /Verifying active Worker version…\r\n/);
  assert.match(result.capture, /Credential configured\./);
  assert.doesNotMatch(result.capture, /\x1b/);
  assertNoChildOutput(result);

  const piped = await fakeCf(t, "success", claudeApi);
  piped.env.TERM = "xterm-256color";
  const nonInteractive = await childAuth(args("claude", "api-key", ["--stdin"]), piped, claudeApi).result;
  assert.equal(nonInteractive.code, 0);
  assert.equal(nonInteractive.stderr, "");
  assert.equal(nonInteractive.output.status, "configured");
});

async function fakeClaude(fixture, scenario) {
  const directory = dirname(fixture.env.SANDBOX_RUNNER_CF_BIN);
  const binary = join(directory, "claude");
  const ready = join(directory, "claude.json");
  fixture.env.SANDBOX_RUNNER_CLAUDE_BIN = binary;
  fixture.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = "https://wrong.invalid";
  fixture.env.ANTHROPIC_BASE_URL = "https://wrong.invalid";
  fixture.env.CLAUDE_CONFIG_DIR = join(directory, "unexpected-config");
  if (scenario !== "missing") {
    const child = [
      "#!/usr/bin/env node",
      'const { realpathSync, statSync, writeFileSync } = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      "const ready = " + JSON.stringify(ready) + ";",
      "const scenario = " + JSON.stringify(scenario) + ";",
      "const token = " + JSON.stringify(oauth) + ";",
      'const config = process.env.CLAUDE_CONFIG_DIR;',
      'const ambient = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "SANDBOX_RUNNER_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",',
      '  "CLAUDE_CODE_CUSTOM_OAUTH_URL", "ANTHROPIC_BASE_URL", "DEBUG", "NODE_OPTIONS"].filter(key => process.env[key]);',
      'if (scenario === "hold" || scenario === "code") process.stdin.setRawMode(true);',
      'writeFileSync(ready, JSON.stringify({ args: process.argv.slice(2), stdinTty: Boolean(process.stdin.isTTY),',
      '  stdoutTty: Boolean(process.stdout.isTTY), stderrTty: Boolean(process.stderr.isTTY), cwd: process.cwd(),',
      '  config: realpathSync(config), configMode: statSync(config).mode & 511, ambient, pid: process.pid,',
      '  size: spawnSync("/bin/stty", ["size"], { encoding: "utf8", stdio: [0, "pipe", "ignore"] }).stdout.trim() }));',
      'function success(value) {',
      '  const split = value.indexOf("synthetic-") + "synthetic-".length;',
      '  process.stdout.write("\\x1b[32m✓ Long-lived authentication token created successfully!\\x1b[0m\\n\\n" +',
      '    "Your OAuth token (valid for 1 year):\\n" + value.slice(0, split) + "\\n" + value.slice(split) +',
      '    "\\n\\nStore this token securely. You will not be able to see it again." + (scenario === "noFinalNewline" ? "" : "\\n"));',
      '}',
      'process.stderr.write("RAW CLAUDE STDERR " + token + "\\n");',
      'process.stdout.write("RAW CLAUDE STDOUT\\n");',
      'if (scenario === "hold") setInterval(() => {}, 1000);',
      'else if (scenario === "code") {',
      '  process.stdin.once("data", chunk => {',
      '    if (chunk.toString() === "fixture-code#fixture-state\\r") success(token);',
      '    else process.exitCode = 1;',
      '    process.stdin.pause();',
      '  });',
      '}',
      'else if (scenario === "malformed") process.stdout.write(token + "\\n");',
      'else if (scenario === "wrongFooter") process.stdout.write(',
      '  "Long-lived authentication token created successfully!\\nYour OAuth token (valid for 1 year):\\n" + token + "\\nDone.\\n");',
      'else if (scenario === "cancel") process.exitCode = 130;',
      'else {',
      '  success(token);',
      '  if (scenario === "multiple") success(token + "_different");',
      '  if (scenario === "repaint") success(token);',
      '  if (scenario === "nonzero") process.exitCode = 1;',
      '}',
    ].join("\n");
    await writeFile(binary, child, { mode: 0o700 });
  }
  return {
    ready,
    async child() {
      if (existsSync(ready)) return JSON.parse(await readFile(ready, "utf8"));
    },
  };
}

function assertNoChildOutput(result) {
  assert(!result.capture.includes("RAW CLAUDE"));
  assert(!result.capture.includes("Long-lived authentication token created successfully!"));
  assert(!result.capture.includes("synthetic-"));
  assert(!result.capture.includes("Masked_Claude"));
}

test("Claude auto authenticates via a private TTY and publishes exactly once", needsClaudePty, async t => {
  const fixture = await fakeCf(t, "success");
  const claude = await fakeClaude(fixture, "repaint");
  const result = await ptyAuth(args("claude", "subscription"), fixture, "", "auto");
  assert.equal(result.code, 0);
  assert.equal(result.restored, true);
  assert.equal(result.output.credentialSource, "claude-setup-token");
  assert.equal(result.output.versionId, newId);
  assert.match(result.capture, /Claude setup-token returned a credential/);
  assert.doesNotMatch(result.capture, /Ctrl-D/);
  assertNoChildOutput(result);
  const child = await claude.child();
  assert.deepEqual(child.args, ["setup-token"]);
  assert.equal(child.stdinTty, true);
  assert.equal(child.stdoutTty, false);
  assert.equal(child.stderrTty, false);
  assert.deepEqual(child.ambient, []);
  assert.equal(child.config, join(child.cwd, "claude"));
  assert.equal(child.configMode, 0o700);
  assert.equal(child.size, "42 256");
  assert.equal(existsSync(child.cwd), false);
  const updates = (await fixture.calls()).filter(call => call.body);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].body.correct, true);
});

test("Claude auto parses the final success line even if stdout ends without a newline", needsClaudePty, async t => {
  const fixture = await fakeCf(t, "success");
  await fakeClaude(fixture, "noFinalNewline");
  const result = await ptyAuth(args("claude", "subscription"), fixture, "", "auto");
  assert.equal(result.code, 0);
  assert.equal(result.output.credentialSource, "claude-setup-token");
  assertNoChildOutput(result);
  assert.equal((await fixture.calls()).filter(call => call.body).length, 1);
});

test("Claude auto forwards the complete browser authorization code to the child only", needsClaudePty, async t => {
  const fixture = await fakeCf(t, "success");
  const claude = await fakeClaude(fixture, "code");
  const code = "fixture-code#fixture-state";
  const result = await ptyAuth(args("claude", "subscription"), fixture, code + "\n", "auto-code", claude.ready);
  assert.equal(result.code, 0);
  assert.equal(result.output.credentialSource, "claude-setup-token");
  assert.equal(result.restored, true);
  assert(!result.capture.includes(code));
  assertNoChildOutput(result);
  assert.equal((await fixture.calls()).filter(call => call.body).length, 1);
});

test("Claude auto offers masked fallback on unsupported, malformed, or ambiguous output", needsClaudePty, async t => {
  for (const scenario of ["missing", "malformed", "wrongFooter", "multiple", "nonzero"]) {
    const fixture = await fakeCf(t, "success");
    if (scenario !== "missing") fixture.env.SANDBOX_RUNNER_CLAUDE_SETUP_DIAGNOSTICS = "1";
    await fakeClaude(fixture, scenario);
    const result = await ptyAuth(args("claude", "subscription"), fixture, oauth + "\n", "no");
    assert.equal(result.code, 0);
    assert.equal(result.masked, true);
    assert.equal(result.restored, true);
    assert.equal(result.output.credentialSource, undefined);
    assert.match(result.capture, /Continue with masked input/);
    assertNoChildOutput(result);
    const diagnosticLine = result.capture.split(/\r?\n/).find(line => line.startsWith("Claude setup-token diagnostic: "));
    if (scenario === "missing") {
      assert.equal(diagnosticLine, undefined);
    } else {
      const diagnostic = JSON.parse(diagnosticLine.slice("Claude setup-token diagnostic: ".length));
      assert.equal(diagnostic.reason, scenario === "nonzero" ? "child_exit" : "output_unrecognized");
      assert.equal(diagnostic.exitCode, scenario === "nonzero" ? 1 : 0);
      assert.equal(diagnostic.heading, scenario !== "malformed");
      assert.equal(diagnostic.tokenPrefix, true);
      assert.equal(diagnostic.footer, scenario === "multiple" || scenario === "nonzero");
      assert.equal(diagnostic.ambiguous, scenario === "malformed" || scenario === "multiple");
      assert.equal(diagnostic.errorOutputSeen, true);
      assert.equal(diagnostic.bridgeOutputSeen, false);
    }
    const updates = (await fixture.calls()).filter(call => call.body);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].body.correct, true);
  }
});

test("Claude auto keyboard cancellation restores the terminal and leaves Cloudflare untouched", needsClaudePty, async t => {
  for (const scenario of ["cancel", "hold"]) {
    const fixture = await fakeCf(t, "success");
    if (scenario === "hold") Object.assign(fixture.env, { TERM: "xterm-256color", FAKE_CF_DELAY_MS: "320" });
    const claude = await fakeClaude(fixture, scenario);
    const result = await ptyAuth(args("claude", "subscription"), fixture, "", scenario === "hold" ? "auto-cancel" : "auto", claude.ready);
    assert.equal(result.code, 3);
    assert.equal(result.output.error, "auth_cancelled");
    assert.equal(result.restored, true);
    if (scenario === "hold") assert(result.capture.includes("\r\x1b[2K\r\nApprove Claude"));
    assert.doesNotMatch(result.capture, /Continue with masked input/);
    assertNoChildOutput(result);
    assert((await fixture.calls()).every(call => !call.body));
    const child = await claude.child();
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    assert.equal(existsSync(child.cwd), false);
  }
});

test("Claude auto times out a waiting child before allowing masked input", needsClaudePty, async t => {
  const fixture = await fakeCf(t, "success");
  // The child holds forever; the deadline only needs to outlast its startup on a loaded machine.
  fixture.env.SANDBOX_RUNNER_CLAUDE_SETUP_TIMEOUT_MS = "3000";
  const claude = await fakeClaude(fixture, "hold");
  const result = await ptyAuth(args("claude", "subscription"), fixture, oauth + "\n", "no");
  assert.equal(result.code, 0);
  assert.equal(result.masked, true);
  assert.equal(result.restored, true);
  assert.equal(result.output.credentialSource, undefined);
  assert.match(result.capture, /Continue with masked input/);
  assertNoChildOutput(result);
  const child = await claude.child();
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  assert.equal((await fixture.calls()).filter(call => call.body).length, 1);
});

test("Claude auto preflights before consent and never falls back after a publication attempt", needsClaudePty, async t => {
  for (const [plan, error] of [
    ["rollout", "worker_target_unverified"],
    ["targetChanged", "worker_target_changed"],
    ["updateFailed", "cloudflare_update_unverified"],
  ]) {
    const fixture = await fakeCf(t, plan);
    const claude = await fakeClaude(fixture, "success");
    const result = await ptyAuth(args("claude", "subscription"), fixture, "", plan === "rollout" ? "stdin" : "auto");
    assert.equal(result.output.error, error);
    assert.equal(result.restored, true);
    assert.doesNotMatch(result.capture, /Continue with masked input/);
    assertNoChildOutput(result);
    assert.equal(Boolean(await claude.child()), plan !== "rollout");
    const updates = (await fixture.calls()).filter(call => call.body);
    assert.equal(updates.length, plan === "updateFailed" ? 1 : 0);
    if (plan === "updateFailed") assert.equal(result.output.uncertain, true);
  }
});

test("Claude --stdin bypasses the setup-token child", async t => {
  const fixture = await fakeCf(t, "success");
  const claude = await fakeClaude(fixture, "hold");
  const result = await childAuth(args("claude", "subscription", ["--stdin"]), fixture, oauth).result;
  assert.equal(result.code, 0);
  assert.equal(result.output.credentialSource, undefined);
  assert.equal(await claude.child(), undefined);
});
