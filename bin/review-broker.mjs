import { accessServiceHeaders } from "./access-service-token.mjs";
import { randomUUID } from "node:crypto";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { isDeepStrictEqual } from "node:util";
import { connectorIssueFailure, connectorIssueForClient } from "./connector-issues.mjs";
import { routeReview, validateReviewPolicy } from "./review-routing.mjs";
import { hasDuplicateJsonKeys } from "../worker/profile-json.mjs";
import { operationId } from "../worker/run-input-validation.mjs";
import { profileReceipt } from "../worker/run-profiles.mjs";

const active = new Set(["queued", "running"]);
const terminal = new Set(["succeeded", "capacity", "auth_required", "failed", "unanswered", "cancelled", "timed_out"]);
const cleanup = new Set(["pending", "destroyed", "failed"]);
// The Worker stores each run or team catalog as a single SQLite Durable Object value.
const maxResponseBytes = 2 * 1024 * 1024;
const escalate = reason => ({ status: "ESCALATE", reason });
const reconcile = (id, reason) => ({ status: "reconcile", operationId: id, reason });

function workerOrigin(value, allowLoopbackFixture) {
  const url = typeof value === "string" && URL.parse(value);
  if (!url || !/^https?:\/\/[^/\s@?#\\]+\/?$/iu.test(value) ||
      (url.protocol !== "https:" && !(allowLoopbackFixture === true && url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new TypeError("A trusted HTTPS Worker origin is required");
  }
  return url.origin;
}

function transport(origin, token, timeoutMs, signal) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token)) throw new TypeError("A team bearer is required");
  // Read once, outside the request: a half-set Access service token is a configuration error, not a request failure.
  const access = accessServiceHeaders();
  return (path, body) => {
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new TypeError("Unexpected Worker origin");
    const request = url.protocol === "https:" ? requestHttps : requestHttp;
    const headers = { accept: "application/json", authorization: `Bearer ${token}`, ...access };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return new Promise(resolve => {
      const outgoing = request(url, { method: body === undefined ? "GET" : "POST", headers,
        signal: requestSignal, agent: false, rejectUnauthorized: true }, async incoming => {
        const status = incoming.statusCode;
        if (status >= 300 && status < 400) {
          incoming.destroy();
          resolve({ issue: "worker_redirect_refused" });
          return;
        }
        try {
          const chunks = [];
          let bytes = 0;
          for await (const chunk of incoming) {
            bytes += chunk.byteLength;
            if (bytes > maxResponseBytes) throw new RangeError("Worker response exceeds the storage limit");
            chunks.push(chunk);
          }
          if (incoming.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
            resolve({ status, issue: "worker_response_unverified" });
            return;
          }
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          const value = JSON.parse(text);
          if (hasDuplicateJsonKeys(text) || JSON.stringify(value).includes(token)) {
            resolve({ status, issue: "worker_response_unverified" });
            return;
          }
          resolve({ status, value });
        } catch {
          resolve({ status, issue: "worker_response_unverified" });
        }
      });
      outgoing.on("error", () => resolve({ issue: "worker_request_unconfirmed" }));
      outgoing.end(body);
    });
  };
}

async function expectedReceipt(attempt) {
  const { journal, profile, body } = attempt;
  const request = JSON.parse(body);
  if (request?.kind !== "team-profile" || Object.keys(request).length !== 7 || hasDuplicateJsonKeys(body) ||
      request.operationId !== journal.operationId || request.profile !== journal.slug ||
      request.revision !== journal.revision || profile?.slug !== journal.slug || profile.revision !== journal.revision ||
      profile.profile?.operation !== "review" || profile.profile.publish) throw new TypeError("Journal request mismatch");
  const expected = await profileReceipt({ kind: "profile", operationId: request.operationId, profile: { slug: profile.slug, body: profile.profile },
    source: request.source, producerAgent: request.producerAgent, prompt: request.prompt });
  if (expected.revision !== journal.revision) throw new TypeError("Journal profile mismatch");
  return expected;
}

