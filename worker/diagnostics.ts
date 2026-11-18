import type { Agent, AuthMode, Outcome } from "./contract";
import { claudeSpendLimitReason } from "./claude-terminal-diagnostics.ts";
import { openCodeQuotaReason } from "./opencode-settings.ts";
import type { ModelProvider } from "./opencode-settings.ts";
import { codexApiCreditPromoRestriction } from "./codex-api-diagnostics.ts";

export type InferenceSignal =
  | { kind: "http"; status: number; restriction?: typeof codexApiCreditPromoRestriction }
  | { kind: "redirect" | "transport_failed" | "transport_timeout" };

export type InferenceEvent = { id: string; signal?: InferenceSignal };
export type InferenceAttempt = InferenceEvent & { ambiguous: boolean };

export function nextInference(current: InferenceAttempt | undefined, event: InferenceEvent): InferenceAttempt | undefined {
  if (!event.signal) {
    if (current?.id === event.id) return;
    return { id: event.id, ambiguous: current !== undefined && (current.ambiguous || !current.signal) };
  }
  if (current?.id === event.id && !current.signal) return { ...current, signal: event.signal };
  if (current?.id === event.id && current.signal?.kind === "http" && current.signal.status === 400 &&
      event.signal.kind === "http" && event.signal.status === 400 && event.signal.restriction === codexApiCreditPromoRestriction &&
      current.signal.restriction === undefined) return { ...current, signal: event.signal };
}

const harnessFailures = new Map<string, Outcome>([
  ["container_lost", { status: "unanswered", reason: "container_lost" }],
  ["aborted", { status: "unanswered", reason: "aborted" }],
  ["not_found", { status: "unanswered", reason: "harness_operation_not_found" }],
  ["container_unavailable", { status: "failed", reason: "container_unavailable" }],
  ["opencode_mcp_startup_failed", { status: "failed", reason: "opencode_mcp_startup_failed" }],
]);

const requestRejected = { status: "failed", reason: "provider_request_rejected" } as const;
const timeout = { status: "failed", reason: "provider_timeout" } as const;
const rateLimited = { status: "capacity", reason: "provider_capacity" } as const;
const overloaded = { status: "capacity", reason: "provider_overloaded" } as const;
const quotaExhausted = { status: "capacity", reason: "provider_quota_exhausted" } as const;
// Exact reason produced by the pinned Codex API-key adapter for a Responses insufficient_quota event.
const codexApiQuota = "Quota exceeded. Check your plan and billing details.";
const httpFailures: Partial<Record<number, Outcome>> = {
  400: requestRejected,
  401: { status: "auth_required", reason: "provider_auth_required" },
  402: { status: "failed", reason: "provider_billing_required" },
  403: { status: "failed", reason: "provider_permission_denied" },
  404: { status: "failed", reason: "provider_resource_unavailable" },
  405: requestRejected,
  408: timeout,
  409: requestRejected,
  413: { status: "failed", reason: "provider_request_too_large" },
  415: requestRejected,
  422: requestRejected,
  429: rateLimited,
  504: timeout,
  529: overloaded,
};
const genericFailure = { status: "failed", reason: "run_failed" } as const;

export function outcome(
  result: { status: "done" | "unanswered"; text?: string; reason?: string },
  attempt: InferenceAttempt | undefined,
  context: { agent: Agent; authMode: AuthMode; modelProvider?: ModelProvider },
): Outcome {
  if (result.status === "done") return { status: "succeeded", output: result.text ?? "" };
  const harnessFailure = result.reason === undefined ? undefined : harnessFailures.get(result.reason);
  if (harnessFailure) return harnessFailure;
  const signal = attempt?.ambiguous ? undefined : attempt?.signal;
  switch (signal?.kind) {
    case "redirect": return { status: "failed", reason: "provider_redirect_denied" };
    case "transport_failed": return { status: "failed", reason: "provider_transport_failed" };
    case "transport_timeout": return timeout;
    case "http":
      if (signal.status === 400 && signal.restriction === codexApiCreditPromoRestriction &&
          context.agent === "codex" && context.authMode === "api-key") {
        return { status: "failed", reason: codexApiCreditPromoRestriction };
      }
      if (signal.status === 429 && context.agent === "claude" && context.authMode === "api-key" &&
          result.reason === claudeSpendLimitReason) return quotaExhausted;
      if (signal.status === 429 && context.agent === "opencode" && context.modelProvider === "openai" &&
          result.reason === openCodeQuotaReason) return quotaExhausted;
      if (signal.status === 200) {
        if (context.agent === "claude") {
          if (result.reason === "claude_provider_http_429" || result.reason === claudeSpendLimitReason) return rateLimited;
          if (result.reason === "claude_provider_http_529") return overloaded;
        } else if (context.agent === "codex" && context.authMode === "api-key" && result.reason === codexApiQuota) {
          return quotaExhausted;
        }
      }
      return httpFailures[signal.status] ?? (signal.status >= 500 && signal.status <= 599
        ? { status: "failed", reason: "provider_unavailable" } : genericFailure);
    default: return genericFailure;
  }
}
