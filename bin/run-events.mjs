import { versionPattern } from "./auth.mjs";
import { testSuites, vitestPhases, vitestStatuses } from "./vitest-run.mjs";
import { connectorIssueForClient } from "./connector-issues.mjs";

const statuses = new Set(["queued", "running", "succeeded", "capacity", "auth_required", "failed", "unanswered", "cancelled", "timed_out"]);
const cleanups = new Set(["pending", "destroyed", "failed"]);

function attemptId(value) {
  return typeof value === "string" && versionPattern.test(value) && value === value.toLowerCase();
}

function attemptState(value) {
  if (!value || typeof value !== "object" || !attemptId(value.operationId) ||
      (value.authMode !== "subscription" && value.authMode !== "api-key") ||
      !statuses.has(value.status) || !cleanups.has(value.cleanup)) return;
  const { operationId, authMode, status, cleanup } = value;
  return { operationId, authMode, status, cleanup };
}

function eventData(event, isTest) {
  const { type, status, cleanup, operationId } = event;
  const runStatuses = isTest ? vitestStatuses : statuses;
  switch (type) {
    case "admitted":
      if (runStatuses.has(status) && cleanups.has(cleanup)) return { type, status, cleanup };
      break;
    case "snapshot": {
      const { attempts, cancellationRequested, phase } = event;
      if (!runStatuses.has(status) || !cleanups.has(cleanup)) break;
      if (isTest) {
        if (vitestPhases.has(phase)) return { type, status, cleanup, phase };
        break;
      }
      if (cancellationRequested !== undefined && cancellationRequested !== true) break;
      const snapshot = { type, status, cleanup, cancellationRequested };
      if (attempts === undefined) return snapshot;
      if (!Array.isArray(attempts)) break;
      const projected = attempts.map(attemptState);
      if (projected.every(Boolean)) return { ...snapshot, attempts: projected };
      break;
    }
    case "state":
      if (!isTest && event.connectorIssue !== undefined && statuses.has(status)) {
        const connectorIssue = connectorIssueForClient(event.connectorIssue);
        if (connectorIssue) return { type: "connector_issue", connectorIssue };
        break;
      }
      if (runStatuses.has(status)) return { type, status };
      break;
    case "phase":
      if (isTest && event.phase !== "queued" && vitestPhases.has(event.phase)) return { type, phase: event.phase };
      break;
    case "cleanup":
      if (cleanups.has(cleanup)) return { type, cleanup };
      break;
    case "cancellation_requested":
      return { type };
    case "attempt_admitted": {
      const attempt = !isTest && attemptState(event);
      if (attempt) return { type, ...attempt };
      break;
    }
    case "attempt_state":
      if (!isTest && attemptId(operationId) && statuses.has(status)) return { type, operationId, status };
      break;
    case "attempt_cleanup":
      if (!isTest && attemptId(operationId) && cleanups.has(cleanup)) return { type, operationId, cleanup };
      break;
    case "fallback": {
      const { fromOperationId, reason } = event;
      if (!isTest && attemptId(fromOperationId) && attemptId(operationId) && fromOperationId !== operationId &&
          reason === "provider_quota_exhausted") return { type, fromOperationId, operationId, reason };
      break;
    }
  }
}

export function parseAfter(value) {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return;
  const cursor = Number(value);
  if (Number.isSafeInteger(cursor)) return cursor;
}

export function checkedEvents(page, id, after) {
  if (page?.id !== id || page.sandboxProvider !== "cloudflare" || !Array.isArray(page.events) ||
      !Number.isSafeInteger(page.nextCursor) || page.nextCursor !== after + page.events.length) return;
  const isTest = page.kind === "test";
  if (isTest ? !testSuites.has(page.suite) :
    page.kind !== "agent" || (page.agent !== "claude" && page.agent !== "codex" && page.agent !== "opencode")) return;
  const events = [];
  for (const [index, event] of page.events.entries()) {
    const cursor = after + index + 1;
    if (event?.cursor !== cursor) return;
    const data = eventData(event, isTest);
    if (!data || (page.agent === "opencode" && data.type === "connector_issue" && data.connectorIssue.mode !== "read-only")) return;
    events.push({ cursor, ...data });
  }
  const sandboxProvider = "cloudflare";
  const nextCursor = page.nextCursor;
  return isTest ? { id, kind: "test", sandboxProvider, suite: page.suite, events, nextCursor }
    : { id, kind: "agent", sandboxProvider, agent: page.agent, events, nextCursor };
}