function validReceipt(value, attempt, expected) {
  return value?.id === attempt.journal.operationId && value.kind === "agent" && value.sandboxProvider === "cloudflare" &&
    (active.has(value.status) || terminal.has(value.status)) && cleanup.has(value.cleanup) &&
    (!active.has(value.status) || value.cleanup === "pending") &&
    value.profile?.source === "worker-catalog" && value.profile.producerSource === "declared" &&
    value.profile.clientId === attempt.clientId && value.profile.slug === expected.slug &&
    value.profile.revision === expected.revision && value.profile.requestDigest === expected.requestDigest &&
    value.publication === undefined && value.output === undefined && value.strategy === undefined &&
    value.attempts === undefined && value.fallbackReason === undefined;
}

async function catalogFor(call, clientId) {
  const response = await call("/v4/profiles");
  if (response.status === 200 && response.value?.clientId === clientId && Array.isArray(response.value.profiles)) {
    return { catalog: response.value };
  }
  return { issue: response.issue ?? "catalog_authority_unverified" };
}

function routeInput(input, attempt, catalog, nextOperationId) {
  const { policy, admission, source, qualifications } = input;
  const previous = attempt && { ...attempt.journal, profile: attempt.profile, requestBody: attempt.body,
    ...(attempt.stage === "settled" ? { receipt: attempt.receipt } : {}) };
  return { policy, admission, source, qualifications, catalog, previous, nextOperationId };
}

function blockedDecision(attempt) {
  const { operationId: id } = attempt.journal;
  if (attempt.rejection?.code === "operation_conflict") return { ...escalate("operation_conflict"), operationId: id };
  const issue = connectorIssueForClient(attempt.rejection);
  if (!issue) return escalate("journal_scope_mismatch");
  const { recovery, ...connectorIssue } = issue;
  return { ...escalate(issue.code), operationId: id, connectorIssue, recovery };
}

async function sendAttempt(attempt, expected, broker) {
  const id = attempt.journal.operationId;
  const authority = await broker.authorizeSubmission(id);
  if (authority?.allowed !== true || broker.signal?.aborted ||
      (authority.expiresAt !== undefined && (!Number.isSafeInteger(authority.expiresAt) || authority.expiresAt <= Date.now()))) {
    return escalate("admission_not_current");
  }
  const response = await broker.call("/v4/runs", attempt.body);
  if (response.status === 202 && validReceipt(response.value, attempt, expected)) {
    await broker.persist({ ...attempt, stage: "admitted" });
    return reconcile(id, "run_admitted");
  }
  const connector = connectorIssueFailure({ name: "run", id, reviewProducer: true,
    connectors: attempt.profile.profile.mcp?.connectors }, response.status, response.value);
  const rejection = connector?.admission === "rejected" ? connector.connectorIssue
    : response.status === 409 && response.value?.error === "operation_conflict" ? { code: "operation_conflict" } : undefined;
  if (rejection) {
    const blocked = { ...attempt, stage: "blocked", rejection };
    await broker.persist(blocked);
    return blockedDecision(blocked);
  }
  return reconcile(id, response.issue ?? "submission_unconfirmed");
}

async function readAttempt(attempt, expected, broker) {
  const id = attempt.journal.operationId;
  const path = `/v1/runs/${id}`;
  const response = await broker.call(path);
  if (response.status === 404 && isDeepStrictEqual(response.value, { error: "run_not_found" })) {
    return { missing: true };
  }
  if (response.status === 409 && isDeepStrictEqual(response.value, { error: "admission_in_progress", operationId: id })) {
    return { decision: reconcile(id, "admission_in_progress") };
  }
  if (response.status !== 200 || !validReceipt(response.value, attempt, expected)) {
    return { decision: reconcile(id, response.issue ?? "run_status_unverified") };
  }
  if (attempt.stage === "uncertain") {
    attempt = { ...attempt, stage: "admitted" };
    await broker.persist(attempt);
  }
  if (!terminal.has(response.value.status) || response.value.cleanup === "pending") {
    return { decision: reconcile(id, "run_in_progress") };
  }
  const result = await broker.call(path + "/result");
  if (result.status !== 200 || !isDeepStrictEqual(response.value, result.value)) {
    return { decision: reconcile(id, result.issue ?? "run_result_unverified") };
  }
  const settled = { ...attempt, stage: "settled", receipt: result.value };
  await broker.persist(settled);
  return { settled };
}

