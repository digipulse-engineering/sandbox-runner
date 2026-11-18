import type { McpAccessMode } from "./mcp-policy.ts";

export { parseConnectorNames } from "./run-input-validation.mjs";
export type { McpAccessMode };
export type ConnectorAccess = { mode: McpAccessMode; connectors: string[] };

export const mcpWriteClaimed = "mcp-write-claimed";
export const mcpContainerHost = "mcp.harness.internal";

export function sameConnectorNames(left?: readonly string[], right?: readonly string[]): boolean {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export function connectorAccessFor(connectors: string[] | undefined, review: boolean): ConnectorAccess | undefined {
  if (connectors) return { mode: review ? "read-only" : "read-write", connectors };
}
