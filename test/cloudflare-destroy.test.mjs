import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/sandbox-runner.mjs", import.meta.url));
const account = "0123456789abcdef0123456789abcdef";
const worker = "example-runner";
const workerId = "adcfa0123456789abcdeffedcba98765";
const profile = "runner-profile";
const pin = "1a450e71325c25ca1ec8b0013d756fe0c733b6f3";
const version = { id: "c428f92d-639b-46a2-b808-86549f9f6bdb", number: 1, percentage: 100 };
const rotatedVersion = { id: "2dad2438-7c35-40c6-bbe4-594a17eeb06b", number: 3, percentage: 100 };
const runId = "0123456789abcdeffedcba9876543210";
const vitestId = "9427ecbd-e818-4bd9-912f-2933bb473a60";
const vitestNamespace = "fedcba9876543210abcdef0123456789";
const indexNamespace = "fedcba98765432100123456789abcdef";
const token = "credential-not-for-output";
const ambient = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_AUTH_PROFILE", "CLOUDFLARE_API_BASE_URL", "CLOUDFLARE_API_HEADERS",
  "CLOUDFLARE_COMPLIANCE_REGION", "NODE_TLS_REJECT_UNAUTHORIZED", "SANDBOX_RUNNER_TOKEN", "OPENAI_API_KEY"];

