import { agentTimeoutOutcome, beforeAgentDeadline, deadlineElapsed, deadlineReached, deadlineView } from "./agent-deadline.ts";
import type { AgentDeadline, AgentDeadlineError } from "./agent-deadline.ts";
import { runSettings, sameRunSettings } from "./agent-settings.ts";
import type { AgentSettings } from "./agent-settings.ts";
import { providerView, terminal } from "./contract.ts";
import type { Agent, PresetAgent, AuthMode, AuthStrategy, ProviderError, RunInput, RunProfileReceipt, RunRouting, RunView, StrategyAttempt } from "./contract.ts";
import type { GithubRepository } from "./github-read.ts";
import { connectorAccessFor, mcpWriteClaimed, sameConnectorNames } from "./mcp-run-access.ts";
import type { ConnectorAccess } from "./mcp-run-access.ts";
import type { McpConnector } from "./mcp-policy.ts";
import type { McpConnectorIssue } from "./mcp-diagnostic.mjs";
import { sameRepository } from "./github-source.ts";
import type { RepositoryInput, RepositoryReference } from "./github-source.ts";
import type { ReviewView } from "./review.ts";
import type { GithubPreparedPublication } from "./github-publish.ts";
import { cancelPublication, failedPublication, publicationAcceptsDeadline, publicationPending, publicationView, receiptMatches,
  timeoutPublication } from "./publication-state.ts";
import type { PublicationState } from "./publication-state.ts";
import type { AdmissionOwnerError } from "./installation-admission.ts";
import { appendRunEvents } from "./run-events.ts";

const modes = {
  "api-key-only": ["api-key"],
  "api-key-first-then-subscription": ["api-key", "subscription"],
  "subscription-only": ["subscription"],
  "subscription-first-then-api-key": ["subscription", "api-key"],
} as const satisfies Record<AuthStrategy, readonly [AuthMode, AuthMode?]>;
const quota = "provider_quota_exhausted";
export const STRATEGY_RUN = "strategy-run";
const STRATEGY_POLL = "strategy-poll";

export type StrategyEnv = {
  SANDBOX_RUNNER_CLAUDE_AUTH_STRATEGY?: string;
  SANDBOX_RUNNER_CODEX_AUTH_STRATEGY?: string;
};

type Policy = { strategy: AuthStrategy; apiSpendCapConfirmed?: boolean };
export type StrategyRun = {
  id: string;
  agent: PresetAgent;
  prompt: string;
  overrides?: AgentSettings;
  routing?: RunRouting;
  repository?: RepositoryInput;
  repositoryRef?: RepositoryReference;
  githubRepository?: GithubRepository;
  review?: ReviewView;
  publish?: true;
  publicationMaxBytes?: number;
  publicationState?: PublicationState;
  policy: Policy;
  attempts: [StrategyAttempt] | [StrategyAttempt, StrategyAttempt];
  output?: string;
  cancellationRequested?: true;
  deadline?: AgentDeadline;
  timedOut?: true;
  connectorAccess?: ConnectorAccess;
  connectorIssues?: McpConnectorIssue[];
  connectorPolicy?: Record<string, McpConnector>;
  connectorGenerations?: Record<string, string>;
  connectorFallbackBlocked?: true;
  profile?: RunProfileReceipt;
};
type StrategyTransaction = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};
type StrategyStorage = {
  transaction<T>(callback: (transaction: StrategyTransaction) => Promise<T>): Promise<T>;
};
export type Reservation = RunView | ProviderError | AgentDeadlineError | AdmissionOwnerError | "auth_strategy_invalid" | "claude_defaults_invalid" | "opencode_disabled" |
  "github_repository_not_allowed" | "github_allowlist_invalid" | "github_checkout_not_configured" |
  "github_publication_configuration_invalid" | "run_index_unavailable" |
  "mcp_connector_configuration_invalid" | "mcp_connector_not_allowed" | "mcp_connector_auth_required" | null;
export type AttemptReservation = Reservation | { view: RunView; receipt: GithubPreparedPublication };

/** The credential modes a strategy may use, in attempt order. */
export function strategyModes(strategy: AuthStrategy): readonly AuthMode[] {
  return modes[strategy];
}

/**
 * The strategy for a new run, or why the run cannot start. Only a run without an explicit mode uses a strategy.
 * A profile that defers to the installation's strategy (required) never falls back to the default mode.
 */
