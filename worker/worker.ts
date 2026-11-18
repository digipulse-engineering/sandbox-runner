import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { claudeCode, codex, containerAgent } from "./pinned-src/harness/container/agents";
import type { ContainerAgent } from "./pinned-src/harness/container/agents";
import type { ContainerEgressProps } from "./pinned-src/harness/container/egress";
import { ContainerHarness } from "./pinned-src/harness/container/harness";
import { Lifecycle } from "./pinned-src/lifecycle";
import type { LifecycleJobContext } from "./pinned-src/lifecycle";
import { admissionGuardBinding, admissionGuardPath, parseGuardAction, readAdmissionGuard,
  readGuardOperation, validGuardId, validGuardToken } from "./admission-guard";
import { agentTimeoutOutcome, beforeAgentDeadline, deadlineElapsed, deadlineReached, deadlineView, resolveAgentDeadline,
  runDeadlineFetch, sameAgentDeadline } from "./agent-deadline";
import type { AgentDeadline } from "./agent-deadline";
import { codexPresetSettings, sameRunSettings } from "./agent-settings";
import type { AgentSettings } from "./agent-settings";
import { resolveClaudeSettings } from "./claude-settings";
import type { ClaudeDefaultsEnv } from "./claude-settings";
import { guardedContainerStart } from "./container-start";
import { effectiveAuthMode, isAuthMode, matchesRunInput, operationId, parseClaudeOverrideInput, parseInput,
  parseProviderRunInput, providerView, resolveRunRouting, sameProfileRequest, sameProviderRequest, terminal } from "./contract";
import type { Agent, AuthMode, Outcome, ProviderError, ProviderRequest, RunInput, RunProfileReceipt, RunRouting, RunView } from "./contract";
import { nextInference, outcome } from "./diagnostics";
import type { InferenceAttempt, InferenceEvent } from "./diagnostics";
import { fixtureFor, fixtureResponse } from "./fixtures";
import type { Fixture } from "./fixtures";
import { apiTimeoutMs, admitGithubCheckout, githubAppCredentials, githubCheckoutFixture } from "./github-checkout";
import type { GithubCheckoutEnv, GithubCheckoutError } from "./github-checkout";
import { githubAgentFixture, githubCodexPublicationFixture } from "./github-agent-fixture";
import { githubFixtureFetcher, githubFixtureReadToken, githubReferenceFixtureFetcher } from "./github-fixtures";
import { githubPublicationFixtureResponse, githubPublicationFixtureToken } from "./github-publication-fixture";
import { exportGithubWorkspace, GithubWorkspaceError, publicationWireBudget } from "./github-export";
import { GithubPublicationError, prepareGithubPublication, publishGithubReference, reconcileGithubReference } from "./github-publish";
import type { GithubPreparedPublication, GithubPublicationResult, PublicationOptions } from "./github-publish";
import { forwardGithubRead, githubGitHost, mintGithubReadToken } from "./github-read";
import type { GithubRepository } from "./github-read";
import { resolveGithubReference } from "./github-reference";
import type { GithubReferenceError } from "./github-reference";
import { sameRequestedSource } from "./github-source";
import type { RepositoryReference } from "./github-source";
import { acquireInstallationAdmission, admissionGenerationKey, checkInstallationIndexWrite, claimInstallationReconciliation,
  expediteInstallationReconciliation, fenceInstallationAdmission, finishInstallationReconciliation, initializeInstallationAdmission, installationFenceAllows,
  installationGuardUnverified, installationLimitBinding, scheduleInstallationReconciliation, updateInstallationGuard,
  validAdmissionGeneration } from "./installation-admission";
import type { AdmissionDecision, AdmissionError, AdmissionObservation, AdmissionOwner, AdmissionOwnerError } from "./installation-admission";
import { GithubReadError, mintGithubCiToken, mintGithubMcpToken } from "./github-auth";
import { checkedMcpConnectorIssue, mcpConnectorCodes } from "./mcp-diagnostic.mjs";
import type { McpConnectorIssue } from "./mcp-diagnostic.mjs";
import { githubCiToolName, isPublicContext7, mcpConnectorName, narrowMcpConnector, parseMcpRegistry } from "./mcp-policy";
import type { McpConnector } from "./mcp-policy";
import { forwardMcp } from "./mcp-relay";
import { isRestrictedApiBinding, restrictedApiFetcher, restrictedApiKey } from "./mcp-restricted-api";
import { mcpSession } from "./mcp-session";
import type { McpInitializeReply, McpInitializeResult, McpUpstreamSession } from "./mcp-session";
import { isMcpOAuthBinding, McpOAuthCredentials, mcpOAuthRequestTimeoutMs, parseMcpOAuthGrant } from "./mcp-oauth";
import type { McpCredentialResult } from "./mcp-oauth";
import { connectorAccessFor, mcpContainerHost, sameConnectorNames } from "./mcp-run-access";
import type { ConnectorAccess, McpAccessMode } from "./mcp-run-access";
import { claimConnectorWrite, closeConnectorWrites, settleConnectorWrite } from "./mcp-write";
import { hasDuplicateJsonKeys } from "./profile-json.mjs";
import { cancelPublication, claimReference, failedPublication, finishAgentPublication, finishReference,
  publicationAcceptsDeadline, publicationPending, publicationView, receiptMatches, recoveryAlarm, timeoutPublication } from "./publication-state";
import type { PublicationState } from "./publication-state";
import { openCodeProviderConfig, providerConfig, providerCredential } from "./provider";
import type { ProviderEnv } from "./provider";
import { isModelProvider, openCodeAnthropicVersion, openCodeEnv, openCodeModelRef, openCodePlaceholder,
  resolveOpenCodeSettings } from "./opencode-settings";
import type { ModelProvider } from "./opencode-settings";
import { openCodeFixtureFor, openCodeFixtureResponse, verifyOpenCodeWitness } from "./opencode-fixtures";
import type { OpenCodeFixture } from "./opencode-fixtures";
import { openCodeNetworkBlocked, verifyOpenCodeNetwork } from "./opencode-network-fixture";
import type { OpenCodeNetworkProof } from "./opencode-network-fixture";
import { guardedForward } from "./relay";
import { reviewPrompt, withReviewResult } from "./review";
import { appendRunEvents, parseEventsCursor, pendingVitestEventsPage, runEventsPage } from "./run-events";
import { initializeRunIndex, openCodeListHeader, parseRunListQuery, pendingRunIndex, publishPendingRun, readRunIndex,
  readTeamDenials, recordRunIndex, recordTeamDenial, runIndexName } from "./run-index";
import type { RunListQuery, RunSummary, TeamDenial } from "./run-index";
import { ProfileError, profileReceipt, profileRevision, resolveProfileRequest, validProfileSlug } from "./run-profiles.mjs";
import { serveAccessMcp } from "./mcp-access";
import type { AccessMcpEnv } from "./mcp-access";
import { allowedRunOwner, catalogStorageKeys, resolveTeamProfile, sameTokenDigest, storedCatalog, teamClient, teamClientByEmail, teamProfile, TeamRequestError, tokenDigest } from "./team-access";
import type { TeamGrant, TeamCatalog } from "./team-access";
import { digest, parseTeamCatalog } from "./team-catalog.mjs";
import { activeAttempt, activeEgressAttempt, advanceStrategy, attemptName, expireStrategy, newStrategyRun, policyFor,
  requestStrategyCancellation, settled, strategyPreparationAllowed, STRATEGY_RUN, strategyAlarmTime, strategyDeadlineDue, strategyView, writeStrategyRun } from "./strategy";
import type { AttemptReservation, Reservation, StrategyEnv, StrategyRun } from "./strategy";
import { parseTestSubmission, sameTestSubmission } from "./vitest/admission";
import type { TestAdmission, TestSubmission } from "./vitest/admission";
import { createVitestState, vitestView } from "./vitest/state";
import type { VitestRunView } from "./vitest/state";

export { VitestEgress, VitestRun } from "./vitest/owner";

const RUN = "run";
const VITEST_ADMISSION = "vitest-admission";
const PENDING_ADMISSION = "github-reference-resolution";
const INFERENCE = "inference-attempt";
const CLEANUP_FAILURES = "cleanup-failures";
const ADVANCE = "sandbox-runner-advance";
const ADVANCE_INTERVAL_MS = 2_000;
// Protect external reservations and container destruction from DO eviction.
const RECOVERY_INTERVAL_MS = 30_000;
// Match the platform's one initial alarm attempt plus six retries. Store the
// failure count because replacing the alarm for recovery resets its retryCount.
// https://developers.cloudflare.com/durable-objects/api/alarms/#alarm
const CLEANUP_FAILURE_LIMIT = 7;
// Leave room below the SQLite DO 2 MiB key/value limit for the serialized record.
const REQUEST_BYTES = 1024 * 1024;
const VITEST_LOG_BYTES = 32 * 1024;
const CLAUDE_PLACEHOLDER = "sandbox-runner-claude-placeholder";
const CODEX_SUBSCRIPTION_CONFIG = [
  'model_providers.gateway.http_headers={originator="sandbox-runner"}',
  'model_providers.gateway.env_key="ACCESS_TOKEN"',
  "model_providers.gateway.requires_openai_auth=false",
  "model_providers.gateway.supports_websockets=false",
  'web_search="disabled"',
  "features.enable_request_compression=false",
  "check_for_update_on_startup=false",
];

type RunRecord = RunView & {
  prompt: string; strategyRunId?: string; overrides?: AgentSettings; routing?: RunRouting;
  githubRepository?: GithubRepository;
  repositoryRef?: RepositoryReference;
  publish?: true;
  publicationMaxBytes?: number;
  publicationState?: PublicationState;
  fixtureNetwork?: OpenCodeNetworkProof;
  deadline?: AgentDeadline;
  timedOut?: true;
  connectorPolicy?: Record<string, McpConnector>;
  connectorGenerations?: Record<string, string>;
};
type TaggedRoute = ContainerAgent["egress"][number] & {
  runId: string;
  strategyRunId?: string;
  agent: Agent;
  authMode?: AuthMode;
  modelProvider?: ModelProvider;
  openCodeFixture?: OpenCodeFixture;
  openCodeFixtureEffort?: "high" | "xhigh";
  openCodeReview?: true;
  fixture?: Fixture;
  githubWorkspaceFixture?: "checkout" | "review" | "publication";
  deadlineAt?: number;
};
type WorkerEnv = Env & ProviderEnv & StrategyEnv & ClaudeDefaultsEnv & GithubCheckoutEnv & AccessMcpEnv & {
  SANDBOX_RUNNER_DEFAULT_SANDBOX_PROVIDER?: string;
  SANDBOX_RUNNER_AGENT_TIMEOUT_MS?: string;
  SANDBOX_RUNNER_OPENCODE?: string;
  SANDBOX_RUNNER_MCP_CONNECTORS?: string;
  SANDBOX_RUNNER_VERSION?: { id: string };
  SANDBOX_RUNNER_GITHUB_PUBLICATION_MAX_BYTES: string;
  [installationLimitBinding]?: string;
  [admissionGuardBinding]?: string;
};
type ReservationOptions = { explicitAuth?: boolean; providerRequest?: ProviderRequest; strategyRunId?: string;
  settings?: AgentSettings; parentRouting?: RunRouting; cancel?: boolean; parentGithubRepository?: GithubRepository;
  publicationMaxBytes?: number; parentDeadline?: AgentDeadline; admission?: AdmissionOwner;
  parentConnectorPolicy?: string; parentConnectorGenerations?: string };
type GithubEgressProps = { runId: string; strategyRunId?: string; deadlineAt?: number };
type McpEgressProps = { runId: string; strategyRunId?: string };
type McpRoute = { connector: McpConnector; mode: McpAccessMode; repository?: GithubRepository; sha?: string;
  deadlineAt?: number; generation?: string };
type McpAdmissionError = "mcp_connector_configuration_invalid" | "mcp_connector_not_allowed";
type McpAdmissionFailure = { connectorIssue: McpConnectorIssue; reconnectScope?: string };
type AgentReservation = Reservation | McpAdmissionFailure;
type McpPreflight = { connectors: Record<string, McpConnector>; generations: Record<string, string>;
  mode: McpAccessMode; repository?: GithubRepository };
type Runtime = { harness: ContainerHarness; lifecycle: Lifecycle<WorkerEnv> };
type VitestReservationError = ProviderError | GithubCheckoutError | AdmissionOwnerError | "vitest_not_configured" | "run_index_unavailable";
type Submission = { input: RunInput; explicitAuth: boolean; providerRequest?: ProviderRequest } | { vitest: TestSubmission };
type PendingAdmission = { nonce: string; fingerprint: string; generation?: string; deadlineAt: number; clientId?: string };
type PendingReference = PendingAdmission & { repository: GithubRepository };
type ReferenceReservation = AgentReservation | VitestRunView | VitestReservationError | GithubReferenceError;

function activeAdmission(pending: PendingAdmission | undefined): boolean {
  return pending !== undefined && Date.now() < pending.deadlineAt;
}

async function clearPendingAdmission(transaction: DurableObjectTransaction, pending: PendingAdmission) {
  if (pending.generation !== undefined) await fenceInstallationAdmission(transaction, pending.generation);
  await transaction.delete(PENDING_ADMISSION);
  await transaction.deleteAlarm();
}

async function checkPendingAdmissionClaim(transaction: DurableObjectTransaction, claim?: PendingAdmission, fingerprint?: string):
Promise<AdmissionOwnerError | null | undefined> {
  const pending = await transaction.get<PendingAdmission>(PENDING_ADMISSION);
  if (claim) return pending?.nonce === claim.nonce && activeAdmission(pending) ? undefined : "admission_unconfirmed";
  if (pending && activeAdmission(pending)) return pending.fingerprint === fingerprint ? "admission_unconfirmed" : null;
  if (pending) return "admission_unconfirmed"; // The expiration alarm owns removal and ticket release.
}

async function rejectUnownedAdmission(transaction: DurableObjectTransaction, admission: AdmissionOwner | undefined):
Promise<AdmissionOwnerError | undefined> {
  if (admission === "replay") return "admission_replay_missing";
  if (admission && !await installationFenceAllows(transaction, admission.generation)) return "admission_unconfirmed";
}

