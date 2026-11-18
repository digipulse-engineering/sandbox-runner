import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/sandbox-runner.mjs", import.meta.url));
const account = "0123456789abcdef0123456789abcdef";
const worker = "example-runner";
const profile = "runner-profile";
const previousId = "c428f92d-639b-46a2-b808-86549f9f6bdb";
const nextId = "2dad2438-7c35-40c6-bbe4-594a17eeb06b";
const runNamespace = "0123456789abcdeffedcba9876543210";
const vitestNamespace = "fedcba9876543210abcdef0123456789";
const indexNamespace = "fedcba98765432100123456789abcdef";
const appId = "9427ecbd-e818-4bd9-912f-2933bb473a60";
const vitestAppId = "1427ecbd-e818-4bd9-912f-2933bb473a61";
const guardToken = "guard-" + "a".repeat(64);
const closureId = "5b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";

async function fixture(t, { plan = "normal", guard = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sandbox-runner-upgrade-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "worker");
  const initialized = spawnSync(process.execPath, [bin, "cloudflare", "init", project, "--account", account, "--worker", worker,
    "--profile", profile], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stdout);
  await mkdir(join(project, "pinned-src"));
  await mkdir(join(project, "node_modules"));
  await writeFile(join(project, "daemon.mjs"), "// Generated daemon fixture\n");
  const log = join(root, "calls.jsonl");
  const switched = join(root, "switched");
  const cf = join(root, "cf.mjs");
  await writeFile(cf, "#!" + process.execPath + "\n" + String.raw`
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { worker, profile, account, previousId, nextId, runNamespace, vitestNamespace, indexNamespace, appId, vitestAppId,
  log, switched, plan, guard } = FIXTURE;
const [flag, selected, ...args] = process.argv.slice(2);
if (flag !== "--profile" || selected !== profile) throw Error("wrong profile");
appendFileSync(log, JSON.stringify({ args }) + "\n");
const send = value => console.log(JSON.stringify(value));
const live = existsSync(switched);
const command = args.slice(0, 3).join(" ");
if (args.join(" ") === "accounts get") send({ id: account });
else if (args[0] === "build") {
  const output = join(process.cwd(), ".cloudflare", "output", "v0");
  const write = (path, value) => writeFileSync(join(output, path), JSON.stringify(value));
  mkdirSync(join(output, "workers", "default"), { recursive: true });
  write("config.json", { buildContext: { isPreview: false, mode: "production" } });
  write("workers/default/worker.config.json", { name: worker, workersDev: true, previewUrls: false,
    env: { SANDBOX_RUNNER_MODE: { type: "text", value: "real" }, SANDBOX_RUNNER_TOKEN: { type: "secret" } },
    exports: { Run: { type: "durable-object", storage: "sqlite", container: worker },
      VitestRun: { type: "durable-object", storage: "sqlite", container: worker + "-vitest" },
      RunIndex: { type: "durable-object", storage: "sqlite" }, ProviderEgress: { type: "worker" } } });
  for (const name of [worker, worker + "-vitest"]) {
    mkdirSync(join(output, "containers", name), { recursive: true });
    const image = { localReference: "cloudflare-build/aabb/" + name + ":beef" };
    write("containers/" + name + "/container.config.json", name === worker
      ? { name, schedulingPolicy: "durable-object", images: { base: image } } : { name, schedulingPolicy: "default", image });
  }
} else if (args.join(" ") === "deploy --prebuilt --dry-run") console.error("│  --dry-run: exiting now.");
else if (args[0] === "deploy") {
  writeFileSync(switched, "");
  console.error("│  Current Version ID: " + nextId);
} else if (command === "workers deployments list") {
  send({ deployments: [{ versions: [{ version_id: live ? nextId : previousId, percentage: 100 }] }] });
} else if (command === "workers versions get") {
  const id = args[3];
  const deployed = JSON.parse(require_log()).find(call => call.args[0] === "deploy" && call.args.includes("--message"));
  send({ id, number: id === nextId ? 8 : 7,
    annotations: id === nextId ? { "workers/message": deployed.args[deployed.args.indexOf("--message") + 1] } : {},
    bindings: [{ name: "SANDBOX_RUNNER_MODE", type: "plain_text", text: "real" }, { name: "SANDBOX_RUNNER_TOKEN", type: "secret_text" },
      { name: "OPENAI_API_KEY", type: "secret_text" },
      ...(guard && !(plan === "guard-lost" && id === nextId) ? [{ name: "SANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN", type: "secret_text" }] : [])],
    containers: [{ name: worker, class_name: "Run" }, { name: worker + "-vitest", class_name: "VitestRun" }] });
} else if (command === "containers applications list") {
  const name = args[4];
  send([{ name, id: name === worker ? appId : vitestAppId, scheduling_policy: name === worker ? "durable_object" : "default",
    durable_objects: { namespace_id: name === worker ? runNamespace : vitestNamespace },
    ...(plan === "no-health" ? {} : { health: { instances: name === worker ? { active: plan === "busy" ? 1 : 0, starting: 0 }
      : { healthy: 5, active: 0, assigned: 0 } } }) }]);
} else if (command === "durable-objects namespaces list") {
  send([{ script: worker, class: "Run", id: runNamespace, use_sqlite: true },
    { script: worker, class: "VitestRun", id: vitestNamespace, use_sqlite: true },
    { script: worker, class: "RunIndex", id: live && plan === "index-replaced" ? appId.replace(/-/g, "") : indexNamespace, use_sqlite: true }]);
} else throw Error("Unexpected cf command " + args.join(" "));
function require_log() {
  return "[" + require("node:fs").readFileSync(log, "utf8").trim().split("\n").join(",") + "]";
}
`.replace("FIXTURE", JSON.stringify({ worker, profile, account, previousId, nextId, runNamespace, vitestNamespace, indexNamespace,
    appId, vitestAppId, log, switched, plan, guard })).replace('import { join } from "node:path";',
    'import { join } from "node:path";\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);'), { mode: 0o700 });

  const guardCalls = [];
  let closure = plan === "guard-closed" ? { upgradeId: closureId, generation: "4", status: "drained" } : null;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    guardCalls.push({ method: request.method, url: request.url, body: body && JSON.parse(body) });
    if (request.url !== "/v4/admissions/guard" || request.headers.authorization !== `Bearer ${guardToken}`) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "POST" && plan === "close-fails") {
      response.writeHead(503).end();
      return;
    }
    if (request.method === "POST") {
      const action = JSON.parse(body);
      closure = { upgradeId: action.upgradeId, generation: "5", status: plan === "guard-draining" ? "draining" : "drained" };
    }
    const live = existsSync(switched);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: plan === "guard-legacy" ? "legacy_unverified" : closure ? closure.status : "open",
      upgradeId: closure?.upgradeId ?? null,
      generation: live && plan === "generation-bump" ? "6" : closure?.generation ?? null, pendingCount: closure?.status === "draining" ? 1 : 0, pending: [], nextCursor: null,
      protocolVersion: 1, workerVersionId: plan === "guard-stale" ? nextId : live ? nextId : previousId }));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise(done => server.close(done)));
  const guardUrl = `http://127.0.0.1:${server.address().port}`;
  const tokenFile = join(root, "guard.json");
  await writeFile(tokenFile, JSON.stringify({ SANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN: guardToken, SANDBOX_RUNNER_TOKEN: "operator" }), { mode: 0o600 });

  async function run(args, env = {}) {
    // The guard server runs in this process, so the CLI must run asynchronously.
    const child = spawn(process.execPath, [bin, "cloudflare", "upgrade", project, ...args], {
      env: { ...process.env, SANDBOX_RUNNER_CF_BIN: cf, CLOUDFLARE_ACCOUNT_ID: account, SANDBOX_RUNNER_TIMEOUT_MS: "5000", ...env },
    });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    const status = await new Promise(done => child.on("close", done));
    const calls = existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line).args) : [];
    return { status, output: JSON.parse(stdout), calls };
  }
  return { run, project, root, guardUrl, tokenFile, guardCalls };
}