export function admissionPolicy(agent: Agent, env: StrategyEnv, implicit: boolean, required: boolean):
  Policy | "auth_strategy_invalid" | undefined {
  if (!implicit || agent === "opencode") return;
  const policy = policyFor(agent, env);
  return policy === undefined && required ? "auth_strategy_invalid" : policy;
}

/** Readiness of a profile that defers to the strategy: the strategy is valid and every mode it may use has a credential. */
export function strategyReadiness(agent: PresetAgent, env: StrategyEnv, hasCredential: (mode: AuthMode) => boolean):
  "auth_strategy_invalid" | "provider_credential_not_configured" | undefined {
  const policy = policyFor(agent, env);
  if (typeof policy !== "object") return "auth_strategy_invalid";
  return strategyModes(policy.strategy).every(hasCredential) ? undefined : "provider_credential_not_configured";
}

export function policyFor(agent: PresetAgent, env: StrategyEnv): Policy | "auth_strategy_invalid" | undefined {
  const raw = agent === "claude" ? env.SANDBOX_RUNNER_CLAUDE_AUTH_STRATEGY : env.SANDBOX_RUNNER_CODEX_AUTH_STRATEGY;
  if (raw === undefined) return;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw);
  } catch {
    return "auth_strategy_invalid";
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "strategy" && key !== "apiSpendCapConfirmed")) {
    return "auth_strategy_invalid";
  }
  const { strategy, apiSpendCapConfirmed } = value;
  if (typeof strategy !== "string" || !Object.hasOwn(modes, strategy) ||
      (apiSpendCapConfirmed !== undefined && typeof apiSpendCapConfirmed !== "boolean") ||
      (strategy !== "subscription-only" && apiSpendCapConfirmed !== true)) {
    return "auth_strategy_invalid";
  }
  return { strategy: strategy as AuthStrategy, apiSpendCapConfirmed };
}

export function attemptName(rootId: string, attemptId: string): string {
  return `strategy-attempt:${rootId}:${attemptId}`;
}

function newAttempt(authMode: AuthMode, excludedIds: string[], settings: AgentSettings): StrategyAttempt {
  let operationId = crypto.randomUUID();
  while (excludedIds.includes(operationId)) operationId = crypto.randomUUID();
  return { operationId, authMode, status: "queued", cleanup: "pending", ...settings };
}

export function newStrategyRun(
  input: RunInput & { agent: PresetAgent }, policy: Policy, settings: AgentSettings = {}, routing?: RunRouting,
  githubRepository?: GithubRepository, publicationMaxBytes?: number, deadline?: AgentDeadline,
  connectorPolicy?: Record<string, McpConnector>,
  connectorGenerations?: Record<string, string>,
): StrategyRun {
  const { operationId: id, agent, prompt, overrides, repository, profile } = input;
  return {
    id, agent, prompt, policy, ...(overrides === undefined ? {} : { overrides }),
    ...(profile === undefined ? {} : { profile }),
    ...(routing === undefined ? {} : { routing }),
    ...(repository === undefined ? {} : { repository }),
    ...(input.repositoryRef === undefined ? {} : { repositoryRef: input.repositoryRef }),
    ...(githubRepository === undefined ? {} : { githubRepository }),
    ...(input.reviewProducer === undefined ? {} : { review: { producerAgent: input.reviewProducer } }),
    ...(input.connectors === undefined ? {} : { connectorAccess: connectorAccessFor(input.connectors, input.reviewProducer !== undefined),
      connectorPolicy, connectorGenerations }),
    ...(input.publish ? { publish: true, publicationMaxBytes, publicationState: { phase: "requested" } } : {}),
    ...(deadline === undefined ? {} : { deadline }),
    attempts: [newAttempt(modes[policy.strategy][0], [id], settings)],
  };
}

export function activeAttempt(run: StrategyRun): StrategyAttempt {
  return run.attempts[1] ?? run.attempts[0];
}

export function activeEgressAttempt(run: StrategyRun, id: string): StrategyAttempt | undefined {
  const attempt = activeAttempt(run);
  if (!run.cancellationRequested && !run.timedOut && !deadlineReached(run.deadline) &&
      attempt.operationId === id && !terminal(attempt.status)) return attempt;
}

