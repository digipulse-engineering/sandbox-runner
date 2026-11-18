import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseNpmLockfile } from "./lockfile.ts";
import { runnerPnpmVersion } from "./pnpm-lockfile.mjs";
import { checkedPnpmLockfile, fetchLockedPnpm, installLockedPnpm } from "./pnpm.mjs";
import { checkedLockfile, checkedVitest, checkWorkspaceLinks } from "./container-files.mjs";

const workspace = "/workspace";
const user = 10001;
const caFile = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const npmRoot = "/usr/local/lib/node_modules/npm";
const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/tester", CI: "true", NO_COLOR: "1" };

function rootDenied(changeIdentity) {
  try {
    changeIdentity(0);
    return false;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function assertUnprivileged() {
  const status = readFileSync("/proc/self/status", "utf8");
  const caps = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];
  if (process.getuid() !== user || process.geteuid() !== user || process.getgid() !== user || process.getegid() !== user ||
      process.getgroups().some(group => group !== user) ||
      !/^NoNewPrivs:\s+1$/m.test(status) || caps.some(name => !new RegExp(`^${name}:\\s+0+$`, "m").test(status)) ||
      !rootDenied(id => process.setuid(id)) || !rootDenied(id => process.setgid(id))) {
    throw new Error("Unexpected test process privileges");
  }
}

function run(argv, childEnv) {
  const child = spawnSync(process.execPath, argv, { cwd: workspace, env: childEnv, stdio: ["ignore", "inherit", "inherit"] });
  if (child.error || child.signal || child.status === null) throw new Error("Could not complete the native process");
  return child.status;
}

try {
  const [, , phase, sha, maxBytes, expectedDigest, logBytes] = process.argv;
  assertUnprivileged();
  const requireVitest = !["inspect-command", "install-command", "fetch-pnpm", "install-pnpm", "command"].includes(phase);
  const lock = checkedLockfile(workspace, sha, Number(maxBytes), !requireVitest);
  const pnpm = lock.packageManager === "pnpm";
  const parsed = pnpm ? checkedPnpmLockfile(lock.text) : parseNpmLockfile(lock.text, requireVitest);
  if (!parsed) throw new Error("Unsupported locked dependencies");
  checkWorkspaceLinks(workspace, parsed.workspaces);
  if (phase === "inspect" || phase === "inspect-command") {
    const npm = JSON.parse(readFileSync(npmRoot + "/package.json", "utf8"));
    process.stdout.write(JSON.stringify({ sha, lockSha256: lock.sha256, lock: parsed, nodeVersion: process.version, npmVersion: npm.version,
      ...(pnpm ? { pnpmVersion: runnerPnpmVersion } : {}) }) + "\n");
  } else if (expectedDigest !== lock.sha256) {
    throw new Error("Package lockfile changed after admission");
  } else if (pnpm && phase === "fetch-pnpm") {
    process.exitCode = fetchLockedPnpm(lock.text, env);
  } else if (pnpm && phase === "install-pnpm") {
    process.exitCode = installLockedPnpm(workspace, env);
  } else if (!pnpm && (phase === "install" || phase === "install-command")) {
    process.exitCode = run([npmRoot + "/bin/npm-cli.js", "ci", "--ignore-scripts", "--no-audit", "--no-fund",
      "--no-update-notifier", "--registry=https://registry.npmjs.org/", "--strict-ssl=true", "--cache=/tmp/sandbox-runner-npm",
      "--userconfig=/tmp/sandbox-runner-user.npmrc", "--globalconfig=/tmp/sandbox-runner-global.npmrc"],
    { ...env, NODE_EXTRA_CA_CERTS: caFile });
  } else if (phase === "vitest") {
    process.exitCode = run([checkedVitest(workspace, parsed.vitestVersion), "run"], env);
  } else if (phase === "command") {
    const supervisor = spawnSync("/usr/local/bin/sandbox-runner-command", [maxBytes, logBytes], {
      cwd: workspace, env: { ...env, PATH: `${pnpm ? "/opt/sandbox-runner-vitest/bin:" : ""}${workspace}/node_modules/.bin:${env.PATH}` },
      stdio: ["inherit", "inherit", "inherit"],
    });
    if (supervisor.error || supervisor.signal || supervisor.status === null) throw new Error("Command supervisor failed");
    process.exitCode = supervisor.status;
  } else {
    throw new Error("Unknown native execution phase");
  }
} catch {
  // Worker diagnostics use a fixed reason and leave repository contents in the sandbox.
  process.stderr.write("sandbox-runner: test preflight or launch failed\n");
  process.exitCode = 125;
}
