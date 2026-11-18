import { registryTarballUrl } from "./lockfile.ts";
import { runnerPnpmVersion } from "./pnpm-lockfile.mjs";

const launcher = "/opt/sandbox-runner-vitest/container.mjs";
const testerId = "10001";
const node = "/usr/local/bin/node";
const workspace = "/workspace";

export type CapturedOutput = { text: string; bytes: number; truncated: boolean };
type OutputPair = { stdout: CapturedOutput; stderr: CapturedOutput };
export type NativeResult = { exitCode: number } & OutputPair;
type CommandResult = NativeResult | ({ signal: number } & OutputPair);
export type VitestPhase = "checkout" | "lockfile" | "install" | "test";
export type VitestRuntimeVersions = { nodeVersion: string; npmVersion: string; pnpmVersion?: string; vitestVersion?: string };
export type VitestExecution = {
  status: "succeeded" | "failed";
  phase: VitestPhase;
  durationMs: number;
  reason?: string;
  checkoutSha?: string;
  lockSha256?: string;
  versions?: VitestRuntimeVersions;
  command?: CommandResult;
};
export type VitestAttestation = Pick<VitestExecution, "checkoutSha" | "lockSha256" | "versions">;

type NativeProcess = {
  exitCode: Promise<number>;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
};
type NativeExecOptions = {
  cwd: string;
  user: string;
  env: Record<string, string>;
  stdin?: ReadableStream<Uint8Array>;
};
type NativeContainer = {
  exec(argv: string[], options: NativeExecOptions): Promise<NativeProcess>;
};

export async function untilRunStops<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const { promise, reject } = Promise.withResolvers<never>();
  const stop = () => reject(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await Promise.race([task(), promise]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

export async function captureOutput(stream: ReadableStream<Uint8Array> | null | undefined, limit: number): Promise<CapturedOutput> {
  if (!stream) return { text: "", bytes: 0, truncated: false };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes < limit) text += decoder.decode(value.subarray(0, limit - bytes), { stream: true });
      bytes += value.byteLength;
    }
    return { text: text + decoder.decode(), bytes, truncated: bytes > limit };
  } finally {
    reader.releaseLock();
  }
}

export async function runNativeCommand(container: NativeContainer, argv: string[], options: {
  timeoutSeconds: number;
  stdoutBytes: number;
  stderrBytes: number;
  env?: Record<string, string>;
  stdin?: ReadableStream<Uint8Array>;
}): Promise<NativeResult> {
  const { timeoutSeconds, stdoutBytes, stderrBytes } = options;
  // The durable_object scheduler can grant root capabilities to a numeric
  // exec user. Drop them in the image before starting timeout or any work.
  const process = await container.exec([
    "/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
    "--reuid", testerId, "--regid", testerId, "--clear-groups", "--",
    "/usr/bin/timeout", "--kill-after=5s", `${timeoutSeconds}s`, ...argv,
  ], { cwd: workspace, user: "0:0", env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/tester", CI: "true", NO_COLOR: "1", ...options.env },
    ...(options.stdin ? { stdin: options.stdin } : {}) });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exitCode, captureOutput(process.stdout, stdoutBytes), captureOutput(process.stderr, stderrBytes),
  ]);
  return { exitCode, stdout, stderr };
}

type Inspection = { lockSha256: string; versions: VitestRuntimeVersions; tarballs: string[] };

function checkedInspection(result: NativeResult, checkoutSha: string, requireVitest: boolean): Inspection | undefined {
  if (result.exitCode !== 0 || result.stdout.truncated) return;
  try {
    const data = JSON.parse(result.stdout.text);
    if (data?.sha !== checkoutSha || typeof data.lockSha256 !== "string" || data.lockSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(data.lockSha256) ||
        typeof data.nodeVersion !== "string" || !/^v24\.[0-9]+\.[0-9]+$/.test(data.nodeVersion) ||
        typeof data.npmVersion !== "string" || (data.pnpmVersion !== undefined && (requireVitest || data.pnpmVersion !== runnerPnpmVersion)) ||
        (requireVitest && typeof data.lock?.vitestVersion !== "string") ||
        !Array.isArray(data.lock?.tarballs) || (requireVitest && !data.lock.tarballs.length) ||
        !data.lock.tarballs.every((tarball: unknown) => typeof tarball === "string" && registryTarballUrl(tarball) === tarball)) return;
    return {
      lockSha256: data.lockSha256, tarballs: data.lock.tarballs,
      versions: { nodeVersion: data.nodeVersion, npmVersion: data.npmVersion,
        ...(data.pnpmVersion === undefined ? {} : { pnpmVersion: data.pnpmVersion }),
        ...(requireVitest ? { vitestVersion: data.lock.vitestVersion } : {}) },
    };
  } catch {
    return;
  }
}

const startErrors = new Set(["not_found", "permission_denied", "invalid_executable", "arguments_too_large", "start_failed"]);

function decodedCapture(value: { data?: unknown; bytes?: unknown; truncated?: unknown } | undefined, limit: number) {
  if (typeof value?.data !== "string" || typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
      value.truncated !== (value.bytes > limit)) return;
  const binary = atob(value.data);
  if (binary.length !== Math.min(value.bytes, limit) || btoa(binary) !== value.data) return;
  const data = Uint8Array.from(binary, byte => byte.charCodeAt(0));
  return { text: new TextDecoder().decode(data), bytes: value.bytes, truncated: value.truncated };
}

