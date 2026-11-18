export const exit = {
  success: 0,
  runFailure: 1,
  usage: 2,
  configuration: 3,
  capacity: 4,
  timeout: 5,
  requestFailure: 6,
};

export class CliError extends Error {
  constructor(code, message, exitCode, { httpStatus, uncertain, admission, connectorIssue, recovery, reconnectScope, workerVersionId,
    issues, profile } = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.httpStatus = httpStatus;
    this.uncertain = uncertain;
    this.admission = admission;
    this.connectorIssue = connectorIssue;
    this.recovery = recovery;
    this.reconnectScope = reconnectScope;
    this.workerVersionId = workerVersionId;
    this.issues = issues;
    this.profile = profile;
  }
}

export function readTimeout(env) {
  const configuredTimeout = env.SANDBOX_RUNNER_TIMEOUT_MS ?? "30000";
  const timeout = Number(configuredTimeout);
  if (!/^\d+$/.test(configuredTimeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new CliError("configuration_error", "SANDBOX_RUNNER_TIMEOUT_MS must be between 1 and 2147483647.", exit.configuration);
  }
  return timeout;
}