export function strategyPreparationAllowed(run: StrategyRun, attemptId: string): boolean {
  const attempt = activeAttempt(run);
  return !run.cancellationRequested && !run.timedOut && !deadlineReached(run.deadline) && run.publicationState?.phase === "requested" &&
    attempt.operationId === attemptId && attempt.cleanup === "pending" &&
    (!terminal(attempt.status) || attempt.status === "succeeded");
}

export function settled(attempt: StrategyAttempt): boolean {
  return terminal(attempt.status) && attempt.cleanup !== "pending";
}

export function strategyView(run: StrategyRun): RunView {
  const { id, agent, attempts, output, policy } = run;
  const attempt = activeAttempt(run);
  const { authMode, cleanup } = attempt;
  const publishing = !!run.deadline && !run.cancellationRequested && attempt.status === "succeeded" &&
    publicationAcceptsDeadline(run.publicationState);
  const { status, reason } = run.timedOut ? agentTimeoutOutcome
    : run.cancellationRequested && attempt.status === "timed_out" ? { status: "cancelled", reason: "run_cancelled" } as const
      : publishing ? { status: "running" as const, reason: undefined } : attempt;
  const publication = publicationView(run.publicationState);
  return {
    id, agent, authMode, status, cleanup, strategy: policy.strategy, attempts, ...runSettings(attempt),
    ...providerView(run.routing), ...deadlineView(run.deadline),
    ...(run.repository === undefined ? {} : { repository: run.repository }),
    ...(run.profile === undefined ? {} : { profile: run.profile }),
    ...(run.review === undefined ? {} : { review: run.review }),
    ...(run.connectorAccess === undefined ? {} : { connectorAccess: run.connectorAccess }),
    ...(run.connectorIssues === undefined ? {} : { connectorIssues: run.connectorIssues }),
    ...(run.connectorFallbackBlocked && !run.timedOut ? { connectorFallbackBlocked: true as const } : {}),
    ...(publication === undefined ? {} : { publication }),
    ...(run.cancellationRequested ? { cancellationRequested: run.cancellationRequested } : {}),
    ...(reason === undefined ? {} : { reason }),
    ...(output === undefined || run.timedOut || publishing ? {} : { output }),
    ...(attempts.length === 2 ? { fallbackReason: quota } : {}),
  };
}

export async function writeStrategyRun(transaction: StrategyTransaction, next: StrategyRun, previous?: StrategyRun): Promise<void> {
  await transaction.put(STRATEGY_RUN, next);
  await appendRunEvents(transaction, previous && strategyView(previous), strategyView(next));
}

export async function requestStrategyCancellation(transaction: StrategyTransaction, run: StrategyRun): Promise<StrategyRun> {
  if (run.cancellationRequested || run.timedOut || (settled(activeAttempt(run)) && !publicationPending(run.publicationState))) return run;
  if (strategyDeadlineDue(run)) return expireStrategy(transaction, run);
  const updated: StrategyRun = { ...run, cancellationRequested: true,
    ...(run.publicationState ? { publicationState: cancelPublication(run.publicationState) } : {}) };
  await writeStrategyRun(transaction, updated, run);
  await transaction.delete(STRATEGY_POLL);
  await transaction.setAlarm(Date.now());
  return updated;
}

export function strategyDeadlineDue(run: StrategyRun, now = Date.now()): boolean {
  return !run.timedOut && !run.cancellationRequested && deadlineReached(run.deadline, now) &&
    (!settled(activeAttempt(run)) || publicationAcceptsDeadline(run.publicationState));
}

export function strategyAlarmTime(run: StrategyRun, scheduled: number): number {
  return run.deadline && !run.timedOut && !run.cancellationRequested &&
    (!settled(activeAttempt(run)) || publicationAcceptsDeadline(run.publicationState))
    ? Math.min(scheduled, run.deadline.deadlineAt) : scheduled;
}

function expiredStrategy(run: StrategyRun, observed = run): StrategyRun {
  const publicationState = timeoutPublication(run.publicationState);
  return { ...observed, timedOut: true, output: undefined,
    ...(run.review === undefined ? {} : { review: { producerAgent: run.review.producerAgent } }),
    ...(publicationState === undefined ? {} : { publicationState }) };
}

