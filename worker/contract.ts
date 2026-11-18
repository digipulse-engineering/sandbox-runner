import { isAgentTimeoutMs } from "./agent-deadline.ts";
import { sameRunSettings } from "./agent-settings.ts";
import type { AgentSettings } from "./agent-settings.ts";
import { parseRepositoryRequest, sameRequestedSource } from "./github-source.ts";
import type { RepositoryInput, RepositoryReference } from "./github-source.ts";
import { parseConnectorNames, sameConnectorNames } from "./mcp-run-access.ts";
import type { ConnectorAccess } from "./mcp-run-access.ts";
import type { McpConnectorIssue } from "./mcp-diagnostic.mjs";
import type { ReviewView } from "./review.ts";
import type { PublicationView } from "./publication-state.ts";
import { resolveOpenCodeSettings } from "./opencode-settings.ts";
import type { ModelProvider } from "./opencode-settings.ts";
import { isAgentEffort, isClaudeModel, isCodexModel, operationId } from "./run-input-validation.mjs";

export { operationId };

export type PresetAgent = "claude" | "codex";
export type Agent = PresetAgent | "opencode";
export type AuthMode = "subscription" | "api-key";
export type AuthStrategy = "api-key-only" | "api-key-first-then-subscription" |
  "subscription-only" | "subscription-first-then-api-key";
export type RunStatus = "queued" | "running" | "succeeded" | "capacity" | "auth_required" | "failed" | "unanswered" | "cancelled" | "timed_out";
export type CleanupStatus = "pending" | "destroyed" | "failed";
export type TerminalStatus = Exclude<RunStatus, "queued" | "running">;
export type Outcome = { status: TerminalStatus; output?: string; reason?: string };
export type RunProfileReceipt = {
  slug: string;
  revision: string;
  source: "client-supplied" | "worker-catalog";
  clientId?: string;
  deliveryId?: string;
  requestDigest: string;
  producerSource?: "declared";
};
export type RunInput = {
  operationId: string; agent: Agent; authMode: AuthMode; prompt: string;
  overrides?: AgentSettings; modelProvider?: ModelProvider; repository?: RepositoryInput; repositoryRef?: RepositoryReference;
  reviewProducer?: PresetAgent; publish?: true; timeoutMs?: number;
  connectors?: string[];
  profile?: RunProfileReceipt;
};
export type SandboxProvider = "cloudflare";
export type ProviderRequest = { sandboxProvider?: string; explicitAuth: boolean };
export type RunRouting = { request: ProviderRequest; sandboxProvider: SandboxProvider };
export type ProviderError = "sandbox_provider_unavailable" | "sandbox_provider_default_invalid";
export type StrategyAttempt = AgentSettings & {
  operationId: string;
  authMode: AuthMode;
  status: RunStatus;
  cleanup: CleanupStatus;
  reason?: string;
};
export type RunView = AgentSettings & {
  id: string;
  agent: Agent;
  kind?: "agent";
  sandboxProvider?: SandboxProvider;
  modelProvider?: ModelProvider;
  repository?: RepositoryInput;
  publication?: PublicationView;
  authMode?: AuthMode;
  status: RunStatus;
  cleanup: CleanupStatus;
  output?: string;
  reason?: string;
  strategy?: AuthStrategy;
  review?: ReviewView;
  attempts?: StrategyAttempt[];
  fallbackReason?: "provider_quota_exhausted";
  cancellationRequested?: true;
  deadlineAt?: number;
  connectorAccess?: ConnectorAccess;
  connectorIssues?: McpConnectorIssue[];
  connectorFallbackBlocked?: true;
  profile?: RunProfileReceipt;
};

export function isAuthMode(value: unknown): value is AuthMode {
  return value === "subscription" || value === "api-key";
}

export function effectiveAuthMode(agent: Agent, authMode?: AuthMode): AuthMode {
  return authMode ?? (agent === "claude" ? "subscription" : "api-key");
}

