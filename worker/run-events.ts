import type { AuthMode, CleanupStatus, RunStatus, RunView, StrategyAttempt } from "./contract.ts";
import type { TestSuite } from "./vitest/admission.ts";
import type { VitestRunPhase, VitestRunView } from "./vitest/state.ts";
import type { McpConnectorIssue } from "./mcp-diagnostic.mjs";

const RUN_EVENTS = "run-events";

type LifecycleState = { status: RunStatus; cleanup: CleanupStatus };
type AttemptState = LifecycleState & { operationId: string; authMode: AuthMode };
type JournalRun = RunView | VitestRunView;
type RunIdentity = Pick<RunView, "id" | "kind" | "agent"> | Pick<VitestRunView, "id" | "kind" | "suite">;
type EventData =
  | ({ type: "admitted" } & LifecycleState)
  | ({ type: "snapshot"; cancellationRequested?: true; attempts?: AttemptState[]; phase?: VitestRunPhase } & LifecycleState)
  | { type: "state"; status: RunStatus; connectorIssue?: McpConnectorIssue }
  | { type: "phase"; phase: VitestRunPhase }
  | { type: "cleanup"; cleanup: CleanupStatus }
  | { type: "cancellation_requested" }
  | ({ type: "attempt_admitted" } & AttemptState)
  | { type: "attempt_state"; operationId: string; status: RunStatus }
  | { type: "attempt_cleanup"; operationId: string; cleanup: CleanupStatus }
  | { type: "fallback"; fromOperationId: string; operationId: string; reason: "provider_quota_exhausted" };
type RunEvent = EventData & { cursor: number };
type JournalReader = { get<T>(key: string): Promise<T | undefined> };
type JournalWriter = JournalReader & { put<T>(key: string, value: T): Promise<void> };

function attemptState({ operationId, authMode, status, cleanup }: StrategyAttempt): AttemptState {
  return { operationId, authMode, status, cleanup };
}

function legacySnapshot(run: JournalRun): RunEvent {
  const snapshot = { type: "snapshot", cursor: 1, status: run.status, cleanup: run.cleanup } as const;
  if (run.kind === "test") return { ...snapshot, phase: run.phase };
  return {
    ...snapshot,
    ...(run.cancellationRequested ? { cancellationRequested: true } : {}),
    ...(run.attempts ? { attempts: run.attempts.map(attemptState) } : {}),
  };
}

function changes(previous: JournalRun | undefined, next: JournalRun): EventData[] {
  const agent = next.kind === "test" ? undefined : next;
  if (!previous) {
    // Cancellation may reserve the child before the parent's admission alarm runs.
    if (next.kind === "test" && next.status === "cancelled") return [
      { type: "admitted", status: "queued", cleanup: "pending" },
      { type: "cancellation_requested" },
      { type: "state", status: "cancelled" },
    ];
    return [
      { type: "admitted", status: next.status, cleanup: next.cleanup },
      ...(agent?.attempts?.map(attempt => ({ type: "attempt_admitted" as const, ...attemptState(attempt) })) ?? []),
    ];
  }
  const previousAgent = previous.kind === "test" ? undefined : previous;
  const events: EventData[] = [];
  for (const connectorIssue of agent?.connectorIssues ?? []) {
    if (!previousAgent?.connectorIssues?.some(issue => issue.connector === connectorIssue.connector && issue.code === connectorIssue.code)) {
      // Older clients accept state events and ignore the added field. The
      // enrichment therefore uses the same cursor on both client versions.
      events.push({ type: "state", status: next.status, connectorIssue });
    }
  }
  if ((!previousAgent?.cancellationRequested && agent?.cancellationRequested) ||
      (!agent?.attempts && previous.status !== "cancelled" && next.status === "cancelled")) {
    events.push({ type: "cancellation_requested" });
  }
  for (const [index, attempt] of (agent?.attempts ?? []).entries()) {
    const before = previousAgent?.attempts?.[index];
    if (!before) {
      const source = agent?.attempts?.[index - 1];
      if (source && agent?.fallbackReason === "provider_quota_exhausted") {
        events.push({ type: "fallback", fromOperationId: source.operationId, operationId: attempt.operationId,
          reason: "provider_quota_exhausted" });
      }
      events.push({ type: "attempt_admitted", ...attemptState(attempt) });
    } else {
      if (before.status !== attempt.status) events.push({ type: "attempt_state", operationId: attempt.operationId, status: attempt.status });
      if (before.cleanup !== attempt.cleanup) events.push({ type: "attempt_cleanup", operationId: attempt.operationId, cleanup: attempt.cleanup });
    }
  }
  if (previous.status !== next.status) events.push({ type: "state", status: next.status });
  if (previous.kind === "test" && next.kind === "test" && next.phase !== "queued" && previous.phase !== next.phase) {
    events.push({ type: "phase", phase: next.phase });
  }
  if (previous.cleanup !== next.cleanup) events.push({ type: "cleanup", cleanup: next.cleanup });
  return events;
}

// Call from the same transaction that writes the run. The projection is bounded
// by run lifecycle transitions and the strategy's existing attempt contract.
export async function appendRunEvents(transaction: JournalWriter, previous: JournalRun | undefined, next: JournalRun): Promise<void> {
  const pending = changes(previous, next);
  if (pending.length === 0) return;
  const events = await transaction.get<RunEvent[]>(RUN_EVENTS) ?? (previous ? [legacySnapshot(previous)] : []);
  const appended = pending.map((event, index) => ({ ...event, cursor: events.length + index + 1 }));
  await transaction.put(RUN_EVENTS, [...events, ...appended]);
}

function eventsPage(run: RunIdentity, events: RunEvent[], after: number) {
  if (after > events.length) return "invalid_cursor" as const;
  const { id } = run;
  const sandboxProvider = "cloudflare" as const;
  const page = { events: events.slice(after), nextCursor: events.length };
  return run.kind === "test" ? { id, kind: "test" as const, sandboxProvider, suite: run.suite, ...page }
    : { id, kind: "agent" as const, sandboxProvider, agent: run.agent, ...page };
}

export async function runEventsPage(transaction: JournalReader, run: JournalRun, after: number) {
  const events = await transaction.get<RunEvent[]>(RUN_EVENTS) ?? [legacySnapshot(run)];
  return eventsPage(run, events, after);
}

export function pendingVitestEventsPage(id: string, after: number, suite: TestSuite = "vitest") {
  return eventsPage({ id, kind: "test", suite }, [], after);
}

export function parseEventsCursor(params: URLSearchParams): number | undefined {
  const entries = [...params.entries()];
  if (entries.length === 0) return 0;
  const [name, value] = entries[0];
  if (entries.length !== 1 || name !== "after" || !/^(?:0|[1-9]\d*)$/.test(value)) return;
  const cursor = Number(value);
  if (Number.isSafeInteger(cursor)) return cursor;
}