async function indexAdmission(transaction: DurableObjectTransaction, id: string, admission: AdmissionOwner | undefined,
  opencode = false, clientId?: string) {
  const generation = admission && admission !== "replay" ? admission.generation : undefined;
  if (generation !== undefined) await transaction.put(admissionGenerationKey, generation);
  await transaction.put(pendingRunIndex, { id, generation, ...(opencode ? { opencode: true } : {}), clientId });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function admittedConnectors(access: ConnectorAccess | undefined, env: WorkerEnv, repository: GithubRepository | undefined):
  { policy: Record<string, McpConnector>; generations: Record<string, string> } | McpAdmissionError | McpAdmissionFailure | undefined {
  if (!access) return;
  if (!env.SANDBOX_RUNNER_MCP_CONNECTORS) return "mcp_connector_not_allowed";
  const registry = parseMcpRegistry(env.SANDBOX_RUNNER_MCP_CONNECTORS);
  if (!registry) return "mcp_connector_configuration_invalid";
  const selected: Record<string, McpConnector> = Object.create(null);
  const generations: Record<string, string> = Object.create(null);
  for (const name of access.connectors) {
    if (!Object.hasOwn(registry, name)) return "mcp_connector_not_allowed";
    let connector = registry[name];
    const reference = access.mode === "read-only" ? connector.readAuth : connector.writeAuth;
    if (reference === "github-app") {
      if (new URL(connector.url).origin !== "https://api.githubcopilot.com") return "mcp_connector_configuration_invalid";
      if (!repository || !githubAppCredentials(env)) {
        return { connectorIssue: { code: mcpConnectorCodes.authRequired, connector: name, mode: access.mode } };
      }
      const forRepository = ({ match }: McpConnector["read"][number]) => match.owner === repository.owner && match.repo === repository.name;
      connector = { ...connector, read: connector.read.filter(forRepository), write: connector.write.filter(forRepository) };
      if (!connector.read.length && (access.mode === "read-only" || !connector.write.length)) return "mcp_connector_not_allowed";
    } else if (isRestrictedApiBinding(reference)) {
      const credential = restrictedMcpCredential(env, reference);
      if (credential.status === "failed") {
        return { connectorIssue: { code: credential.code, connector: name, mode: access.mode } };
      }
      generations[name] = restrictedCredentialGeneration(credential.token);
    } else if (!isPublicContext7(connector)) {
      const secret = Reflect.get(env, reference);
      const grant = parseMcpOAuthGrant(secret, connector.url);
      if (!isMcpOAuthBinding(reference) || !grant) {
        return { connectorIssue: {
          code: secret === undefined ? mcpConnectorCodes.authRequired : mcpConnectorCodes.configurationInvalid,
          connector: name, mode: access.mode,
        } };
      }
      generations[name] = grant.generation;
    }
    selected[name] = connector;
  }
  return { policy: selected, generations };
}

type ReadinessKind = "sandbox" | "repository" | "credentials" | "settings" | "connectors" | "publication" | "timeout";
type ReadinessCheck = { kind: ReadinessKind; status: "configured" } | { kind: ReadinessKind; status: "blocked"; code: string };

/** Inspect configuration only. A launch still has to check live credentials and permissions. */
function profileReadiness(profile: Record<string, unknown>, env: WorkerEnv) {
  const checks: ReadinessCheck[] = [];
  const check = (kind: ReadinessKind, code?: string) => {
    checks.push(code === undefined ? { kind, status: "configured" } : { kind, status: "blocked", code });
  };
  const sandboxProvider = typeof profile.sandboxProvider === "string" ? profile.sandboxProvider : undefined;
  const routing = resolveRunRouting({ sandboxProvider, explicitAuth: false },
    env.SANDBOX_RUNNER_DEFAULT_SANDBOX_PROVIDER);
  check("sandbox", typeof routing === "string" ? routing :
    profile.harness === "opencode" && env.SANDBOX_RUNNER_OPENCODE !== "1" ? "opencode_disabled" : undefined);

  const { defaults, allowedOverrides } = profile as { defaults?: AgentSettings & { repo?: string };
    allowedOverrides?: { repo?: string[]; model?: string[]; effort?: NonNullable<AgentSettings["effort"]>[] } };
  const repositories = new Set(allowedOverrides?.repo);
  if (defaults?.repo !== undefined) repositories.add(defaults.repo);
  const admitted: GithubRepository[] = [];
  const checkoutTimeout = Number(env.SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS);
  let checkoutError: GithubCheckoutError | undefined = !Number.isSafeInteger(checkoutTimeout) || checkoutTimeout < 1 ||
    checkoutTimeout > 2_147_483_647 || apiTimeoutMs(env) === undefined ? "github_checkout_not_configured" : undefined;
  if (!checkoutError) {
    for (const slug of repositories) {
      const candidate = admitGithubCheckout({ slug }, env);
      if (typeof candidate === "string") {
        checkoutError = candidate;
        break;
      }
      admitted.push(candidate);
    }
  }
  check("repository", checkoutError);

  if (profile.kind === "agent") {
    const review = profile.operation === "review";
    const provider = profile.harness === "opencode" && isModelProvider(profile.modelProvider)
      ? openCodeProviderConfig(profile.modelProvider, review)
      : (profile.harness === "claude" || profile.harness === "codex") && isAuthMode(profile.authMode)
        ? providerConfig(profile.harness, profile.authMode) : undefined;
    check("credentials", provider && providerCredential(provider, env) ? undefined : "provider_credential_not_configured");
    if (profile.harness === "claude") {
      const settings = resolveClaudeSettings({ model: defaults?.model ?? allowedOverrides?.model?.[0],
        effort: defaults?.effort ?? allowedOverrides?.effort?.[0] }, env);
      check("settings", typeof settings === "string" ? settings : undefined);
    }
    const mcp = profile.mcp as { connectors: string[] } | undefined;
    const access = connectorAccessFor(mcp?.connectors, review);
    if (access) {
      let connectorError: string | undefined = checkoutError === undefined ? undefined : "mcp_connector_repository_unverified";
      if (!connectorError) {
        for (const repository of admitted) {
          const selected = admittedConnectors(access, env, repository);
          connectorError = typeof selected === "string" ? selected : selected && "connectorIssue" in selected ? selected.connectorIssue.code : undefined;
          if (connectorError) break;
        }
      }
      check("connectors", connectorError);
    }
    if (profile.publish) {
      check("publication", publicationWireBudget(env.SANDBOX_RUNNER_GITHUB_PUBLICATION_MAX_BYTES) === undefined ||
        apiTimeoutMs(env) === undefined ? "github_publication_configuration_invalid" : undefined);
    }
    const deadline = resolveAgentDeadline(undefined, env.SANDBOX_RUNNER_AGENT_TIMEOUT_MS, Date.now());
    check("timeout", typeof deadline === "string" ? deadline : undefined);
  } else {
    check("timeout", vitestTimeout(env) === undefined ? "vitest_not_configured" : undefined);
  }
  return { qualification: "unverified", checks };
}

function vitestTimeout(env: WorkerEnv) {
  const timeout = Number(env.SANDBOX_RUNNER_VITEST_TIMEOUT_MS);
  if (Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 21_600_000) return timeout;
}

function restrictedCredentialGeneration(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function restrictedMcpCredential(env: WorkerEnv, reference: string, generation?: string): McpCredentialResult {
  const value = Reflect.get(env, reference);
  const token = restrictedApiKey(reference, value);
  if (!token) return { status: "failed", code: value === undefined ? mcpConnectorCodes.authRequired
    : mcpConnectorCodes.configurationInvalid };
  if (generation !== undefined && restrictedCredentialGeneration(token) !== generation) {
    return { status: "failed", code: mcpConnectorCodes.credentialChanged };
  }
  return { status: "ready", token };
}

async function githubMcpCredential(env: WorkerEnv, repository: GithubRepository | undefined, mode: McpAccessMode,
  fetcher: typeof fetch): Promise<McpCredentialResult> {
  const app = githubAppCredentials(env);
  if (!app || !repository) return { status: "failed", code: mcpConnectorCodes.authRequired };
  try {
    const { token } = await mintGithubMcpToken(repository, app, mode, { fetcher });
    return { status: "ready", token };
  } catch (error) {
    const code = error instanceof GithubReadError && error.code === "github_app_invalid"
      ? mcpConnectorCodes.configurationInvalid : mcpConnectorCodes.unavailable;
    return { status: "failed", code };
  }
}

function hasUnconfirmedMcpWrite(run: Pick<RunView, "connectorIssues">, connector?: string): boolean {
  return run.connectorIssues?.some(issue => issue.code === mcpConnectorCodes.writeUnconfirmed &&
    (connector === undefined || issue.connector === connector)) === true;
}

function appendMcpIssues(run: Pick<RunView, "connectorIssues">, issues: readonly McpConnectorIssue[]) {
  const current = run.connectorIssues ?? [];
  const added = issues.filter(issue => !current.some(previous =>
    previous.connector === issue.connector && previous.code === issue.code));
  if (added.length) return [...current, ...added];
}

function mcpRouteFor(run: RunRecord | undefined, name: string, configured?: string): McpRoute | undefined {
  if (!run?.connectorAccess?.connectors.includes(name) || !run.connectorPolicy || !Object.hasOwn(run.connectorPolicy, name) ||
      terminal(run.status) || deadlineReached(run.deadline)) return;
  const { mode } = run.connectorAccess;
  const snapshot = run.connectorPolicy[name];
  const connector = run.profile === undefined ? snapshot : narrowMcpConnector(snapshot, parseMcpRegistry(configured)?.[name], mode);
  if (connector) return { connector, mode, repository: run.githubRepository, sha: run.repository?.sha,
    generation: run.connectorGenerations?.[name],
    ...deadlineView(run.deadline) };
}

function mcpSessionKey(name: string): string {
  return "mcp-session:" + name;
}

function notFound(): Response {
  return json({ error: "not_found" }, 404);
}

async function readRequestText(request: Request): Promise<string | undefined> {
  if (!request.body || Number(request.headers.get("content-length")) > REQUEST_BYTES) return;
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let body = "";
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return body + decoder.decode();
      size += chunk.value.byteLength;
      if (size > REQUEST_BYTES) {
        await reader.cancel();
        return;
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return;
  } finally {
    reader.releaseLock();
  }
}

async function readInput(request: Request, path: string, team?: TeamGrant):
  Promise<Submission | ProfileError | undefined> {
  const text = await readRequestText(request);
  if (text === undefined) return;
  try {
    let value = JSON.parse(text);
    if (path === "/v4/runs") {
      let teamReceipt: RunProfileReceipt | undefined;
      if (team) {
        if (value?.kind !== "team-profile") throw profileRequired();
        if (hasDuplicateJsonKeys(text)) throw new ProfileError("invalid_profile_request", "Profile requests require unique JSON keys.");
        const resolved = await resolveTeamProfile(value, team.catalog, team.client);
        value = resolved.request;
        teamReceipt = resolved.receipt;
      }
      if (value?.kind === "profile") {
        if (!teamReceipt && hasDuplicateJsonKeys(text)) throw new ProfileError("invalid_profile_request", "Profile requests require unique JSON keys.");
        const resolved = resolveProfileRequest(value);
        const profile = teamReceipt ?? await profileReceipt(value);
        const vitest = parseTestSubmission(resolved, true);
        if (vitest) return { vitest: { ...vitest, profile } };
        const agent = parseProviderRunInput(resolved);
        return agent && { ...agent, input: { ...agent.input, profile } };
      }
      const vitest = parseTestSubmission(value);
      return vitest ? { vitest } : parseProviderRunInput(value);
    }
    if (value && typeof value === "object" && (Object.hasOwn(value, "repository") ||
        Object.hasOwn(value, "reviewProducer") || Object.hasOwn(value, "publish") || Object.hasOwn(value, "modelProvider") ||
        Object.hasOwn(value, "connectors") || Object.hasOwn(value, "profile"))) return;
    if (path === "/v3/runs") return parseClaudeOverrideInput(value);
    const explicitAuth = path === "/v2/runs";
    const input = parseInput(value, explicitAuth);
    return input ? { input, explicitAuth } : undefined;
  } catch (error) {
    return error instanceof ProfileError ? error : undefined;
  }
}

function publicView(run: RunRecord): RunView {
  const { prompt, strategyRunId, overrides, routing, githubRepository, repositoryRef, publish, publicationMaxBytes, publicationState,
    deadline, timedOut, output, connectorPolicy, connectorGenerations, ...view } = run;
  const publication = publicationView(publicationState);
  const expiredRoot = strategyRunId === undefined && timedOut;
  const publishing = strategyRunId === undefined && !!deadline && run.status === "succeeded" && publicationAcceptsDeadline(publicationState);
  return { ...view, ...providerView(routing), ...deadlineView(deadline),
    ...(expiredRoot ? agentTimeoutOutcome : publishing ? { status: "running" as const } : {}),
    ...(output === undefined || expiredRoot || publishing ? {} : { output }),
    ...(publication ? { publication } : {}) };
}

async function writeRun(transaction: DurableObjectTransaction, next: RunRecord, previous?: RunRecord): Promise<void> {
  await transaction.put(RUN, next);
  // Only logical roots are public. Strategy attempts are journaled by their root.
  if (next.strategyRunId === undefined) await appendRunEvents(transaction, previous && publicView(previous), publicView(next));
}

async function writePublicationOwner(transaction: DurableObjectTransaction, owner: RunRecord | StrategyRun,
  publicationState: PublicationState): Promise<void> {
  if ("policy" in owner) await writeStrategyRun(transaction, { ...owner, publicationState }, owner);
  else await writeRun(transaction, { ...owner, publicationState }, owner);
}

async function cancelRecord(transaction: DurableObjectTransaction, run: RunRecord, parentCancelled = false): Promise<RunView> {
  if (!parentCancelled) run = await expireRecord(transaction, run);
  if (run.timedOut || run.status === "timed_out") return publicView(run);
  if (terminal(run.status) && !publicationPending(run.publicationState)) return publicView(run);
  const cancelled: RunRecord = { ...run,
    ...(terminal(run.status) ? {} : { status: "cancelled", reason: "run_cancelled" }),
    ...(run.publicationState ? { publicationState: cancelPublication(run.publicationState) } : {}),
  };
  await writeRun(transaction, cancelled, run);
  await transaction.delete(INFERENCE);
  await transaction.setAlarm(Date.now());
  return publicView(cancelled);
}

async function finishRecord(transaction: DurableObjectTransaction, run: RunRecord, outcome: Outcome): Promise<RunRecord> {
  if (terminal(run.status)) return run;
  const publicationState = finishAgentPublication(run.publicationState, outcome.status);
  const updated = { ...run, ...outcome, ...(publicationState === undefined ? {} : { publicationState }) };
  await writeRun(transaction, updated, run);
  await transaction.delete(INFERENCE);
  await transaction.setAlarm(Date.now());
  return updated;
}

function runDeadlineDue(run: RunRecord): boolean {
  return !run.timedOut && deadlineReached(run.deadline) &&
    (!terminal(run.status) || (run.status === "succeeded" && publicationAcceptsDeadline(run.publicationState)));
}

async function expireRecord(transaction: DurableObjectTransaction, run: RunRecord): Promise<RunRecord> {
  if (!runDeadlineDue(run)) return run;
  if (!terminal(run.status)) return finishRecord(transaction, run, agentTimeoutOutcome);
  const updated = { ...run, timedOut: true as const, publicationState: timeoutPublication(run.publicationState) };
  await writeRun(transaction, updated, run);
  await transaction.setAlarm(Date.now());
  return updated;
}

function expirePublicationOwner(transaction: DurableObjectTransaction, owner: RunRecord | StrategyRun) {
  return "policy" in owner ? expireStrategy(transaction, owner) : expireRecord(transaction, owner);
}

function publicationDeadline(owner: RunRecord | StrategyRun): AgentDeadline | undefined {
  if (!owner.timedOut && publicationAcceptsDeadline(owner.publicationState)) return owner.deadline;
}

function publicationAlarmTime(owner: RunRecord | StrategyRun, scheduled: number): number {
  return Math.min(publicationDeadline(owner)?.deadlineAt ?? Infinity, scheduled);
}

function allowsEgress(run: RunRecord | undefined, agent: Agent, authMode: AuthMode, modelProvider?: ModelProvider,
  openCodeReview = false): boolean {
  return run?.agent === agent && run.modelProvider === modelProvider &&
    (agent !== "opencode" || (run.review !== undefined) === openCodeReview) &&
    !terminal(run.status) && !deadlineReached(run.deadline) && effectiveAuthMode(agent, run.authMode) === authMode;
}

function taggedRoute(route: ContainerAgent["egress"][number] | undefined): route is TaggedRoute {
  return !!route && "runId" in route && typeof route.runId === "string" && operationId(route.runId) === route.runId &&
    (!("strategyRunId" in route) || (typeof route.strategyRunId === "string" &&
      operationId(route.strategyRunId) === route.strategyRunId)) &&
    "agent" in route && (
      route.agent === "opencode"
        ? "modelProvider" in route && isModelProvider(route.modelProvider) && "authMode" in route && route.authMode === "api-key" &&
          !("strategyRunId" in route) &&
          (!("openCodeReview" in route) || (route.openCodeReview === true && route.modelProvider === "openai"))
        : !("openCodeReview" in route) && (route.agent === "claude" || route.agent === "codex") && !("modelProvider" in route) &&
          (!("authMode" in route) || isAuthMode(route.authMode))
    );
}

function selectedProvider(agent: Agent, authMode: AuthMode, modelProvider?: ModelProvider, openCodeReview = false) {
  if (agent !== "opencode") return providerConfig(agent, authMode);
  if (modelProvider && authMode === "api-key") return openCodeProviderConfig(modelProvider, openCodeReview);
}

function buildAgent(run: RunRecord, image: string, fixtureMode: boolean, checkoutTimeout: string): ContainerAgent {
  const authMode = effectiveAuthMode(run.agent, run.authMode);
  const checkoutEnv: Record<string, string> = run.repository ? {
    SANDBOX_RUNNER_GITHUB_REPOSITORY: run.repository.slug,
    SANDBOX_RUNNER_GITHUB_SHA: run.repository.sha,
    SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS: checkoutTimeout,
  } : {};
  if (run.agent === "opencode") {
    const review = run.review !== undefined;
    const settings = resolveOpenCodeSettings(run.modelProvider, run.model, run.effort, review);
    if (!settings || authMode !== "api-key") throw new Error("Invalid OpenCode run settings");
    const provider = openCodeProviderConfig(settings.modelProvider, review);
    const route: TaggedRoute = {
      host: provider.host, upstream: provider.upstream, headers: {}, strip: [], runId: run.id,
      agent: "opencode", authMode, modelProvider: settings.modelProvider,
      ...(review ? { openCodeReview: true } : {}),
      ...deadlineView(run.deadline),
      ...(fixtureMode ? { openCodeFixture: openCodeFixtureFor(run.prompt), openCodeFixtureEffort: settings.effort } : {}),
    };
    return containerAgent({ image, adapter: "opencode", model: openCodeModelRef(settings),
      env: { ...openCodeEnv(settings, run.connectorAccess?.connectors), ...checkoutEnv }, egress: [route] });
  }
  const publicationFallbackFixture = fixtureMode && run.publish && run.agent === "claude" &&
    run.prompt === "J2 fixture GitHub publication fallback";
  const fixture = fixtureMode ? publicationFallbackFixture && authMode === "api-key" ? "strategy_quota" : fixtureFor(run.prompt)
    : undefined;
  const settings = codexPresetSettings(run, authMode);
  const codexConfig = [
    ...(authMode === "subscription" ? CODEX_SUBSCRIPTION_CONFIG : []),
    ...(fixtureMode ? [
      "model_providers.gateway.stream_max_retries=0",
      "model_providers.gateway.request_max_retries=0",
    ] : []),
    ...settings.config,
  ];
  const preset = run.agent === "claude"
    ? claudeCode({ version: "2.1.289", model: run.model ?? "sonnet" })
    : codex({
      version: "0.157.0",
      model: settings.model,
      ...(codexConfig.length ? { config: codexConfig } : {}),
    });
  const env: Record<string, string> = { ...preset.env, CF_HARNESS_USER: "10001:10001", ...checkoutEnv };
  if (run.connectorAccess) env.SANDBOX_RUNNER_MCP_CONNECTORS_JSON = JSON.stringify(run.connectorAccess.connectors);
  if (run.publish) env.SANDBOX_RUNNER_GITHUB_PUBLICATION = "1";
  if (run.agent === "claude") {
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    if (run.effort !== undefined) env.CLAUDE_CODE_EFFORT_LEVEL = run.effort;
    if (fixtureMode) env.CLAUDE_CODE_MAX_RETRIES = "0";
    if (fixture === "claude_sse_capacity" || fixture === "claude_sse_overloaded") {
      env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = "1";
    }
    if (authMode === "subscription") {
      delete env.ANTHROPIC_API_KEY;
      env.CLAUDE_CODE_OAUTH_TOKEN = CLAUDE_PLACEHOLDER;
    }
  } else if (authMode === "subscription") {
    delete env.OPENAI_API_KEY;
    env.ACCESS_TOKEN = "sandbox-runner-codex-placeholder";
  }
  const egress: TaggedRoute[] = preset.egress.map(route => ({
    ...route,
    headers: {},
    runId: run.id,
    ...(run.strategyRunId ? { strategyRunId: run.strategyRunId } : {}),
    agent: run.agent,
    authMode,
    ...deadlineView(run.deadline),
    ...(fixture ? { fixture } : {}),
    ...(fixtureMode && run.repository && run.agent === "claude" && run.prompt === "J2 fixture GitHub workspace"
      ? { githubWorkspaceFixture: run.review ? "review" as const : "checkout" as const } : {}),
    ...(fixtureMode && run.publish && (run.prompt === "J2 fixture GitHub publication" ||
        (publicationFallbackFixture && authMode === "subscription"))
      ? { githubWorkspaceFixture: "publication" as const } : {}),
  }));
  return { ...preset, image: { kind: "custom", image }, env, egress };
}

export class ProviderEgress extends WorkerEntrypoint<WorkerEnv, ContainerEgressProps> {
  async fetch(request: Request): Promise<Response> {
    const route = this.ctx.props.routes[0];
    if (!taggedRoute(route)) return json({ error: "egress_denied" }, 403);
    const { agent, runId, strategyRunId, modelProvider, openCodeReview } = route;
    const authMode = effectiveAuthMode(agent, route.authMode);
    const root = strategyRunId ? this.ctx.exports.Run.getByName(strategyRunId) : undefined;
    const owner = this.ctx.exports.Run.getByName(strategyRunId ? attemptName(strategyRunId, runId) : runId);
    if (!await owner.egressAllowed(agent, authMode, modelProvider, openCodeReview)) return json({ error: "egress_denied" }, 403);
    const provider = selectedProvider(agent, authMode, modelProvider, openCodeReview);
    if (!provider) return json({ error: "egress_denied" }, 403);
    if (modelProvider === "anthropic" && (request.headers.get("x-api-key") !== openCodePlaceholder ||
        request.headers.has("authorization") || request.headers.get("anthropic-version") !== openCodeAnthropicVersion) ||
        modelProvider === "openai" && (request.headers.get("authorization") !== "Bearer " + openCodePlaceholder ||
        request.headers.has("x-api-key"))) return json({ error: "egress_denied" }, 403);
    const credential = providerCredential(provider, this.env);
    if (!credential) return json({ error: "provider_unavailable" }, 503);
    const fixture = this.env.SANDBOX_RUNNER_MODE === "fixture";
    if (fixture && !(agent === "opencode" ? route.openCodeFixture : route.fixture)) return json({ error: "fixture_not_configured" }, 503);
    try {
      const response = await guardedForward(request, [{
        host: provider.host,
        upstream: fixture ? "https://sandbox-runner-fixture.invalid" : provider.upstream,
        headers: {
          [provider.header]: credential,
          ...(provider.originator ? { originator: provider.originator } : {}),
        },
        strip: openCodeReview ? ["originator", "chatgpt-account-id", "chatgpt-plan-type", "x-codex-turn-state", "x-codex-turn-metadata"]
          : provider.originator ? ["x-codex-turn-state"] : [],
        allow: [{ method: "POST", path: provider.path, searches: provider.searches }],
      }], { containerId: runId, contractId: null }, () => {}, runDeadlineFetch(fixture ? async (target, init) => {
        // This is the upstream mock, after the opaque relay. It checks only the credential boundary.
        const headers = new Headers(init?.headers);
        const alternateHeader = provider.header === "authorization" ? "x-api-key" : "authorization";
        if (new URL(String(target)).origin !== "https://sandbox-runner-fixture.invalid" ||
            headers.get(provider.header) !== credential || headers.has(alternateHeader) ||
            (provider.originator && (headers.get("originator") !== provider.originator ||
              request.headers.get("originator") !== provider.originator)) ||
            init?.redirect !== "manual") {
          return json({ error: "fixture_transport_mismatch" }, 502);
        }
        if (agent === "opencode") {
          return openCodeFixtureResponse(modelProvider!, route.openCodeFixtureEffort, route.openCodeFixture!, runId, init?.body);
        }
        if (agent === "codex" && route.githubWorkspaceFixture === "publication") {
          return githubCodexPublicationFixture(init?.body, authMode);
        }
        if (route.githubWorkspaceFixture) {
          return githubAgentFixture(init?.body, this.env.SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS, route.githubWorkspaceFixture);
        }
        return fixtureResponse(agent, authMode, route.fixture!);
      } : fetch, route.deadlineAt), undefined, async event => {
        if (!await owner.observeInference(agent, authMode, event, modelProvider, openCodeReview)) return false;
        return event.signal !== undefined || !root || await root.strategyEgressAllowed(runId, agent, authMode);
      }, agent === "codex" && authMode === "api-key");
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return json({ error: "provider_redirect_denied" }, 502);
      }
      return response;
    } catch {
      return json({ error: "provider_unavailable" }, 502);
    }
  }
}

export class GithubEgress extends WorkerEntrypoint<WorkerEnv, GithubEgressProps> {
  async fetch(request: Request): Promise<Response> {
    const { runId, strategyRunId, deadlineAt } = this.ctx.props;
    if (typeof runId !== "string" || operationId(runId) !== runId ||
        (strategyRunId !== undefined && operationId(strategyRunId) !== strategyRunId)) {
      return json({ error: "github_egress_denied" }, 403);
    }
    const owner = this.ctx.exports.Run.getByName(strategyRunId ? attemptName(strategyRunId, runId) : runId);
    const root = strategyRunId ? this.ctx.exports.Run.getByName(strategyRunId) : undefined;
    async function authorizedRepository() {
      const repository = await owner.githubEgressRepository();
      if (repository && (!root || await root.githubEgressAttemptAllowed(runId))) return repository;
    }
    const repository = await authorizedRepository();
    if (!repository) return json({ error: "github_egress_denied" }, 403);
    const fixture = githubCheckoutFixture(this.env);
    const credentials = fixture ? undefined : githubAppCredentials(this.env);
    if (!fixture && !credentials) return json({ error: "github_read_unavailable" }, 502);
    const fetcher = runDeadlineFetch(fixture ? githubFixtureFetcher(repository) : fetch, deadlineAt);
    return forwardGithubRead(request, {
      repository,
      getToken: selected => credentials ? mintGithubReadToken(selected, credentials, { fetcher })
        : Promise.resolve(githubFixtureReadToken(selected)),
      subject: { containerId: runId, contractId: null },
      journal: () => {},
      async fetcher(target, init) {
        // Minting or attesting the installation token can take long enough for
        // the child or its strategy root to become terminal.
        const current = await authorizedRepository();
        if (!current || current.repositoryId !== repository.repositoryId ||
            current.owner !== repository.owner || current.name !== repository.name) {
          return json({ error: "github_egress_denied" }, 403);
        }
        return fetcher(target, init);
      },
    });
  }
}

export class McpEgress extends WorkerEntrypoint<WorkerEnv, McpEgressProps> {
  async fetch(request: Request): Promise<Response> {
    const { runId, strategyRunId } = this.ctx.props;
    const name = mcpConnectorName(request);
    if (!name || operationId(runId) !== runId || (strategyRunId !== undefined && operationId(strategyRunId) !== strategyRunId)) {
      return json({ error: "mcp_egress_denied" }, 403);
    }
    const owner = this.ctx.exports.Run.getByName(strategyRunId ? attemptName(strategyRunId, runId) : runId);
    const root = strategyRunId ? this.ctx.exports.Run.getByName(strategyRunId) : undefined;
    const selected = await owner.mcpRoute(name);
    if (!selected) return json({ error: "mcp_egress_denied" }, 403);
    const route: McpRoute = JSON.parse(selected);
    const fetcher = runDeadlineFetch(fetch, route.deadlineAt);
    const app = route.connector.readAuth === "github-app" ? githubAppCredentials(this.env) : undefined;
    const { repository, sha } = route;
    return forwardMcp(request, {
      connector: route.connector,
      mode: route.mode,
      authorize: async () => await owner.mcpAllowed(name, selected) && (!root || await root.mcpAttemptAllowed(runId, name)),
      claimWrite: requestId => (root ?? owner).claimMcpWrite(name, requestId, root ? runId : undefined),
      settleWrite: (requestId, dispatched) => (root ?? owner).settleMcpWrite(name, requestId, root ? runId : undefined, dispatched),
      credentials: async (reference, _connector, _mode, rejectedFingerprint) => {
        if (reference === "github-app") {
          if (new URL(route.connector.url).origin !== "https://api.githubcopilot.com") {
            return { status: "failed", code: mcpConnectorCodes.configurationInvalid };
          }
          return githubMcpCredential(this.env, route.repository, route.mode, fetcher);
        }
        if (isRestrictedApiBinding(reference)) return restrictedMcpCredential(this.env, reference, route.generation);
        using result = await this.ctx.exports.RunIndex.getByName(runIndexName)
          .mcpOAuthCredential(reference, route.connector.url, rejectedFingerprint, route.generation);
        return { ...result };
      },
      diagnose: async issue => {
        if (root) await Promise.all([owner.recordMcpIssue(issue), root.recordMcpIssue(issue, runId)]);
        else await owner.recordMcpIssue(issue);
      },
      session: {
        read: async () => {
          using value = await owner.mcpSessionRead(name);
          if (value) return structuredClone(value);
        },
        claim: (id, replaces) => owner.mcpSessionClaim(name, id, replaces),
        commit: (id, upstreamId, protocolVersion, reply) => owner.mcpSessionCommit(name, id, upstreamId, protocolVersion, reply),
        replay: async (id, requestedVersion) => {
          using result = await owner.mcpSessionReplay(name, id, requestedVersion);
          if (result) return structuredClone(result);
        },
        acknowledge: id => owner.mcpSessionAcknowledge(name, id),
        release: (id, pendingOnly) => owner.mcpSessionRelease(name, id, pendingOnly),
      },
      maxBytes: REQUEST_BYTES,
      fetcher: isRestrictedApiBinding(route.connector.readAuth) ? restrictedApiFetcher(route.connector, fetcher) : fetcher,
      ...(app && repository && sha && route.connector.read.some(rule => rule.tool === githubCiToolName) ? {
        githubCi: { repository, sha, getToken: () => mintGithubCiToken(repository, app, { fetcher }) },
      } : {}),
    });
  }
}

export class RunIndex extends DurableObject<WorkerEnv> {
  #mcpOAuth: McpOAuthCredentials;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.#mcpOAuth = new McpOAuthCredentials(ctx.storage);
    initializeRunIndex(ctx.storage.sql);
    initializeInstallationAdmission(ctx.storage.sql);
  }

  async mcpOAuthCredential(binding: string, resource: string, rejectedFingerprint?: string,
    generation?: string): Promise<McpCredentialResult> {
    if (!isMcpOAuthBinding(binding)) return { status: "failed", code: mcpConnectorCodes.configurationInvalid };
    const secret = Reflect.get(this.env, binding);
    const grant = parseMcpOAuthGrant(secret, resource);
    if (!grant) return { status: "failed",
      code: secret === undefined ? mcpConnectorCodes.authRequired : mcpConnectorCodes.configurationInvalid };
    if (generation !== undefined && grant.generation !== generation) {
      return { status: "failed", code: mcpConnectorCodes.credentialChanged };
    }
    return this.#mcpOAuth.resolve(binding, grant, rejectedFingerprint);
  }

  async record(id: string, generation?: string, opencode = false): Promise<void> {
    this.#record(id, generation, opencode);
  }

  async recordTeam(id: string, generation: string | undefined, opencode: boolean, clientId: string): Promise<void> {
    if (!validProfileSlug(clientId)) throw new Error("Run index client identity mismatch");
    this.#record(id, generation, opencode, clientId);
  }

  #record(id: string, generation: string | undefined, opencode: boolean, clientId?: string) {
    if (operationId(id) !== id || typeof opencode !== "boolean") {
      throw new Error("Run index identity mismatch");
    }
    const { sql } = this.ctx.storage;
    this.ctx.storage.transactionSync(() => {
      checkInstallationIndexWrite(sql, id, generation, clientId);
      recordRunIndex(sql, id, opencode, clientId);
    });
  }

  async acquire(id: string): Promise<AdmissionDecision> {
    return this.#acquire(id);
  }

  async acquireGuarded(id: string, clientId?: string): Promise<AdmissionDecision> {
    if (clientId !== undefined && !validProfileSlug(clientId)) throw new Error("Installation admission identity mismatch");
    const enabled = guardCredential(this.env) !== undefined;
    return this.#acquire(id, { enabled, invalid: this.env[admissionGuardBinding] !== undefined && !enabled, clientId });
  }

  async #acquire(id: string, guard?: { enabled: boolean; invalid?: boolean; clientId?: string }): Promise<AdmissionDecision> {
    if (typeof id !== "string" || operationId(id) !== id) throw new Error("Installation admission identity mismatch");
    const { sql } = this.ctx.storage;
    return this.ctx.storage.transaction(async transaction => {
      const decision = acquireInstallationAdmission(sql, id, this.env[installationLimitBinding], Date.now() + RECOVERY_INTERVAL_MS, guard);
      if (typeof decision === "object") await scheduleInstallationReconciliation(sql, transaction);
      return decision;
    });
  }

  async admissionGuard(cursor?: string) {
    const { sql } = this.ctx.storage;
    return readAdmissionGuard(sql, installationGuardUnverified(sql), 50, cursor);
  }

  async admissionGuardOperation(id: string) {
    return readGuardOperation(this.ctx.storage.sql, id);
  }

  async updateAdmissionGuard(input: NonNullable<ReturnType<typeof parseGuardAction>>) {
    const { sql } = this.ctx.storage;
    return this.ctx.storage.transactionSync(() => updateInstallationGuard(sql, input, 50));
  }

  async reconsider(id: string, generation: string): Promise<void> {
    if (operationId(id) !== id || !validAdmissionGeneration(generation)) throw new Error("Installation admission identity mismatch");
    const { sql } = this.ctx.storage;
    await this.ctx.storage.transaction(async transaction => {
      if (expediteInstallationReconciliation(sql, id, generation, Date.now())) {
        await scheduleInstallationReconciliation(sql, transaction);
      }
    });
  }

  async alarm(): Promise<void> {
    const { sql } = this.ctx.storage;
    const claim = await this.ctx.storage.transaction(async transaction => {
      const now = Date.now();
      const due = claimInstallationReconciliation(sql, now, now + RECOVERY_INTERVAL_MS);
      await scheduleInstallationReconciliation(sql, transaction);
      return due;
    });
    if (!claim) return;
    let result: AdmissionObservation;
    try {
      result = await this.ctx.exports.Run.getByName(claim.id).reconcileAdmission(claim.id, claim.generation);
    } catch {
      return; // The reconciliation alarm was persisted before calling the owner.
    }
    await this.ctx.storage.transaction(async transaction => {
      if (finishInstallationReconciliation(sql, claim, result)) await scheduleInstallationReconciliation(sql, transaction);
    });
  }

  #catalog() {
    return storedCatalog<{ revision: string; catalog: TeamCatalog }>(this.ctx.storage);
  }

  async catalog() {
    const current = await this.#catalog();
    if (!current) return null;
    const { revision, catalog: { clients, profiles } } = current;
    return JSON.stringify({ revision, config: { schemaVersion: 1, profiles, clients: Object.fromEntries(
      clients.map(({ id, ...grant }) => [id, grant]),
    ) } });
  }

  async publishCatalog(expected: string | null, catalog: TeamCatalog) {
    const revision = await profileRevision(catalog);
    return this.ctx.storage.transaction(async transaction => {
      const current = await storedCatalog<{ revision: string }>(transaction);
      if ((current?.revision ?? null) !== expected) return null;
      const keys = catalogStorageKeys(catalog);
      await transaction.put(keys.put, { revision, catalog });
      await transaction.delete(keys.delete);
      return revision;
    });
  }

  async identifyTeamClient(digest: string): Promise<string | null> {
    const current = await this.#catalog();
    if (!current) return null;
    const client = teamClient(current.catalog, digest);
    if (!client) return null;
    const profiles = Object.fromEntries(client.profiles.map(slug => [slug, current.catalog.profiles[slug]]));
    // Return only authorized definitions and the identity. Token digests remain in storage.
    return JSON.stringify({ client: { id: client.id, profiles: client.profiles, ...(client.readOnly ? { readOnly: true } : {}) },
      catalog: { profiles } } satisfies TeamGrant);
  }

  async identifyAccessMember(email: string): Promise<string | null> {
    const current = await this.#catalog();
    if (!current) return null;
    const client = teamClientByEmail(current.catalog, email);
    if (!client) return null;
    const profiles = Object.fromEntries(client.profiles.map(slug => [slug, current.catalog.profiles[slug]]));
    return JSON.stringify({ client: { id: client.id, profiles: client.profiles, ...(client.readOnly ? { readOnly: true } : {}) },
      catalog: { profiles } } satisfies TeamGrant);
  }

  async deny(clientId: string, reason: TeamDenial): Promise<void> {
    recordTeamDenial(this.ctx.storage.sql, clientId, reason, Date.now());
  }

  async denials() {
    return readTeamDenials(this.ctx.storage.sql);
  }

  async page(query: RunListQuery) {
    return readRunIndex(this.ctx.storage.sql, query);
  }
}