export async function expireStrategy(transaction: StrategyTransaction, run: StrategyRun): Promise<StrategyRun> {
  if (!strategyDeadlineDue(run)) return run;
  const expired = expiredStrategy(run);
  await writeStrategyRun(transaction, expired, run);
  await transaction.delete(STRATEGY_POLL);
  await transaction.setAlarm(Date.now());
  return expired;
}

type ReserveAttempt = (input: RunInput, settings: AgentSettings, routing: RunRouting | undefined, cancel: boolean,
  githubRepository?: GithubRepository, publicationMaxBytes?: number, deadline?: AgentDeadline) => Promise<AttemptReservation>;

async function observeStrategyAttempt(
  run: StrategyRun,
  reserve: ReserveAttempt,
): Promise<StrategyRun> {
  const previous = activeAttempt(run);
  if (settled(previous)) return run;
  const { authMode, operationId } = previous;
  const settings = runSettings(previous);
  const response = await reserve({
    operationId, authMode, agent: run.agent, prompt: run.prompt,
    ...(run.repository === undefined ? {} : { repository: run.repository }),
    ...(run.review === undefined ? {} : { reviewProducer: run.review.producerAgent }),
    ...(run.connectorAccess === undefined ? {} : { connectors: run.connectorAccess.connectors }),
    ...(run.profile === undefined ? {} : { profile: run.profile }),
    ...(run.publish ? { publish: true } : {}),
  }, settings, run.routing, run.cancellationRequested === true, run.githubRepository, run.publicationMaxBytes, run.deadline);
  const prepared = response && typeof response === "object" && "receipt" in response ? response : undefined;
  const child = response && typeof response === "object" && "view" in response ? response.view : response;
  if (!child || typeof child === "string" ||
      child.id !== operationId || child.agent !== run.agent || child.authMode !== authMode ||
      child.sandboxProvider !== run.routing?.sandboxProvider ||
      child.deadlineAt !== run.deadline?.deadlineAt ||
      !sameRepository(child.repository, run.repository) ||
      child.review?.producerAgent !== run.review?.producerAgent ||
      child.connectorAccess?.mode !== run.connectorAccess?.mode ||
      !sameConnectorNames(child.connectorAccess?.connectors, run.connectorAccess?.connectors) ||
      (run.review && child.status === "succeeded" && child.review?.verdict === undefined) ||
      !sameRunSettings(child, settings)) {
    // The reserved child could not be identified. Its cleanup cannot be attested.
    const failed: StrategyAttempt = terminal(previous.status)
      ? { ...previous, cleanup: "failed" }
      : { operationId, authMode, status: "failed", cleanup: "failed", reason: "run_failed", ...settings };
    return { ...run, attempts: run.attempts.length === 1 ? [failed] : [run.attempts[0], failed],
      ...(publicationPending(run.publicationState) ? { publicationState: failedPublication("github_publication_cleanup_failed") } : {}) };
  }
  const { status, cleanup, reason } = child;
  if ((terminal(previous.status) && (status !== previous.status || reason !== previous.reason)) ||
      (previous.status === "running" && status === "queued")) return run;
  if (status === previous.status && cleanup === previous.cleanup && reason === previous.reason) return run;
  const attempt: StrategyAttempt = {
    operationId, authMode, status, cleanup, ...settings, ...(reason === undefined ? {} : { reason }),
  };
  const publicationState = settled(attempt) && run.publicationState?.phase === "requested"
    ? publicationFromAttempt(run, child, prepared?.receipt) : run.publicationState;
  return {
    ...run,
    attempts: run.attempts.length === 1 ? [attempt] : [run.attempts[0], attempt],
    ...(settled(attempt) && child.output !== undefined ? { output: child.output } : {}),
    ...(child.review === undefined || run.timedOut ? {} : { review: child.review }),
    ...(publicationState ? { publicationState } : {}),
  };
}

function publicationFromAttempt(run: StrategyRun, child: RunView, receipt?: GithubPreparedPublication): PublicationState {
  if (child.cleanup !== "destroyed") return failedPublication("github_publication_cleanup_failed");
  if (child.status === "cancelled") return { phase: "settled", result: { status: "cancelled" } };
  if (child.status !== "succeeded") return failedPublication("github_publication_agent_not_succeeded");
  if (receipt && receiptMatches(receipt, run.githubRepository, run.id, run.repository?.sha)) {
    return { phase: "prepared", receipt };
  }
  if (child.publication?.status === "no_changes" || child.publication?.status === "failed") {
    return { phase: "settled", result: child.publication };
  }
  return failedPublication("github_publication_unavailable");
}

