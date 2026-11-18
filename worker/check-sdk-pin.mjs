#!/usr/bin/env node
/**
 * Maintainer check: what changed in the Agents SDK since the ContainerHarness pin in prepare-sdk.sh?
 *
 * It computes the SDK files this Worker and its container daemon actually use (the import closure from our
 * `pinned-src/` imports and the daemon entry point), then asks GitHub which upstream files changed between the pin
 * and the target ref. Exit code 0: no used file changed. Exit code 1: a used file changed, so bump the pin, prepare
 * again (npm ci), test, release, then upgrade installations. Exit code 2: the check could not run.
 *
 * Usage: node worker/check-sdk-pin.mjs [--ref <branch|tag|sha>]   (GH_TOKEN or GITHUB_TOKEN raises the rate limit)
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "cloudflare/agents";
const sourceRoot = "packages/agents/src";
// prepare-sdk.sh bundles the upstream container daemon from this entry point.
const daemonEntry = "harness/container/runtime/main.ts";
// Written by prepare-sdk.sh into pinned-src, not part of upstream.
const generated = new Set(["harness/container/daemon-source.generated.ts"]);

export function pinnedCommit(prepareScript) {
  const pin = prepareScript.match(/^pin=([a-f0-9]{40})$/m)?.[1];
  if (!pin) throw new Error("prepare-sdk.sh has no pin=<40 hex> line.");
  return pin;
}

const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** Relative import specifiers of a TypeScript source, including type-only and dynamic imports. */
export function importSpecifiers(source) {
  return [...source.matchAll(importPattern)].map(match => match[1]).filter(specifier => specifier.startsWith("."));
}

/** Resolves a relative specifier the way the bundler does, against the set of known source paths. */
export function resolveImport(from, specifier, files) {
  const base = normalize(join(dirname(from), specifier)).replaceAll("\\", "/");
  const stem = base.replace(/\.(?:js|mjs|ts|tsx)$/, "");
  for (const candidate of [base, stem + ".ts", stem + ".tsx", stem + ".mjs", stem + "/index.ts", stem + "/index.tsx"]) {
    if (files.has(candidate)) return candidate;
  }
}

/**
 * The SDK files reached from `entries` (paths relative to the SDK source root) through relative imports.
 * `read(path)` returns a file's text; `files` lists every path in the pinned source.
 */
export async function importClosure(entries, files, read) {
  const used = new Set();
  const pending = [...entries];
  while (pending.length > 0) {
    const path = pending.pop();
    if (used.has(path)) continue;
    used.add(path);
    for (const specifier of importSpecifiers(await read(path))) {
      const target = resolveImport(path, specifier, files);
      if (target !== undefined && !used.has(target)) pending.push(target);
    }
  }
  for (const path of generated) used.delete(path);
  return used;
}

async function listFiles(root, directory = root, found = new Set()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await listFiles(root, path, found);
    else if (/\.(?:ts|tsx|mjs|js)$/.test(entry.name)) found.add(relative(root, path).replaceAll("\\", "/"));
  }
  return found;
}

/** Entry points: what the Worker and our daemon modules import from pinned-src, plus the bundled upstream daemon. */
export async function entryPoints(workerDirectory, files) {
  const entries = new Set([daemonEntry]);
  for (const entry of await readdir(workerDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:ts|mjs)$/.test(entry.name)) continue;
    const source = await readFile(join(workerDirectory, entry.name), "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith("./pinned-src/")) continue;
      const target = resolveImport("", specifier.slice("./pinned-src/".length), files);
      if (target === undefined) throw new Error(`${entry.name} imports ${specifier}, which the pinned source does not contain.`);
      entries.add(target);
    }
  }
  return [...entries];
}

function github(fetchImpl, token) {
  return async path => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "sandbox-runner-sdk-pin-check",
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}.`);
    return response.json();
  };
}

/** Compares the pin with `ref` upstream and classifies the changed SDK files. */
export async function checkPin({ pin, ref, used, fetchImpl = fetch, token }) {
  const api = github(fetchImpl, token);
  const comparison = await api(`compare/${pin}...${encodeURIComponent(ref)}`);
  if (comparison.status === "behind" || comparison.status === "diverged") {
    throw new Error(`The pin is not an ancestor of ${ref} (${comparison.status}).`);
  }
  const files = comparison.files ?? [];
  // GitHub truncates comparisons at 300 files; a truncated list cannot prove that no used file changed.
  const truncated = files.length >= 300 || (comparison.commits?.length ?? 0) < comparison.ahead_by;
  const prefix = sourceRoot + "/";
  const changed = files.filter(file => file.filename.startsWith(prefix) ||
    (file.previous_filename ?? "").startsWith(prefix));
  const relativeName = name => name.slice(prefix.length);
  const usedChanges = changed.filter(file => used.has(relativeName(file.filename)) ||
    (file.previous_filename && used.has(relativeName(file.previous_filename))))
    .map(file => ({ file: relativeName(file.filename), status: file.status, additions: file.additions, deletions: file.deletions }));
  const harnessChanges = changed.map(file => relativeName(file.filename))
    .filter(name => name.startsWith("harness/") && !usedChanges.some(change => change.file === name));
  const commits = (comparison.commits ?? []).map(commit => ({ sha: commit.sha.slice(0, 12),
    date: commit.commit?.committer?.date?.slice(0, 10), title: commit.commit?.message?.split("\n")[0] }));
  return {
    pin, ref, upstream: comparison.commits?.at(-1)?.sha ?? pin, aheadBy: comparison.ahead_by,
    usedFiles: used.size, usedChanges, otherHarnessChanges: harnessChanges, commits, truncated,
    upToDate: usedChanges.length === 0 && !truncated,
  };
}

function options(args) {
  let ref = "main";
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--ref" && args[index + 1]) ref = args[++index];
    else throw new Error("Usage: node worker/check-sdk-pin.mjs [--ref <branch|tag|sha>]");
  }
  return { ref };
}

async function main() {
  const workerDirectory = dirname(fileURLToPath(import.meta.url));
  const { ref } = options(process.argv.slice(2));
  const pin = pinnedCommit(await readFile(join(workerDirectory, "prepare-sdk.sh"), "utf8"));
  const pinned = join(workerDirectory, "pinned-src");
  let files;
  try {
    files = await listFiles(pinned);
  } catch {
    throw new Error("worker/pinned-src is missing: run npm ci in worker/ first.");
  }
  const used = await importClosure(await entryPoints(workerDirectory, files), files,
    path => readFile(join(pinned, path), "utf8"));
  const result = await checkPin({ pin, ref, used, token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN });
  console.log(JSON.stringify(result, null, 2));
  return result.upToDate ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(JSON.stringify({ error: "sdk_pin_check_failed", message: error.message }));
    process.exitCode = 2;
  });
}
