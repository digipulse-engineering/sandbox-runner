import { createHash } from "node:crypto";
import { mcpConnectorCodes } from "./mcp-diagnostic.mjs";
import type { McpConnectorIssue } from "./mcp-diagnostic.mjs";
import { mcpWriteClaimed } from "./mcp-run-access.ts";

type Storage = Pick<DurableObjectTransaction, "get" | "put" | "delete">;

function fingerprint(name: string, requestId: string | number, attemptId?: string): string {
  return createHash("sha256").update(JSON.stringify([attemptId, name, requestId])).digest("hex");
}

function pendingWrite(name: string): string {
  return "mcp-write-pending:" + name;
}

function writesClosed(attemptId?: string): string {
  return "mcp-writes-closed:" + (attemptId ?? "run");
}

// These operations run in the same transaction as the owner's authorization check.
export async function claimConnectorWrite(storage: Storage, name: string, requestId: string | number, attemptId?: string,
  aliases: readonly string[] = [name]): Promise<boolean> {
  if (await storage.get(writesClosed(attemptId))) return false;
  for (const alias of aliases) {
    if (await storage.get(pendingWrite(alias))) return false;
  }
  const id = fingerprint(name, requestId, attemptId);
  const key = "mcp-write:" + id;
  if (await storage.get(key)) return false;
  await storage.put(key, true);
  // A crash after dispatch can leave no reply. Hold later writes on this
  // connector until the first one is definitively settled.
  await storage.put(pendingWrite(name), id);
  if (attemptId !== undefined) await storage.put(mcpWriteClaimed, true);
  return true;
}

export async function settleConnectorWrite(storage: Storage, name: string, requestId: string | number, attemptId?: string,
  dispatched = false): Promise<boolean> {
  if (dispatched && await storage.get(writesClosed(attemptId))) return false;
  const key = pendingWrite(name);
  if (await storage.get(key) !== fingerprint(name, requestId, attemptId)) return false;
  return storage.delete(key);
}

export async function closeConnectorWrites(storage: Storage, connectors: readonly string[], attemptId?: string): Promise<McpConnectorIssue[]> {
  await storage.put(writesClosed(attemptId), true);
  const issues: McpConnectorIssue[] = [];
  for (const connector of connectors) {
    if (await storage.get(pendingWrite(connector))) {
      issues.push({ code: mcpConnectorCodes.writeUnconfirmed, connector, mode: "read-write" });
    }
  }
  return issues;
}