async function fixture(t, plan = "normal", { legacy = false, index = false, fakeReceipt, agentName } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sandbox-runner-destroy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "worker");
  const receiptPath = join(root, "deploy.json");
  const log = join(root, "calls.jsonl");
  const applications = [{ name: agentName ?? worker, className: "Run", schedulingPolicy: "durable-object", id: runId, namespaceId: runId }];
  if (!legacy) applications.push({ name: worker + "-vitest", className: "VitestRun", schedulingPolicy: "default", id: vitestId, namespaceId: vitestNamespace });
  const receipt = { status: "deployed", account, profile, worker, sdkCommit: pin, version, applications,
    ...(index ? { runIndexNamespaceId: indexNamespace } : {}) };
  await mkdir(project);
  await writeFile(join(project, "sandbox-runner.project.json"), JSON.stringify({ schemaVersion: 1, cliVersion: "0.1.0",
    account, profile, worker, sdkCommit: pin, ...(agentName === undefined ? {} : { containers: { agent: { name: agentName } } }) }));
  await writeFile(join(project, ".env"), `CLOUDFLARE_API_TOKEN=${token}\n`);
  await writeFile(receiptPath, JSON.stringify(fakeReceipt ? fakeReceipt(structuredClone(receipt)) : receipt));
  const cf = join(root, "cf.mjs");
  await writeFile(cf, "#!" + process.execPath + "\n" + String.raw`
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const {account, worker, workerId, profile, applications, version, rotatedVersion, index, indexNamespace, plan, token, log, ambient} = FIXTURE;
const [flag, selected, ...args] = process.argv.slice(2);
if (flag !== "--profile" || selected !== profile) throw Error("wrong profile");
const cwd = process.cwd();
appendFileSync(log, JSON.stringify({args, cwd, account:process.env.CLOUDFLARE_ACCOUNT_ID,
  dotenv:existsSync(join(cwd, ".env")), ambient:ambient.filter(name => process.env[name] !== undefined)}) + "\n");
process.stderr.write(token);
const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line).args);
const workerDelete = calls.some(call => call[0] === "workers" && call[1] === "delete");
const gone = plan === "partial" || plan === "already-gone" || plan === "renamed-orphan" ||
  (workerDelete && !["worker-not-deleted", "worker-refused"].includes(plan));
const [area, resource, verb, value] = args;
const send = data => console.log(JSON.stringify(data));
const fail = () => process.exit(1);
if (area === "accounts" && resource === "get") {
  send({id:plan === "wrong-account" ? "f".repeat(32) : account, name:token});
} else if (area === "workers" && resource === "list") {
  if (plan === "broken-readback" && workerDelete) fail();
  if (value === "1") send(Array.from({length:100}, (_, index) => ({name:"other-"+index, id:"worker-"+index})));
  else if (workerDelete && plan === "replacement-after-delete") send([{name:worker, id:account}]);
  else send(gone ? [] : [{name:worker, id:workerId}]);
} else if (area === "workers" && resource === "get") {
  if (verb !== workerId) throw Error("Wrong Worker ID read");
  send({id:workerId, name:plan === "worker-renamed-before-delete" ? "renamed-worker" : worker});
} else if (area === "workers" && resource === "versions" && verb === "get") {
  if (args[5] !== workerId) throw Error("Wrong Worker ID for version read");
  if (plan === "original-missing" && value === version.id) fail();
  const details = value === rotatedVersion.id ? rotatedVersion : version;
  const containers = applications.map(app => ({class_name:app.className,name:app.name}));
  send({id:details.id, number:details.number, bindings:[{name:"SANDBOX_RUNNER_MODE",type:"plain_text",text:"real"},
    {name:"SANDBOX_RUNNER_TOKEN",type:"secret_text",text:token}],
    containers:plan === "version-lost-vitest" || (plan === "active-topology-changed" && value === rotatedVersion.id) ? containers.slice(0,1) : containers});
} else if (area === "workers" && resource === "deployments" && verb === "list") {
  const checkingAgain = calls.filter(call => call[1] === "deployments").length > 1;
  const rotated = ["rotated", "active-topology-changed"].includes(plan) || (plan === "active-changed-during-check" && !checkingAgain);
  const active = {version_id:rotated ? rotatedVersion.id : version.id, percentage:plan === "split" ? 50 : 100};
  send({deployments:[{versions:plan === "split" ? [active, {version_id:"other", percentage:50}] : [active]}]});
} else if (area === "containers" && resource === "applications" && verb === "list") {
  if (plan === "already-gone") send([]);
  else {
    const surviving = applications.filter(app => !calls.some(call => call[2] === "delete" && call[3] === app.id) &&
      !(app.className === "Run" && (gone && !["worker-lost-response", "app-lost-response"].includes(plan) || plan === "missing-app")));
    send(surviving.map(app => ({id:plan === "replaced-app" && workerDelete ? account : app.id,
      name:plan === "renamed-orphan" ? "renamed-application" : app.name,
      scheduling_policy:app.schedulingPolicy.replace("-","_"),
      durable_objects:{namespace_id:plan === "divorced-app" && app.className === "VitestRun" ? account : app.namespaceId}})));
  }
} else if (area === "durable-objects" && resource === "namespaces" && verb === "list") {
  if (args[4] === "1") send(Array.from({length:1000}, (_, index) => ({id:"namespace-"+index, script:"unrelated", class:"Other"})));
  else {
    const namespaces = applications.map(app => ({
      id:plan === "recreated-worker" ? app.namespaceId.slice(1)+"a" : app.namespaceId,
      class:app.className, script:worker, use_sqlite:true,
    }));
    if (plan === "additional-worker-do") namespaces.push({id:account,class:"RunIndex",script:worker,use_sqlite:true});
    const indexEntry = {id:plan === "wrong-index" ? account : indexNamespace,class:"RunIndex",script:worker,use_sqlite:true};
    if (index) namespaces.push(indexEntry);
    send(gone && plan !== "lingering-namespace" ? plan === "lingering-index" ? [indexEntry] : [] : namespaces);
  }
} else if (area === "workers" && resource === "delete") {
  if (verb !== workerId || value !== "--force" || args.length !== 4) throw Error("Unverified Worker deletion");
  if (["worker-lost-response", "worker-refused"].includes(plan)) fail();
} else if (area === "containers" && resource === "applications" && verb === "delete") {
  if (plan === "app-lost-response") fail();
} else throw Error("Unexpected cf command");
`.replace("FIXTURE", JSON.stringify({ account, worker, workerId, profile, applications, version, rotatedVersion,
  index, indexNamespace, plan, token, log, ambient })), { mode: 0o700 });

  async function invoke(flags = [], includeReceipt = true) {
    const args = [bin, "cloudflare", "destroy", project, ...(includeReceipt ? ["--receipt", receiptPath] : []), ...flags];
    const command = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env,
      ...Object.fromEntries(ambient.map(name => [name, token])), SANDBOX_RUNNER_CF_BIN: cf,
      CLOUDFLARE_ACCOUNT_ID: runId, SANDBOX_RUNNER_CF_PROFILE: "unrelated", SANDBOX_RUNNER_TIMEOUT_MS: "30000" } });
    assert.ifError(command.error);
    assert.equal(command.stderr, "");
    assert(!command.stdout.includes(token));
    const calls = existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse) : [];
    assert(calls.every(call => call.account === account && call.ambient.length === 0 && !call.dotenv && !existsSync(call.cwd)));
    return { status: command.status, output: JSON.parse(command.stdout), calls: calls.map(call => call.args),
      deletes: calls.map(call => call.args).filter(args => args.includes("delete")) };
  }
  return { invoke };
}

