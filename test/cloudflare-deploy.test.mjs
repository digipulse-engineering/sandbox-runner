import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/sandbox-runner.mjs", import.meta.url));
const account = "0123456789abcdef0123456789abcdef";
const worker = "example-runner";
const profile = "runner-profile";
const token = "control-value-kept-private";
const versionId = "c428f92d-639b-46a2-b808-86549f9f6bdb";
const appId = "0123456789abcdeffedcba9876543210";
const vitestNamespace = "fedcba9876543210abcdef0123456789";
const indexNamespace = "abcdef0123456789abcdef0123456789";
const ambient = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_HEADERS", "CLOUDFLARE_API_BASE_URL", "CLOUDFLARE_CONTAINER_REGISTRY",
  "CLOUDFLARE_COMPLIANCE_REGION", "WRANGLER_TOKEN_URL", "CLOUDFLARE_AUTH_PROFILE", "WRANGLER_DOCKER_HOST",
  "SANDBOX_RUNNER_FIXTURES", "SANDBOX_RUNNER_GITHUB_FIXTURES", "SANDBOX_RUNNER_TOKEN", "OPENAI_API_KEY"];
const buildOnlyOverrides = new Set(["CLOUDFLARE_CONTAINER_REGISTRY", "CLOUDFLARE_COMPLIANCE_REGION", "WRANGLER_DOCKER_HOST",
  "SANDBOX_RUNNER_FIXTURES", "SANDBOX_RUNNER_GITHUB_FIXTURES"]);

function invoke(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", ...options });
}

const guardToken = "guard-" + "c".repeat(64);

