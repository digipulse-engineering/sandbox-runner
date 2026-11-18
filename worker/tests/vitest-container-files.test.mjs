import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkedLockfile, checkedVitest, checkWorkspaceLinks } from "../vitest/container-files.mjs";

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "sandbox-runner-vitest-files-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return realpathSync(path);
}

function checkout(t) {
  const workspace = directory(t);
  const git = (...args) => execFileSync("/usr/bin/git", args, { cwd: workspace, stdio: ["ignore", "pipe", "ignore"], env: {
    PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  } });
  const text = '{"lockfileVersion":3,"packages":{"":{}}}\n';
  writeFileSync(join(workspace, "package.json"), '{"name":"fixture"}\n');
  writeFileSync(join(workspace, "package-lock.json"), text);
  git("init", "--initial-branch=main", "--object-format=sha1");
  git("add", "package.json", "package-lock.json");
  git("commit", "-m", "Fixture");
  return { workspace, text, git, sha: git("rev-parse", "HEAD").toString().trim() };
}

test("checks the working lock bytes against the requested Git commit", t => {
  const { workspace, sha, text, git } = checkout(t);
  assert.deepEqual(checkedLockfile(workspace, sha, 4096), {
    text, sha256: createHash("sha256").update(text).digest("hex"),
  });
  assert.throws(() => checkedLockfile(workspace, "0".repeat(40), 4096), /HEAD/);
  assert.throws(() => checkedLockfile(workspace, sha, 1), /configured limit/);
  writeFileSync(join(workspace, "package-lock.json"), text + "\n");
  assert.throws(() => checkedLockfile(workspace, sha, 4096));
  git("checkout", "--", "package-lock.json");
  writeFileSync(join(workspace, "npm-shrinkwrap.json"), "{}\n");
  assert.throws(() => checkedLockfile(workspace, sha, 4096), /takes precedence/);
});

test("requires a workspace manifest within the checkout and rejects external symlinks", t => {
  const workspace = directory(t);
  const external = directory(t);
  mkdirSync(join(workspace, "packages", "normal"), { recursive: true });
  writeFileSync(join(workspace, "packages", "normal", "package.json"), "{}");
  writeFileSync(join(external, "package.json"), "{}");
  symlinkSync(external, join(workspace, "packages", "external"));
  checkWorkspaceLinks(workspace, ["packages/normal"]);
  assert.throws(() => checkWorkspaceLinks(workspace, ["packages/external"]), /leaves the checkout/);
});

test("resolves only the installed locked Vitest executable inside its package", t => {
  const workspace = directory(t);
  const packageRoot = join(workspace, "node_modules", "vitest");
  const entrypoint = join(packageRoot, "vitest.mjs");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "vitest", version: "5.1.0", bin: { vitest: "./vitest.mjs" } }));
  writeFileSync(entrypoint, "");
  assert.equal(checkedVitest(workspace, "5.1.0"), entrypoint);
  assert.throws(() => checkedVitest(workspace, "5.0.0"), /locked version/);
  rmSync(entrypoint);
  symlinkSync("../../outside.mjs", entrypoint);
  writeFileSync(join(workspace, "outside.mjs"), "");
  assert.throws(() => checkedVitest(workspace, "5.1.0"), /leaves the checkout/);
});

test("recognizes a committed pnpm lock only for command suites and preserves npm precedence", t => {
  const { workspace, git } = checkout(t);
  const pnpm = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";
  writeFileSync(join(workspace, "pnpm-lock.yaml"), pnpm);
  writeFileSync(join(workspace, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(workspace, "package.json"), '{"name":"fixture","packageManager":"pnpm@10.11.1"}\n');
  git("add", ".");
  git("commit", "-m", "Both lockfiles");
  const both = git("rev-parse", "HEAD").toString().trim();
  assert.equal(checkedLockfile(workspace, both, 4096, true).packageManager, undefined);
  git("rm", "package-lock.json");
  git("commit", "-m", "pnpm only");
  const sha = git("rev-parse", "HEAD").toString().trim();
  assert.throws(() => checkedLockfile(workspace, sha, 4096));
  assert.deepEqual(checkedLockfile(workspace, sha, 4096, true), {
    packageManager: "pnpm", text: pnpm, sha256: createHash("sha256").update(pnpm).digest("hex"),
  });
  writeFileSync(join(workspace, "pnpm-workspace.yaml"), "packages: [outside]\n");
  assert.throws(() => checkedLockfile(workspace, sha, 4096, true));
});