const deployed = calls => calls.filter(call => call[0] === "deploy" && !call.includes("--dry-run"));

test("an installation without a guard upgrades only with --without-guard and keeps its secrets", async t => {
  const { run } = await fixture(t);
  const refused = await run([]);
  assert.equal(refused.output.error, "cloudflare_upgrade_guard_absent");
  assert.equal(deployed(refused.calls).length, 0);
  const result = await run(["--without-guard"]);
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.equal(result.output.status, "upgraded");
  assert.deepEqual(result.output.previousVersion, { id: previousId, number: 7 });
  assert.deepEqual(result.output.version, { id: nextId, number: 8, percentage: 100 });
  assert.deepEqual(result.output.guard, { status: "absent" });
  assert.deepEqual(result.output.templateChanges, []);
  const [upload] = deployed(result.calls);
  assert(!upload.includes("--secrets-file"), "an upgrade keeps the Worker's secrets");
});

test("an installation with a guard requires it and refuses --without-guard", async t => {
  const { run } = await fixture(t, { guard: true });
  for (const args of [[], ["--without-guard"]]) {
    const result = await run(args);
    assert.equal(result.output.error, "cloudflare_upgrade_guard_required");
    assert.equal(deployed(result.calls).length, 0);
  }
});

test("an open guard is closed, the version switched and the closure left for the operator to reopen", async t => {
  const { run, guardUrl, tokenFile, guardCalls } = await fixture(t, { guard: true });
  const result = await run(["--guard-url", guardUrl, "--guard-token-file", tokenFile]);
  assert.equal(result.status, 0, JSON.stringify(result.output));
  const close = guardCalls.find(call => call.method === "POST");
  assert.equal(close.body.action, "close");
  assert.equal(result.output.guard.upgradeId, close.body.upgradeId);
  assert.deepEqual(result.output.guard.reopen.body, { action: "open", upgradeId: close.body.upgradeId, generation: "5" });
  assert(!guardCalls.some(call => call.body?.action === "open"), "upgrade never reopens admissions");
  assert.equal(result.output.runIndexNamespaceId, indexNamespace);
});

