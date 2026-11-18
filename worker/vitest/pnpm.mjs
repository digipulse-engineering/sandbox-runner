import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePnpmYaml, parsePnpmLockfile, runnerPnpmVersion } from "./pnpm-lockfile.mjs";

const root = "/opt/sandbox-runner-vitest";
const executable = `${root}/tools/pnpm/bin/pnpm.cjs`;
const store = "/tmp/sandbox-runner-pnpm-store";
const ca = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const args = ["--config.manage-package-manager-versions=false", "--config.package-manager-strict-version=false",
  "--config.ignore-pnpmfile=true", "--config.lockfile=true", "--config.shared-workspace-lockfile=true",
  "--config.git-branch-lockfile=false", "--config.merge-git-branch-lockfiles=false",
  "--config.userconfig=/dev/null", "--config.globalconfig=/dev/null", "--config.registry=https://registry.npmjs.org/",
  "--config.strict-ssl=true", "--config.verify-store-integrity=true", "--config.side-effects-cache=false",
  "--config.update-notifier=false", "--ignore-scripts", `--store-dir=${store}`];

export function checkedPnpmLockfile(text) {
  const parser = createRequire(import.meta.url)(`${root}/tools/yaml`);
  const result = parsePnpmLockfile(decodePnpmYaml(text, parser));
  if (!result) throw new Error("Unsupported pnpm dependencies");
  const { version } = JSON.parse(readFileSync(`${root}/tools/pnpm/package.json`, "utf8"));
  if (version !== runnerPnpmVersion) throw new Error("Unsupported pnpm runtime");
  return result;
}

function runPnpm(args, cwd, env) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd,
    // The bundled pnpm recognizes this marker and skips project-managed version switching.
    env: { ...env, COREPACK_ROOT: root },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.error || result.signal || result.status === null) throw new Error("Could not complete pnpm");
  return result.status;
}

export function fetchLockedPnpm(lockfile, env) {
  // No checkout configuration or scripts are reachable by this online process.
  const stage = mkdtempSync("/tmp/sandbox-runner-pnpm-fetch-");
  try {
    writeFileSync(join(stage, "pnpm-lock.yaml"), lockfile, { flag: "wx" });
    return runPnpm([...args, `--config.lockfile-dir=${stage}`, "fetch"], stage,
      { ...env, HOME: stage, XDG_CONFIG_HOME: stage, NODE_EXTRA_CA_CERTS: ca });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function installLockedPnpm(workspace, env) {
  return runPnpm([...args, `--config.lockfile-dir=${workspace}`, "install", "--offline", "--frozen-lockfile"], workspace, env);
}