/** Advance a broker-owned review by one step while the broker holds its contract lock. */
export async function advanceReview(input, { origin, token, timeoutMs = 30_000, allowLoopbackFixture = false,
  persist, authorizeSubmission, signal } = {}) {
  validateReviewPolicy(input?.policy);
  origin = workerOrigin(origin, allowLoopbackFixture);
  if (typeof persist !== "function" || typeof authorizeSubmission !== "function" || typeof input.allowSubmission !== "boolean" ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new TypeError("Invalid broker configuration");
  const call = transport(origin, token, timeoutMs, signal);
  const broker = { call, persist, authorizeSubmission, signal };
  const { policy, previous } = input;
  let attempt = previous?.attempt;
  if (previous !== undefined && (!attempt || Object.keys(previous).length !== 1)) return escalate("journal_scope_mismatch");
  if (attempt && (attempt.origin !== origin || attempt.clientId !== policy.clientId || !attempt.journal?.operationId ||
      operationId(attempt.journal.operationId) !== attempt.journal.operationId ||
      !["uncertain", "admitted", "settled", "blocked"].includes(attempt.stage))) return escalate("journal_scope_mismatch");
  if (attempt?.stage === "blocked") return blockedDecision(attempt);

  const nextOperationId = randomUUID();
  if (attempt) {
    const id = attempt.journal.operationId;
    const expected = await expectedReceipt(attempt);
    if (attempt.body.includes(token) || (attempt.stage === "settled" &&
        (!validReceipt(attempt.receipt, attempt, expected) || !terminal.has(attempt.receipt.status) || attempt.receipt.cleanup === "pending"))) {
      return escalate("journal_scope_mismatch");
    }
    if (attempt.stage !== "settled") {
      const read = await readAttempt(attempt, expected, broker);
      if (read.decision) return read.decision;
      if (read.missing) {
        if (attempt.stage !== "uncertain" || !input.allowSubmission) return reconcile(id, "submission_unconfirmed");
        const { catalog, issue } = await catalogFor(call, policy.clientId);
        if (!catalog) return reconcile(id, issue);
        const prior = await routeReview({ ...routeInput(input, attempt, catalog, nextOperationId), replay: true });
        if (prior.status !== "reconcile" || prior.operationId !== id) return prior;
        if (!catalog.profiles.some(entry => isDeepStrictEqual(entry, attempt.profile))) {
          return reconcile(id, "replay_scope_unverified");
        }
        return sendAttempt(attempt, expected, broker);
      }
      attempt = read.settled;
    }
    const settledDecision = await routeReview(routeInput(input, attempt, undefined, nextOperationId));
    if (settledDecision.reason !== "current_catalog_required_for_fallback") return settledDecision;
  }

  if (!input.allowSubmission) return escalate("admission_not_current");
  const { catalog, issue } = await catalogFor(call, policy.clientId);
  if (!catalog) return escalate(issue);
  const decision = await routeReview(routeInput(input, attempt, catalog, nextOperationId));
  if (decision.status !== "submit") return decision;
  const { journal, request } = decision;
  const submission = { origin, clientId: policy.clientId, journal, body: JSON.stringify(request), stage: "uncertain",
    profile: catalog.profiles.find(entry => entry.slug === journal.slug) };
  if (submission.body.includes(token)) return escalate("credential_in_packet");
  const expected = await expectedReceipt(submission);
  await persist(structuredClone(submission));
  return sendAttempt(submission, expected, broker);
}