export function sameProfileRequest(left?: RunProfileReceipt, right?: RunProfileReceipt): boolean {
  return left?.requestDigest === right?.requestDigest && left?.source === right?.source &&
    left?.clientId === right?.clientId && left?.deliveryId === right?.deliveryId;
}

export function matchesRunInput(
  previous: {
    agent: Agent; authMode?: AuthMode; prompt: string; overrides?: AgentSettings; repository?: RepositoryInput;
    repositoryRef?: RepositoryReference; review?: ReviewView; connectorAccess?: ConnectorAccess;
    publish?: true; modelProvider?: ModelProvider; profile?: RunProfileReceipt;
  },
  input: RunInput,
): boolean {
  return sameProfileRequest(previous.profile, input.profile) &&
    previous.agent === input.agent && previous.prompt === input.prompt &&
    effectiveAuthMode(previous.agent, previous.authMode) === input.authMode &&
    previous.modelProvider === input.modelProvider && sameRunSettings(previous.overrides, input.overrides) &&
    sameRequestedSource(previous, input) && previous.review?.producerAgent === input.reviewProducer &&
    previous.publish === input.publish && sameConnectorNames(previous.connectorAccess?.connectors, input.connectors);
}

export function parseInput(value: unknown, explicitAuth: boolean): RunInput | undefined {
  if (!value || typeof value !== "object") return;
  const input = value as Record<string, unknown>;
  const id = operationId(input.operationId);
  const { agent, authMode, prompt } = input;
  if (!id || (agent !== "claude" && agent !== "codex") || typeof prompt !== "string" || !prompt.trim()) return;
  if (explicitAuth) {
    return isAuthMode(authMode) ? { operationId: id, agent, authMode, prompt } : undefined;
  }
  if (!Object.hasOwn(input, "authMode")) {
    return { operationId: id, agent, authMode: effectiveAuthMode(agent), prompt };
  }
}

export function parseClaudeOverrideInput(value: unknown): { input: RunInput; explicitAuth: boolean } | undefined {
  if (!value || typeof value !== "object") return;
  const explicitAuth = Object.hasOwn(value, "authMode");
  const input = parseInput(value, explicitAuth);
  if (input?.agent !== "claude") return;
  const overrides = parseRunSettings("claude", value as Record<string, unknown>);
  if (!overrides || Object.keys(overrides).length === 0) return;
  return { input: { ...input, overrides }, explicitAuth };
}

function parseRunSettings(agent: PresetAgent, fields: Record<string, unknown>): AgentSettings | undefined {
  const overrides: AgentSettings = {};
  if (Object.hasOwn(fields, "model")) {
    const validModel = agent === "claude" ? isClaudeModel : isCodexModel;
    if (!validModel(fields.model)) return;
    overrides.model = fields.model;
  }
  if (Object.hasOwn(fields, "effort")) {
    if (!isAgentEffort(fields.effort)) return;
    overrides.effort = fields.effort;
  }
  return overrides;
}