async function fixture(t, plan = "fresh", { vitest = false, index = false, context, maxConcurrentRuns, versionMetadata = false,
  agentName } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sandbox-runner-deploy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "worker");
  const initialized = invoke(["cloudflare", "init", project, "--account", account, "--worker", worker, "--profile", profile,
    ...(maxConcurrentRuns === undefined ? [] : ["--max-concurrent-runs", String(maxConcurrentRuns)])]);
  assert.equal(initialized.status, 0, initialized.stdout);
  if (agentName !== undefined) {
    const manifestPath = join(project, "sandbox-runner.project.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.containers = { agent: { name: agentName } };
    await writeFile(manifestPath, JSON.stringify(manifest));
  }
  await mkdir(join(project, "pinned-src"));
  await mkdir(join(project, "node_modules"));
  await writeFile(join(project, "daemon.mjs"), "// Generated daemon fixture\n");
  await writeFile(join(project, ".env"), `CLOUDFLARE_ACCOUNT_ID=${"f".repeat(32)}\nCLOUDFLARE_API_TOKEN=${token}\n`);
  const sourceSecret = join(project, "secrets.env");
  await writeFile(sourceSecret, `SANDBOX_RUNNER_TOKEN=${token}\nSANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN=${guardToken}\n`, { mode: 0o600 });
  const dockerConfig = join(root, "operator-docker");
  await mkdir(join(dockerConfig, "contexts"), { recursive: true });
  await writeFile(join(dockerConfig, "config.json"), JSON.stringify({ credsStore: "operator", auths: { registry: { auth: token } } }));
  const cf = join(root, "cf.mjs");
  const log = join(root, "calls.jsonl");
  await writeFile(cf, "#!" + process.execPath + "\n" + String.raw`
import { existsSync, lstatSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { account, worker, profile, token, versionId, appId, vitestNamespace, indexNamespace, ambient, log, plan, vitest, index,
  dockerConfig, maxConcurrentRuns, versionMetadata, agentName } = FIXTURE;
const agent = agentName ?? worker;
const [flag, selected, ...args] = process.argv.slice(2);
if (flag !== "--profile" || selected !== profile) throw Error("wrong profile");
const cwd = process.cwd();
const upload = args[0] === "deploy" && !args.includes("--dry-run");
const record = { args, cwd, account: process.env.CLOUDFLARE_ACCOUNT_ID,
  dockerHost: process.env.DOCKER_HOST, dockerContext: process.env.DOCKER_CONTEXT,
  dockerConfig: process.env.DOCKER_CONFIG, ambient: ambient.filter(name => process.env[name] !== undefined),
  dotenv: existsSync(join(cwd, ".env")), originalSecrets: existsSync(join(cwd, "secrets.env")),
};
if (args[0] === "build") {
  record.staged = ["agent-deadline.ts", "installation-admission.ts", "worker.ts", "unlisted.ts"]
    .filter(name => existsSync(join(cwd, name)));
}
if (upload) {
  const secretPath = args[args.indexOf("--secrets-file") + 1];
  const file = JSON.parse(readFileSync(secretPath, "utf8"));
  const docker = JSON.parse(readFileSync(join(record.dockerConfig, "config.json"), "utf8"));
  record.privateControl = lstatSync(secretPath).mode % 512 === 384 && Object.keys(file).length === 2 && file.SANDBOX_RUNNER_TOKEN === token &&
    /^guard-[a-f0-9]{64}$/.test(file.SANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN);
  record.privateDocker = record.dockerConfig !== dockerConfig && lstatSync(join(record.dockerConfig, "config.json")).mode % 512 === 384 &&
    Object.keys(docker.auths).join(",") === "registry.cloudflare.com" && !docker.credsStore && !JSON.stringify(docker).includes(token);
  record.contextPreserved = record.dockerContext === undefined || lstatSync(join(record.dockerConfig, "contexts")).isSymbolicLink();
}
appendFileSync(log, JSON.stringify(record) + "\n");
process.stderr.write(token + "\n");
const previous = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
const uploaded = previous.find(call => call.args[0] === "deploy" && !call.args.includes("--dry-run"));
const send = value => console.log(JSON.stringify(value));
const appNames = vitest ? [agent, worker + "-vitest"] : [agent];
if (args.join(" ") === "accounts get") {
  send({id: plan === "wrong-account" ? appId : account, name: token});
} else if (args[0] === "build") {
  const output = join(cwd, ".cloudflare", "output", "v0");
  const write = (path, value) => writeFileSync(join(output, path), JSON.stringify(value));
  mkdirSync(join(output, "workers", "default"), {recursive:true});
  write("config.json", {buildContext:{isPreview:false, mode:"production"}});
  const exported = {Run:{type:"durable-object",storage:"sqlite",container:agent},ProviderEgress:{type:"worker"}};
  if (vitest) exported.VitestRun = {type:"durable-object",storage:"sqlite",container:worker+"-vitest"};
  if (index) exported.RunIndex = {type:"durable-object",storage:"sqlite", ...(plan === "index-with-container" ? {container:worker} : {})};
  const metadata = {
    "metadata-as-text": {SANDBOX_RUNNER_VERSION:{type:"text",value:"fake-version"}},
    "metadata-with-value": {SANDBOX_RUNNER_VERSION:{type:"version-metadata",value:"fake-version"}},
    "metadata-wrong-name": {OTHER_VERSION:{type:"version-metadata"}},
  }[plan] ?? (versionMetadata ? {SANDBOX_RUNNER_VERSION:{type:"version-metadata"}} : {});
  write("workers/default/worker.config.json", {
    name: plan === "wrong-worker" ? "other" : worker, workersDev:true, previewUrls:false,
    env: {SANDBOX_RUNNER_MODE:{type:"text",value:plan === "fixture" ? "fixture" : "real"}, SANDBOX_RUNNER_TOKEN:{type:"secret"},
      ...metadata,
      ...(maxConcurrentRuns === undefined ? {} : {SANDBOX_RUNNER_INSTALLATION_MAX_RUNS:{type:"text",
        value:String(plan === "wrong-build-limit" ? maxConcurrentRuns + 1 : maxConcurrentRuns)}})},
    exports:exported, ...(plan === "routes" ? {routes:[{pattern:"unrelated.example"}]} : {}),
  });
  for (const name of appNames) {
    mkdirSync(join(output, "containers", name), {recursive:true});
    const image = {localReference: plan === "wrong-image" ? "elsewhere.invalid/other:fake" : "cloudflare-build/aabb/"+name+":beef"};
    write("containers/"+name+"/container.config.json", name === agent
      ? {name,schedulingPolicy:"durable-object",images:{base:image}}
      : {name,schedulingPolicy:"default",image});
  }
  if (plan === "dotenv") writeFileSync(join(cwd,".env.production"), "CLOUDFLARE_API_TOKEN="+token);
} else if (args.join(" ") === "deploy --prebuilt --dry-run") {
  if (plan !== "missing-dry-run-proof") console.error("│  --dry-run: exiting now.");
} else if (args.slice(0,2).join(" ") === "workers list") {
  if (plan === "existing-worker" && args[3] === "1") send(Array.from({length:100}, (_, index) => ({name:"other-"+index})));
  else send(plan === "existing-worker" ? [{name:worker}] : []);
} else if (args.slice(0,3).join(" ") === "containers applications list") {
  const name = args[4];
  if (uploaded) send([{name,id:appId,scheduling_policy:name === agent ? "durable_object" : "default",
    durable_objects:{namespace_id:plan === "wrong-namespace" ? account : name === agent ? appId : vitestNamespace}}]);
  else send(plan === "existing-application" && name.endsWith("-vitest") ? [{name}] : []);
} else if (upload) {
  if (plan === "upload-lost") process.exitCode = 1;
  else {
    console.log(token);
    console.error("│    https://"+worker+".test.workers.dev");
    console.error("│  Current Version ID: "+versionId);
  }
} else if (args.slice(0,3).join(" ") === "workers deployments list") {
  send({deployments:[{versions:[{version_id:versionId,percentage:100}]}]});
} else if (args.slice(0,3).join(" ") === "workers versions get") {
  const message = uploaded.args[uploaded.args.indexOf("--message") + 1];
  send({id:versionId,number:plan === "version-conflict" ? 2 : 1,annotations:{"workers/message":message},
    bindings:[{name:"SANDBOX_RUNNER_MODE",type:"plain_text",text:"real"},{name:"SANDBOX_RUNNER_TOKEN",type:"secret_text",text:token},
      ...(plan === "missing-guard" ? [] : [{name:"SANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN",type:"secret_text"}]),
      ...(versionMetadata && plan !== "missing-active-metadata" ? [{name:"SANDBOX_RUNNER_VERSION",
        type:plan === "wrong-active-metadata" ? "plain_text" : "version_metadata"}] : []),
      ...(maxConcurrentRuns === undefined ? [] : [{name:"SANDBOX_RUNNER_INSTALLATION_MAX_RUNS",type:"plain_text",
        text:String(plan === "wrong-active-limit" ? maxConcurrentRuns + 1 : maxConcurrentRuns)}])],
    containers:[{name:agent,class_name:"Run"},
      ...(vitest && plan !== "missing-vitest" ? [{name:worker+"-vitest",class_name:"VitestRun"}] : [])],
  });
} else if (args.slice(0,3).join(" ") === "durable-objects namespaces list") {
  if (!uploaded && maxConcurrentRuns !== undefined) {
    send(plan === "existing-namespace" ? [{script:worker,class:"RunIndex",id:indexNamespace,use_sqlite:true}] : [{id:account}]);
  } else send([{script:worker,class:"Run",id:appId,use_sqlite:true},
    ...(vitest ? [{script:worker,class:"VitestRun",id:vitestNamespace,use_sqlite:true}] : []),
    ...(index && plan !== "missing-index" ? [{script:worker,class:"RunIndex",
      id:plan === "duplicate-namespace-id" ? appId : indexNamespace,use_sqlite:true}] : [])]);
} else throw Error("Unexpected cf command");
`.replace("FIXTURE", JSON.stringify({ account, worker, profile, token, versionId, appId, vitestNamespace, indexNamespace, ambient, log,
  plan, vitest, index, dockerConfig, maxConcurrentRuns, versionMetadata, agentName })), { mode: 0o700 });

  async function run(args, env = {}, command = "deploy", directory = project) {
    const result = invoke(["cloudflare", command, directory, ...args], { env: {
      ...process.env, ...Object.fromEntries(ambient.map(name => [name, token])), SANDBOX_RUNNER_CF_BIN: cf,
      CLOUDFLARE_ACCOUNT_ID: appId, SANDBOX_RUNNER_CF_PROFILE: "unrelated", DOCKER_CONFIG: dockerConfig,
      DOCKER_HOST: "unix:///synthetic/docker.sock", DOCKER_CONTEXT: context, ...env,
    } });
    assert.ifError(result.error);
    assert.equal(result.stderr, "");
    assert(!result.stdout.includes(token));
    const calls = existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse) : [];
    assert(calls.every(call => {
      const loginRead = command === "setup" && call.args.join(" ") === "accounts get";
      const sanitized = loginRead ? call.ambient.every(key => buildOnlyOverrides.has(key)) : call.ambient.length === 0;
      return call.account === account && sanitized && !call.dotenv && !call.originalSecrets && !existsSync(call.cwd);
    }));
    assert((await readFile(join(dockerConfig, "config.json"), "utf8")).includes(token));
    return { status: result.status, output: JSON.parse(result.stdout), calls };
  }
  return { run, root, project, sourceSecret };
}

