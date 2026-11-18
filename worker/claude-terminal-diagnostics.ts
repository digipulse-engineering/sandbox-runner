import type { CliParser } from "./pinned-src/harness/container/runtime";

const reasonPrefix = "claude_provider_http_";
export const claudeSpendLimitReason = reasonPrefix + "429_enforced_spend_limit_reached";

function providerReason(line: string): string | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof event !== "object" || event === null) return;
  const { type, is_error, terminal_reason, api_error_status, api_error_code } = event as Record<string, unknown>;
  if (
    type === "result" && is_error === true && terminal_reason === "api_error" &&
    typeof api_error_status === "number" && Number.isInteger(api_error_status) &&
    api_error_status >= 400 && api_error_status <= 599
  ) {
    if (api_error_status === 429 && api_error_code === "enforced_spend_limit_reached") {
      return claudeSpendLimitReason;
    }
    return reasonPrefix + api_error_status;
  }
}

function untypedReason(reason: string): string {
  // Only a validated terminal CLI status may produce a reserved reason.
  return reason.startsWith(reasonPrefix) ? "claude_unclassified_failure" : reason;
}

export function withClaudeTerminalDiagnostics(parser: CliParser): CliParser {
  return {
    line(text) {
      const update = parser.line(text);
      if (update.outcome?.status !== "unanswered") return update;
      const reason = providerReason(text) ?? untypedReason(update.outcome.reason);
      if (reason === update.outcome.reason) return update;
      return { ...update, outcome: { status: "unanswered", reason } };
    },
    end(exit) {
      const outcome = parser.end(exit);
      if (outcome.status !== "unanswered") return outcome;
      const reason = untypedReason(outcome.reason);
      return reason === outcome.reason ? outcome : { status: "unanswered", reason };
    },
  };
}
