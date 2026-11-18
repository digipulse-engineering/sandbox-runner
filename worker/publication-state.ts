import type { GithubRepository } from "./github-auth.ts";
import { verifiedPublicationReceipt } from "./github-publish.ts";
import type { GithubPreparedPublication, GithubPublicationResult } from "./github-publish.ts";
import type { RunStatus } from "./contract.ts";

type PublicationOutcome =
  | { status: "no_changes" | "cancelled" }
  | { status: "published"; branch: string; commitSha: string; treeSha: string }
  | { status: "conflict" | "uncertain"; branch: string }
  | { status: "failed"; reason: string };

export type PublicationView = { status: "pending" } | PublicationOutcome;

export type PublicationState =
  | { phase: "requested" }
  | { phase: "capture"; commitDate: string }
  | { phase: "prepared"; receipt: GithubPreparedPublication }
  | { phase: "claimed"; receipt: GithubPreparedPublication; reconcileUntil: number; cancelRequested?: true }
  | { phase: "uncertain"; receipt: GithubPreparedPublication }
  | { phase: "settled"; result: PublicationOutcome };

export function publicationView(state: PublicationState | undefined): PublicationView | undefined {
  if (!state) return;
  if (state.phase === "uncertain") return { status: "uncertain", branch: "sandbox-runner/" + state.receipt.operationId };
  return state.phase === "settled" ? state.result : { status: "pending" };
}

export function publicationPending(state: PublicationState | undefined): boolean {
  return state !== undefined && state.phase !== "settled" && state.phase !== "uncertain";
}

export function failedPublication(reason: string): PublicationState {
  return { phase: "settled", result: { status: "failed", reason } };
}

export function publicationAcceptsDeadline(state: PublicationState | undefined): boolean {
  return publicationPending(state) && !(state?.phase === "claimed" && state.cancelRequested);
}

export function timeoutPublication(state: PublicationState | undefined): PublicationState | undefined {
  // An existing claim may already have reached GitHub. Preserve the exact
  // receipt and the read-only recovery window, even after run expiry.
  if (!publicationAcceptsDeadline(state) || state?.phase === "claimed") return state;
  return failedPublication("github_publication_run_timed_out");
}

export function finishAgentPublication(state: PublicationState | undefined, status: RunStatus): PublicationState | undefined {
  if (state?.phase !== "requested") return state;
  if (status === "succeeded") return { phase: "capture", commitDate: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z") };
  if (status === "timed_out") return timeoutPublication(state);
  return status === "cancelled" ? cancelPublication(state) : failedPublication("github_publication_agent_not_succeeded");
}

export function cancelPublication(state: PublicationState | undefined): PublicationState | undefined {
  if (!state || state.phase === "settled" || state.phase === "uncertain") return state;
  if (state.phase === "claimed") return { ...state, cancelRequested: true };
  return { phase: "settled", result: { status: "cancelled" } };
}

export function receiptMatches(
  receipt: GithubPreparedPublication, repository: GithubRepository | undefined, operationId: string, baseSha: string | undefined,
): boolean {
  return verifiedPublicationReceipt(receipt) && !!repository && receipt.operationId === operationId &&
    receipt.baseSha === baseSha && receipt.repository.repositoryId === repository.repositoryId &&
    receipt.repository.owner === repository.owner && receipt.repository.name === repository.name;
}

export function sameReceipt(left: GithubPreparedPublication, right: GithubPreparedPublication): boolean {
  return receiptMatches(left, right.repository, right.operationId, right.baseSha) &&
    left.treeSha === right.treeSha && left.commitSha === right.commitSha;
}

export function claimReference(
  state: PublicationState, expected: GithubPreparedPublication, reconcileUntil: number, deadlineAt?: number, now = Date.now(),
): PublicationState | undefined {
  if (deadlineAt !== undefined && now >= deadlineAt) return;
  if (state.phase === "prepared" && sameReceipt(state.receipt, expected)) {
    return { phase: "claimed", receipt: state.receipt, reconcileUntil };
  }
}

export function recoveryAlarm(
  state: PublicationState, priorPhase: "prepared" | "claimed" | "uncertain", expected: GithubPreparedPublication,
  observed: GithubPublicationResult, now: number, delay: number,
): number | undefined {
  if (state.phase !== "claimed" || !sameReceipt(state.receipt, expected) ||
      observed.ref !== "refs/heads/sandbox-runner/" + expected.operationId ||
      (observed.status !== "reconcile" && observed.status !== "uncertain" && observed.status !== "denied")) return;
  // Always perform a fresh read after the write invocation. If the ref is
  // temporarily absent, give GitHub the remaining recovery window.
  if (priorPhase === "prepared") return now;
  if (now < state.reconcileUntil) return Math.min(now + delay, state.reconcileUntil);
}

export function finishReference(
  state: PublicationState, expected: GithubPreparedPublication, observed: GithubPublicationResult,
): PublicationState | undefined {
  if ((state.phase !== "prepared" && state.phase !== "claimed" && state.phase !== "uncertain") ||
      !sameReceipt(state.receipt, expected)) return;
  const branch = "sandbox-runner/" + expected.operationId;
  if (observed.ref !== "refs/heads/" + branch) return failedPublication("github_objects_unverified");
  switch (observed.status) {
    case "published":
      if (observed.commitSha !== expected.commitSha) return failedPublication("github_objects_unverified");
      return { phase: "settled", result: { status: "published", branch, commitSha: expected.commitSha, treeSha: expected.treeSha } };
    case "conflict":
      return { phase: "settled", result: { status: "conflict", branch } };
    case "uncertain":
    case "denied":
      return state.phase === "claimed" || state.phase === "uncertain"
        ? { phase: "uncertain", receipt: expected }
        : failedPublication("github_publication_unavailable");
    case "reconcile":
      return;
  }
}
