import { posix } from "node:path";

export const runnerPnpmVersion = "10.34.8";

const registry = "https://registry.npmjs.org/";
const integrity = /^sha512-[A-Za-z0-9+/]{86}==$/;
const packagePart = "[a-z0-9_~][a-z0-9_~.-]*";
const packageName = new RegExp(`^(?:@${packagePart}/)?${packagePart}$`);
const packageKey = new RegExp(`^((?:@${packagePart}/)?(${packagePart}))@([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)(?:\\+[0-9A-Za-z.-]+)?$`);
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies"];
const prototypeKeys = new Set(["__proto__", "constructor", "prototype"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return record(value) && Object.keys(value).every(key => allowed.includes(key));
}

function workspacePath(value) {
  return typeof value === "string" && value.split("/").every(part => /^[A-Za-z0-9_~][A-Za-z0-9_~.-]*$/.test(part) && part !== "node_modules");
}

function workspaceLink(importers, importer, value) {
  const path = value.slice("link:".length);
  if (!path || posix.isAbsolute(path) || /[\\:\p{Cc}]/u.test(path)) return false;
  const target = posix.normalize(posix.join(importer, path));
  return target !== importer && workspacePath(target) && Object.hasOwn(importers, target);
}

function snapshotKey(key, packages) {
  const peer = key.indexOf("(");
  const base = peer === -1 ? key : key.slice(0, peer);
  if (!Object.hasOwn(packages, base)) return false;
  if (peer === -1) return true;
  const suffix = key.slice(peer);
  if (!/^(?:\([A-Za-z0-9_~.@()+/\-]+\))$/.test(suffix) || /(?:^|[/(])\.{1,2}(?:[)/]|$)/.test(suffix)) return false;
  let depth = 0;
  for (const char of suffix) {
    if (char === "(") depth++;
    else if (char === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

function validDependencies(section, snapshots, importer) {
  return dependencyFields.every(field => {
    const entries = section[field];
    if (entries === undefined) return true;
    return record(entries) && Object.entries(entries).every(([name, entry]) => {
      if (!packageName.test(name)) return false;
      if (importer && (!onlyKeys(entry, ["specifier", "version"]) || typeof entry.specifier !== "string" ||
          !/^(?:workspace:|npm:|[~^*<>=0-9A-Za-z])/.test(entry.specifier) || /^(?:https?|git(?:hub|lab)?|file|link|ssh|bitbucket):/i.test(entry.specifier))) return false;
      const version = importer ? entry.version : entry;
      if (typeof version !== "string") return false;
      if (version.startsWith("link:")) return importer && workspaceLink(importer.importers, importer.path, version);
      return Object.hasOwn(snapshots, `${name}@${version}`) || Object.hasOwn(snapshots, version);
    });
  });
}

/** Parse the registry-only subset of pnpm 10's version-9 lockfile. */
export function parsePnpmLockfile(lockfile) {
  if (!onlyKeys(lockfile, ["lockfileVersion", "settings", "overrides", "importers", "packages", "snapshots"]) ||
      lockfile.lockfileVersion !== "9.0") return;
  const { importers, packages = {}, snapshots = {} } = lockfile;
  if (!record(importers) || !Object.hasOwn(importers, ".") || !record(packages) || !record(snapshots)) return;
  const tarballs = new Set();
  for (const [key, entry] of Object.entries(packages)) {
    const match = packageKey.exec(key);
    if (!match || !onlyKeys(entry, ["resolution", "engines", "cpu", "os", "libc", "hasBin", "peerDependencies", "peerDependenciesMeta", "deprecated"])
        || !onlyKeys(entry.resolution, ["integrity"]) || typeof entry.resolution.integrity !== "string"
        || !integrity.test(entry.resolution.integrity)) return;
    const [, name, basename, version] = match;
    tarballs.add(`${registry}${name}/-/${basename}-${version}.tgz`);
  }
  for (const [key, entry] of Object.entries(snapshots)) {
    if (!snapshotKey(key, packages) || !onlyKeys(entry, [...dependencyFields, "optional", "transitivePeerDependencies"]) ||
        !validDependencies(entry, snapshots)) return;
  }
  for (const [path, entry] of Object.entries(importers)) {
    if ((path !== "." && !workspacePath(path)) || !onlyKeys(entry, dependencyFields) ||
        !validDependencies(entry, snapshots, { importers, path })) return;
  }
  return { tarballs: [...tarballs], workspaces: Object.keys(importers).filter(path => path !== ".") };
}

/** The caller supplies the parser pinned in the trusted test image. */
export function decodePnpmYaml(text, { parseDocument, visit }) {
  const doc = parseDocument(text, { strict: true, uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new Error("Invalid pnpm YAML");
  visit(doc, {
    Alias() { throw new Error("YAML aliases are not supported"); },
    Node(_key, value) { if (value.tag) throw new Error("Explicit YAML tags are not supported"); },
    Pair(_key, value) {
      if (typeof value.key?.value !== "string" || prototypeKeys.has(value.key.value)) throw new Error("Unsupported YAML key");
    },
  });
  return doc.toJS({ maxAliasCount: 0 });
}