async function fakeNpm(root) {
  const log = join(root, "npm.jsonl");
  const path = root + delimiter + (process.env.PATH ?? "");
  await writeFile(join(root, "npm"), "#!" + process.execPath + "\n" + String.raw`
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { log, ambient, token } = FIXTURE;
const cwd = process.cwd();
appendFileSync(log, JSON.stringify({ cwd, args: process.argv.slice(2),
  manifestPresent: existsSync(join(cwd, "sandbox-runner.project.json")),
  inheritedCredential: ambient.some(key => process.env[key] !== undefined),
}) + "\n");
process.stdout.write(token);
if (existsSync(join(cwd, "fail-npm"))) process.exit(1);
mkdirSync(join(cwd, "pinned-src"), { recursive: true });
mkdirSync(join(cwd, "node_modules"), { recursive: true });
writeFileSync(join(cwd, "daemon.mjs"), "// Prepared by npm fixture\n");
`.replace("FIXTURE", JSON.stringify({ log, ambient, token })), { mode: 0o700 });
  return {
    env: { PATH: path },
    calls: async () => existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse) : [],
  };
}

test("deploy dry-run uses the older project sources without importing new template modules", async t => {
  const { project, run } = await fixture(t, "fresh", { vitest: true, index: true });
  await rm(join(project, "agent-deadline.ts"));
  await rm(join(project, "installation-admission.ts"));
  await writeFile(join(project, "unlisted.ts"), "// Outside the deployment allowlist\n");
  const result = await run(["--dry-run"]);
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.equal(result.output.status, "dry_run");
  assert.deepEqual(result.calls.find(call => call.args[0] === "build").staged, ["worker.ts"]);
  assert(result.calls.some(call => call.args.join(" ") === "deploy --prebuilt --dry-run"));
});