test("dry-run validates both apps and all paginated metadata without a delete", async t => {
  const { invoke } = await fixture(t);
  const result = await invoke(["--dry-run"]);
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.equal(result.output.status, "dry_run");
  assert.equal(result.output.images, "retained");
  assert.equal(result.output.workerId, workerId);
  assert.deepEqual(result.output.activeVersion, version);
  assert.equal(result.output.workerPresent, true);
  assert.deepEqual(result.output.applicationsPresent, [runId, vitestId]);
  assert.deepEqual(result.output.namespacesPresent, [runId, vitestNamespace]);
  assert.deepEqual(result.calls, [
    ["accounts", "get"], ["workers", "list", "--page", "1", "--per-page", "100"], ["workers", "list", "--page", "2", "--per-page", "100"],
    ["containers", "applications", "list"], ["durable-objects", "namespaces", "list", "--page", "1", "--per-page", "1000"],
    ["durable-objects", "namespaces", "list", "--page", "2", "--per-page", "1000"],
    ["workers", "versions", "get", version.id, "--worker-id", workerId],
    ["workers", "deployments", "list", "--worker", worker], ["workers", "get", workerId],
  ]);
});

test("destroy deletes Worker once and the remaining app by ID, then an explicit replay finds nothing", async t => {
  const { invoke } = await fixture(t);
  const result = await invoke();
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.equal(result.output.status, "destroyed");
  assert.equal(result.output.images, "retained");
  const deletions = [["workers", "delete", workerId, "--force"], ["containers", "applications", "delete", vitestId, "--force"]];
  assert.deepEqual(result.deletes, deletions);
  assert.deepEqual(result.calls.at(-1), ["durable-objects", "namespaces", "list", "--page", "2", "--per-page", "1000"]);
  const replay = await invoke();
  assert.equal(replay.status, 0);
  assert.equal(replay.output.status, "already_destroyed");
  assert.deepEqual(replay.deletes, deletions);
});

for (const plan of ["worker-lost-response", "app-lost-response", "partial"]) {
  test(`${plan} reconciles exact inventory and never retries a delete`, async t => {
    const { invoke } = await fixture(t, plan);
    const result = await invoke();
    assert.equal(result.status, 0, JSON.stringify(result.output));
    assert.equal(result.output.status, "destroyed");
    const deleteApps = [runId, vitestId].filter(id => plan !== "partial" || id !== runId)
      .map(id => ["containers", "applications", "delete", id, "--force"]);
    assert.deepEqual(result.deletes, [...(plan === "partial" ? [] : [["workers", "delete", workerId, "--force"]]), ...deleteApps]);
  });
}

for (const plan of ["worker-not-deleted", "worker-refused", "broken-readback", "replaced-app", "replacement-after-delete"]) {
  test(`${plan} stops after one delete and reports uncertainty`, async t => {
    const { invoke } = await fixture(t, plan);
    const result = await invoke();
    assert.equal(result.status, 6);
    assert.equal(result.output.error, "cloudflare_destroy_unconfirmed");
    assert.equal(result.output.uncertain, true);
    assert.deepEqual(result.deletes, [["workers", "delete", workerId, "--force"]]);
  });
}

for (const plan of ["original-missing", "split", "recreated-worker", "version-lost-vitest", "active-topology-changed",
  "active-changed-during-check", "divorced-app", "missing-app", "renamed-orphan", "wrong-account", "worker-renamed-before-delete"]) {
  test(`${plan} is refused before any deletion`, async t => {
    const { invoke } = await fixture(t, plan);
    const result = await invoke();
    assert.equal(result.status, 3);
    assert.equal(result.output.error, plan === "wrong-account" ? "cloudflare_account_unverified" : "cloudflare_destroy_target_unverified");
    assert.equal(result.output.uncertain, undefined);
    assert.deepEqual(result.deletes, []);
  });
}

test("an attested namespace left in inventory keeps the destruction unconfirmed", async t => {
  const { invoke } = await fixture(t, "lingering-namespace");
  const result = await invoke();
  assert.equal(result.status, 6);
  assert.equal(result.output.error, "cloudflare_destroy_unconfirmed");
  assert.equal(result.output.uncertain, true);
  assert.equal(result.deletes.length, 2);
});