function commandReceipt(result: NativeResult, logBytes: number): { reason?: string; command?: CommandResult } {
  const infrastructureFailure = { reason: "test_runtime_failed" };
  if (result.exitCode !== 0 || result.stdout.truncated) return infrastructureFailure;
  try {
    const receipt = JSON.parse(result.stdout.text);
    if (startErrors.has(receipt.startError)) return { reason: `test_command_${receipt.startError}` };
    const stdout = decodedCapture(receipt.stdout, logBytes);
    const stderr = decodedCapture(receipt.stderr, logBytes);
    if (!stdout || !stderr) return infrastructureFailure;
    const { exitCode, signal } = receipt;
    if (exitCode === undefined && Number.isInteger(signal) && signal >= 1 && signal <= 64) {
      return { reason: "test_command_signaled", command: { signal, stdout, stderr } };
    }
    if (signal === undefined && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) {
      return { ...(exitCode === 0 ? {} : { reason: "test_command_failed" }), command: { exitCode, stdout, stderr } };
    }
  } catch {
    return infrastructureFailure;
  }
  return infrastructureFailure;
}

type RunVitestOptions = {
  container: NativeContainer;
  expectedSha: string;
  deadlineAt: number;
  maxLockBytes: number;
  logBytes: number;
  argv?: string[];
  checkout(deadlineAt: number): Promise<string | undefined>;
  setPhase(phase: VitestPhase, observed: VitestAttestation): Promise<void>;
  sealCheckout(deadlineAt: number): Promise<void>;
  openNpm(tarballs: string[], deadlineAt: number): Promise<void>;
  sealNpm(deadlineAt: number): Promise<void>;
};

function commandTimedOut(result: NativeResult, deadlineAt: number): boolean {
  return (result.exitCode === 124 || result.exitCode === 137) && Date.now() >= deadlineAt;
}

/** Owns command order. The run owner supplies checkout, persisted phase and egress gates. */
export async function runVitest({ container, expectedSha, deadlineAt, maxLockBytes, logBytes, argv, checkout, setPhase,
  sealCheckout, openNpm, sealNpm }: RunVitestOptions): Promise<VitestExecution> {
  const startedAt = Date.now();
  let phase: VitestPhase = "checkout";
  const observed: VitestAttestation = {};
  const failed = (reason: string, command?: CommandResult): VitestExecution => ({
    status: "failed", phase, durationMs: Date.now() - startedAt, reason, ...observed, ...(command ? { command } : {}),
  });
  const command = async (name: string, args: string[], stdoutBytes = logBytes, stdin?: ReadableStream<Uint8Array>) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return undefined;
    return runNativeCommand(container, [node, launcher, name, expectedSha, String(maxLockBytes), ...args], {
      timeoutSeconds: remaining / 1000, stdoutBytes, stderrBytes: logBytes, stdin,
    });
  };
  await setPhase(phase, observed);
  if (Date.now() >= deadlineAt) return failed("test_timed_out");
  let actualSha;
  try {
    actualSha = await checkout(deadlineAt);
  } finally {
    await sealCheckout(deadlineAt);
  }
  if (Date.now() >= deadlineAt) return failed("test_timed_out");
  if (actualSha !== expectedSha) return failed("checkout_failed");
  observed.checkoutSha = actualSha;

  phase = "lockfile";
  await setPhase(phase, observed);
  // The structured inspection projects URLs from the lockfile and adds fixed runtime metadata.
  const raw = await command(argv ? "inspect-command" : "inspect", [], maxLockBytes * 2);
  if (!raw || commandTimedOut(raw, deadlineAt)) return failed("test_timed_out");
  const snapshot = checkedInspection(raw, actualSha, !argv);
  if (!snapshot) return failed("test_lockfile_unverified");
  const { lockSha256, versions, tarballs } = snapshot;
  Object.assign(observed, { lockSha256, versions });

  phase = "install";
  await setPhase(phase, observed);
  if (Date.now() >= deadlineAt) return failed("test_timed_out");
  await openNpm(tarballs, deadlineAt);
  let install;
  try {
    install = await command(versions.pnpmVersion ? "fetch-pnpm" : argv ? "install-command" : "install", [lockSha256]);
  } finally {
    await sealNpm(deadlineAt);
  }
  if (!install || commandTimedOut(install, deadlineAt)) return failed("test_timed_out", install);
  if (install.exitCode !== 0) return failed("test_install_failed", install);
  if (versions.pnpmVersion) {
    // Install from the verified store only once registry egress has closed and drained.
    const offline = await command("install-pnpm", [lockSha256]);
    if (!offline || commandTimedOut(offline, deadlineAt)) return failed("test_timed_out", offline);
    if (offline.exitCode !== 0) return failed("test_install_failed", offline);
  }

  phase = "test";
  await setPhase(phase, observed);
  if (argv) {
    // The supervisor emits one receipt containing two base64 prefixes and fixed metadata.
    const receiptBytes = 2 * Math.ceil(logBytes / 3) * 4 + 256;
    const result = await command("command", [lockSha256, String(logBytes)], receiptBytes, new Blob([JSON.stringify(argv)]).stream());
    if (!result || commandTimedOut(result, deadlineAt)) return failed("test_timed_out");
    const verified = commandReceipt(result, logBytes);
    if (verified.reason) return failed(verified.reason, verified.command);
    return { status: "succeeded", phase, durationMs: Date.now() - startedAt, ...observed, command: verified.command };
  }
  const result = await command("vitest", [lockSha256]);
  if (!result || commandTimedOut(result, deadlineAt)) return failed("test_timed_out", result);
  if (result.exitCode === 1) return failed("test_failed", result);
  if (result.exitCode !== 0) return failed("test_runtime_failed", result);
  return { status: "succeeded", phase, durationMs: Date.now() - startedAt, ...observed, command: result };
}