test("deploy dry-run accepts the version metadata emitted by the current project", async t => {
  const { run } = await fixture(t, "fresh", { vitest: true, index: true, versionMetadata: true });
  const result = await run(["--dry-run"]);
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.equal(result.output.status, "dry_run");
  assert(result.calls.some(call => call.args.join(" ") === "deploy --prebuilt --dry-run"));
});

test("a project without the guard cannot declare a concurrency limit in its manifest", async t => {
  const { project, run } = await fixture(t, "fresh", { vitest: true, index: true });
  await rm(join(project, "installation-admission.ts"));
  const manifestPath = join(project, "sandbox-runner.project.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, maxConcurrentRuns: 1 }));
  const result = await run(["--dry-run"]);
  assert.equal(result.status, 3);
  assert.equal(result.output.error, "cloudflare_build_unverified");
  assert(!result.calls.some(call => call.args[0] === "deploy"));
});

test("deploy rejects missing entry points and symlinks in allowlisted project paths before build", async t => {
  for (const file of ["worker.ts", "cloudflare.config.ts", "prepare-sdk.sh", "daemon.mjs"]) {
    const { project, run } = await fixture(t);
    await rm(join(project, file));
    const result = await run(["--dry-run"]);
    assert.equal(result.output.error, "cloudflare_project_unprepared");
    assert(!result.calls.some(call => call.args[0] === "build"));
  }
  for (const file of ["installation-admission.ts", "vitest"]) {
    const { root, project, run } = await fixture(t);
    const outside = join(root, file);
    await rename(join(project, file), outside);
    await symlink(outside, join(project, file));
    const result = await run(["--dry-run"]);
    assert.equal(result.output.error, "cloudflare_project_unprepared");
    assert(!result.calls.some(call => call.args[0] === "build"));
  }
});

test("Cloudflare setup initializes, prepares, verifies and deploys from the same project", async t => {
  const { run, root, sourceSecret } = await fixture(t, "fresh", { vitest: true });
  const npm = await fakeNpm(root);
  const directory = join(root, "worker with spaces");
  const dryRun = await run(["--account", account.toUpperCase(), "--worker", worker, "--profile", profile, "--dry-run"],
    npm.env, "setup", directory);
  assert.equal(dryRun.status, 0, JSON.stringify(dryRun.output));
  assert.equal(dryRun.output.directory, directory);
  assert.equal(dryRun.output.status, "dry_run");
  assert.deepEqual(dryRun.calls.map(call => call.args), [
    ["accounts", "get"], ["accounts", "get"], ["build"], ["deploy", "--prebuilt", "--dry-run"],
  ]);
  const deployed = await run(["--secrets-file", sourceSecret], npm.env, "setup", directory);
  assert.equal(deployed.status, 0, JSON.stringify(deployed.output));
  assert.equal(deployed.output.status, "deployed");
  assert.equal(deployed.output.version.id, versionId);
  assert.equal(deployed.output.applications.length, 2);
  assert.equal(deployed.calls.filter(call => call.args.includes("--secrets-file")).length, 1);
  const cwd = await realpath(directory);
  assert.deepEqual(await npm.calls(), Array.from({ length: 2 }, () => ({
    cwd, args: ["ci", `--prefix=${directory}`, "--workspaces=false", "--include=dev", "--ignore-scripts=false", "--no-audit", "--no-fund"],
    manifestPresent: true, inheritedCredential: false,
  })));
});

test("setup renders the explicit limit, verifies it on deployment and refuses to change an initialized project", async t => {
  const { run, root, sourceSecret } = await fixture(t, "fresh", { vitest:true, index:true, maxConcurrentRuns:2 });
  const npm = await fakeNpm(root);
  const directory = join(root, "guarded");
  const result = await run(["--account", account, "--worker", worker, "--profile", profile, "--max-concurrent-runs", "2",
    "--secrets-file", sourceSecret], npm.env, "setup", directory);
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.equal(result.output.maxConcurrentRuns, 2);
  assert.equal(result.output.runIndexNamespaceId, indexNamespace);
  assert.equal(result.calls.filter(call => call.args.slice(0, 3).join(" ") === "durable-objects namespaces list").length, 2);
  const changed = await run(["--dry-run", "--max-concurrent-runs", "3"], npm.env, "setup", directory);
  assert.equal(changed.output.error, "cloudflare_project_target_mismatch");
  assert.equal((await npm.calls()).length, 1);
});

test("Cloudflare setup retains an initialized project when npm fails and rejects a mismatched target before npm", async t => {
  const { run, root, project } = await fixture(t);
  const npm = await fakeNpm(root);
  await writeFile(join(project, "fail-npm"), "");
  assert.equal((await run(["--dry-run", "--worker", "other"], npm.env, "setup")).output.error,
    "cloudflare_project_target_mismatch");
  const nonexistent = join(root, "new-directory");
  assert.equal((await run([], npm.env, "setup", nonexistent)).output.error, "cloudflare_deploy_secret_invalid");
  assert.equal(existsSync(nonexistent), false);
  assert.deepEqual(await npm.calls(), []);
  const failure = await run(["--dry-run"], npm.env, "setup");
  assert.equal(failure.status, 3);
  assert.equal(failure.output.error, "cloudflare_setup_prepare_failed");
  assert.deepEqual(failure.calls, []);
  assert.equal(existsSync(join(project, "sandbox-runner.project.json")), true);
});

test("Cloudflare setup refuses modified lifecycle inputs and project npm configuration before executing npm", async t => {
  const { run, root, project } = await fixture(t);
  const npm = await fakeNpm(root);
  for (const name of [".npmrc", ".npm-extension", "prepare-sdk.sh", "package.json"]) {
    const path = join(project, name);
    const original = existsSync(path) ? await readFile(path) : undefined;
    await writeFile(path, "modified setup input");
    const result = await run(["--dry-run"], npm.env, "setup");
    assert.equal(result.status, 3);
    assert.equal(result.output.error, "cloudflare_setup_template_mismatch");
    assert.deepEqual(result.calls, []);
    if (original) await writeFile(path, original);
    else await rm(path);
  }
  assert.deepEqual(await npm.calls(), []);
});

test("dry-run builds a fresh isolated project and never forwards secrets or deploys", async t => {
  const { run, sourceSecret } = await fixture(t);
  const result = await run(["--dry-run", "--secrets-file", sourceSecret]);
  assert.equal(result.status, 0);
  assert.equal(result.output.status, "dry_run");
  assert.deepEqual(result.output.applications, [{ name: worker, className: "Run", schedulingPolicy: "durable-object" }]);
  assert.deepEqual(result.calls.map(call => call.args), [["accounts", "get"], ["build"], ["deploy", "--prebuilt", "--dry-run"]]);
  assert.equal(result.calls[1].dockerHost, "unix:///synthetic/docker.sock");
});

test("first deploy checks both application names, preserves Docker context and verifies the active receipt", async t => {
  const { run, sourceSecret } = await fixture(t, "fresh", { vitest: true, index: true, context: "team-docker", versionMetadata: true });
  const result = await run(["--secrets-file", sourceSecret]);
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.equal(result.output.status, "deployed");
  assert.equal(result.output.url, `https://${worker}.test.workers.dev`);
  assert.deepEqual(result.output.version, { id: versionId, number: 1, percentage: 100 });
  assert.equal(result.output.applications.length, 2);
  assert.equal(result.output.applications[1].schedulingPolicy, "default");
  assert.equal(result.output.applications[1].namespaceId, vitestNamespace);
  assert.equal(result.output.runIndexNamespaceId, indexNamespace);
  const upload = result.calls[6];
  assert.deepEqual(result.calls.slice(3, 6).map(call => call.args), [
    ["workers", "list", "--page", "1", "--per-page", "100"],
    ["containers", "applications", "list", "--name", worker],
    ["containers", "applications", "list", "--name", worker + "-vitest"],
  ]);
  assert.deepEqual(upload.args.slice(0, 3), ["deploy", "--prebuilt", "--secrets-file"]);
  assert(upload.privateControl && upload.privateDocker && upload.contextPreserved);
  assert.equal(result.calls[1].dockerContext, "team-docker");
  assert.equal(upload.dockerContext, "team-docker");
  assert.equal(upload.dockerHost, undefined);
  assert.equal(existsSync(upload.dockerConfig), false);
});

for (const [plan, expected] of [
  ["wrong-account", "cloudflare_account_unverified"], ["wrong-worker", "cloudflare_build_unverified"],
  ["fixture", "cloudflare_build_unverified"], ["routes", "cloudflare_build_unverified"], ["wrong-image", "cloudflare_build_unverified"],
  ["index-with-container", "cloudflare_build_unverified"],
  ["metadata-as-text", "cloudflare_build_unverified"], ["metadata-with-value", "cloudflare_build_unverified"],
  ["metadata-wrong-name", "cloudflare_build_unverified"],
  ["dotenv", "cloudflare_deploy_dotenv"], ["missing-dry-run-proof", "cloudflare_dry_run_failed"],
  ["existing-worker", "cloudflare_target_exists"], ["existing-application", "cloudflare_target_exists"],
]) {
  test(`deploy rejects ${plan} before mutation`, async t => {
    const { run, sourceSecret } = await fixture(t, plan, { vitest: true, index: plan === "index-with-container" });
    const result = await run(["--secrets-file", sourceSecret]);
    assert.equal(result.status, 3);
    assert.equal(result.output.error, expected);
    assert(!result.calls.some(call => call.args.includes("--secrets-file")));
    if (plan === "existing-worker") assert(result.calls.some(call => call.args[3] === "2"));
  });
}

for (const plan of ["upload-lost", "version-conflict", "wrong-namespace", "missing-vitest", "missing-index", "duplicate-namespace-id",
  "missing-active-metadata", "wrong-active-metadata"]) {
  test(`deploy reports ${plan} as uncertain after exactly one upload`, async t => {
    const { run, sourceSecret } = await fixture(t, plan, { vitest: plan === "missing-vitest",
      index: plan === "missing-index" || plan === "duplicate-namespace-id", versionMetadata: plan.endsWith("-active-metadata") });
    const result = await run(["--secrets-file", sourceSecret]);
    assert.equal(result.status, 6);
    assert.equal(result.output.error, "cloudflare_deploy_unconfirmed");
    assert.equal(result.output.uncertain, true);
    assert.equal(result.calls.filter(call => call.args.includes("--secrets-file")).length, 1);
  });
}

test("deploy requires an explicit control file and refuses interpolation or extra provider credentials", async t => {
  const { run, sourceSecret } = await fixture(t);
  assert.equal((await run([])).output.error, "cloudflare_deploy_secret_invalid");
  for (const content of ["SANDBOX_RUNNER_TOKEN=$TOKEN", JSON.stringify({ SANDBOX_RUNNER_TOKEN: token, OPENAI_API_KEY: token })]) {
    await writeFile(sourceSecret, content);
    const result = await run(["--secrets-file", sourceSecret]);
    assert.equal(result.output.error, "cloudflare_deploy_secret_invalid");
    assert.deepEqual(result.calls, []);
  }
});

for (const [plan, code, expected, uploads] of [
  ["wrong-build-limit", 3, "cloudflare_build_unverified", 0],
  ["existing-namespace", 3, "cloudflare_target_exists", 0],
  ["wrong-active-limit", 6, "cloudflare_deploy_unconfirmed", 1],
]) {
  test(`guarded deploy handles ${plan} without retrying a mutation`, async t => {
    const { run, sourceSecret } = await fixture(t, plan, { vitest:true, index:true, maxConcurrentRuns:2 });
    const result = await run(["--secrets-file", sourceSecret]);
    assert.equal(result.status, code);
    assert.equal(result.output.error, expected);
    assert.equal(result.calls.filter(call => call.args.includes("--secrets-file")).length, uploads);
  });
}


test("deploy accepts a renamed agent application from the manifest", async t => {
  const { run, sourceSecret } = await fixture(t, "fresh", { vitest: true, index: true, agentName: "example-agent" });
  const result = await run(["--secrets-file", sourceSecret]);
  assert.equal(result.status, 0, JSON.stringify(result.output));
  assert.equal(result.output.status, "deployed");
  assert.deepEqual(result.output.applications.map(app => app.name), ["example-agent", worker + "-vitest"]);
});

test("deploy refuses installation settings with a template that predates them", async t => {
  const { project, run } = await fixture(t, "fresh", { vitest: true, index: true, agentName: "example-agent" });
  await writeFile(join(project, "cloudflare.config.ts"), "// Worker config rewritten by an earlier init\n");
  const result = await run(["--dry-run"]);
  assert.equal(result.output.error, "cloudflare_project_outdated");
  assert(!result.calls.some(call => call.args[0] === "build"));
});

test("deploy reports invalid installation settings before building", async t => {
  const { project, run } = await fixture(t, "fresh", { vitest: true, index: true });
  const manifestPath = join(project, "sandbox-runner.project.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, settings: { SANDBOX_RUNNER_OPENCODE: "yes" } }));
  const result = await run(["--dry-run"]);
  assert.equal(result.output.error, "cloudflare_project_invalid");
  assert.equal(result.calls.length, 0);
});

test("deploy refuses a setting exported in the environment instead of recorded in the manifest", async t => {
  const { run } = await fixture(t, "fresh", { vitest: true, index: true });
  const result = await run(["--dry-run"], { SANDBOX_RUNNER_VITEST_TIMEOUT_MS: "900000" });
  assert.equal(result.output.error, "cloudflare_setting_in_environment");
  assert.match(result.output.message, /SANDBOX_RUNNER_VITEST_TIMEOUT_MS/);
  assert.equal(result.calls.length, 0);
});


test("the first deployment requires a distinct guard token and verifies it on the new version", async t => {
  const { run, project, sourceSecret } = await fixture(t, "fresh", { vitest: true, index: true });
  for (const content of [`SANDBOX_RUNNER_TOKEN=${token}\n`, `SANDBOX_RUNNER_TOKEN=${token}\nSANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN=${token}\n`,
    `SANDBOX_RUNNER_TOKEN=${token}\nSANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN=guard-short\n`]) {
    const file = join(project, "partial.env");
    await writeFile(file, content, { mode: 0o600 });
    const result = await run(["--secrets-file", file]);
    assert.equal(result.output.error, "cloudflare_deploy_secret_invalid");
    assert(!result.calls.some(call => call.args[0] === "deploy"));
  }
  const missing = await fixture(t, "missing-guard", { vitest: true, index: true });
  const result = await missing.run(["--secrets-file", missing.sourceSecret]);
  assert.equal(result.output.error, "cloudflare_deploy_unconfirmed");
  assert.equal(result.output.uncertain, true);
  assert.ok(sourceSecret);
});