test("a draining guard stops before the switch and reports the closure to resume with", async t => {
  const { run, guardUrl, tokenFile } = await fixture(t, { guard: true, plan: "guard-draining" });
  const result = await run(["--guard-url", guardUrl, "--guard-token-file", tokenFile]);
  assert.equal(result.status, 4);
  assert.equal(result.output.status, "draining");
  assert.equal(result.output.guard.pendingCount, 1);
  assert.equal(deployed(result.calls).length, 0);
});

test("a closure made earlier is adopted only with its upgrade ID", async t => {
  const { run, guardUrl, tokenFile, guardCalls } = await fixture(t, { guard: true, plan: "guard-closed" });
  const refused = await run(["--guard-url", guardUrl, "--guard-token-file", tokenFile]);
  assert.equal(refused.output.error, "cloudflare_upgrade_guard_closed");
  assert.equal(deployed(refused.calls).length, 0);
  const result = await run(["--guard-url", guardUrl, "--guard-token-file", tokenFile, "--upgrade-id", closureId]);
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.deepEqual(result.output.guard.reopen.body, { action: "open", upgradeId: closureId, generation: "4" });
  assert(!guardCalls.some(call => call.method === "POST"));
});

test("dry-run reads the installation and guard without closing or deploying", async t => {
  const { run, guardUrl, tokenFile, guardCalls } = await fixture(t, { guard: true });
  const result = await run(["--dry-run", "--guard-url", guardUrl, "--guard-token-file", tokenFile]);
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.equal(result.output.status, "dry_run");
  assert.equal(result.output.guard.status, "open");
  assert.equal(deployed(result.calls).length, 0);
  assert(!guardCalls.some(call => call.method === "POST"));
});

test("a replaced run index or a lost guard binding leaves the upgrade unconfirmed", async t => {
  for (const [plan, guard] of [["index-replaced", false], ["guard-lost", true]]) {
    const { run, guardUrl, tokenFile } = await fixture(t, { guard, plan });
    const result = await run(guard ? ["--guard-url", guardUrl, "--guard-token-file", tokenFile] : ["--without-guard"]);
    assert.equal(result.output.error, "cloudflare_upgrade_unconfirmed", plan);
    assert.equal(result.output.uncertain, true);
    assert.match(result.output.message, new RegExp(previousId));
  }
});

test("an outdated project takes this CLI's template and reinstalls until the refresh completes", async t => {
  const { run, project, root } = await fixture(t);
  const config = join(project, "cloudflare.config.ts");
  const manifestPath = join(project, "sandbox-runner.project.json");
  const current = await readFile(config);
  const digest = JSON.parse(await readFile(manifestPath, "utf8")).templateDigest;
  await writeFile(config, "// An earlier template\n");
  const preview = await run(["--dry-run", "--without-guard"]);
  assert.equal(preview.status, 0, JSON.stringify(preview.output));
  assert.deepEqual(preview.output.templateChanges, ["cloudflare.config.ts"]);
  assert.equal(preview.output.built, false);
  assert(!preview.calls.some(call => call[0] === "build"));
  assert.equal(await readFile(config, "utf8"), "// An earlier template\n");

  const npmLog = join(root, "npm.log");
  const npm = fail => writeFile(join(root, "npm"), "#!" + process.execPath + "\n" +
    `require("node:fs").appendFileSync(${JSON.stringify(npmLog)}, process.argv.slice(2).join(" ") + "\\n");\n` +
    (fail ? "process.exit(1);\n" : ""), { mode: 0o700 });
  const path = { PATH: root + delimiter + process.env.PATH };
  await npm(true);
  const failed = await run(["--without-guard"], path);
  assert.equal(failed.output.error, "cloudflare_setup_prepare_failed");
  assert.deepEqual(await readFile(config), current);
  const unfinished = JSON.parse(await readFile(manifestPath, "utf8"));
  unfinished.templateDigest = "0".repeat(64);
  await writeFile(manifestPath, JSON.stringify(unfinished));
  assert.equal(deployed(failed.calls).length, 0);

  await npm(false);
  const result = await run(["--without-guard"], path);
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.deepEqual(result.output.templateChanges, [], "the files already match; the dependencies are prepared again");
  assert.equal(result.output.sdkCommit, JSON.parse(await readFile(manifestPath, "utf8")).sdkCommit);
  assert.equal((await readFile(npmLog, "utf8")).trim().split("\n").length, 2);
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).templateDigest, digest);
});