export class Run extends DurableObject<WorkerEnv> {
  #runtime?: Runtime;
  #tearingDown = false;
  #publicationBusy = false;

  #publishIndex(acknowledgeBy?: number) {
    return publishPendingRun(this.ctx.storage, (id, generation, opencode, clientId) => {
      const index = this.ctx.exports.RunIndex.getByName(runIndexName);
      return clientId === undefined ? index.record(id, generation, opencode) : index.recordTeam(id, generation, opencode ?? false, clientId);
    }, acknowledgeBy);
  }

  async reconcileAdmission(id: string, generation: string): Promise<AdmissionObservation> {
    if (id !== this.ctx.id.name || operationId(id) !== id || !validAdmissionGeneration(generation)) {
      throw new Error("Installation admission identity mismatch");
    }
    const disposition = await this.ctx.storage.transaction<AdmissionObservation | "test">(async transaction => {
      const test = await transaction.get<TestAdmission>(VITEST_ADMISSION);
      const strategy = await transaction.get<StrategyRun>(STRATEGY_RUN);
      const run = await transaction.get<RunRecord>(RUN);
      if (!test && !strategy && !run) {
        const pending = await transaction.get<PendingAdmission>(PENDING_ADMISSION);
        if (pending?.generation === generation) {
          if (activeAdmission(pending)) return "held";
          await clearPendingAdmission(transaction, pending);
          return "fenced";
        }
        await fenceInstallationAdmission(transaction, generation);
        return "fenced";
      }
      if (await transaction.get<string>(admissionGenerationKey) !== generation) return "held";
      if (test) return "test";
      const record = strategy ?? run!;
      const state = strategy ? activeAttempt(strategy) : run!;
      if (terminal(state.status) && state.cleanup === "failed") return "cleanup_failed";
      return terminal(state.status) && state.cleanup === "destroyed" && !publicationPending(record.publicationState) ? "settled" : "held";
    });
    if (disposition !== "test") return disposition;
    using test = await this.ctx.exports.VitestRun.getByName(id).summary();
    if (!test || !terminal(test.status)) return "held";
    return test.cleanup === "destroyed" ? "settled" : test.cleanup === "failed" ? "cleanup_failed" : "held";
  }

  async #expediteAdmissionRelease(id: string, generation?: string) {
    if (generation !== undefined) {
      // The index owns the release and will also reconcile on its existing alarm.
      await this.ctx.exports.RunIndex.getByName(runIndexName).reconsider(id, generation).catch(() => {});
    }
  }

  async #releasePendingAdmission(id: string, owner: PendingAdmission) {
    const closed = await this.ctx.storage.transaction(async transaction => {
      const current = await transaction.get<PendingAdmission>(PENDING_ADMISSION);
      if (current?.nonce !== owner.nonce) return false;
      await clearPendingAdmission(transaction, current);
      return true;
    });
    if (closed) await this.#expediteAdmissionRelease(id, owner.generation);
  }

  // A gateway can see a new version while this object still runs an older one.
  // Team calls use distinct RPC names so the old runtime cannot ignore identity.
  async reserveTeam(submission: Submission, admission?: AdmissionOwner): Promise<ReferenceReservation> {
    const input = "vitest" in submission ? submission.vitest : submission.input;
    if (input.profile?.source !== "worker-catalog" || !validProfileSlug(input.profile.clientId)) {
      throw new Error("Run client identity mismatch");
    }
    if (input.repositoryRef) return this.reserveReference(submission, admission);
    return "vitest" in submission ? this.reserveVitest(submission.vitest, admission)
      : this.reserve(submission.input, { explicitAuth: submission.explicitAuth, providerRequest: submission.providerRequest, admission });
  }

  async reserveReference(submission: Submission, admission?: AdmissionOwner): Promise<ReferenceReservation> {
    const input = "vitest" in submission ? submission.vitest : submission.input;
    const { operationId: id, repositoryRef } = input;
    if (!repositoryRef || id !== this.ctx.id.name || operationId(id) !== id) throw new Error("Reference admission identity mismatch");
    const providerRequest = "vitest" in submission
      ? { sandboxProvider: submission.vitest.sandboxProvider, explicitAuth: false } : submission.providerRequest;
    if (!providerRequest) throw new Error("Reference requires provider-aware admission");
    const reserve = (claim?: PendingReference, sha?: string) => {
      const repository = sha === undefined ? undefined : { slug: repositoryRef.slug, sha };
      const owner = claim === undefined ? "replay" : admission;
      return "vitest" in submission
        ? this.#reserveTest({ ...submission.vitest, repository }, owner, claim)
        : this.#reserveAgent({ ...submission.input, repository }, {
          admission: owner, explicitAuth: submission.explicitAuth, providerRequest,
        }, claim);
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(submission)).digest("hex");
    const generation = admission && admission !== "replay" ? admission.generation : undefined;
    const started = await this.ctx.storage.transaction(async transaction => {
      if (await transaction.get(RUN) || await transaction.get(STRATEGY_RUN) || await transaction.get(VITEST_ADMISSION)) return "existing" as const;
      const prior = await transaction.get<PendingAdmission>(PENDING_ADMISSION);
      if (prior && activeAdmission(prior)) return prior.fingerprint === fingerprint ? "admission_unconfirmed" as const : null;
      if (prior) {
        await clearPendingAdmission(transaction, prior);
        if (prior.generation !== undefined && prior.generation === generation) {
          return { error: "admission_unconfirmed" as const, release: prior.generation };
        }
      }
      const reject = async (error: ProviderError | GithubCheckoutError | "opencode_disabled") => {
        if (generation !== undefined) await fenceInstallationAdmission(transaction, generation);
        return { error, release: generation };
      };
      if ("input" in submission && submission.input.agent === "opencode" && this.env.SANDBOX_RUNNER_OPENCODE !== "1") {
        return reject("opencode_disabled");
      }
      const denied = await rejectUnownedAdmission(transaction, admission);
      if (denied) return denied;
      const routing = resolveRunRouting(providerRequest, this.env.SANDBOX_RUNNER_DEFAULT_SANDBOX_PROVIDER);
      if (typeof routing === "string") return reject(routing);
      const repository = admitGithubCheckout(repositoryRef, this.env);
      if (typeof repository === "string") return reject(repository);
      const timeout = apiTimeoutMs(this.env);
      const checkout = Number(this.env.SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS);
      // The run needs both: this deadline for resolution, the checkout one for the container's fetch.
      if (timeout === undefined || !Number.isSafeInteger(checkout) || checkout < 1 || checkout > 2_147_483_647) {
        return reject("github_checkout_not_configured");
      }
      const pending: PendingReference = { nonce: crypto.randomUUID(), fingerprint, generation, repository,
        deadlineAt: Date.now() + timeout, clientId: input.profile?.clientId };
      await transaction.put(PENDING_ADMISSION, pending);
      await transaction.setAlarm(pending.deadlineAt);
      return pending;
    });
    if (started === "existing") return reserve();
    if (typeof started !== "object" || !started) return started;
    if ("error" in started) {
      await this.#expediteAdmissionRelease(id, started.release);
      return started.error;
    }
    try {
      const fixture = githubCheckoutFixture(this.env);
      const credentials = fixture ? undefined : githubAppCredentials(this.env);
      if (!fixture && !credentials) return "github_checkout_not_configured";
      const result = await resolveGithubReference(started.repository, repositoryRef.ref, started.deadlineAt, {
        getToken: (repository, fetcher) => credentials ? mintGithubReadToken(repository, credentials, { fetcher })
          : Promise.resolve(githubFixtureReadToken(repository)),
        ...(fixture ? { fetcher: githubReferenceFixtureFetcher(started.repository) } : {}),
      });
      if (!activeAdmission(started)) return "admission_unconfirmed";
      return typeof result === "string" ? result : await reserve(started, result.sha);
    } finally {
      await this.#releasePendingAdmission(id, started);
    }
  }

  async #preflightMcp({ connectors, generations, mode, repository }: McpPreflight): Promise<McpAdmissionFailure | undefined> {
    const timeout = apiTimeoutMs(this.env);
    const fetcher = runDeadlineFetch(fetch, timeout === undefined ? Date.now() : Date.now() + timeout);
    const results = await Promise.all(Object.entries(connectors).map(async ([connector, config]) => {
      if (isPublicContext7(config)) return;
      const reference = mode === "read-only" ? config.readAuth : config.writeAuth;
      const staticKey = isRestrictedApiBinding(reference);
      const grant = reference === "github-app" || staticKey ? undefined : parseMcpOAuthGrant(Reflect.get(this.env, reference), config.url);
      using result = reference === "github-app" || staticKey ? undefined
        : await this.ctx.exports.RunIndex.getByName(runIndexName).mcpOAuthCredential(reference, config.url, undefined, generations[connector]);
      const credential = result ?? (staticKey ? restrictedMcpCredential(this.env, reference, generations[connector])
        : await githubMcpCredential(this.env, repository, mode, fetcher));
      if (credential.status === "ready") {
        if (reference === "github-app" && config.read.some(rule => rule.tool === githubCiToolName)) {
          const app = githubAppCredentials(this.env);
          if (!app || !repository || !await mintGithubCiToken(repository, app, { fetcher }).catch(() => undefined)) {
            return { connectorIssue: { code: mcpConnectorCodes.unavailable, connector, mode } };
          }
        }
        return;
      }
      const { code, retryAfterSeconds } = credential;
      const reconnectScope = code === mcpConnectorCodes.reauthRequired || code === mcpConnectorCodes.refreshUnconfirmed
        ? grant?.scope : undefined;
      return {
        connectorIssue: { code, connector, mode, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
        ...(reconnectScope === undefined ? {} : { reconnectScope }),
      };
    }));
    return results.find(failure => failure !== undefined);
  }

  async reserve(input: RunInput, options: ReservationOptions = {}): Promise<AgentReservation> {
    return this.#reserveAgent(input, options);
  }

  async #reserveAgent(input: RunInput, options: ReservationOptions, claim?: PendingReference): Promise<AgentReservation> {
    const { strategyRunId, parentRouting, providerRequest, cancel, parentGithubRepository, parentDeadline, admission } = options;
    const implicit = options.explicitAuth === false && strategyRunId === undefined;
    const name = strategyRunId === undefined ? input.operationId : attemptName(strategyRunId, input.operationId);
    if (name !== this.ctx.id.name || (cancel && strategyRunId === undefined) ||
        (strategyRunId !== undefined && (operationId(strategyRunId) !== strategyRunId || admission !== undefined))) {
      throw new Error("Run identity mismatch");
    }
    const fingerprint = strategyRunId === undefined && !claim && input.connectors
      ? createHash("sha256").update(JSON.stringify([input, providerRequest])).digest("hex") : undefined;
    const reserve = (preflight?: { owner: PendingAdmission; failure?: McpAdmissionFailure }) => this.ctx.storage.transaction<
      AgentReservation | { preflight: McpPreflight; owner: PendingAdmission }
    >(async transaction => {
      if (await transaction.get(VITEST_ADMISSION)) return null;
      const strategy = await transaction.get<StrategyRun>(STRATEGY_RUN);
      if (strategy) {
        if (!implicit || !sameProfileRequest(strategy.profile, input.profile) ||
            strategy.agent !== input.agent || strategy.prompt !== input.prompt ||
            !sameProviderRequest(strategy.routing?.request, providerRequest) ||
            strategy.deadline?.timeoutMs !== input.timeoutMs ||
            !sameRequestedSource(strategy, input) ||
            strategy.review?.producerAgent !== input.reviewProducer ||
            strategy.publish !== input.publish ||
            !sameConnectorNames(strategy.connectorAccess?.connectors, input.connectors) ||
            !sameRunSettings(strategy.overrides, input.overrides)) return null;
        return strategyView(strategy);
      }
      const previous = await transaction.get<RunRecord>(RUN);
      if (previous) {
        if (previous.strategyRunId !== strategyRunId || !matchesRunInput(previous, input) ||
            !sameProviderRequest(previous.routing?.request, parentRouting?.request ?? providerRequest) ||
            (strategyRunId !== undefined && previous.routing?.sandboxProvider !== parentRouting?.sandboxProvider) ||
            (strategyRunId !== undefined && previous.githubRepository?.repositoryId !== parentGithubRepository?.repositoryId) ||
            (strategyRunId !== undefined && previous.publicationMaxBytes !== options.publicationMaxBytes) ||
            (strategyRunId === undefined ? previous.deadline?.timeoutMs !== input.timeoutMs : !sameAgentDeadline(previous.deadline, parentDeadline)) ||
            (strategyRunId !== undefined && !sameRunSettings(previous, options.settings))) return null;
        if (cancel) return cancelRecord(transaction, previous, true);
        return publicView(strategyRunId === undefined ? previous : await expireRecord(transaction, previous));
      }
      if (input.agent === "opencode" && this.env.SANDBOX_RUNNER_OPENCODE !== "1") return "opencode_disabled";
      const pending = preflight?.owner ?? claim;
      const pendingError = await checkPendingAdmissionClaim(transaction, pending, fingerprint);
      if (pendingError !== undefined) return pendingError;
      const denied = await rejectUnownedAdmission(transaction, admission);
      if (denied) return denied;
      const routing = providerRequest === undefined ? parentRouting
        : resolveRunRouting(providerRequest, this.env.SANDBOX_RUNNER_DEFAULT_SANDBOX_PROVIDER);
      if (typeof routing === "string") return routing;
      const githubRepository = input.repository
        ? strategyRunId === undefined ? admitGithubCheckout(input.repository, this.env) : parentGithubRepository
        : undefined;
      if (typeof githubRepository === "string") return githubRepository;
      if (claim && githubRepository?.repositoryId !== claim.repository.repositoryId) return "github_repository_not_allowed";
      const publicationMaxBytes = input.publish ? strategyRunId === undefined
        ? publicationWireBudget(this.env.SANDBOX_RUNNER_GITHUB_PUBLICATION_MAX_BYTES) : options.publicationMaxBytes : undefined;
      if (input.publish && publicationMaxBytes === undefined) {
        return "github_publication_configuration_invalid";
      }
      if (input.repository && (!githubRepository ||
          `${githubRepository.owner}/${githubRepository.name}` !== input.repository.slug)) {
        return "github_checkout_not_configured";
      }
      const connectorAccess = connectorAccessFor(input.connectors, input.reviewProducer !== undefined);
      const selected = strategyRunId === undefined ? admittedConnectors(connectorAccess, this.env, githubRepository) : undefined;
      if (typeof selected === "string") return selected;
      const connectorFailure = selected && "connectorIssue" in selected ? selected : preflight?.failure;
      if (connectorFailure) {
        if (admission && admission !== "replay" && !pending) await fenceInstallationAdmission(transaction, admission.generation);
        return connectorFailure;
      }
      const connectorPolicy: Record<string, McpConnector> | undefined = strategyRunId === undefined
        ? selected && "policy" in selected ? selected.policy : undefined
        : options.parentConnectorPolicy === undefined ? undefined : JSON.parse(options.parentConnectorPolicy);
      const connectorGenerations: Record<string, string> | undefined = strategyRunId === undefined
        ? selected && "generations" in selected ? selected.generations : undefined
        : options.parentConnectorGenerations === undefined ? undefined : JSON.parse(options.parentConnectorGenerations);
      if (connectorAccess && !connectorAccess.connectors.every(name => connectorPolicy && Object.hasOwn(connectorPolicy, name))) {
        return "mcp_connector_configuration_invalid";
      }
      const policy = implicit && input.agent !== "opencode" ? policyFor(input.agent, this.env) : undefined;
      if (policy === "auth_strategy_invalid") return policy;
      // A strategy child receives the root's admitted snapshot, even when it is empty.
      const settings = strategyRunId !== undefined ? options.settings
        : input.agent === "claude" ? resolveClaudeSettings(input.overrides, this.env)
        : input.agent === "opencode" ? resolveOpenCodeSettings(input.modelProvider, input.overrides?.model,
          input.overrides?.effort, input.reviewProducer !== undefined)
        : input.overrides;
      if (settings === "claude_defaults_invalid") return settings;
      const deadline = providerRequest === undefined ? parentDeadline
        : resolveAgentDeadline(input.timeoutMs, this.env.SANDBOX_RUNNER_AGENT_TIMEOUT_MS, Date.now());
      if (typeof deadline === "string") return deadline;
      if (strategyRunId === undefined && connectorAccess && connectorPolicy && connectorGenerations && !preflight) {
        const requestTimeout = Math.max(mcpOAuthRequestTimeoutMs, apiTimeoutMs(this.env) ?? 0);
        // The resolver bounds its I/O. A recovery interval lets the owner
        // release the admission even if the request or its reply is interrupted.
        const deadlineAt = Date.now() + requestTimeout + RECOVERY_INTERVAL_MS;
        const generation = admission && admission !== "replay" ? admission.generation : undefined;
        const owner = claim ? { ...claim, deadlineAt }
          : { nonce: crypto.randomUUID(), fingerprint: fingerprint!, generation, deadlineAt, clientId: input.profile?.clientId };
        await transaction.put(PENDING_ADMISSION, owner);
        await transaction.setAlarm(owner.deadlineAt);
        return { preflight: { connectors: connectorPolicy, generations: connectorGenerations,
          mode: connectorAccess.mode, repository: githubRepository }, owner };
      }
      if (pending) {
        if (!activeAdmission(pending)) return "admission_unconfirmed";
        await transaction.delete(PENDING_ADMISSION);
      }
      if (policy && input.agent !== "opencode") {
        const run = newStrategyRun({ ...input, agent: input.agent }, policy, settings, routing,
          githubRepository, publicationMaxBytes, deadline, connectorPolicy, connectorGenerations);
        await writeStrategyRun(transaction, run);
        await indexAdmission(transaction, run.id, admission, false, run.profile?.clientId);
        await transaction.setAlarm(Date.now());
        return strategyView(run);
      }
      const run: RunRecord = {
        id: input.operationId, agent: input.agent, authMode: input.authMode, prompt: input.prompt,
        status: "queued", cleanup: "pending", ...settings,
        ...(input.profile === undefined ? {} : { profile: input.profile }),
        ...(routing === undefined ? {} : { routing }),
        ...(input.repository === undefined ? {} : { repository: input.repository, githubRepository }),
        ...(input.repositoryRef === undefined ? {} : { repositoryRef: input.repositoryRef }),
        ...(input.reviewProducer === undefined ? {} : { review: { producerAgent: input.reviewProducer } }),
        ...(input.publish ? { publish: true, publicationMaxBytes, publicationState: { phase: "requested" } } : {}),
        ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
        ...(strategyRunId === undefined ? {} : { strategyRunId }),
        ...(deadline === undefined ? {} : { deadline }),
        ...(connectorAccess === undefined ? {} : { connectorAccess, connectorPolicy, connectorGenerations }),
      };
      // A cancelled strategy may reach an attempt before a delayed reservation.
      // Persist the same identity in terminal state so a later reserve cannot start it.
      if (cancel) return publicView(await finishRecord(transaction, run, { status: "cancelled", reason: "run_cancelled" }));
      if (strategyRunId !== undefined && deadlineReached(deadline)) return publicView(await expireRecord(transaction, run));
      await writeRun(transaction, run);
      if (strategyRunId === undefined) await indexAdmission(transaction, run.id, admission, run.agent === "opencode", run.profile?.clientId);
      await transaction.setAlarm(Date.now());
      return publicView(run);
    });
    let reservation = await reserve();
    if (reservation && typeof reservation === "object" && "preflight" in reservation) {
      const { preflight, owner } = reservation;
      try {
        const failure = await this.#preflightMcp(preflight);
        reservation = await reserve({ owner, failure });
        if (reservation && typeof reservation === "object" && "preflight" in reservation) throw new Error("MCP preflight repeated");
      } finally {
        if (!claim) await this.#releasePendingAdmission(input.operationId, owner);
      }
    }
    if (reservation && typeof reservation === "object" && "connectorIssue" in reservation) {
      if (admission && admission !== "replay" && claim === undefined) await this.#expediteAdmissionRelease(input.operationId, admission.generation);
      return reservation;
    }
    if (reservation && typeof reservation !== "string" && strategyRunId === undefined && !await this.#publishIndex()) {
      return "run_index_unavailable";
    }
    return reservation;
  }

  async reserveVitest(submission: TestSubmission, owner?: AdmissionOwner): Promise<VitestRunView | VitestReservationError | null> {
    return this.#reserveTest(submission, owner);
  }

  async #reserveTest(submission: TestSubmission, owner?: AdmissionOwner, claim?: PendingReference):
    Promise<VitestRunView | VitestReservationError | null> {
    if (submission.operationId !== this.ctx.id.name) throw new Error("Test run identity mismatch");
    const admitted = await this.ctx.storage.transaction<TestAdmission | VitestReservationError | null>(async transaction => {
      const existing = await transaction.get<TestAdmission>(VITEST_ADMISSION);
      if (existing) return sameTestSubmission(existing, submission) ? existing : null;
      if (await transaction.get(RUN) || await transaction.get(STRATEGY_RUN)) return null;
      const reference = await checkPendingAdmissionClaim(transaction, claim);
      if (reference !== undefined) return reference;
      const denied = await rejectUnownedAdmission(transaction, owner);
      if (denied) return denied;
      const routing = resolveRunRouting({ sandboxProvider: submission.sandboxProvider, explicitAuth: false },
        this.env.SANDBOX_RUNNER_DEFAULT_SANDBOX_PROVIDER);
      if (typeof routing === "string") return routing;
      const { repository } = submission;
      if (!repository) return "github_checkout_not_configured";
      const githubRepository = admitGithubCheckout(repository, this.env);
      if (typeof githubRepository === "string") return githubRepository;
      if (claim && githubRepository.repositoryId !== claim.repository.repositoryId) return "github_repository_not_allowed";
      const timeout = vitestTimeout(this.env);
      if (timeout === undefined) return "vitest_not_configured";
      const admittedAt = Date.now();
      if (claim) {
        if (admittedAt >= claim.deadlineAt) return "admission_unconfirmed";
        await transaction.delete(PENDING_ADMISSION);
      }
      const admission = { ...submission, repository, githubRepository, admittedAt, deadlineAt: admittedAt + timeout,
        maxLockBytes: REQUEST_BYTES, logBytes: VITEST_LOG_BYTES };
      await transaction.put(VITEST_ADMISSION, admission);
      await indexAdmission(transaction, submission.operationId, owner, false, submission.profile?.clientId);
      await transaction.setAlarm(admittedAt);
      return admission;
    });
    if (!admitted || typeof admitted === "string") return admitted;
    if (!await this.#publishIndex()) return "run_index_unavailable";
    return this.#readVitest(admitted);
  }

  async #readVitest(admission: TestAdmission): Promise<VitestRunView> {
    const { operationId: id, repository, admittedAt, deadlineAt, profile } = admission;
    using view = await this.ctx.exports.VitestRun.getByName(id).read();
    const result = view ?? vitestView(createVitestState(id, repository, admittedAt, deadlineAt, admission.suite));
    return profile === undefined ? result : { ...structuredClone(result), profile };
  }

  async #admittedRun(storage: Pick<DurableObjectStorage, "get">) {
    return await storage.get<TestAdmission>(VITEST_ADMISSION) ??
      await storage.get<StrategyRun>(STRATEGY_RUN) ?? await storage.get<RunRecord>(RUN);
  }

  async #pendingRunVisible(storage: Pick<DurableObjectStorage, "get">, clientId?: string) {
    const pending = await storage.get<PendingAdmission>(PENDING_ADMISSION);
    return activeAdmission(pending) && allowedRunOwner(clientId, pending?.clientId);
  }

  async cancelTeam(clientId: string) {
    if (!validProfileSlug(clientId)) throw new Error("Run client identity mismatch");
    return this.#cancel(clientId);
  }

  async cancel() {
    return this.#cancel();
  }

  async #cancel(clientId?: string): Promise<RunView | VitestRunView | "cancel_unsupported" | "admission_in_progress" | null> {
    const state = await this.ctx.storage.transaction(async transaction => {
      const admitted = await this.#admittedRun(transaction);
      if (!admitted) return await this.#pendingRunVisible(transaction, clientId) ? "admission_in_progress" as const : null;
      if (!allowedRunOwner(clientId, admitted.profile?.clientId)) return null;
      if ("operationId" in admitted) return admitted;
      if ("policy" in admitted) {
        if (!admitted.routing) return "cancel_unsupported" as const;
        return strategyView(await requestStrategyCancellation(transaction, admitted));
      }
      if (!admitted.routing || admitted.strategyRunId !== undefined) return "cancel_unsupported" as const;
      return cancelRecord(transaction, admitted);
    });
    if (state && typeof state === "object" && "operationId" in state) {
      const { repositoryRef, ...test } = state;
      using view = await this.ctx.exports.VitestRun.getByName(test.operationId).reserve(test, true);
      return test.profile === undefined ? view : { ...structuredClone(view), profile: test.profile };
    }
    return state;
  }

  async readTeam(clientId: string) {
    if (!validProfileSlug(clientId)) throw new Error("Run client identity mismatch");
    return this.#read(clientId);
  }

  async read() {
    return this.#read();
  }

  async #read(clientId?: string): Promise<RunView | VitestRunView | "admission_in_progress" | null> {
    const state = await this.ctx.storage.transaction(async transaction => {
      const admitted = await this.#admittedRun(transaction);
      if (admitted) return allowedRunOwner(clientId, admitted.profile?.clientId) ? admitted : null;
      return await this.#pendingRunVisible(transaction, clientId) ? "admission_in_progress" as const : null;
    });
    if (!state || typeof state === "string") return state;
    if ("operationId" in state) return this.#readVitest(state);
    let strategy = "policy" in state ? state : undefined;
    if (strategy?.publicationState?.phase === "uncertain") {
      await this.#advanceReference(STRATEGY_RUN, true);
      strategy = await this.ctx.storage.get<StrategyRun>(STRATEGY_RUN);
    }
    if (strategy) return strategyView(strategy);
    let run = "policy" in state ? undefined : state;
    if (run?.publicationState?.phase === "uncertain") {
      await this.#advanceReference(RUN, true);
      run = await this.ctx.storage.get<RunRecord>(RUN);
    }
    return run ? publicView(run) : null;
  }

  async summary(): Promise<RunSummary | null> {
    const test = await this.ctx.storage.get<TestAdmission>(VITEST_ADMISSION);
    if (test) {
      const id = test.operationId;
      using state = await this.ctx.exports.VitestRun.getByName(id).summary();
      return { id, kind: "test", suite: test.suite ?? "vitest", sandboxProvider: "cloudflare",
        status: state?.status ?? "queued", cleanup: state?.cleanup ?? "pending",
        ...(test.profile === undefined ? {} : { profile: test.profile }) };
    }
    const strategy = await this.ctx.storage.get<StrategyRun>(STRATEGY_RUN);
    if (strategy) {
      const { status, cleanup } = strategyView(strategy);
      return { id: strategy.id, kind: "agent", agent: strategy.agent, sandboxProvider: "cloudflare", status, cleanup,
        ...(strategy.profile === undefined ? {} : { profile: strategy.profile }) };
    }
    const run = await this.ctx.storage.get<RunRecord>(RUN);
    if (!run || run.strategyRunId !== undefined) return null;
    const { id, agent, status, cleanup } = publicView(run);
    return { id, kind: "agent", agent, sandboxProvider: "cloudflare", status, cleanup,
      ...(run.profile === undefined ? {} : { profile: run.profile }) };
  }

  async eventsTeam(after: number, clientId: string) {
    if (!validProfileSlug(clientId)) throw new Error("Run client identity mismatch");
    return this.#events(after, clientId);
  }

  async events(after: number) {
    return this.#events(after);
  }

  async #events(after: number, clientId?: string) {
    const state = await this.ctx.storage.transaction(async transaction => {
      const admitted = await this.#admittedRun(transaction);
      if (!admitted || !allowedRunOwner(clientId, admitted.profile?.clientId)) return null;
      if ("operationId" in admitted) return admitted;
      if ("policy" in admitted) return runEventsPage(transaction, strategyView(admitted), after);
      return admitted.strategyRunId === undefined ? runEventsPage(transaction, publicView(admitted), after) : null;
    });
    if (!state || typeof state === "string" || !("operationId" in state)) return state;
    const page = await this.ctx.exports.VitestRun.getByName(state.operationId).events(after);
    if (page === "invalid_cursor") return page;
    using view = page;
    return view ?? pendingVitestEventsPage(state.operationId, after, state.suite);
  }

  async egressAllowed(agent: Agent, authMode?: AuthMode, modelProvider?: ModelProvider, openCodeReview?: true): Promise<boolean> {
    const run = await this.ctx.storage.get<RunRecord>(RUN);
    return (agent !== "opencode" || this.env.SANDBOX_RUNNER_OPENCODE === "1") &&
      allowsEgress(run, agent, effectiveAuthMode(agent, authMode), modelProvider, openCodeReview);
  }

  async githubEgressRepository(): Promise<GithubRepository | undefined> {
    const run = await this.ctx.storage.get<RunRecord>(RUN);
    if (run && !terminal(run.status) && !deadlineReached(run.deadline)) return run.githubRepository;
  }

  async githubEgressAttemptAllowed(id: string): Promise<boolean> {
    const strategy = await this.ctx.storage.get<StrategyRun>(STRATEGY_RUN);
    return !!strategy?.githubRepository && activeEgressAttempt(strategy, id) !== undefined;
  }

  async mcpRoute(name: string): Promise<string | undefined> {
    const route = mcpRouteFor(await this.ctx.storage.get<RunRecord>(RUN), name, this.env.SANDBOX_RUNNER_MCP_CONNECTORS);
    // Pass the recursive JSON policy by value across the internal RPC boundary.
    if (route) return JSON.stringify(route);
  }

  async mcpAllowed(name: string, selected: string): Promise<boolean> {
    return await this.mcpRoute(name) === selected;
  }

  async mcpAttemptAllowed(id: string, name: string): Promise<boolean> {
    const strategy = await this.ctx.storage.get<StrategyRun>(STRATEGY_RUN);
    return !!strategy?.connectorAccess?.connectors.includes(name) && activeEgressAttempt(strategy, id) !== undefined;
  }

  #mcpSession(name: string) {
    return mcpSession(this.ctx.storage, mcpSessionKey(name),
      async transaction => !!mcpRouteFor(await transaction.get<RunRecord>(RUN), name, this.env.SANDBOX_RUNNER_MCP_CONNECTORS));
  }

  async mcpSessionRead(name: string): Promise<McpUpstreamSession | undefined> {
    return this.#mcpSession(name).read();
  }

  async mcpSessionClaim(name: string, id: string, replaces?: string): Promise<boolean> {
    return this.#mcpSession(name).claim(id, replaces);
  }

  async mcpSessionCommit(name: string, id: string, upstreamId: string, protocolVersion: string,
    reply?: McpInitializeReply): Promise<boolean> {
    return this.#mcpSession(name).commit(id, upstreamId, protocolVersion, reply);
  }

  async mcpSessionReplay(name: string, id: string, requestedVersion: string): Promise<McpInitializeResult | undefined> {
    return this.#mcpSession(name).replay(id, requestedVersion);
  }

  async mcpSessionAcknowledge(name: string, id: string): Promise<boolean> {
    return this.#mcpSession(name).acknowledge(id);
  }

  async mcpSessionRelease(name: string, id: string, pendingOnly?: true): Promise<boolean> {
    return this.#mcpSession(name).release(id, pendingOnly);
  }

  async recordMcpIssue(value: McpConnectorIssue, attemptId?: string): Promise<void> {
    const issue = checkedMcpConnectorIssue(value);
    if (!issue) return;
    await this.ctx.storage.transaction(async transaction => {
      const run = attemptId === undefined ? await transaction.get<RunRecord>(RUN)
        : await transaction.get<StrategyRun>(STRATEGY_RUN);
      if (!run?.connectorAccess?.connectors.includes(issue.connector) || run.connectorAccess.mode !== issue.mode ||
          ("policy" in run ? !attemptId || activeEgressAttempt(run, attemptId) === undefined
            : terminal(run.status) || deadlineReached(run.deadline))) return;
      const connectorIssues = appendMcpIssues(run, [issue]);
      if (!connectorIssues) return;
      if ("policy" in run) await writeStrategyRun(transaction, { ...run, connectorIssues }, run);
      else await writeRun(transaction, { ...run, connectorIssues }, run);
    });
  }

  async claimMcpWrite(name: string, requestId: string | number, attemptId?: string): Promise<boolean> {
    return this.ctx.storage.transaction(async transaction => {
      let run: RunRecord | StrategyRun | undefined;
      if (attemptId === undefined) {
        run = await transaction.get<RunRecord>(RUN);
        if (run?.strategyRunId !== undefined ||
            mcpRouteFor(run, name, this.env.SANDBOX_RUNNER_MCP_CONNECTORS)?.mode !== "read-write") return false;
      } else {
        const strategy = await transaction.get<StrategyRun>(STRATEGY_RUN);
        if (strategy?.connectorAccess?.mode !== "read-write" || !strategy.connectorAccess.connectors.includes(name) ||
            activeEgressAttempt(strategy, attemptId) === undefined) return false;
        run = strategy;
      }
      const { connectorAccess, connectorPolicy } = run ?? {};
      const endpoint = connectorPolicy?.[name]?.url;
      if (!run || !connectorAccess || !connectorPolicy || !endpoint) return false;
      const origin = new URL(endpoint).origin;
      const aliases = connectorAccess.connectors.filter(alias => {
        const target = connectorPolicy[alias]?.url;
        return target !== undefined && new URL(target).origin === origin;
      });
      if (aliases.some(alias => hasUnconfirmedMcpWrite(run, alias))) return false;
      return claimConnectorWrite(transaction, name, requestId, attemptId, aliases);
    });
  }

  async settleMcpWrite(name: string, requestId: string | number, attemptId?: string, dispatched = false): Promise<boolean> {
    return this.ctx.storage.transaction(async transaction => {
      if (dispatched) {
        if (attemptId === undefined) {
          const run = await transaction.get<RunRecord>(RUN);
          if (mcpRouteFor(run, name, this.env.SANDBOX_RUNNER_MCP_CONNECTORS)?.mode !== "read-write") return false;
        } else {
          const run = await transaction.get<StrategyRun>(STRATEGY_RUN);
          if (!run || activeEgressAttempt(run, attemptId) === undefined) return false;
        }
      }
      return settleConnectorWrite(transaction, name, requestId, attemptId, dispatched);
    });
  }

  async closeMcpWrites(attemptId?: string): Promise<McpConnectorIssue[]> {
    return this.ctx.storage.transaction(async transaction => {
      const run = attemptId === undefined ? await transaction.get<RunRecord>(RUN)
        : await transaction.get<StrategyRun>(STRATEGY_RUN);
      if (run?.connectorAccess?.mode !== "read-write" ||
          ("policy" in run ? activeAttempt(run).operationId !== attemptId || activeAttempt(run).cleanup !== "pending"
            : run.cleanup !== "pending")) return [];
      const issues = await closeConnectorWrites(transaction, run.connectorAccess.connectors, attemptId);
      const connectorIssues = appendMcpIssues(run, issues);
      if (connectorIssues) {
        if ("policy" in run) await writeStrategyRun(transaction, { ...run, connectorIssues }, run);
        else await writeRun(transaction, { ...run, connectorIssues }, run);
      }
      return issues;
    });
  }

  async #closeRunMcpWrites(run: RunRecord): Promise<McpConnectorIssue[]> {
    if (run.connectorAccess?.mode !== "read-write") return [];
    if (run.strategyRunId === undefined) return this.closeMcpWrites();
    using issues = await this.ctx.exports.Run.getByName(run.strategyRunId).closeMcpWrites(run.id);
    return issues.map(issue => ({ ...issue }));
  }

  async publicationPreparationAllowed(id: string): Promise<boolean> {
    const strategy = await this.ctx.storage.get<StrategyRun>(STRATEGY_RUN);
    return strategy !== undefined && strategyPreparationAllowed(strategy, id);
  }

  async preparedPublication(rootId: string): Promise<GithubPreparedPublication | undefined> {
    const run = await this.ctx.storage.get<RunRecord>(RUN);
    if (run?.strategyRunId === rootId && run.status === "succeeded" && run.cleanup === "destroyed" && !deadlineReached(run.deadline) &&
        run.publicationState?.phase === "prepared") return run.publicationState.receipt;
  }

  async fixturePublicationRequest(rootId: string, repository: GithubRepository, request: Request): Promise<Response> {
    if (!githubCheckoutFixture(this.env) || this.ctx.id.name !== "github-publication-fixture:" + rootId ||
        operationId(rootId) !== rootId) return notFound();
    return githubPublicationFixtureResponse(request, repository, rootId, this.ctx.storage);
  }

  async strategyEgressAllowed(id: string, agent: Agent, authMode: AuthMode): Promise<boolean> {
    const run = await this.ctx.storage.get<StrategyRun>(STRATEGY_RUN);
    return run?.agent === agent && activeEgressAttempt(run, id)?.authMode === authMode;
  }

  async observeInference(agent: Agent, authMode: AuthMode, event: InferenceEvent, modelProvider?: ModelProvider,
    openCodeReview?: true): Promise<boolean> {
    return this.ctx.storage.transaction(async transaction => {
      if ((agent === "opencode" && this.env.SANDBOX_RUNNER_OPENCODE !== "1") ||
          !allowsEgress(await transaction.get<RunRecord>(RUN), agent, authMode, modelProvider, openCodeReview)) return false;
      const current = await transaction.get<InferenceAttempt>(INFERENCE);
      const next = nextInference(current, event);
      if (next) await transaction.put(INFERENCE, next);
      return true;
    });
  }

  #runtimeFor(run: RunRecord): Runtime {
    if (this.#runtime) return this.#runtime;
    const container = this.ctx.container;
    if (!container) throw new Error("Container binding unavailable");
    const props = { runId: run.id, ...(run.strategyRunId ? { strategyRunId: run.strategyRunId } : {}) };
    const installEgress = run.githubRepository || run.connectorAccess ? async () => {
      if (run.githubRepository) await container.interceptOutboundHttps(
        githubGitHost, this.ctx.exports.GithubEgress({ props: { ...props, ...deadlineView(run.deadline) } }),
      );
      if (run.connectorAccess) await container.interceptOutboundHttp(
        mcpContainerHost, this.ctx.exports.McpEgress({ props }),
      );
    } : undefined;
    const harness = new ContainerHarness({
      agent: buildAgent(
        run, container.images.base, this.env.SANDBOX_RUNNER_MODE === "fixture", this.env.SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS,
      ),
      container: guardedContainerStart(container, () => !this.#tearingDown && !deadlineReached(run.deadline), installEgress),
      egress: this.ctx.exports.ProviderEgress,
      enableInternet: false,
      instance: { vcpu: 0.25, memoryMib: 1024, diskMb: 4000 },
      onContainerLost: "fail",
    });
    const lifecycle = Lifecycle.install(this).use(harness);
    return this.#runtime = { harness, lifecycle };
  }

  #advanceStrategy(): Promise<void> {
    return advanceStrategy(
      this.ctx.storage,
      async (rootId, input, settings, parentRouting, cancel, parentGithubRepository, publicationMaxBytes, parentDeadline,
        parentConnectorPolicy, parentConnectorGenerations): Promise<AttemptReservation> => {
        const child = this.ctx.exports.Run.getByName(attemptName(rootId, input.operationId));
        const view = await child.reserve(input, {
          strategyRunId: rootId, settings, parentRouting, cancel, parentGithubRepository, publicationMaxBytes, parentDeadline,
          parentConnectorPolicy: parentConnectorPolicy === undefined ? undefined : JSON.stringify(parentConnectorPolicy),
          parentConnectorGenerations: parentConnectorGenerations === undefined ? undefined : JSON.stringify(parentConnectorGenerations),
        });
        if (!view || typeof view === "string") return view;
        if ("connectorIssue" in view) return "mcp_connector_configuration_invalid";
        using reserved = view;
        const detached = structuredClone(reserved);
        if (detached.status === "succeeded" && detached.cleanup === "destroyed" && detached.publication?.status === "pending" &&
            !deadlineReached(parentDeadline)) {
          using receipt = await child.preparedPublication(rootId);
          if (receipt) return { view: detached, receipt: structuredClone(receipt) };
        }
        return detached;
      },
      { advance: ADVANCE_INTERVAL_MS, recovery: RECOVERY_INTERVAL_MS },
    );
  }

  async #checkDeadline(run: RunRecord): Promise<RunRecord> {
    if (!runDeadlineDue(run)) return run;
    return this.ctx.storage.transaction(async transaction => {
      const current = await transaction.get<RunRecord>(RUN);
      return current ? expireRecord(transaction, current) : run;
    });
  }

  async #publishAlarmIndex(): Promise<boolean> {
    if (await this.ctx.storage.get(pendingRunIndex) === undefined) return true;
    const run = await this.ctx.storage.get<RunRecord>(RUN);
    const deadline = run?.deadline ?? (await this.ctx.storage.get<StrategyRun>(STRATEGY_RUN))?.deadline;
    if (!deadline) return this.#publishIndex();

    // A suspended index RPC must not hold the only alarm past the workload's
    // deadline or delay timeout teardown during a later index retry.
    const expired = deadlineReached(deadline);
    if (expired) await this.#recoverIndex();
    const nextAlarm = await this.ctx.storage.getAlarm();
    const now = Date.now();
    return this.#publishIndex(Math.min(now + RECOVERY_INTERVAL_MS,
      expired ? Infinity : deadline.deadlineAt,
      nextAlarm !== null && nextAlarm > now ? nextAlarm : Infinity));
  }

  async #recoverIndex(): Promise<void> {
    const run = await this.ctx.storage.get<RunRecord>(RUN);
    if (run) {
      const current = await this.#checkDeadline(run);
      if ((current.status === "timed_out" || current.timedOut) && current.cleanup === "pending") await this.#cleanup(current);
    }
    const strategy = await this.ctx.storage.get<StrategyRun>(STRATEGY_RUN);
    // Do not start work until indexing succeeds, but expiry still closes the child.
    if (strategy && (strategy.timedOut || strategyDeadlineDue(strategy))) await this.#advanceStrategy();
    await this.ctx.storage.transaction(async transaction => {
      const current = await transaction.get<RunRecord>(RUN);
      const root = await transaction.get<StrategyRun>(STRATEGY_RUN);
      let retry = Date.now() + RECOVERY_INTERVAL_MS;
      if (current?.deadline && !terminal(current.status)) retry = Math.min(retry, current.deadline.deadlineAt);
      if (root) retry = strategyAlarmTime(root, retry);
      const alarm = await transaction.getAlarm();
      await transaction.setAlarm(alarm === null ? retry : Math.min(retry, alarm));
    });
  }

  #nextAdvance(run: RunRecord): number {
    const next = Date.now() + ADVANCE_INTERVAL_MS;
    // The SDK owns the physical alarm while active. Bound its host job's
    // next wake instead of competing with the SDK's own alarm re-arming.
    return run.deadline ? Math.min(next, run.deadline.deadlineAt) : next;
  }

  async #driveLifecycle(run: RunRecord): Promise<void> {
    const { lifecycle } = this.#runtimeFor(run);
    const work = (async () => {
      if (!lifecycle.jobs.get(ADVANCE)) await lifecycle.jobs.push({ id: ADVANCE, fn: ADVANCE, time: Date.now() });
      await lifecycle.alarm();
      if (!this.#tearingDown && !lifecycle.jobs.get(ADVANCE)) {
        await lifecycle.jobs.push({ id: ADVANCE, fn: ADVANCE, time: this.#nextAdvance(run) });
      }
    })();
    if (!run.deadline) return work;

    // A single DO cannot run a second alarm during a long SDK wake. Join the
    // wake after teardown has closed its socket and the native container.
    const { promise, resolve } = Promise.withResolvers<false>();
    const timer = setTimeout(() => resolve(false), Math.max(0, run.deadline.deadlineAt - Date.now()));
    try {
      if (await Promise.race([work.then(() => true), promise])) return;
      const current = await this.#checkDeadline(run);
      if (current.status === "timed_out" || current.timedOut) {
        this.#tearingDown = true;
        // disableAlarms fences re-arming before it clears storage. Cleanup
        // establishes its own recovery alarm even if clearing failed.
        await lifecycle.disableAlarms().catch(() => {});
        try {
          if (current.cleanup === "pending") await this.#cleanup(current);
        } finally {
          await work.catch(() => {}); // A wake can fail when its container is destroyed.
        }
      } else {
        await work;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // Cloudflare checks for this prototype method when the object schedules an alarm.
  async alarm(): Promise<void> {
    const pending = await this.ctx.storage.transaction(async transaction => {
      const reference = await transaction.get<PendingAdmission>(PENDING_ADMISSION);
      if (!reference) return;
      const expired = !activeAdmission(reference);
      if (expired) await clearPendingAdmission(transaction, reference);
      else await transaction.setAlarm(reference.deadlineAt);
      return { reference, expired };
    });
    if (pending) {
      if (pending.expired) await this.#expediteAdmissionRelease(this.ctx.id.name!, pending.reference.generation);
      return;
    }
    if (!await this.#publishAlarmIndex()) {
      await this.#recoverIndex();
      return;
    }
    const test = await this.ctx.storage.get<TestAdmission>(VITEST_ADMISSION);
    if (test) {
      const { repositoryRef, ...admission } = test;
      using reserved = await this.ctx.exports.VitestRun.getByName(test.operationId).reserve(admission);
      return;
    }
    const strategy = await this.ctx.storage.get<StrategyRun>(STRATEGY_RUN);
    if (strategy) {
      if (settled(activeAttempt(strategy))) {
        await this.#advanceReference(STRATEGY_RUN);
        return;
      }
      await this.#advanceStrategy();
      return;
    }
    const stored = await this.ctx.storage.get<RunRecord>(RUN);
    if (!stored) return;
    const run = await this.#checkDeadline(stored);
    if (terminal(run.status)) {
      if (run.cleanup === "pending") {
        if (run.publicationState?.phase === "capture") await this.#prepareRunPublication(run);
        else await this.#cleanup(run);
      } else if (run.strategyRunId === undefined) {
        await this.#advanceReference(RUN);
      }
      return;
    }
    if (run.agent === "opencode" && this.env.SANDBOX_RUNNER_OPENCODE !== "1") {
      await this.#finish(run, { status: "failed", reason: "opencode_disabled" });
      return;
    }
    const provider = selectedProvider(run.agent, effectiveAuthMode(run.agent, run.authMode), run.modelProvider, run.review !== undefined);
    const fixtureMissingKey = this.env.SANDBOX_RUNNER_MODE === "fixture" && run.agent === "opencode" &&
      openCodeFixtureFor(run.prompt) === "missing";
    if (!provider || fixtureMissingKey || !providerCredential(provider, this.env)) {
      await this.#finish(run, { status: "auth_required", reason: "provider_credential_missing" });
      return;
    }
    if (!this.ctx.container) {
      await this.#finish(run, { status: "failed", reason: "container_unavailable" });
      return;
    }
    try {
      await this.#driveLifecycle(run);
    } finally {
      // A lifecycle alarm may have re-armed its jobs after a concurrent stop.
      const latest = await this.ctx.storage.get<RunRecord>(RUN);
      const current = latest && await this.#checkDeadline(latest);
      if (current && terminal(current.status) && current.cleanup === "pending" && !this.#tearingDown) {
        if (current.publicationState?.phase === "capture") await this.ctx.storage.setAlarm(Date.now());
        else await this.#cleanup(current);
      }
    }
  }

  async onJob({ job }: LifecycleJobContext) {
    if (job.fn !== ADVANCE) return;
    const stored = await this.ctx.storage.get<RunRecord>(RUN);
    if (!stored) return;
    const run = await this.#checkDeadline(stored);
    if (terminal(run.status)) return;
    const { harness } = this.#runtimeFor(run);
    if (run.status === "queued") {
      await harness.session().submit(run.review ? reviewPrompt(run.prompt) : run.prompt, { operationId: run.id });
      const running = await this.ctx.storage.transaction(async transaction => {
        const current = await transaction.get<RunRecord>(RUN);
        if (!current || current.status !== "queued") return false;
        if (await expireRecord(transaction, current) !== current) return false;
        await writeRun(transaction, { ...current, status: "running" }, current);
        return true;
      });
      if (running) return { rescheduleAt: this.#nextAdvance(run) };
      return;
    }
    if ((await harness.pending()).some(operation => operation.operationId === run.id)) {
      return { rescheduleAt: this.#nextAdvance(run) };
    }
    // Abort immediately if the operation would need to wait for a sibling job.
    const result = await harness.session().wait(run.id, AbortSignal.abort());
    let witnessFailed = false;
    let networkFailed = false;
    let fixtureNetwork: OpenCodeNetworkProof | undefined;
    if (run.agent === "opencode" && result.status === "done" &&
        this.env.SANDBOX_RUNNER_MODE === "fixture") {
      const fixture = openCodeFixtureFor(run.prompt);
      const checkout = fixture === "checkout" ? run.repository : undefined;
      if (fixture === "write" || fixture === "network" || fixture === "checkout") {
        witnessFailed = (fixture === "checkout" && (!checkout || !githubCheckoutFixture(this.env))) ||
          await beforeAgentDeadline(() => verifyOpenCodeWitness(this.ctx.container, run.id, checkout?.sha), run.deadline) !== true;
      }
      const modelProvider = run.modelProvider;
      if ((fixture === "network" || fixture === "checkout") && modelProvider && !witnessFailed) {
        const observed = await beforeAgentDeadline(() => verifyOpenCodeNetwork(this.ctx.container, modelProvider, checkout?.slug), run.deadline);
        fixtureNetwork = observed === deadlineElapsed ? undefined : observed;
        networkFailed = !openCodeNetworkBlocked(fixtureNetwork, fixture === "checkout");
      }
    }
    const pendingWrites = await this.#closeRunMcpWrites(run);
    const finished = await this.ctx.storage.transaction(async transaction => {
      const current = await transaction.get<RunRecord>(RUN);
      if (!current || current.status !== "running") return false;
      const attempt = await transaction.get<InferenceAttempt>(INFERENCE);
      if (await expireRecord(transaction, current) !== current) return true;
      const context = { agent: current.agent, authMode: effectiveAuthMode(current.agent, current.authMode),
        modelProvider: current.modelProvider };
      const connectorIssues = appendMcpIssues(current, pendingWrites);
      const resolved = pendingWrites.length > 0 || hasUnconfirmedMcpWrite(current)
        ? { status: "failed" as const, reason: mcpConnectorCodes.writeUnconfirmed }
        : witnessFailed ? { status: "failed" as const, reason: "opencode_fixture_verification_failed" }
        : networkFailed ? { status: "failed" as const, reason: "opencode_fixture_network_unverified" }
        : current.githubRepository && result.status === "unanswered" && result.reason === "github_checkout_failed"
        ? { status: "failed" as const, reason: "github_checkout_failed" }
        : outcome(result, attempt, context);
      const projected = withReviewResult(resolved, current.review);
      const publicationState = finishAgentPublication(current.publicationState, projected.status);
      await writeRun(transaction, { ...current, ...projected,
        ...(connectorIssues === undefined ? {} : { connectorIssues }),
        ...(fixtureNetwork === undefined ? {} : { fixtureNetwork }),
        ...(publicationState ? { publicationState } : {}) }, current);
      await transaction.delete(INFERENCE);
      return true;
    });
    if (finished) return { rescheduleAt: Date.now() };
  }

  async #finish(run: RunRecord, result: Outcome): Promise<void> {
    await this.ctx.storage.transaction(async transaction => {
      const current = await transaction.get<RunRecord>(RUN);
      if (!current || current.id !== run.id || terminal(current.status)) return;
      await finishRecord(transaction, current, deadlineReached(current.deadline) ? agentTimeoutOutcome : result);
    });
  }

  #publicationOptions(signal: AbortSignal, repository: GithubRepository, rootId: string, deadline?: AgentDeadline): PublicationOptions | undefined {
    const guard = () => {
      if (deadlineReached(deadline)) throw new GithubPublicationError("github_publication_authority_closed");
      if (deadline) signal.throwIfAborted();
    };
    if (githubCheckoutFixture(this.env)) {
      const fixture = this.ctx.exports.Run.getByName("github-publication-fixture:" + rootId);
      return { fixtureToken: githubPublicationFixtureToken,
        fetcher: (target, init) => {
          guard();
          return fixture.fixturePublicationRequest(rootId, repository, new Request(target, init));
        } };
    }
    const credentials = githubAppCredentials(this.env);
    if (credentials) return { credentials, fetcher: (target, init) => {
      guard();
      return fetch(target, { ...init, signal });
    } };
  }

  #publicationSignal(deadline?: AgentDeadline): AbortSignal {
    // A status or result read can reconcile an uncertain publication, so publication uses the API deadline.
    const transport = apiTimeoutMs(this.env) ?? 0;
    const remaining = deadline ? Math.max(0, deadline.deadlineAt - Date.now()) : transport;
    return AbortSignal.timeout(Math.min(transport, remaining));
  }

  async #prepareRunPublication(run: RunRecord): Promise<void> {
    const state = run.publicationState;
    if (state?.phase !== "capture" || this.#publicationBusy) return;
    this.#publicationBusy = true;
    try {
      const recovering = await this.ctx.storage.transaction(async transaction => {
        const current = await transaction.get<RunRecord>(RUN);
        if (current?.publicationState?.phase !== "capture" || current.publicationState.commitDate !== state.commitDate) return false;
        if (await expireRecord(transaction, current) !== current) return false;
        await transaction.setAlarm(publicationAlarmTime(current, Date.now() + RECOVERY_INTERVAL_MS));
        return true;
      });
      if (!recovering) return;
      const root = run.strategyRunId ? this.ctx.exports.Run.getByName(run.strategyRunId) : undefined;
      const allowed = async () => {
        const current = await this.ctx.storage.get<RunRecord>(RUN);
        if (current?.publicationState?.phase !== "capture" || current.publicationState.commitDate !== state.commitDate ||
            current.cleanup !== "pending" || current.status !== "succeeded" || deadlineReached(current.deadline)) return false;
        return !root || await root.publicationPreparationAllowed(run.id);
      };
      let prepared: PublicationState | typeof deadlineElapsed;
      try {
        prepared = await beforeAgentDeadline(async (): Promise<PublicationState> => {
          const signal = this.#publicationSignal(run.deadline);
          const container = this.ctx.container;
          if (!run.githubRepository || !run.repository || !container?.running) {
            throw new GithubPublicationError("github_publication_unavailable");
          }
          const rootId = run.strategyRunId ?? run.id;
          const options = this.#publicationOptions(signal, run.githubRepository, rootId, run.deadline);
          const maxBytes = run.publicationMaxBytes;
          if (!options || maxBytes === undefined) throw new GithubPublicationError("github_publication_unavailable");
          const artifact = await exportGithubWorkspace(container, run.repository.sha, maxBytes, signal, allowed);
          if (artifact.changes.length === 0) return { phase: "settled", result: { status: "no_changes" } };
          if (run.deadline && !await allowed()) throw new GithubPublicationError("github_publication_authority_closed");
          const identity = { name: "Sandbox Runner", email: "sandbox-runner@example.invalid", date: state.commitDate };
          const receipt = await prepareGithubPublication({
            repository: run.githubRepository, operationId: rootId, baseSha: run.repository.sha,
            expectedBaseTreeSha: artifact.baseTreeSha, expectedTreeSha: artifact.treeSha, changes: artifact.changes,
            commit: { message: "Sandbox Runner " + rootId, author: identity, committer: identity },
          }, options, allowed);
          return { phase: "prepared", receipt };
        }, run.deadline);
      } catch (error) {
        const reason = error instanceof GithubPublicationError || error instanceof GithubWorkspaceError
          ? error.code : "github_publication_unavailable";
        prepared = failedPublication(reason);
      }
      await this.ctx.storage.transaction(async transaction => {
        const current = await transaction.get<RunRecord>(RUN);
        if (current?.publicationState?.phase !== "capture" || current.publicationState.commitDate !== state.commitDate) return;
        if (await expireRecord(transaction, current) !== current) return;
        if (prepared === deadlineElapsed) {
          await transaction.setAlarm(publicationAlarmTime(current, Date.now() + RECOVERY_INTERVAL_MS));
          return;
        }
        await writeRun(transaction, { ...current, publicationState: prepared }, current);
        await transaction.setAlarm(Date.now());
      });
    } finally {
      this.#publicationBusy = false;
    }
  }

  async #referenceOwner(key: string, storage: Pick<DurableObjectStorage, "get">): Promise<RunRecord | StrategyRun | undefined> {
    if (key === STRATEGY_RUN) {
      const strategy = await storage.get<StrategyRun>(key);
      if (!strategy) return;
      const attempt = activeAttempt(strategy);
      return attempt.status === "succeeded" && attempt.cleanup === "destroyed" ? strategy : undefined;
    }
    const run = await storage.get<RunRecord>(RUN);
    return run?.status === "succeeded" && run.cleanup === "destroyed" && run.strategyRunId === undefined ? run : undefined;
  }

  async #advanceReference(key: string, manual = false): Promise<void> {
    if (this.#publicationBusy) return;
    this.#publicationBusy = true;
    try {
      const selected = await this.ctx.storage.transaction(async transaction => {
        let owner = await this.#referenceOwner(key, transaction);
        if (owner && !manual) owner = await expirePublicationOwner(transaction, owner);
        const pending = owner?.publicationState;
        if (!owner || !pending ||
            (pending.phase !== "prepared" && pending.phase !== "claimed" && pending.phase !== "uncertain")) return;
        if (manual !== (pending.phase === "uncertain")) return;
        if (!receiptMatches(pending.receipt, owner.githubRepository, owner.id, owner.repository?.sha)) {
          await writePublicationOwner(transaction, owner, failedPublication("github_objects_unverified"));
          await transaction.deleteAlarm();
          return;
        }
        if (pending.phase !== "uncertain") await transaction.setAlarm(publicationAlarmTime(owner, Date.now() + RECOVERY_INTERVAL_MS));
        return { state: pending, deadline: manual ? undefined : publicationDeadline(owner) };
      });
      if (!selected) return;
      const { state, deadline } = selected;
      const { receipt } = state;
      const uncertain = { status: "uncertain", ref: "refs/heads/sandbox-runner/" + receipt.operationId } as const;
      let result: GithubPublicationResult;
      try {
        const timeout = apiTimeoutMs(this.env) ?? 0;
        const options = this.#publicationOptions(this.#publicationSignal(deadline), receipt.repository, receipt.operationId, deadline);
        if (!options) throw new GithubPublicationError("github_publication_unavailable");
        const attempt = await beforeAgentDeadline(() => state.phase !== "prepared" ? reconcileGithubReference(receipt, options)
          : publishGithubReference(receipt, options, () => this.ctx.storage.transaction(async transaction => {
            const owner = await this.#referenceOwner(key, transaction);
            const now = Date.now();
            if (!owner?.publicationState || owner.timedOut ||
                ("cancellationRequested" in owner && owner.cancellationRequested)) return false;
            // Allow a full configured attempt for the write and a second
            // window for fresh reads if GitHub has not exposed the ref yet.
            const claimed = claimReference(owner.publicationState, receipt, now + timeout * 2, owner.deadline?.deadlineAt, now);
            if (!claimed) return false;
            await writePublicationOwner(transaction, owner, claimed);
            await transaction.setAlarm(publicationAlarmTime(owner, now + RECOVERY_INTERVAL_MS));
            return true;
          })), deadline);
        result = attempt === deadlineElapsed ? uncertain : attempt;
      } catch {
        result = uncertain;
      }
      await this.ctx.storage.transaction(async transaction => {
        let owner = await this.#referenceOwner(key, transaction);
        if (owner && !manual) owner = await expirePublicationOwner(transaction, owner);
        if (!owner?.publicationState) return;
        const retry = recoveryAlarm(owner.publicationState, state.phase, receipt, result, Date.now(), ADVANCE_INTERVAL_MS);
        if (retry !== undefined) {
          await transaction.setAlarm(publicationAlarmTime(owner, retry));
          return;
        }
        if (owner.publicationState.phase === "uncertain" && result.status === "uncertain") return;
        const next = finishReference(owner.publicationState, receipt, result);
        if (!next) return;
        await writePublicationOwner(transaction, owner, next);
        await transaction.deleteAlarm();
      });
    } finally {
      this.#publicationBusy = false;
    }
  }

  async #destroyContainer(): Promise<boolean> {
    try {
      await this.#runtime?.harness.dispose();
    } catch {
      // Closing a session socket is best effort. The container still needs destruction.
    }
    try {
      const container = this.ctx.container;
      if (container && (container.running || await container.inspect() !== null)) await container.destroy();
      return container === undefined || (!container.running && await container.inspect() === null);
    } catch {
      // The recovery alarm will retry the native operation without restarting the harness.
      return false;
    }
  }

  async #cleanup(run: RunRecord): Promise<void> {
    this.#tearingDown = true;
    await this.ctx.storage.setAlarm(publicationAlarmTime(run, Date.now() + RECOVERY_INTERVAL_MS));
    await this.#closeRunMcpWrites(run);
    const destruction = this.#destroyContainer();
    let destroyed = await beforeAgentDeadline(() => destruction, publicationDeadline(run));
    if (destroyed === deadlineElapsed) {
      await this.#checkDeadline(run);
      destroyed = await destruction;
    }
    const cleanup = await this.ctx.storage.transaction(async transaction => {
      const stored = await transaction.get<RunRecord>(RUN);
      if (!stored || stored.cleanup !== "pending") return "unchanged";
      const current = await expireRecord(transaction, stored);
      if (!destroyed) {
        const failures = (await transaction.get<number>(CLEANUP_FAILURES) ?? 0) + 1;
        if (failures < CLEANUP_FAILURE_LIMIT) {
          await transaction.put(CLEANUP_FAILURES, failures);
          return "retry";
        }
      }
      const publicationState = !destroyed && current.publish ? failedPublication("github_publication_cleanup_failed")
        : current.publicationState;
      await writeRun(transaction, { ...current, cleanup: destroyed ? "destroyed" : "failed",
        ...(publicationState ? { publicationState } : {}) }, current);
      await transaction.delete(CLEANUP_FAILURES);
      if (destroyed && current.strategyRunId === undefined && publicationState?.phase === "prepared") {
        await transaction.setAlarm(Date.now());
        return "publication";
      }
      await transaction.deleteAlarm();
      return "settled";
    });
    if (cleanup === "settled") await this.#runtime?.lifecycle.disableAlarms();
  }

}