function finishStrategyPoll(previous: StrategyRun, observed: StrategyRun, connectorWriteStarted = false): StrategyRun {
  if (strategyDeadlineDue(previous)) return expiredStrategy(previous, observed);
  const attempt = activeAttempt(observed);
  const nextMode = modes[observed.policy.strategy][1];
  if (observed !== previous && !observed.cancellationRequested && !observed.timedOut && observed.attempts.length === 1 && nextMode &&
      attempt.status === "capacity" && attempt.reason === quota && attempt.cleanup === "destroyed") {
    if (connectorWriteStarted) return { ...observed, connectorFallbackBlocked: true };
    return { ...previous, attempts: [attempt, newAttempt(nextMode, [observed.id, attempt.operationId], runSettings(attempt))] };
  }
  return observed;
}

export async function pollStrategy(run: StrategyRun, reserve: ReserveAttempt): Promise<StrategyRun> {
  return finishStrategyPoll(run, await observeStrategyAttempt(run, reserve));
}

export async function advanceStrategy(
  storage: StrategyStorage,
  reserve: (rootId: string, input: RunInput, settings: AgentSettings, routing: RunRouting | undefined,
    cancel: boolean, githubRepository?: GithubRepository, publicationMaxBytes?: number, deadline?: AgentDeadline,
    connectorPolicy?: Record<string, McpConnector>, connectorGenerations?: Record<string, string>) => Promise<AttemptReservation>,
  timing: { advance: number; recovery: number },
): Promise<void> {
  const claim = await storage.transaction(async transaction => {
    let run = await transaction.get<StrategyRun>(STRATEGY_RUN);
    if (!run || settled(activeAttempt(run))) return;
    run = await expireStrategy(transaction, run);
    const ticket = crypto.randomUUID();
    await transaction.put(STRATEGY_POLL, ticket);
    await transaction.setAlarm(strategyAlarmTime(run, Date.now() + timing.recovery));
    return { run, ticket };
  });
  if (!claim) return;
  const { run, ticket } = claim;
  let observed: StrategyRun;
  try {
    const deadline = run.timedOut || run.cancellationRequested ? undefined : run.deadline;
    const reply = await beforeAgentDeadline(() =>
      observeStrategyAttempt(run, (input, settings, routing, cancel, githubRepository, publicationMaxBytes, inheritedDeadline) =>
        reserve(run.id, input, settings, routing, cancel, githubRepository, publicationMaxBytes, inheritedDeadline,
          run.connectorPolicy, run.connectorGenerations)), deadline);
    observed = reply === deadlineElapsed ? run : reply;
  } catch {
    // Reuse the persisted child identity if the reservation's reply was lost.
    if (!strategyDeadlineDue(run)) return;
    observed = run;
  }
  await storage.transaction(async transaction => {
    // A recovery alarm may have issued another poll while this RPC was pending.
    // Only the latest claim can update the journal and schedule its next alarm.
    if (await transaction.get<string>(STRATEGY_POLL) !== ticket) return;
    const connectorWriteStarted = run.connectorAccess?.mode === "read-write" && await transaction.get<boolean>(mcpWriteClaimed) === true;
    const next = finishStrategyPoll(run, observed, connectorWriteStarted);
    if (next !== run) {
      const current = await transaction.get<StrategyRun>(STRATEGY_RUN);
      if (current) await writeStrategyRun(transaction, {
        ...next, ...(current.connectorIssues === undefined ? {} : { connectorIssues: current.connectorIssues }),
      }, current);
    }
    await transaction.delete(STRATEGY_POLL);
    if (settled(activeAttempt(next))) {
      if (publicationPending(next.publicationState)) await transaction.setAlarm(Date.now());
      else await transaction.deleteAlarm();
    } else {
      const sameStage = next.attempts.length === run.attempts.length && next.timedOut === run.timedOut;
      const delay = sameStage ? timing.advance : 0;
      await transaction.setAlarm(strategyAlarmTime(next, Date.now() + delay));
    }
  });
}
