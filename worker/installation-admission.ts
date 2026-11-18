import { admissionGuardClosed, admissionGuardTracking, changeAdmissionGuard, initializeAdmissionGuard, readAdmissionGuard, readGuardOperation,
  registerGuardOperation, startAdmissionGuardTracking, updateGuardOperation } from "./admission-guard.ts";
import type { GuardAction } from "./admission-guard.ts";

export const installationLimitBinding = "SANDBOX_RUNNER_INSTALLATION_MAX_RUNS";
export const admissionGenerationKey = "installation-admission-generation";
const fencedThrough = "installation-admission-fenced-through";

type Sql = Pick<SqlStorage, "exec">;
type Alarm = Pick<DurableObjectTransaction, "setAlarm" | "deleteAlarm">;
type FenceStorage = Pick<DurableObjectTransaction, "get" | "put">;
type Policy = { max_runs: number | null; legacy_seen: number; active: number };
export type AdmissionTicket = { id: string; generation: string };
export type AdmissionError = "installation_capacity" | "legacy_unverified" | "installation_admission_invalid" |
  "installation_maintenance" | "admission_unconfirmed";
export type AdmissionDecision = "unconfigured" | "existing" | "frozen_pending" | "operation_conflict" |
  Exclude<AdmissionError, "admission_unconfirmed"> | { generation: string };
export type AdmissionOwner = "replay" | { generation: string };
export type AdmissionOwnerError = "admission_replay_missing" | "admission_unconfirmed";
export type AdmissionObservation = "held" | "fenced" | "settled" | "cleanup_failed";

const sqliteSequenceMax = "9223372036854775807";

export function validAdmissionGeneration(value: string): boolean {
  return typeof value === "string" && value.trim() === value && value.length <= sqliteSequenceMax.length && /^[1-9][0-9]*$/.test(value) &&
    (value.length < sqliteSequenceMax.length || value <= sqliteSequenceMax);
}

function parseLimit(value: string): number | undefined {
  const limit = Number(value);
  if (value.trim() === value && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(limit)) return limit;
}

