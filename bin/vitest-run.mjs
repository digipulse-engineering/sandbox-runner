import { matchesRepositoryReceipt, parseRepository } from "./github-repository.mjs";

const terminal = new Set(["succeeded", "failed", "cancelled"]);
export const vitestStatuses = new Set(["queued", "running", ...terminal]);
export const vitestPhases = new Set(["queued", "checkout", "lockfile", "install", "test"]);
export const testSuites = new Set(["vitest", "command"]);
const cleanupStatuses = new Set(["pending", "destroyed", "failed"]);

function capture(value) {
  if (!value || typeof value.text !== "string" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
      typeof value.truncated !== "boolean") return;
  const { text, bytes, truncated } = value;
  return { text, bytes, truncated };
}

export function checkedVitestRun(body, command) {
  if (body.id !== command.id || body.kind !== "test" || !testSuites.has(body.suite) ||
      (command.suite !== undefined && body.suite !== command.suite) || body.sandboxProvider !== "cloudflare" ||
      !vitestStatuses.has(body.status) || !vitestPhases.has(body.phase) || !cleanupStatuses.has(body.cleanup) ||
      (command.name === "result" && (!terminal.has(body.status) || body.cleanup === "pending")) ||
      (command.sandboxProvider !== undefined && body.sandboxProvider !== command.sandboxProvider)) return;
  const repository = parseRepository(body.repository);
  if (!repository || repository.sha !== body.repository.sha ||
      (command.repository && !matchesRepositoryReceipt(repository, command.repository))) return;
  const { id, kind, suite, sandboxProvider, status, phase, cleanup, reason, imageDigest, checkoutSha, lockSha256, durationMs, exitCode, signal } = body;
  if ((reason !== undefined && typeof reason !== "string") ||
      (imageDigest !== undefined && (typeof imageDigest !== "string" || imageDigest.length !== 71 || !/^sha256:[a-f0-9]{64}$/.test(imageDigest))) ||
      (checkoutSha !== undefined && checkoutSha !== repository.sha) ||
      (lockSha256 !== undefined && (typeof lockSha256 !== "string" || lockSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(lockSha256))) ||
      (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || durationMs < 0)) ||
      (exitCode !== undefined && (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) ||
      (signal !== undefined && (suite !== "command" || exitCode !== undefined || !Number.isInteger(signal) || signal < 1 || signal > 64))) return;
  if (suite === "command" && ((reason === "test_command_failed" && (status !== "failed" || !(exitCode > 0))) ||
      ((reason === "test_command_signaled") !== (signal !== undefined)) || (signal !== undefined && status !== "failed"))) return;
  const stdout = capture(body.stdout);
  const stderr = capture(body.stderr);
  if ((body.stdout !== undefined && !stdout) || (body.stderr !== undefined && !stderr) ||
      (exitCode !== undefined || signal !== undefined ? !stdout || !stderr : stdout || stderr)) return;
  let versions;
  if (body.versions !== undefined) {
    const { nodeVersion, npmVersion, pnpmVersion, vitestVersion } = body.versions ?? {};
    if (typeof nodeVersion !== "string" || !/^v24\.\d+\.\d+$/.test(nodeVersion) ||
        typeof npmVersion !== "string" || (pnpmVersion !== undefined && (suite !== "command" || typeof pnpmVersion !== "string" || !/^10\.\d+\.\d+$/.test(pnpmVersion))) || (suite === "vitest" && typeof vitestVersion !== "string")) return;
    versions = { nodeVersion, npmVersion, ...(pnpmVersion === undefined ? {} : { pnpmVersion }), ...(suite === "vitest" ? { vitestVersion } : {}) };
  }
  if (status === "succeeded" && (phase !== "test" || exitCode !== 0 || !checkoutSha || !lockSha256 || !versions)) return;
  return { id, kind, suite, repository, sandboxProvider, status, phase, cleanup, reason, imageDigest,
    checkoutSha, lockSha256, versions, durationMs, exitCode, ...(signal === undefined ? {} : { signal }), stdout, stderr };
}