function admissionFailure(error: AdmissionError, operationId: string): Response {
  return json({ error, operationId }, error === "installation_capacity" ? 429 : 503);
}

function guardCredential(env: WorkerEnv): string | undefined {
  const token = env[admissionGuardBinding];
  return validGuardToken(token) && token !== env.SANDBOX_RUNNER_TOKEN ? token : undefined;
}

async function manageAdmissionGuard(request: Request, env: WorkerEnv, ctx: ExecutionContext, pathname: string,
  searchParams: URLSearchParams): Promise<Response> {
  const index = ctx.exports.RunIndex.getByName(runIndexName);
  const metadata = { protocolVersion: 1, workerVersionId: env.SANDBOX_RUNNER_VERSION?.id ?? null };
  try {
    if (pathname !== admissionGuardPath) {
      const id = pathname.slice(admissionGuardPath.length + 1);
      if (request.method !== "GET" || searchParams.size || !validGuardId(id)) return notFound();
      using operation = await index.admissionGuardOperation(id);
      return operation ? json(operation) : json({ error: "admission_not_found" }, 404);
    }
    if (request.method === "GET") {
      const cursor = searchParams.get("after");
      if (searchParams.size && (searchParams.size !== 1 || !cursor || !validAdmissionGeneration(cursor))) {
        return json({ error: "invalid_cursor" }, 400);
      }
      using state = await index.admissionGuard(cursor ?? undefined);
      return json({ ...state, ...metadata });
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (searchParams.size || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return json({ error: "invalid_admission_guard_request" }, 400);
    }
    const text = await readRequestText(request);
    let action: ReturnType<typeof parseGuardAction>;
    try {
      if (text !== undefined && !hasDuplicateJsonKeys(text)) action = parseGuardAction(JSON.parse(text), validAdmissionGeneration);
    } catch { /* Reject malformed JSON below. */ }
    if (!action) return json({ error: "invalid_admission_guard_request" }, 400);
    using state = await index.updateAdmissionGuard(action);
    return state ? json({ ...state, ...metadata }) : json({ error: "admission_guard_conflict" }, 409);
  } catch {
    return json({ error: "admission_guard_unavailable" }, 503);
  }
}

function profileRequired() {
  return new TeamRequestError("profile_required", "Team clients must submit a published profile.", 403);
}

function auditDenial(ctx: ExecutionContext, clientId: string | undefined, reason: TeamDenial) {
  if (clientId === undefined) return;
  ctx.waitUntil(ctx.exports.RunIndex.getByName(runIndexName).deny(clientId, reason).catch(() => {}));
}

async function manageCatalog(request: Request, ctx: ExecutionContext, operatorDigest: string): Promise<Response> {
  const index = ctx.exports.RunIndex.getByName(runIndexName);
  if (request.method === "GET") {
    const current = await index.catalog();
    return current === null ? json({ revision: null, config: null })
      : new Response(current, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  if (request.method !== "PUT") return json({ error: "method_not_allowed" }, 405);
  const match = request.headers.get("if-match");
  const create = request.headers.get("if-none-match");
  const expected = match === null && create === "*" ? null
    : create === null && /^"[a-f0-9]{64}"$/.test(match ?? "") ? match!.slice(1, -1) : undefined;
  if (expected === undefined) return json({ error: "team_catalog_precondition_required" }, 428);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return json({ error: "invalid_team_catalog" }, 415);
  }
  const text = await readRequestText(request);
  const catalog = text === undefined ? undefined : parseTeamCatalog(text);
  if (!catalog || catalog.clients.some(client => sameTokenDigest(client.tokenSha256, operatorDigest))) {
    return json({ error: "invalid_team_catalog" }, 400);
  }
  const revision = await index.publishCatalog(expected, catalog);
  return revision === null ? json({ error: "team_catalog_revision_changed" }, 412) : json({ revision });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    // /mcp is authenticated by Cloudflare Access, not by a runner token. Other paths are unaffected.
    const index = () => ctx.exports.RunIndex.getByName(runIndexName);
    const remote = await serveAccessMcp(request, env, ctx,
      async email => { const grant = await index().identifyAccessMember(email); return grant === null ? null : JSON.parse(grant); },
      (api, team) => serveApi(api, env, ctx, { team }));
    if (remote) return remote;
    const bearer = request.headers.get("authorization");
    if (!bearer?.startsWith("Bearer ") || !env.SANDBOX_RUNNER_TOKEN) return notFound();
    const token = bearer.slice("Bearer ".length);
    const [actual, operatorDigest] = await Promise.all([tokenDigest(token), tokenDigest(env.SANDBOX_RUNNER_TOKEN)]);
    const { pathname: path, searchParams } = new URL(request.url);
    if (path === admissionGuardPath || path.startsWith(admissionGuardPath + "/")) {
      const credential = guardCredential(env);
      if (!validGuardToken(token) || !credential || !sameTokenDigest(actual, await tokenDigest(credential))) return notFound();
      return manageAdmissionGuard(request, env, ctx, path, searchParams);
    }
    const operator = sameTokenDigest(actual, operatorDigest);
    if (!operator && (token.length !== 64 || !/^[a-f0-9]+$/.test(token))) return notFound();
    let team: TeamGrant | null = null;
    if (!operator) {
      try {
        const grant = await ctx.exports.RunIndex.getByName(runIndexName).identifyTeamClient(actual);
        team = grant === null ? null : JSON.parse(grant);
      } catch {
        return json({ error: "team_configuration_invalid" }, 503);
      }
    }
    if (!operator && !team) return notFound();
    return serveApi(request, env, ctx, team === null ? { team: null, operatorDigest } : { team });
  },
} satisfies ExportedHandler<WorkerEnv>;

// Only the operator carries its token digest, so a team caller (token or Access) cannot be typed as operator.
type ApiCaller = { team: TeamGrant } | { team: null; operatorDigest: string };

/** Route an authenticated request. `team` is null only for the operator token. */
async function serveApi(request: Request, env: WorkerEnv, ctx: ExecutionContext, caller: ApiCaller): Promise<Response> {
    const { team } = caller;
    const operator = team === null;
    const operatorDigest = caller.team === null ? caller.operatorDigest : "";
    const { pathname: path, search, searchParams } = new URL(request.url);
    const clientId = team?.client.id;
    // Every team write (start, retry, cancel) is a POST; reads are GETs.
    if (team?.client.readOnly === true && request.method !== "GET") {
      auditDenial(ctx, clientId, "read_only_client");
      return json({ error: "client_read_only" }, 403);
    }
    if (path === "/v4/team/catalog" || path === "/v4/team/denials") {
      if (!operator) {
        auditDenial(ctx, clientId, "operator_required");
        return notFound();
      }
      if (search) return notFound();
      try {
        if (path === "/v4/team/catalog") return await manageCatalog(request, ctx, operatorDigest);
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        using denials = await ctx.exports.RunIndex.getByName(runIndexName).denials();
        return json({ denials });
      } catch {
        return json({ error: "team_configuration_invalid" }, 503);
      }
    }
    if (path === "/v4/profiles" || path.startsWith("/v4/profiles/")) {
      if (!team || request.method !== "GET") return notFound();
      const readiness = /^\/v4\/profiles\/([^/]+)\/readiness$/u.exec(path);
      if (search && !readiness) return notFound();
      if (path === "/v4/profiles") {
        const profiles = await Promise.all([...team.client.profiles].sort()
          .map(slug => teamProfile(team.catalog, team.client, slug)));
        return json({ clientId, profiles });
      }
      const slug = readiness?.[1] ?? path.slice("/v4/profiles/".length);
      const entry = await teamProfile(team.catalog, team.client, slug);
      if (!entry) {
        auditDenial(ctx, clientId, "profile_not_found");
        return json({ error: "profile_not_found" }, 404);
      }
      if (!readiness) return json({ clientId, ...entry });
      const revision = searchParams.get("revision");
      if (search && (searchParams.size !== 1 || revision === null || revision.length !== 64 || !digest.test(revision))) {
        return json({ error: "invalid_profile_request", message: "Supply an optional exact profile revision." }, 400);
      }
      if (revision !== null && revision !== entry.revision) {
        auditDenial(ctx, clientId, "profile_revision_changed");
        return json({ error: "profile_revision_changed", message: "The published profile revision has changed." }, 409);
      }
      return json({ clientId, slug, revision: entry.revision, ...profileReadiness(entry.profile, env) });
    }
    if (path === "/v4/runs" && request.method === "GET") {
      const query = parseRunListQuery(searchParams);
      if (typeof query === "string") return json({ error: query }, 400);
      try {
        const includeOpenCode = request.headers.get(openCodeListHeader) === "1";
        using page = await ctx.exports.RunIndex.getByName(runIndexName).page({ ...query, includeOpenCode, clientId });
        const runs = await Promise.all(page.ids.map(async id => {
          using run = await ctx.exports.Run.getByName(id).summary();
          if (run?.id !== id || !allowedRunOwner(clientId, run.profile?.clientId)) throw new Error("Run index projection unavailable");
          return run;
        }));
        return json({ runs, nextCursor: page.nextCursor });
      } catch {
        return json({ error: "run_list_unavailable" }, 503);
      }
    }
    if (path === "/v1/runs" || path === "/v2/runs" || path === "/v3/runs" || path === "/v4/runs") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const submission = team && path !== "/v4/runs" ? profileRequired() : await readInput(request, path, team ?? undefined);
      if (!submission) {
        auditDenial(ctx, clientId, "invalid_profile_request");
        return json({ error: "invalid_request" }, 400);
      }
      if (submission instanceof ProfileError) {
        const { code, message, issues } = submission;
        const status = submission instanceof TeamRequestError ? submission.status : 400;
        if (code === "invalid_profile_inputs") {
          const reason = issues?.some(issue => issue.code === "override_not_allowed") ? "override_not_allowed" : "invalid_profile_request";
          auditDenial(ctx, clientId, reason);
        } else if (code === "profile_required" || code === "profile_not_found" || code === "profile_revision_changed" ||
            code === "invalid_profile_request" || code === "override_not_allowed") auditDenial(ctx, clientId, code);
        return json({ error: code, message, ...(issues === undefined ? {} : { issues }) }, status);
      }
      const input = "vitest" in submission ? submission.vitest : submission.input;
      const id = input.operationId;
      const owner = ctx.exports.Run.getByName(id);
      const reserve = (admission?: AdmissionOwner) => team ? owner.reserveTeam(submission, admission)
        : input.repositoryRef ? owner.reserveReference(submission, admission)
        : "vitest" in submission ? owner.reserveVitest(submission.vitest, admission)
        : owner.reserve(submission.input, { explicitAuth: submission.explicitAuth, providerRequest: submission.providerRequest, admission });
      let run: Awaited<ReturnType<typeof reserve>>;
      try {
        if ("input" in submission && submission.input.agent === "opencode" && env.SANDBOX_RUNNER_OPENCODE !== "1") {
          // Existing runs stay replayable when the capability is disabled. A
          // fresh disabled request may not consume an installation ticket.
          run = await reserve("replay");
        } else {
          const decision = await ctx.exports.RunIndex.getByName(runIndexName).acquireGuarded(id, clientId);
          if (decision === "operation_conflict") return json({ error: decision }, 409);
          if (typeof decision === "object") {
            using ticket = decision;
            run = await reserve({ generation: ticket.generation });
          } else if (decision === "unconfigured") {
            run = await reserve();
          } else {
            run = await reserve("replay");
            if (run === "admission_replay_missing") {
              const error = decision === "existing" || decision === "frozen_pending" ? "admission_unconfirmed" : decision;
              return admissionFailure(error, id);
            }
          }
        }
      } catch {
        return admissionFailure("admission_unconfirmed", id);
      }
      if (run === "admission_unconfirmed" || run === "admission_replay_missing") return admissionFailure("admission_unconfirmed", id);
      if (run === "run_timeout_exceeds_limit") return json({ error: run }, 400);
      if (run === "github_reference_not_found") return json({ error: run, operationId: id }, 404);
      if (run === "github_reference_unavailable") return json({ error: run, operationId: id }, 503);
      if (run && typeof run === "object" && "connectorIssue" in run) {
        using failure = run;
        const { code, retryAfterSeconds } = failure.connectorIssue;
        const workerVersionId = env.SANDBOX_RUNNER_VERSION?.id;
        const response = json({ error: code, operationId: id, admission: "rejected", ...failure,
          ...(workerVersionId ? { workerVersionId } : {}) }, code === mcpConnectorCodes.rateLimited ? 429 : 503);
        if (retryAfterSeconds !== undefined) response.headers.set("retry-after", String(retryAfterSeconds));
        return response;
      }
      if (typeof run === "string") return json({ error: run },
        run === "github_repository_not_allowed" || run === "mcp_connector_not_allowed" ? 403 : 503);
      if (!run) {
        auditDenial(ctx, clientId, "operation_conflict");
        return json({ error: "operation_conflict" }, 409);
      }
      using view = run;
      if (!allowedRunOwner(clientId, view.profile?.clientId)) return admissionFailure("admission_unconfirmed", id);
      return json("input" in submission && submission.explicitAuth ? { ...view, authMode: submission.input.authMode } : view, 202);
    }
    const cancelId = operationId(/^\/v4\/runs\/([^/]+)\/cancel$/.exec(path)?.[1]);
    if (cancelId && !search) {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      await request.body?.cancel();
      const owner = ctx.exports.Run.getByName(cancelId);
      const run = await (clientId === undefined ? owner.cancel() : owner.cancelTeam(clientId)).catch(() => undefined);
      if (run === undefined) return json({ error: "run_cancel_unavailable" }, 503);
      if (run === "cancel_unsupported") return json({ error: run }, 409);
      if (run === "admission_in_progress") return json({ error: run, operationId: cancelId }, 409);
      if (!run) {
        auditDenial(ctx, clientId, "run_not_found");
        return json({ error: "run_not_found" }, 404);
      }
      using view = run;
      return json(view, 202);
    }
    const eventsId = operationId(/^\/v4\/runs\/([^/]+)\/events$/.exec(path)?.[1]);
    if (eventsId) {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      const cursor = parseEventsCursor(searchParams);
      if (cursor === undefined) return json({ error: "invalid_cursor" }, 400);
      const owner = ctx.exports.Run.getByName(eventsId);
      const page = await (clientId === undefined ? owner.events(cursor) : owner.eventsTeam(cursor, clientId)).catch(() => undefined);
      if (page === undefined) return json({ error: "run_events_unavailable" }, 503);
      if (page === "invalid_cursor") return json({ error: "invalid_cursor" }, 400);
      if (page === null) {
        auditDenial(ctx, clientId, "run_not_found");
        return json({ error: "run_not_found" }, 404);
      }
      using view = page;
      return json(view);
    }
    const match = /^\/v1\/runs\/([^/]+)(\/result)?$/.exec(path);
    const id = operationId(match?.[1]);
    if (!id) return notFound();
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const owner = ctx.exports.Run.getByName(id);
    const state = await (clientId === undefined ? owner.read() : owner.readTeam(clientId)).catch(() => undefined);
    if (state === undefined) return json({ error: "run_read_unavailable" }, 503);
    if (!state) {
      auditDenial(ctx, clientId, "run_not_found");
      return json({ error: "run_not_found" }, 404);
    }
    if (state === "admission_in_progress") return json({ error: match?.[2] ? "run_in_progress" : state, operationId: id }, 409);
    using run = state;
    if (match?.[2] && (!terminal(run.status) || run.cleanup === "pending" ||
        (run.kind !== "test" && run.publication?.status === "pending"))) {
      return json({ error: "run_in_progress" }, 409);
    }
    return json(run);
}
