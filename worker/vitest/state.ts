import type { RunProfileReceipt } from "../contract.ts";
import type { RepositoryInput } from "../github-source.ts";
import type { TestSuite } from "./admission.ts";
import type { CapturedOutput, VitestExecution, VitestPhase, VitestRuntimeVersions } from "./runtime.ts";

export type VitestRunPhase = "queued" | VitestPhase;
type Status = "queued" | "running" | "succeeded" | "failed" | "cancelled";
type Cleanup = "pending" | "destroyed" | "failed";
export type VitestRunView = {
  id: string;
  kind: "test";
  suite: TestSuite;
  repository: RepositoryInput;
  sandboxProvider: "cloudflare";
  phase: VitestRunPhase;
  status: Status;
  cleanup: Cleanup;
  reason?: string;
  profile?: RunProfileReceipt;
  imageDigest?: string;
  checkoutSha?: string;
  lockSha256?: string;
  versions?: VitestRuntimeVersions;
  durationMs?: number;
  exitCode?: number;
  signal?: number;
  stdout?: CapturedOutput;
  stderr?: CapturedOutput;
};

export type VitestRunState = VitestRunView & { admittedAt: number; deadlineAt: number; startedAt?: number };
const phases: VitestPhase[] = ["checkout", "lockfile", "install", "test"];

export function createVitestState(id: string, repository: RepositoryInput, admittedAt: number, deadlineAt: number,
  suite: TestSuite = "vitest"): VitestRunState {
  return { id, kind: "test", suite, repository, sandboxProvider: "cloudflare", admittedAt, deadlineAt,
    phase: "queued", status: "queued", cleanup: "pending" };
}

export function vitestView(state: VitestRunState): VitestRunView {
  const { admittedAt, deadlineAt, startedAt, ...view } = state;
  return view;
}

export function vitestSettled(state: VitestRunState): boolean {
  return state.status !== "queued" && state.status !== "running";
}

export function startVitest(state: VitestRunState, now: number): VitestRunState | undefined {
  if (state.status !== "queued") return;
  if (now >= state.deadlineAt) return terminateVitest(state, "test_timed_out", now);
  return { ...state, status: "running", phase: "checkout", startedAt: now };
}

export function setVitestPhase(state: VitestRunState, phase: VitestPhase): VitestRunState | undefined {
  if (state.status !== "running" || state.phase === "queued") return;
  if (state.phase === phase || phases[phases.indexOf(state.phase) + 1] === phase) return { ...state, phase };
}

export function finishVitest(state: VitestRunState, execution: VitestExecution): VitestRunState {
  if (state.status !== "running" || execution.phase !== state.phase) return state;
  const { status, durationMs, reason, checkoutSha, lockSha256, versions, command } = execution;
  return { ...state, status, durationMs, reason, checkoutSha, lockSha256, versions, ...command };
}

export function terminateVitest(state: VitestRunState, reason: "run_cancelled" | "test_timed_out" | "test_runtime_failed" | "test_runtime_lost", now: number): VitestRunState {
  if (vitestSettled(state)) return state;
  return { ...state, status: reason === "run_cancelled" ? "cancelled" : "failed", reason,
    durationMs: Math.max(0, now - (state.startedAt ?? state.admittedAt)) };
}

export function recordVitestCleanup(state: VitestRunState, cleanup: Exclude<Cleanup, "pending">): VitestRunState {
  if (vitestSettled(state) && state.cleanup === "pending") return { ...state, cleanup };
  return state;
}
