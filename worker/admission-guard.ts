import { operationId } from "./run-input-validation.mjs";

export const admissionGuardBinding = "SANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN";
export const admissionGuardPath = "/v4/admissions/guard";

type Sql = Pick<SqlStorage, "exec">;
type Closure = { upgradeId: string; generation: string; closed: number };
export type GuardOperationState = "pending" | "cleanup_failed" | "fenced" | "indexed_and_destroyed";
type GuardOperation = { operationId: string; generation: string; clientId: string | null; state: GuardOperationState };
export type GuardAction = { action: "close"; upgradeId: string } | { action: "open"; upgradeId: string; generation: string };

export function validGuardToken(value: string | undefined): value is string {
  return typeof value === "string" && /^guard-[a-f0-9]{64}$/u.test(value) && value.length === 70;
}

export function validGuardId(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && operationId(value) === value;
}

export function parseGuardAction(input: unknown, validGeneration: (generation: string) => boolean): GuardAction | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const { action, upgradeId, generation } = input as Record<string, unknown>;
  if (!validGuardId(upgradeId)) return;
  if (action === "close" && Object.keys(input).length === 2) return { action, upgradeId };
  if (action === "open" && Object.keys(input).length === 3 && typeof generation === "string" && validGeneration(generation)) {
    return { action, upgradeId, generation };
  }
}

export function initializeAdmissionGuard(sql: Sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS installation_guard_tracking (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))");
  sql.exec(`CREATE TABLE IF NOT EXISTS installation_guard_closures (
    generation INTEGER PRIMARY KEY AUTOINCREMENT, upgrade_id TEXT NOT NULL UNIQUE, closed INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS installation_guard_operations (
    id TEXT PRIMARY KEY, generation INTEGER NOT NULL, client_id TEXT, state TEXT NOT NULL
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS installation_guard_pending ON installation_guard_operations (generation) WHERE state IN ('pending', 'cleanup_failed')");
}

export function admissionGuardTracking(sql: Sql): boolean {
  return sql.exec("SELECT 1 FROM installation_guard_tracking WHERE singleton = 1").toArray().length > 0;
}

export function startAdmissionGuardTracking(sql: Sql) {
  sql.exec("INSERT INTO installation_guard_tracking (singleton) VALUES (1) ON CONFLICT DO NOTHING");
}

function latestClosure(sql: Sql): Closure | undefined {
  return sql.exec<Closure>("SELECT upgrade_id AS upgradeId, CAST(generation AS TEXT) AS generation, closed " +
    "FROM installation_guard_closures ORDER BY generation DESC LIMIT 1").toArray()[0];
}

export function admissionGuardClosed(sql: Sql): boolean {
  return latestClosure(sql)?.closed === 1;
}

export function changeAdmissionGuard(sql: Sql, input: GuardAction): boolean {
  const latest = latestClosure(sql);
  if (input.action === "close") {
    if (latest?.closed) return latest.upgradeId === input.upgradeId;
    const reused = sql.exec("SELECT 1 FROM installation_guard_closures WHERE upgrade_id = ?", input.upgradeId).toArray();
    if (reused.length) return false;
    sql.exec("INSERT INTO installation_guard_closures (upgrade_id, closed) VALUES (?, 1)", input.upgradeId);
    return true;
  }
  if (latest?.upgradeId !== input.upgradeId || latest.generation !== input.generation) return false;
  sql.exec("UPDATE installation_guard_closures SET closed = 0 WHERE upgrade_id = ?", input.upgradeId);
  return true;
}

export function registerGuardOperation(sql: Sql, id: string, generation: string, clientId: string | undefined) {
  sql.exec("INSERT INTO installation_guard_operations (id, generation, client_id, state) VALUES (?, CAST(? AS INTEGER), ?, 'pending') " +
    "ON CONFLICT (id) DO UPDATE SET generation = excluded.generation, client_id = excluded.client_id, state = excluded.state", id, generation, clientId ?? null);
}

export function updateGuardOperation(sql: Sql, id: string, generation: string, state: GuardOperationState) {
  sql.exec("UPDATE installation_guard_operations SET state = ? WHERE id = ? AND generation = CAST(? AS INTEGER)", state, id, generation);
}

const operationColumns = "id AS operationId, CAST(generation AS TEXT) AS generation, client_id AS clientId, state";

export function readGuardOperation(sql: Sql, id: string): GuardOperation | null {
  return sql.exec<GuardOperation>("SELECT " + operationColumns + " FROM installation_guard_operations WHERE id = ?", id).toArray()[0] ?? null;
}

export function readAdmissionGuard(sql: Sql, legacyUnverified: boolean, pageSize: number, after = "0") {
  const latest = latestClosure(sql);
  const { pendingCount, cleanupFailed } = sql.exec<{ pendingCount: number; cleanupFailed: number }>(
    "SELECT COUNT(*) AS pendingCount, COUNT(CASE state WHEN 'cleanup_failed' THEN 1 END) AS cleanupFailed " +
    "FROM installation_guard_operations WHERE state IN ('pending', 'cleanup_failed')").one();
  const pending = sql.exec<GuardOperation>("SELECT " + operationColumns + " FROM installation_guard_operations " +
    "WHERE state IN ('pending', 'cleanup_failed') AND generation > CAST(? AS INTEGER) ORDER BY generation LIMIT ?", after, pageSize + 1).toArray();
  // An unsupported older runtime might have issued a ticket after tracking began.
  // A ticket without an exact proof row must not disappear from a drain decision.
  const untracked = sql.exec(`SELECT 1 FROM installation_tickets AS ticket
    LEFT JOIN installation_guard_operations AS operation
      ON operation.id = ticket.id AND operation.generation = ticket.sequence
      AND operation.state IN ('pending', 'cleanup_failed')
    WHERE operation.id IS NULL LIMIT 1`).toArray().length !== 0;
  const status = legacyUnverified || untracked ? "legacy_unverified" : !latest?.closed ? "open"
    : cleanupFailed ? "cleanup_failed" : pendingCount ? "draining" : "drained";
  return { status, upgradeId: latest?.upgradeId ?? null, generation: latest?.generation ?? null,
    pendingCount, pending: pending.slice(0, pageSize), nextCursor: pending.length > pageSize ? pending[pageSize - 1].generation : null };
}
