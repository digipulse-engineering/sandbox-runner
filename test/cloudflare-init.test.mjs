import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import release from "../package.json" with { type: "json" };

const bin = fileURLToPath(new URL("../bin/sandbox-runner.mjs", import.meta.url));
const account = "0123456789abcdef0123456789abcdef";
const worker = "example-sandbox-runner";
const profile = "named-profile";
const secret = "synthetic-init-secret-must-not-appear";
const sdkCommit = "1a450e71325c25ca1ec8b0013d756fe0c733b6f3";

function run(args, env = {}, executable = bin) {
  const result = spawnSync(process.execPath, [executable, "cloudflare", "init", ...args], {
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "", SANDBOX_RUNNER_WORKER: "", SANDBOX_RUNNER_CF_PROFILE: "",
      SANDBOX_RUNNER_CF_BIN: "must-not-execute-cf", SANDBOX_RUNNER_FIXTURES: "1", SANDBOX_RUNNER_TOKEN: secret,
      ANTHROPIC_API_KEY: secret, OPENAI_API_KEY: secret, ...env },
  });
  assert.ifError(result.error);
  assert.equal(result.stderr, "");
  assert(!result.stdout.includes(secret));
  return { code: result.status, output: JSON.parse(result.stdout) };
}

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-runner-init-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("init writes the allowlisted standalone template and versioned manifest in a new path", async t => {
  const directory = join(await scratch(t), "Worker with spaces");
  const { code, output } = run([directory, "--account", account.toUpperCase(), "--worker", worker, "--profile", profile]);
  assert.equal(code, 0);
  const manifest = "sandbox-runner.project.json";
  const project = { schemaVersion: 1, cliVersion: release.version, sdkCommit, templateDigest: output.templateDigest, account, worker, profile };
  assert.match(output.templateDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(output, { status: "initialized", directory, manifest, ...project });
  assert.deepEqual(JSON.parse(await readFile(join(directory, manifest), "utf8")), project);
  const included = release.files.filter(path => path.startsWith("worker/")).map(path => path.slice("worker/".length));
  const generated = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1));
  assert.deepEqual(generated.sort(), [...included, manifest].sort());
  for (const path of included) {
    const copy = await readFile(join(directory, path));
    assert(!copy.includes(secret));
    // Installations share the template byte for byte; their settings live in the manifest.
    assert.deepEqual(copy, await readFile(new URL("../worker/" + path, import.meta.url)));
  }
  assert.match(await readFile(join(directory, "vitest", "Dockerfile"), "utf8"), /vitest\/container\.mjs/);
});

test("init respects environment target defaults and omits an unselected profile", async t => {
  const directory = join(await scratch(t), "worker");
  const { code, output } = run([directory], {
    CLOUDFLARE_ACCOUNT_ID: account, SANDBOX_RUNNER_WORKER: worker, SANDBOX_RUNNER_CF_PROFILE: undefined,
  });
  assert.equal(code, 0);
  assert.equal(output.worker, worker);
  assert.equal(Object.hasOwn(output, "profile"), false);
});

test("init renders an explicit installation limit without inheriting ambient values", async t => {
  const directory = join(await scratch(t), "guarded");
  const args = [directory, "--account", account, "--worker", worker, "--profile", profile];
  for (const value of ["0", "01", "1\n", "1.5", "9007199254740992"]) {
    assert.equal(run([...args, "--max-concurrent-runs", value]).code, 2);
  }
  assert.equal(existsSync(directory), false);
  const { code, output } = run([...args, "--max-concurrent-runs", "3"], { SANDBOX_RUNNER_INSTALLATION_MAX_RUNS: "9" });
  assert.equal(code, 0);
  assert.equal(output.maxConcurrentRuns, 3);
  assert.equal(JSON.parse(await readFile(join(directory, output.manifest))).maxConcurrentRuns, 3);
  assert.deepEqual(await readFile(join(directory, "cloudflare.config.ts")),
    await readFile(new URL("../worker/cloudflare.config.ts", import.meta.url)));
});

test("init restores the Git ignore file after the npm installer renames it", async t => {
  const directory = await scratch(t);
  const installed = join(directory, "installed");
  await mkdir(installed);
  await cp(new URL("../bin", import.meta.url), join(installed, "bin"), { recursive: true });
  await cp(new URL("../package.json", import.meta.url), join(installed, "package.json"));
  for (const source of release.files.filter(path => path.startsWith("worker/"))) {
    const target = join(installed, source === "worker/.gitignore" ? "worker/.npmignore" : source);
    await mkdir(dirname(target), { recursive: true });
    await cp(new URL("../" + source, import.meta.url), target);
  }
  const generated = join(directory, "generated");
  const { code } = run([generated, "--account", account, "--worker", worker, "--profile", profile], {},
    join(installed, "bin", "sandbox-runner.mjs"));
  assert.equal(code, 0);
  assert.deepEqual(await readFile(join(generated, ".gitignore")), await readFile(new URL("../worker/.gitignore", import.meta.url)));
  assert.equal(existsSync(join(generated, ".npmignore")), false);
});

test("init rejects an existing directory and symlink without changing either destination", async t => {
  const base = await scratch(t);
  const directory = join(base, "existing");
  const link = join(base, "link");
  await mkdir(directory);
  await writeFile(join(directory, "keep"), "preserved");
  await symlink(directory, link);
  for (const path of [directory, link]) {
    const { code, output } = run([path, "--account", account, "--worker", worker, "--profile", profile]);
    assert.equal(code, 3);
    assert.equal(output.error, "project_directory_exists");
  }
  assert.deepEqual(await readdir(directory), ["keep"]);
  assert.equal(await readFile(join(link, "keep"), "utf8"), "preserved");
});

test("init rejects an invalid target or duplicate flag before creating a directory", async t => {
  const directory = join(await scratch(t), "invalid");
  assert.equal(run([directory, "--account", account, "--worker", "Uppercase", "--profile", profile]).code, 3);
  assert.equal(run([directory, "--account", account, "--worker", worker, "--worker", worker]).code, 2);
  assert.equal(existsSync(directory), false);
});