test("destroy accepts credential rotation with the original version and matching active topology", async t => {
  const { invoke } = await fixture(t, "rotated");
  const result = await invoke();
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.deepEqual(result.output.version, version);
  assert.deepEqual(result.output.activeVersion, rotatedVersion);
  assert.deepEqual(result.calls.filter(call => call[1] === "versions").map(call => call[3]), [version.id, rotatedVersion.id]);
  assert.equal(result.calls.filter(call => call[1] === "deployments").length, 2);
  assert.deepEqual(result.deletes, [["workers", "delete", workerId, "--force"], ["containers", "applications", "delete", vitestId, "--force"]]);
});

test("destroy accepts an additional Durable Object that has no Container application", async t => {
  const { invoke } = await fixture(t, "additional-worker-do");
  const result = await invoke();
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.equal(result.output.status, "destroyed");
  assert.deepEqual(result.deletes, [["workers", "delete", workerId, "--force"], ["containers", "applications", "delete", vitestId, "--force"]]);
});

test("destroy attests RunIndex with both apps and verifies deletion through Worker inventory", async t => {
  const { invoke } = await fixture(t, "worker-lost-response", { index: true });
  const dryRun = await invoke(["--dry-run"]);
  assert.equal(dryRun.status, 0, JSON.stringify(dryRun.output));
  assert.equal(dryRun.output.runIndexNamespaceId, indexNamespace);
  assert.deepEqual(dryRun.output.applicationsPresent, [runId, vitestId]);
  assert.deepEqual(dryRun.output.namespacesPresent, [runId, vitestNamespace, indexNamespace]);
  assert.deepEqual(dryRun.deletes, []);
  const result = await invoke();
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.equal(result.output.status, "destroyed");
  assert.deepEqual(result.deletes, [["workers", "delete", workerId, "--force"],
    ["containers", "applications", "delete", runId, "--force"], ["containers", "applications", "delete", vitestId, "--force"]]);
});

test("destroy refuses a RunIndex ID divergent from the receipt before any mutation", async t => {
  const { invoke } = await fixture(t, "wrong-index", { index: true });
  const result = await invoke();
  assert.equal(result.status, 3);
  assert.equal(result.output.error, "cloudflare_destroy_target_unverified");
  assert.deepEqual(result.deletes, []);
});

test("destroy is unconfirmed when only the attested RunIndex remains", async t => {
  const { invoke } = await fixture(t, "lingering-index", { index: true });
  const result = await invoke();
  assert.equal(result.status, 6);
  assert.equal(result.output.error, "cloudflare_destroy_unconfirmed");
  assert.equal(result.output.uncertain, true);
  assert.deepEqual(result.deletes, [["workers", "delete", workerId, "--force"], ["containers", "applications", "delete", vitestId, "--force"]]);
});

test("legacy receipt with one Run app remains usable and retains images", async t => {
  const { invoke } = await fixture(t, "normal", { legacy: true });
  const result = await invoke();
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.equal(result.output.images, "retained");
  assert.deepEqual(result.deletes, [["workers", "delete", workerId, "--force"]]);
});

test("receipt is required and a cross-target receipt is rejected before running cf", async t => {
  const { invoke } = await fixture(t, "normal", { fakeReceipt: receipt => ({ ...receipt, profile: "other" }) });
  const missing = await invoke([], false);
  assert.equal(missing.status, 2);
  assert.deepEqual(missing.calls, []);
  const mismatch = await invoke();
  assert.equal(mismatch.status, 3);
  assert.equal(mismatch.output.error, "cloudflare_destroy_receipt_invalid");
  assert.deepEqual(mismatch.calls, []);
});

test("destroy follows the agent application name recorded in the manifest", async t => {
  const renamed = await fixture(t, "normal", { agentName: "example-agent" });
  const result = await renamed.invoke(["--dry-run"]);
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.deepEqual(result.output.applicationsPresent, [runId, vitestId]);
  const mismatched = await fixture(t, "normal", { agentName: "example-agent",
    fakeReceipt: receipt => ({ ...receipt, applications: receipt.applications.map(app => app.className === "Run" ? { ...app, name: worker } : app) }) });
  assert.equal((await mismatched.invoke(["--dry-run"])).output.error, "cloudflare_destroy_receipt_invalid");
});
