import { testSuites, vitestStatuses } from "./vitest-run.mjs";
import { checkedProfileReceipt } from "./profile-commands.mjs";

export const runListLimit = 24;
export const openCodeListHeader = "Sandbox-Runner-List-OpenCode";
const maximumSqliteSequence = "9223372036854775807";
const idPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const agentStatuses = new Set([...vitestStatuses, "capacity", "auth_required", "unanswered", "timed_out"]);
const cleanupStatuses = new Set(["pending", "destroyed", "failed"]);

export function validListCursor(value) {
  return typeof value === "string" && value.trim() === value && /^[1-9][0-9]*$/.test(value) &&
    (value.length < maximumSqliteSequence.length || (value.length === maximumSqliteSequence.length && value <= maximumSqliteSequence));
}

export function parseListLimit(value) {
  if (typeof value !== "string" || value.trim() !== value || !/^[1-9][0-9]*$/.test(value)) return;
  const limit = Number(value);
  if (Number.isInteger(limit) && limit <= runListLimit) return limit;
}

function checkedSummary(summary) {
  if (!summary || typeof summary.id !== "string" || summary.id.length !== 36 || !idPattern.test(summary.id) ||
      summary.sandboxProvider !== "cloudflare" || !cleanupStatuses.has(summary.cleanup)) return;
  const { id, kind, sandboxProvider, status, cleanup } = summary;
  const profile = checkedProfileReceipt(summary.profile, undefined, kind === "test" ? false : undefined);
  if (summary.profile !== undefined && !profile) return;
  const run = { id, kind, sandboxProvider, status, cleanup, ...(profile ? { profile } : {}) };
  if (kind === "agent" && (summary.agent === "claude" || summary.agent === "codex" || summary.agent === "opencode") && agentStatuses.has(status)) {
    return { ...run, agent: summary.agent };
  }
  if (kind === "test" && testSuites.has(summary.suite) && vitestStatuses.has(status)) {
    return { ...run, suite: summary.suite };
  }
}

export function checkedRunList(payload, { limit = runListLimit, cursor }) {
  if (!payload || !Array.isArray(payload.runs) || payload.runs.length > limit) return;
  const { nextCursor } = payload;
  if (nextCursor !== null && (!validListCursor(nextCursor) || payload.runs.length !== limit ||
      (cursor !== undefined && BigInt(nextCursor) >= BigInt(cursor)))) return;
  const runs = payload.runs.map(checkedSummary);
  if (runs.some(run => !run) || new Set(runs.map(run => run.id)).size !== runs.length) return;
  return { runs, nextCursor };
}
