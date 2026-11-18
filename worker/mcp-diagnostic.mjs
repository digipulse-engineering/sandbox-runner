import { isMcpConnectorName } from "./run-input-validation.mjs";

export const mcpConnectorCodes = Object.freeze({
  configurationInvalid: "mcp_connector_configuration_invalid",
  authRequired: "mcp_connector_auth_required",
  reauthRequired: "mcp_connector_reauth_required",
  refreshUnconfirmed: "mcp_connector_refresh_unconfirmed",
  authRejected: "mcp_connector_auth_rejected",
  credentialChanged: "mcp_connector_credential_changed",
  accessDenied: "mcp_connector_access_denied",
  policyDenied: "mcp_tool_access_denied",
  toolUnavailable: "mcp_connector_tool_unavailable",
  toolFailed: "mcp_connector_tool_failed",
  rateLimited: "mcp_connector_rate_limited",
  unavailable: "mcp_connector_unavailable",
  writeUnconfirmed: "mcp_connector_write_unconfirmed",
});

/** @typedef {(typeof mcpConnectorCodes)[keyof typeof mcpConnectorCodes]} McpConnectorCode */
/** @typedef {{code: McpConnectorCode, connector: string, mode: "read-only" | "read-write", retryAfterSeconds?: number}} McpConnectorIssue */

const codes = new Set(Object.values(mcpConnectorCodes));

/** @param {unknown} code @returns {code is McpConnectorCode} */
export function isMcpConnectorCode(code) {
  return codes.has(/** @type {McpConnectorCode} */ (code));
}

/** @param {unknown} value @returns {McpConnectorIssue | undefined} */
export function checkedMcpConnectorIssue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !("code" in value) || !("connector" in value) || !("mode" in value)) return;
  const { code, connector, mode } = value;
  const retryAfterSeconds = "retryAfterSeconds" in value ? value.retryAfterSeconds : undefined;
  if (!isMcpConnectorCode(code) || !isMcpConnectorName(connector) ||
      (mode !== "read-only" && mode !== "read-write") ||
      (retryAfterSeconds !== undefined && (typeof retryAfterSeconds !== "number" ||
        !Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 0))) return;
  return { code, connector, mode, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) };
}

/** @param {string | null} value @param {number} now @returns {number | undefined} */
export function mcpRetryAfterSeconds(value, now) {
  if (value === null) return;
  const httpDate = /^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)[ ,]/i;
  const seconds = /^\d+$/.test(value) ? Number(value) : httpDate.test(value)
    ? Math.max(0, Math.ceil((Date.parse(value) - now) / 1_000)) : NaN;
  if (Number.isSafeInteger(seconds) && Number.isSafeInteger(now + seconds * 1_000)) return seconds;
}
