import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const gitEnv = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" };
const objectId = /^[a-f0-9]{40}$/;

function rejectShrinkwrap(workspace) {
  try {
    lstatSync(join(workspace, "npm-shrinkwrap.json"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("npm shrinkwrap takes precedence over package-lock.json");
}

function openRegular(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (fstatSync(fd).isFile()) return fd;
  closeSync(fd);
  throw new Error("Expected a regular checkout file");
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function checkedFile(workspace, name, sha, maxBytes, git) {
  const fd = openRegular(join(workspace, name));
  try {
    if (fstatSync(fd).size > maxBytes) throw new Error("Checkout metadata exceeds the configured limit");
    const contents = readFileSync(fd);
    if (contents.length > maxBytes || !contents.equals(git(["show", `${sha}:${name}`]))) {
      throw new Error("Checkout metadata differs from the admitted checkout");
    }
    return contents;
  } finally {
    closeSync(fd);
  }
}

export function checkedLockfile(workspace, sha, maxBytes, allowPnpm = false) {
  if (!objectId.test(sha) || sha.trim() !== sha || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid checkout pin");
  const git = (args, maxBuffer = maxBytes) => execFileSync("/usr/bin/git", args, {
    cwd: workspace, env: gitEnv, maxBuffer, stdio: ["ignore", "pipe", "ignore"],
  });
  if (git(["rev-parse", "--verify", "HEAD"], 128).toString().trim() !== sha) throw new Error("Checkout HEAD does not match");
  git(["diff", "--quiet", "--no-ext-diff", "--no-textconv", sha, "--"]);
  git(["cat-file", "-e", `${sha}:package.json`], 128);
  rejectShrinkwrap(workspace);
  closeSync(openRegular(join(workspace, "package.json")));
  const pnpm = allowPnpm && !exists(join(workspace, "package-lock.json")) && exists(join(workspace, "pnpm-lock.yaml"));
  if (pnpm) {
    const manifest = JSON.parse(checkedFile(workspace, "package.json", sha, maxBytes, git));
    if (typeof manifest.packageManager !== "string" || !/^pnpm@10\.\d+\.\d+(?:\+sha512\.[a-f0-9]{128})?$/.test(manifest.packageManager)) {
      throw new Error("Expected an exact pnpm 10 project version");
    }
    if (exists(join(workspace, "pnpm-workspace.yaml"))) checkedFile(workspace, "pnpm-workspace.yaml", sha, maxBytes, git);
  }
  const contents = checkedFile(workspace, pnpm ? "pnpm-lock.yaml" : "package-lock.json", sha, maxBytes, git);
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(contents), sha256: createHash("sha256").update(contents).digest("hex"),
    ...(pnpm ? { packageManager: "pnpm" } : {}) };
}

function containedPath(root, target) {
  const resolved = realpathSync(target);
  const difference = relative(root, resolved);
  if (!difference || isAbsolute(difference) || difference.split("/").includes("..")) throw new Error("Path leaves the checkout");
  return resolved;
}

export function checkWorkspaceLinks(workspace, directories) {
  const root = realpathSync(workspace);
  for (const path of directories) {
    const directory = containedPath(root, join(root, path));
    if (!statSync(directory).isDirectory()) throw new Error("Expected a workspace directory");
    closeSync(openRegular(join(directory, "package.json")));
  }
}

export function checkedVitest(workspace, version) {
  const root = realpathSync(workspace);
  const expectedRoot = join(root, "node_modules", "vitest");
  const packageRoot = containedPath(root, expectedRoot);
  if (packageRoot !== expectedRoot) throw new Error("Installed Vitest package directory is not the registry package");
  const fd = openRegular(join(packageRoot, "package.json"));
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
  const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.vitest;
  if (metadata.name !== "vitest" || metadata.version !== version || typeof bin !== "string" || isAbsolute(bin)) {
    throw new Error("Installed Vitest differs from the locked version");
  }
  const executable = containedPath(packageRoot, join(packageRoot, bin));
  if (!statSync(executable).isFile()) throw new Error("Installed Vitest entrypoint is unavailable");
  return executable;
}