export function initializeInstallationAdmission(sql: Sql) {
  initializeAdmissionGuard(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS installation_admission (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    max_runs INTEGER,
    legacy_seen INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0 CHECK (active >= 0)
  )`);
  sql.exec("INSERT INTO installation_admission (singleton) VALUES (1) ON CONFLICT DO NOTHING");
  sql.exec(`CREATE TABLE IF NOT EXISTS installation_tickets (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    retry_at INTEGER
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS installation_tickets_due ON installation_tickets (retry_at, sequence)");
}

function ticket(sql: Sql, id: string): AdmissionTicket | undefined {
  return sql.exec<AdmissionTicket>(
    "SELECT id, CAST(sequence AS TEXT) AS generation FROM installation_tickets WHERE id = ?", id,
  ).toArray()[0];
}

function indexed(sql: Sql, id?: string): boolean {
  return id === undefined
    ? sql.exec("SELECT 1 FROM logical_runs LIMIT 1").toArray().length !== 0
    : sql.exec("SELECT 1 FROM logical_runs WHERE id = ?", id).toArray().length !== 0;
}

function admissionPolicy(sql: Sql): Policy {
  return sql.exec<Policy>("SELECT max_runs, legacy_seen, active FROM installation_admission WHERE singleton = 1").one();
}

export function prepareInstallationGuard(sql: Sql): boolean {
  const policy = admissionPolicy(sql);
  if (policy.legacy_seen || (!admissionGuardTracking(sql) && (policy.active !== 0 || indexed(sql)))) return false;
  startAdmissionGuardTracking(sql);
  return true;
}

export function installationGuardUnverified(sql: Sql): boolean {
  const policy = admissionPolicy(sql);
  return policy.legacy_seen !== 0 || (!admissionGuardTracking(sql) && (policy.active !== 0 || indexed(sql)));
}

/** Apply a guard action inside the caller's storage transaction. */
export function updateInstallationGuard(sql: Sql, input: GuardAction, pageSize: number) {
  const read = () => readAdmissionGuard(sql, installationGuardUnverified(sql), pageSize);
  if (input.action === "open" && read().status === "legacy_unverified") return null;
  if (!changeAdmissionGuard(sql, input)) return null;
  prepareInstallationGuard(sql);
  return read();
}

export function acquireInstallationAdmission(sql: Sql, id: string, configured: string | undefined, retryAt: number,
  guard?: { enabled: boolean; invalid?: boolean; clientId?: string }): AdmissionDecision {
  const tracking = admissionGuardTracking(sql);
  const closed = admissionGuardClosed(sql);
  const operation = tracking ? readGuardOperation(sql, id) : null;
  if (operation && operation.clientId !== (guard?.clientId ?? null)) return "operation_conflict";
  const current = ticket(sql, id);
  // Older callers can replay durable records, but cannot acquire a guarded ticket.
  if (current) return closed || (tracking && !guard) ? "frozen_pending" : { generation: current.generation };
  if (indexed(sql, id)) return "existing";
  if (closed || (tracking && !guard)) return "installation_maintenance";
  if (guard?.invalid) return "installation_admission_invalid";
  const guarded = tracking || (guard?.enabled === true && prepareInstallationGuard(sql));
  const policy = admissionPolicy(sql);
  if (!guarded && configured === undefined && policy.max_runs === null) {
    markLegacyAdmission(sql);
    return "unconfigured";
  }
  if (policy.legacy_seen || (!guarded && policy.max_runs === null && indexed(sql))) return "legacy_unverified";
  const limit = configured === undefined ? undefined : parseLimit(configured);
  const unlimited = guarded && configured === undefined && policy.max_runs === null;
  if (!unlimited && (limit === undefined || (policy.max_runs !== null && policy.max_runs !== limit))) return "installation_admission_invalid";
  if (limit !== undefined && policy.active >= limit) return "installation_capacity";
  sql.exec("INSERT INTO installation_tickets (id, retry_at) VALUES (?, ?)", id, retryAt);
  sql.exec("UPDATE installation_admission SET max_runs = ?, active = active + 1 WHERE singleton = 1", limit ?? null);
  const { generation } = ticket(sql, id)!;
  if (guarded) registerGuardOperation(sql, id, generation, guard?.clientId);
  return { generation };
}

function markLegacyAdmission(sql: Sql) {
  sql.exec("UPDATE installation_admission SET legacy_seen = 1 WHERE singleton = 1 AND legacy_seen = 0");
}

function matchingGuardIndex(sql: Sql, id: string, clientId: string | null) {
  return sql.exec("SELECT 1 FROM logical_runs WHERE id = ? AND client_id IS ?", id, clientId).toArray().length > 0;
}

export function checkInstallationIndexWrite(sql: Sql, id: string, generation: string | undefined, clientId?: string) {
  const operation = readGuardOperation(sql, id);
  if (operation && (operation.generation !== generation || operation.clientId !== (clientId ?? null) || operation.state === "fenced")) {
    throw new Error("Installation guard owner does not match the run index write");
  }
  if (operation && indexed(sql, id) && !matchingGuardIndex(sql, id, operation.clientId)) {
    throw new Error("Installation guard owner does not match the existing run index row");
  }
  if (generation === undefined) {
    markLegacyAdmission(sql);
    return;
  }
  const current = ticket(sql, id);
  // A lost acknowledgement can replay the indexed write after the slot is released.
  if (!validAdmissionGeneration(generation) || (current ? current.generation !== generation : !indexed(sql, id))) {
    throw new Error("Installation ticket does not match the run index write");
  }
}

export function claimInstallationReconciliation(sql: Sql, now: number, retryAt: number): AdmissionTicket | undefined {
  const due = sql.exec<AdmissionTicket>(
    "SELECT id, CAST(sequence AS TEXT) AS generation FROM installation_tickets " +
      "WHERE retry_at <= ? ORDER BY retry_at, sequence LIMIT 1", now,
  ).toArray()[0];
  if (due) sql.exec("UPDATE installation_tickets SET retry_at = ? WHERE id = ?", retryAt, due.id);
  return due;
}

export function expediteInstallationReconciliation(sql: Sql, id: string, generation: string, now: number): boolean {
  if (ticket(sql, id)?.generation !== generation) return false;
  sql.exec("UPDATE installation_tickets SET retry_at = ? WHERE id = ? AND retry_at > ?", now, id, now);
  return true;
}

export function finishInstallationReconciliation(sql: Sql, claim: AdmissionTicket, result: AdmissionObservation): boolean {
  if (result === "held" || ticket(sql, claim.id)?.generation !== claim.generation) return false;
  if (result === "cleanup_failed") {
    // This is a terminal cleanup failure. Keep the slot without polling forever.
    sql.exec("UPDATE installation_tickets SET retry_at = NULL WHERE id = ?", claim.id);
    updateGuardOperation(sql, claim.id, claim.generation, "cleanup_failed");
    return true;
  }
  // An indexed run must have an owner receipt. A fence can only retire a
  // reservation that never reached the index.
  if (indexed(sql, claim.id) !== (result === "settled")) return false;
  const operation = readGuardOperation(sql, claim.id);
  if (result === "settled" && operation && !matchingGuardIndex(sql, claim.id, operation.clientId)) return false;
  updateGuardOperation(sql, claim.id, claim.generation, result === "settled" ? "indexed_and_destroyed" : "fenced");
  sql.exec("DELETE FROM installation_tickets WHERE id = ?", claim.id);
  sql.exec("UPDATE installation_admission SET active = active - 1 WHERE singleton = 1");
  return true;
}

export async function scheduleInstallationReconciliation(sql: Sql, alarm: Alarm): Promise<void> {
  const next = sql.exec<{ retryAt: number }>(
    "SELECT retry_at AS retryAt FROM installation_tickets WHERE retry_at IS NOT NULL ORDER BY retry_at, sequence LIMIT 1",
  ).toArray()[0];
  if (next) await alarm.setAlarm(next.retryAt);
  else await alarm.deleteAlarm();
}

export async function installationFenceAllows(storage: FenceStorage, generation: string): Promise<boolean> {
  if (!validAdmissionGeneration(generation)) return false;
  const fence = await storage.get<string>(fencedThrough);
  return fence === undefined || BigInt(fence) < BigInt(generation);
}

export async function fenceInstallationAdmission(storage: FenceStorage, generation: string): Promise<void> {
  if (await installationFenceAllows(storage, generation)) await storage.put(fencedThrough, generation);
}
