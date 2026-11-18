import type { Agent, CleanupStatus, RunProfileReceipt, RunStatus } from "./contract.ts";
import type { TestSuite } from "./vitest/admission.ts";

export const runIndexName = "logical-runs";
export const pendingRunIndex = "run-index-pending";
export const openCodeListHeader = "Sandbox-Runner-List-OpenCode";
// One index RPC plus at most two reads per row stay within the list API's 50-RPC budget.
export const runListLimit = 24;
const maximumSqliteSequence = "9223372036854775807";

export type RunSummary = { id: string; sandboxProvider: "cloudflare"; status: RunStatus; cleanup: CleanupStatus; profile?: RunProfileReceipt } &
  ({ kind: "agent"; agent: Agent } | { kind: "test"; suite: TestSuite });
export type RunListQuery = { cursor?: string; limit: number; includeOpenCode?: boolean; clientId?: string };
type PendingRunIndex = string | { id: string; generation?: string; opencode?: true; clientId?: string };
type IndexStorage = Pick<SqlStorage, "exec">;
type OutboxStorage = Pick<DurableObjectStorage, "get" | "delete">;

function validCursor(value: string): boolean {
  return value.trim() === value && /^[1-9][0-9]*$/.test(value) && (value.length < maximumSqliteSequence.length ||
    (value.length === maximumSqliteSequence.length && value <= maximumSqliteSequence));
}

export function parseRunListQuery(params: URLSearchParams): RunListQuery | "invalid_query" | "invalid_cursor" | "invalid_limit" {
  if ([...params.keys()].some(name => name !== "cursor" && name !== "limit")) return "invalid_query";
  const cursors = params.getAll("cursor");
  if (cursors.length > 1 || (cursors.length && !validCursor(cursors[0]))) return "invalid_cursor";
  const limits = params.getAll("limit");
  const limit = limits.length ? Number(limits[0]) : runListLimit;
  if (limits.length > 1 || (limits.length && (limits[0].trim() !== limits[0] || !/^[1-9][0-9]*$/.test(limits[0]))) ||
      !Number.isInteger(limit) || limit > runListLimit) {
    return "invalid_limit";
  }
  return { ...(cursors.length ? { cursor: cursors[0] } : {}), limit };
}

export function initializeRunIndex(sql: IndexStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS logical_runs (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    opencode INTEGER NOT NULL DEFAULT 0 CHECK (opencode IN (0, 1))
  )`);
  // Retain existing sequence numbers and cursor ordering across the schema upgrade.
  const columns = sql.exec<{ name: string }>("PRAGMA table_info(logical_runs)").toArray();
  if (!columns.some(column => column.name === "opencode")) {
    sql.exec("ALTER TABLE logical_runs ADD COLUMN opencode INTEGER NOT NULL DEFAULT 0 CHECK (opencode IN (0, 1))");
  }
  if (!columns.some(column => column.name === "client_id")) {
    sql.exec("ALTER TABLE logical_runs ADD COLUMN client_id TEXT");
  }
  sql.exec("CREATE INDEX IF NOT EXISTS logical_runs_client_sequence ON logical_runs (client_id, sequence)");
  sql.exec(`CREATE TABLE IF NOT EXISTS team_denials (
    client_id TEXT NOT NULL, reason TEXT NOT NULL, count INTEGER NOT NULL, last_at INTEGER NOT NULL,
    PRIMARY KEY (client_id, reason)
  )`);
}

export type TeamDenial = "profile_required" | "profile_not_found" | "invalid_profile_request" |
  "profile_revision_changed" | "override_not_allowed" | "run_not_found" | "operator_required" | "operation_conflict" | "read_only_client";

export function recordTeamDenial(sql: IndexStorage, clientId: string, reason: TeamDenial, now: number) {
  sql.exec(`INSERT INTO team_denials (client_id, reason, count, last_at) VALUES (?, ?, 1, ?)
    ON CONFLICT (client_id, reason) DO UPDATE SET count = count + 1, last_at = MAX(last_at, excluded.last_at)`,
  clientId, reason, now);
}

export function readTeamDenials(sql: IndexStorage) {
  return sql.exec("SELECT client_id AS clientId, reason, count, last_at AS lastAt FROM team_denials ORDER BY client_id, reason").toArray();
}

export function recordRunIndex(sql: IndexStorage, id: string, opencode = false, clientId?: string): void {
  sql.exec("INSERT INTO logical_runs (id, opencode, client_id) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING", id, Number(opencode),
    clientId ?? null);
}

export function readRunIndex(sql: IndexStorage, { cursor, limit, includeOpenCode = false, clientId }: RunListQuery) {
  // Keep the sequence as a decimal string across RPC to preserve its precision.
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];
  if (clientId !== undefined) {
    conditions.push("client_id = ?");
    bindings.push(clientId);
  }
  if (!includeOpenCode) conditions.push("opencode = 0");
  if (cursor !== undefined) {
    conditions.push("sequence < CAST(? AS INTEGER)");
    bindings.push(cursor);
  }
  const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
  const rows = sql.exec<{ id: string; cursor: string }>(
    "SELECT id, CAST(sequence AS TEXT) AS cursor FROM logical_runs" + where + " ORDER BY sequence DESC LIMIT ?",
    ...bindings, limit + 1).toArray();
  return { ids: rows.slice(0, limit).map(row => row.id), nextCursor: rows.length > limit ? rows[limit - 1].cursor : null };
}

export async function publishPendingRun(
  storage: OutboxStorage, record: (id: string, generation?: string, opencode?: true, clientId?: string) => Promise<void>, acknowledgeBy?: number,
): Promise<boolean> {
  const pending = await storage.get<PendingRunIndex>(pendingRunIndex);
  if (pending === undefined) return true;
  const write = () => typeof pending === "string" ? record(pending) : record(pending.id, pending.generation, pending.opencode, pending.clientId);
  try {
    if (acknowledgeBy === undefined) {
      await write();
    } else {
      const remaining = acknowledgeBy - Date.now();
      if (remaining <= 0) return false;
      const { promise, resolve } = Promise.withResolvers<false>();
      const timer = setTimeout(() => resolve(false), remaining);
      try {
        // A timed-out RPC may still have inserted the row. Retry the same ID.
        // The raced work has no continuation that can clear the local outbox.
        if (!await Promise.race([write().then(() => true), promise]) || Date.now() >= acknowledgeBy) return false;
      } finally {
        clearTimeout(timer);
      }
    }
    await storage.delete(pendingRunIndex);
    return true;
  } catch {
    // The admission and its alarm are already durable. Replay the same row until acknowledged.
    return false;
  }
}
