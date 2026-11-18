import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePnpmLockfile } from "../vitest/pnpm-lockfile.mjs";

const hash = `sha512-${"A".repeat(86)}==`;
const packageId = "@fixture/tool@1.2.3";
const key = `${packageId}(peer@2.0.0)`;
const base = {
  lockfileVersion: "9.0",
  importers: {
    ".": { devDependencies: { "@fixture/tool": { specifier: "1.2.3", version: "1.2.3(peer@2.0.0)" } } },
    "packages/a": { dependencies: { b: { specifier: "workspace:*", version: "link:../b" } } },
    "packages/b": {},
  },
  packages: {
    [packageId]: { resolution: { integrity: hash } },
    "peer@2.0.0": { resolution: { integrity: hash } },
  },
  snapshots: { [key]: { dependencies: { peer: "2.0.0" } }, "peer@2.0.0": {} },
};

test("projects the admitted pnpm workspace and exact registry tarballs", () => {
  assert.deepEqual(parsePnpmLockfile(base), {
    workspaces: ["packages/a", "packages/b"],
    tarballs: ["https://registry.npmjs.org/@fixture/tool/-/tool-1.2.3.tgz", "https://registry.npmjs.org/peer/-/peer-2.0.0.tgz"],
  });
  assert.deepEqual(parsePnpmLockfile({ lockfileVersion: "9.0", importers: { ".": {} } }), { workspaces: [], tarballs: [] });
});

test("rejects mutable registry sources and lockfile metadata that could reinterpret an admitted package", () => {
  for (const mutate of [
    lock => lock.patches = { package: "file.patch" },
    lock => lock.configDependencies = { dangerous: "1.0.0" },
    lock => lock.packages[packageId].resolution = { integrity: "sha1-example" },
    lock => lock.packages[packageId].resolution.tarball = "https://registry.npmjs.org/other/-/other.tgz",
    lock => lock.packages[packageId].resolution.commit = "123",
    lock => lock.snapshots[key].resolution = { integrity: hash, tarball: "file:/tmp/fixture.tgz" },
    lock => lock.snapshots[key].dependencies.peer = "file:/tmp/fixture.tgz",
    lock => lock.snapshots["@fixture/tool@1.2.3(peer@2.0.0(/../../outside))"] = {},
    lock => lock.snapshots["@fixture/tool@1.2.3(peer@2.0.0)("] = {},
    lock => lock.snapshots["unknown@1.0.0"] = {},
    lock => delete lock.packages["peer@2.0.0"],
  ]) {
    const lock = structuredClone(base);
    mutate(lock);
    assert.equal(parsePnpmLockfile(lock), undefined);
  }
});

test("accepts only dependency links that resolve to another declared workspace", () => {
  for (const version of ["link:../../../outside", "link:/packages/b", "link:../missing", "link:..\\b", "link:../a"]) {
    const lock = structuredClone(base);
    lock.importers["packages/a"].dependencies.b.version = version;
    assert.equal(parsePnpmLockfile(lock), undefined);
  }
  const lock = structuredClone(base);
  lock.importers["/packages/b"] = {};
  assert.equal(parsePnpmLockfile(lock), undefined);
});
