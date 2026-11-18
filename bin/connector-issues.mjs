import { checkedMcpConnectorIssue, mcpConnectorCodes as code } from "../worker/mcp-diagnostic.mjs";
import { oauthScopes } from "../worker/mcp-oauth-format.mjs";
import { authText, terminalAuthLocale } from "./auth-i18n.mjs";
import { versionPattern } from "./auth.mjs";
import { CliError, exit } from "./cli-errors.mjs";

const recoveryByCode = new Map([
  [code.configurationInvalid, ["check_configuration", "Check the connector configuration on the Worker.", [503]]],
  [code.authRequired, ["check_credentials", "Check the connector credentials configured on the Worker.", [503]]],
  [code.rateLimited, ["retry_later", "The connector is rate limited. Wait before trying again.", [429]]],
  [code.unavailable, ["retry_later", "The connector is temporarily unavailable. Check its status before retrying.", [503]]],
  [code.reauthRequired, ["connector_login", "Reconnect the connector in your browser.", [503]]],
  [code.refreshUnconfirmed, ["connector_login", "The connector's credential refresh could not be confirmed. Reconnect in your browser.", [503]]],
  [code.accessDenied, ["check_permissions", "Check the connector permissions and the run's access policy.", [503]]],
  [code.policyDenied, ["check_permissions", "The run's access policy denied this connector operation.", []]],
  [code.toolUnavailable, ["check_tool", "The requested tool is unavailable. Check the connector's tool catalog.", []]],
  [code.toolFailed, ["check_tool", "The connector tool reported an error. Check the run events before retrying.", []]],
  [code.writeUnconfirmed, ["verify_write", "Verify the write at the connector before attempting it again.", []]],
  [code.authRejected, ["check_credentials", "The connector rejected authentication. Check its credentials and access policy.", [503]]],
  [code.credentialChanged, ["check_credentials", "The connector authorization changed during the run. Inspect the run before submitting another one.", [503]]],
]);

export const connectorRecoveryActions = [...new Set([...recoveryByCode.values()].map(([action]) => action))];

export function connectorIssueForClient(value) {
  const issue = checkedMcpConnectorIssue(value);
  const recovery = issue && recoveryByCode.get(issue.code);
  if (recovery) return { ...issue, recovery: { action: recovery[0] } };
}

export function checkedConnectorIssues(value, access) {
  if (!access || !Array.isArray(value)) return;
  const issues = [];
  const seen = new Set();
  for (const item of value) {
    const issue = connectorIssueForClient(item);
    if (!issue || issue.mode !== access.mode || !access.connectors.includes(issue.connector)) return;
    const key = issue.connector + ":" + issue.code;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  }
  return issues;
}

export function connectorIssueFailure(command, httpStatus, body) {
  if (command.name !== "run" || body?.connectorIssue === undefined) return;
  const issue = checkedMcpConnectorIssue(body.connectorIssue);
  const mode = command.reviewProducer ? "read-only" : "read-write";
  const recovery = issue && recoveryByCode.get(issue.code);
  if (!recovery || !recovery[2].includes(httpStatus) || !command.connectors?.includes(issue.connector) ||
      issue.mode !== mode || body.error !== issue.code || body.operationId !== command.id ||
      body.admission !== "rejected") {
    return new CliError("invalid_response", "The Worker returned an invalid connector diagnostic.", exit.requestFailure,
      { httpStatus, uncertain: true });
  }
  const [action, message] = recovery;
  const scope = typeof body.reconnectScope === "string" && oauthScopes(body.reconnectScope) ? body.reconnectScope : undefined;
  const workerVersionId = typeof body.workerVersionId === "string" && versionPattern.test(body.workerVersionId)
    ? body.workerVersionId.toLowerCase() : undefined;
  const exitCode = action === "retry_later" ? exit.requestFailure : exit.configuration;
  return new CliError(issue.code, message, exitCode, {
    httpStatus,
    admission: "rejected",
    connectorIssue: issue,
    recovery: { action, retry: "same_operation_id" },
    reconnectScope: action === "connector_login" ? scope : undefined,
    workerVersionId: action === "connector_login" ? workerVersionId : undefined,
  });
}

export function connectorIssueHint(issue, env, overrideAction) {
  const recovery = recoveryByCode.get(issue.code);
  if (!recovery) return;
  const action = overrideAction ?? recovery[0];
  const message = action === recovery[0] ? recovery[1] : "Check the connector configuration on the Worker.";
  const locale = terminalAuthLocale(env);
  const lines = [`${issue.connector} · ${authText(locale, issue.mode)}`, authText(locale, message)];
  if (action === "connector_login") {
    lines.push(authText(locale, "Use the account and Worker for this Runner."));
    lines.push(`sandbox-runner connector login ${issue.connector} --mode ${issue.mode} --scope '<scopes>' --account '<account-id>' --worker '<worker-name>'`);
  }
  if (issue.retryAfterSeconds !== undefined) {
    lines.push(`${authText(locale, "Retry after (seconds)")} ${issue.retryAfterSeconds}`);
  }
  return lines.join("\n");
}