test("the guard must answer from the serving version and in a state that can drain", async t => {
  for (const [plan, error] of [["guard-stale", "cloudflare_upgrade_guard_unverified"], ["guard-legacy", "cloudflare_upgrade_guard_blocked"]]) {
    const { run, guardUrl, tokenFile, guardCalls } = await fixture(t, { guard: true, plan });
    const result = await run(["--guard-url", guardUrl, "--guard-token-file", tokenFile]);
    assert.equal(result.output.error, error, plan);
    assert.equal(deployed(result.calls).length, 0);
    assert(!guardCalls.some(call => call.method === "POST"));
  }
});

test("a close without a response is uncertain and names the upgrade ID to resume with", async t => {
  const { run, guardUrl, tokenFile, guardCalls } = await fixture(t, { guard: true, plan: "close-fails" });
  const result = await run(["--guard-url", guardUrl, "--guard-token-file", tokenFile]);
  assert.equal(result.output.uncertain, true);
  const close = guardCalls.find(call => call.method === "POST");
  assert(result.output.message.includes(close.body.upgradeId));
  assert.equal(deployed(result.calls).length, 0);
});

test("a guard whose closure changes across the switch leaves the upgrade unconfirmed and frozen", async t => {
  const { run, guardUrl, tokenFile } = await fixture(t, { guard: true, plan: "generation-bump" });
  const result = await run(["--guard-url", guardUrl, "--guard-token-file", tokenFile]);
  assert.equal(result.output.error, "cloudflare_upgrade_unconfirmed");
  assert.equal(result.output.uncertain, true);
  assert.match(result.output.message, /frozen/);
});

test("the guard token file holds the token alone, or by name in JSON or dotenv, and nothing else", async t => {
  const { run, root, guardUrl } = await fixture(t, { guard: true });
  const file = join(root, "guard.env");
  await writeFile(file, `SANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN=${guardToken}\n`);
  assert.equal((await run(["--dry-run", "--guard-url", guardUrl, "--guard-token-file", file])).status, 0);
  await writeFile(file, guardToken + "\n");
  assert.equal((await run(["--dry-run", "--guard-url", guardUrl, "--guard-token-file", file])).status, 0);
  await writeFile(file, "operator-token\n");
  const invalid = await run(["--dry-run", "--guard-url", guardUrl, "--guard-token-file", file]);
  assert.equal(invalid.output.error, "cloudflare_upgrade_guard_token_invalid");
  assert(!JSON.stringify(invalid.output).includes("operator-token"));
});

test("upgrade refuses settings exported in the environment", async t => {
  const { run } = await fixture(t);
  const result = await run(["--without-guard"], { SANDBOX_RUNNER_MCP_CONNECTORS: "{}" });
  assert.equal(result.output.error, "cloudflare_setting_in_environment");
  assert.equal(result.calls.length, 0);
});

test("without a guard, upgrade switches only when no container instance is busy", async t => {
  const { run } = await fixture(t, { plan: "busy" });
  const result = await run(["--without-guard"]);
  assert.equal(result.output.error, "cloudflare_upgrade_runs_active");
  assert.equal(deployed(result.calls).length, 0);
});

test("without readable instance health, an unguarded upgrade refuses to switch", async t => {
  const { run } = await fixture(t, { plan: "no-health" });
  const result = await run(["--without-guard"]);
  assert.equal(result.output.error, "cloudflare_upgrade_instances_unverified");
  assert.equal(deployed(result.calls).length, 0);
});

test("a refresh refuses a node_modules link, which npm ci would empty", async t => {
  const { run, project, root } = await fixture(t);
  await writeFile(join(project, "cloudflare.config.ts"), "// An earlier template\n");
  const shared = join(root, "shared-modules");
  await mkdir(join(shared, "kept"), { recursive: true });
  await rm(join(project, "node_modules"), { recursive: true });
  await (await import("node:fs/promises")).symlink(shared, join(project, "node_modules"), "dir");
  const result = await run(["--without-guard"]);
  assert.equal(result.output.error, "cloudflare_upgrade_shared_dependencies");
  assert(existsSync(join(shared, "kept")));
  assert.equal(await readFile(join(project, "cloudflare.config.ts"), "utf8"), "// An earlier template\n");
});