const providerRunFields = new Set([
  "operationId", "kind", "agent", "prompt", "authMode", "modelProvider", "model", "effort", "sandboxProvider", "repository", "reviewProducer", "publish", "timeoutMs", "connectors",
]);
const providerName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function parseProviderRunInput(value: unknown):
  { input: RunInput; explicitAuth: boolean; providerRequest: ProviderRequest } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const fields = value as Record<string, unknown>;
  if (fields.kind !== "agent" || Object.keys(fields).some(field => !providerRunFields.has(field))) return;
  const { sandboxProvider } = fields;
  if (Object.hasOwn(fields, "sandboxProvider") &&
      (typeof sandboxProvider !== "string" || !providerName.test(sandboxProvider) || sandboxProvider.trim() !== sandboxProvider)) return;
  const explicitAuth = Object.hasOwn(fields, "authMode");
  const { timeoutMs } = fields;
  if (Object.hasOwn(fields, "timeoutMs") && !isAgentTimeoutMs(timeoutMs)) return;
  const providerRequest = { explicitAuth, ...(typeof sandboxProvider === "string" ? { sandboxProvider } : {}) };
  const source = parseRepositoryRequest(fields.repository);
  if (Object.hasOwn(fields, "repository") && !source) return;
  if (fields.agent === "opencode") {
    const id = operationId(fields.operationId);
    const { prompt, model, effort, reviewProducer } = fields;
    const reviewing = Object.hasOwn(fields, "reviewProducer");
    const settings = resolveOpenCodeSettings(fields.modelProvider, model, effort, reviewing);
    const connectors = parseConnectorNames(fields.connectors);
    if (!id || !settings || typeof prompt !== "string" || !prompt.trim() || !prompt.isWellFormed() || prompt.includes("\0") ||
        fields.authMode !== "api-key" || Object.hasOwn(fields, "publish") ||
        (reviewing && (!(source && "sha" in source) || (reviewProducer !== "claude" && reviewProducer !== "codex"))) ||
        (Object.hasOwn(fields, "connectors") && (!reviewing || !connectors))) return;
    const overrides = {
      ...(typeof model === "string" ? { model } : {}),
      ...(effort === undefined ? {} : { effort: settings.effort }),
    };
    return {
      input: { operationId: id, agent: "opencode", authMode: "api-key", prompt, modelProvider: settings.modelProvider,
        ...(model !== undefined || effort !== undefined ? { overrides } : {}),
        ...(source === undefined ? {} : "ref" in source ? { repositoryRef: source } : { repository: source }),
        ...(reviewProducer === "claude" || reviewProducer === "codex" ? { reviewProducer } : {}),
        ...(connectors ? { connectors } : {}),
        ...(typeof timeoutMs === "number" ? { timeoutMs } : {}) },
      explicitAuth, providerRequest,
    };
  }
  if (Object.hasOwn(fields, "modelProvider")) return;
  const input = parseInput(fields, explicitAuth);
  if (!input || input.agent === "opencode") return;
  const overrides = parseRunSettings(input.agent, fields);
  if (!overrides) return;
  if (Object.keys(overrides).length !== 0) input.overrides = overrides;
  if (Object.hasOwn(fields, "connectors")) {
    const connectors = parseConnectorNames(fields.connectors);
    if (!connectors) return;
    input.connectors = connectors;
  }
  if (typeof timeoutMs === "number") input.timeoutMs = timeoutMs;
  if (source) {
    if ("ref" in source) input.repositoryRef = source;
    else input.repository = source;
  }
  if (Object.hasOwn(fields, "reviewProducer")) {
    const producer = fields.reviewProducer;
    if (Object.hasOwn(fields, "publish") || !input.repository ||
        (producer !== "claude" && producer !== "codex") || producer === input.agent) return;
    input.reviewProducer = producer;
  }
  if (Object.hasOwn(fields, "publish")) {
    if (fields.publish !== true || (!input.repository && !input.repositoryRef)) return;
    input.publish = true;
  }
  return { input, explicitAuth, providerRequest };
}

export function resolveRunRouting(request: ProviderRequest, configuredDefault?: string): RunRouting | ProviderError {
  if (request.sandboxProvider !== undefined && request.sandboxProvider !== "cloudflare") {
    return "sandbox_provider_unavailable";
  }
  if (request.sandboxProvider === undefined && configuredDefault !== undefined && configuredDefault !== "cloudflare") {
    return "sandbox_provider_default_invalid";
  }
  return { request, sandboxProvider: "cloudflare" };
}

export function sameProviderRequest(left: ProviderRequest | undefined, right: ProviderRequest | undefined): boolean {
  return left?.explicitAuth === right?.explicitAuth && left?.sandboxProvider === right?.sandboxProvider;
}

export function providerView(routing: RunRouting | undefined): Pick<RunView, "kind" | "sandboxProvider"> {
  return routing === undefined ? {} : { kind: "agent", sandboxProvider: routing.sandboxProvider };
}

export function terminal(status: RunStatus): status is TerminalStatus {
  return status !== "queued" && status !== "running";
}
