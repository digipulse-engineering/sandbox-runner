import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNpmLockfile } from "../vitest/lockfile.ts";

const parseVitestLockfile = text => parseNpmLockfile(text, true);

const registry = "https://registry.npmjs.org";
const integrity = "sha512-" + "a".repeat(86) + "==";
const vitest = { version: "5.1.0", resolved: registry + "/vitest/-/vitest-5.1.0.tgz", integrity };
const scoped = { version: "5.1.0", resolved: registry + "/@vitest/expect/-/expect-5.1.0.tgz", integrity };
const lockfile = (packages = {}, version = 3) => JSON.stringify({
  lockfileVersion: version,
  packages: { "": { devDependencies: { vitest: vitest.version } }, "node_modules/vitest": vitest, ...packages },
});

test("derives exact tarball URLs, bundled dependencies and confined workspace paths", () => {
  for (const version of [2, 3]) {
    assert.deepEqual(parseVitestLockfile(lockfile({
      "node_modules/@vitest/expect": scoped,
      "node_modules/vitest/node_modules/bundled": { version: "1.0.0", inBundle: true },
      "node_modules/workspace": { resolved: "packages/example", link: true },
      "packages/example": { version: "1.0.0" },
      "packages/example/node_modules/@vitest/expect": scoped,
    }, version)), { tarballs: [vitest.resolved, scoped.resolved], workspaces: ["packages/example"], vitestVersion: "5.1.0" });
  }
});

test("refuses unresolved, external, mutable or path-escaping dependencies", () => {
  for (const pkg of [
    { ...scoped, resolved: "https://example.invalid/expect.tgz" },
    { ...scoped, resolved: scoped.resolved + "?redirect=1" },
    { ...scoped, resolved: scoped.resolved.replace("https://", "http://") },
    { ...scoped, resolved: scoped.resolved.replace("https://", "https://fake@") },
    { ...scoped, resolved: "git+https://github.com/owner/repo.git#sha" },
    { ...scoped, resolved: "file:../outside" },
    { ...scoped, resolved: undefined },
    { ...scoped, integrity: "sha1-abcd" },
    { ...scoped, integrity: undefined },
    { resolved: "../outside", link: true },
    { resolved: "packages/unknown", link: true },
  ]) assert.equal(parseVitestLockfile(lockfile({ "node_modules/package": pkg })), undefined);
  assert.equal(parseVitestLockfile(lockfile({ "/outside": {} })), undefined);
  assert.equal(parseVitestLockfile(lockfile({ "node_modules/pkg/../../outside": {} })), undefined);
});

test("requires a supported lockfile and a registry-pinned project Vitest", () => {
  for (const candidate of ["{", "[]", "null", lockfile({}, 1), lockfile({ "node_modules/vitest": null }),
    lockfile({ "node_modules/vitest": { ...vitest, version: "latest" } }),
    lockfile({ "node_modules/vitest": { ...vitest, version: "5.1.0\n" } }),
  ]) assert.equal(parseVitestLockfile(candidate), undefined);
});

test("command suites permit dependency-free npm locks and apply the same tarball constraints", () => {
  const empty = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "fixture" } } });
  assert.deepEqual(parseNpmLockfile(empty, false), { tarballs: [], workspaces: [] });
  assert.equal(parseVitestLockfile(empty), undefined);
  assert.deepEqual(parseNpmLockfile(lockfile(), false), { tarballs: [vitest.resolved], workspaces: [] });
  assert.equal(parseNpmLockfile(lockfile({ "node_modules/package": { ...scoped, resolved: "file:../outside" } }), false), undefined);
});
