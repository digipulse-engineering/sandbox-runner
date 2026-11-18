import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRelease } from "../scripts/release-check.mjs";

const script = fileURLToPath(new URL("../scripts/release-check.mjs", import.meta.url));
const lock = version => ({ name: "sandbox-runner-cli", version, packages: { "": { name: "sandbox-runner-cli", version } } });
const release = (version, changes = {}) => ({
  tag: `v${version}`, packageJson: { name: "sandbox-runner-cli", version }, packageLock: lock(version),
  changelog: `# Changelog\n\n## Unreleased\n\n## ${version} - 2026-11-18\n\n- Change.\n`, ...changes,
});

test("a stable version is staged under latest and a prerelease under next", () => {
  assert.deepEqual(checkRelease(release("0.1.0")), { version: "0.1.0", distTag: "latest" });
  assert.deepEqual(checkRelease(release("0.2.0-beta.1")), { version: "0.2.0-beta.1", distTag: "next" });
  assert.deepEqual(checkRelease(release("1.0.0", { changelog: "## 1.0.0\n" })), { version: "1.0.0", distTag: "latest" });
});

test("refuses a tag, lockfile or changelog that does not match the version", () => {
  for (const [input, message] of [
    [release("0.1.0", { tag: "0.1.0" }), /expected v0\.1\.0/],
    [release("0.1.0", { tag: "v0.1.1" }), /does not match/],
    [release("0.1.0", { packageLock: lock("0.0.9") }), /package-lock\.json/],
    [release("0.1.0", { packageLock: { ...lock("0.1.0"), packages: { "": { version: "0.0.9" } } } }), /package-lock\.json/],
    [release("0.1.0", { changelog: "## Unreleased\n\n- Change.\n" }), /CHANGELOG/],
    [release("0.1.0", { changelog: "## 0.1.0-beta.1\n## 0.1.01\n### 0.1.0\n" }), /CHANGELOG/],
    [release("0.1.0", { changelog: "## 0x1x0\n" }), /CHANGELOG/],
  ]) assert.throws(() => checkRelease(input), message);
  for (const version of ["01.0.0", "1.0", "1.0.0+build.5", "1.0.0-", "v1.0.0", undefined]) {
    assert.throws(() => checkRelease({ ...release("1.0.0"), packageJson: { version } }), /semantic version/);
  }
});

test("the command writes the workflow outputs and fails with a workflow error annotation", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-check-"));
  try {
    const { packageJson, packageLock, changelog } = release("0.2.0-rc.1");
    writeFileSync(join(directory, "package.json"), JSON.stringify(packageJson));
    writeFileSync(join(directory, "package-lock.json"), JSON.stringify(packageLock));
    writeFileSync(join(directory, "CHANGELOG.md"), changelog);
    const output = join(directory, "github-output");
    writeFileSync(output, "");
    const run = tag => spawnSync(process.execPath, [script, tag], {
      cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output },
    });
    const passed = run("v0.2.0-rc.1");
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(readFileSync(output, "utf8"), "version=0.2.0-rc.1\ndist-tag=next\n");
    const failed = run("v0.2.0");
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /^::error::Tag v0\.2\.0 does not match/m);
    assert.equal(readFileSync(output, "utf8"), "version=0.2.0-rc.1\ndist-tag=next\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
