import assert from "node:assert/strict";
import test from "node:test";
import { claudeSpendLimitReason } from "../claude-terminal-diagnostics.ts";
import { codexApiCreditPromoRestriction } from "../codex-api-diagnostics.ts";
import { nextInference, outcome as projectOutcome } from "../diagnostics.ts";

const unanswered = { status: "unanswered", reason: "raw message containing insufficient_quota" };
const generic = { status: "failed", reason: "run_failed" };
const codexApi = { agent: "codex", authMode: "api-key" };

function outcome(result, observed, context = codexApi) {
  return projectOutcome(result, observed, context);
}

function attempt(signal) {
  return { id: "request", ambiguous: false, signal };
}

test("projects provider responses to fixed reasons without copying raw agent details", () => {
  for (const [httpStatus, status, reason] of [
    [400, "failed", "provider_request_rejected"],
    [401, "auth_required", "provider_auth_required"],
    [402, "failed", "provider_billing_required"],
    [403, "failed", "provider_permission_denied"],
    [404, "failed", "provider_resource_unavailable"],
    [408, "failed", "provider_timeout"],
    [413, "failed", "provider_request_too_large"],
    [429, "capacity", "provider_capacity"],
    [500, "failed", "provider_unavailable"],
    [503, "failed", "provider_unavailable"],
    [504, "failed", "provider_timeout"],
    [529, "capacity", "provider_overloaded"],
  ]) {
    assert.deepEqual(outcome(unanswered, attempt({ kind: "http", status: httpStatus })), { status, reason });
  }
  assert.deepEqual(outcome(unanswered, attempt({ kind: "redirect" })), { status: "failed", reason: "provider_redirect_denied" });
  assert.deepEqual(outcome(unanswered, attempt({ kind: "transport_failed" })), { status: "failed", reason: "provider_transport_failed" });
  assert.deepEqual(outcome(unanswered, attempt({ kind: "transport_timeout" })), { status: "failed", reason: "provider_timeout" });
  assert.deepEqual(outcome(unanswered, attempt({ kind: "http", status: 200 })), generic);
  assert.deepEqual(outcome(unanswered, undefined), generic);
});

test("preserves the pinned Codex API-key quota result for a corroborating HTTP 200", () => {
  const codexQuota = { status: "unanswered", reason: "Quota exceeded. Check your plan and billing details." };
  const successHeaders = attempt({ kind: "http", status: 200 });
  assert.deepEqual(outcome(codexQuota, successHeaders), { status: "capacity", reason: "provider_quota_exhausted" });
  assert.deepEqual(outcome(codexQuota, successHeaders, { agent: "codex", authMode: "subscription" }), generic);
  assert.deepEqual(outcome(codexQuota, successHeaders, { agent: "claude", authMode: "api-key" }), generic);
  assert.deepEqual(outcome(codexQuota, { ...successHeaders, ambiguous: true }), generic);
  assert.deepEqual(outcome(codexQuota, attempt({ kind: "http", status: 201 })), generic);
  assert.deepEqual(outcome({ ...codexQuota, reason: codexQuota.reason + " extra" }, successHeaders), generic);
});

test("projects a confirmed Codex API-credit restriction only for the attributed API-key request", () => {
  const id = "request";
  const started = nextInference(undefined, { id });
  const http = { kind: "http", status: 400 };
  const rejected = nextInference(started, { id, signal: http });
  const restriction = { id, signal: { ...http, restriction: codexApiCreditPromoRestriction } };
  const confirmed = nextInference(rejected, restriction);
  const genericRejection = { status: "failed", reason: "provider_request_rejected" };
  assert.deepEqual(outcome(unanswered, rejected), genericRejection);
  assert.deepEqual(outcome(unanswered, confirmed), { status: "failed", reason: codexApiCreditPromoRestriction });
  assert.deepEqual(outcome(unanswered, confirmed, { agent: "codex", authMode: "subscription" }), genericRejection);
  assert.deepEqual(outcome(unanswered, confirmed, { agent: "claude", authMode: "api-key" }), genericRejection);
  assert.deepEqual(outcome(unanswered, { ...confirmed, ambiguous: true }), generic);
  assert.equal(nextInference(confirmed, restriction), undefined);
  assert.equal(nextInference(nextInference(rejected, { id: "later" }), restriction), undefined);
  assert.equal(nextInference(nextInference(started, { id, signal: { kind: "http", status: 429 } }), restriction), undefined);
  assert.deepEqual(outcome({ status: "done", text: "OK" }, confirmed), { status: "succeeded", output: "OK" });
});

test("accepts typed Claude 429 and 529 only for a corroborating HTTP 200", () => {
  const context = { agent: "claude", authMode: "subscription" };
  const response = attempt({ kind: "http", status: 200 });
  const limited = { status: "unanswered", reason: "claude_provider_http_429" };
  const overloaded = { status: "unanswered", reason: "claude_provider_http_529" };
  assert.deepEqual(outcome(limited, response, context), { status: "capacity", reason: "provider_capacity" });
  assert.deepEqual(outcome(overloaded, response, context), { status: "capacity", reason: "provider_overloaded" });
  assert.deepEqual(outcome(limited, response), generic);
  assert.deepEqual(outcome(limited, { ...response, ambiguous: true }, context), generic);
  assert.deepEqual(outcome(limited, undefined, context), generic);
  assert.deepEqual(outcome(limited, attempt({ kind: "http", status: 201 }), context), generic);
  assert.deepEqual(outcome(limited, attempt({ kind: "http", status: 403 }), context), {
    status: "failed", reason: "provider_permission_denied",
  });
  for (const reason of ["claude_provider_http_401", "claude_provider_http_502", "claude_provider_http_429 detail"]) {
    assert.deepEqual(outcome({ status: "unanswered", reason }, response, context), generic);
  }
});

test("requires a matching Claude API-key HTTP 429 to confirm the documented spend cap", () => {
  const claudeApi = { agent: "claude", authMode: "api-key" };
  const limit = { status: "unanswered", reason: claudeSpendLimitReason };
  const rateLimit = attempt({ kind: "http", status: 429 });
  assert.deepEqual(outcome(limit, rateLimit, claudeApi), { status: "capacity", reason: "provider_quota_exhausted" });
  assert.deepEqual(outcome(limit, rateLimit, { ...claudeApi, authMode: "subscription" }), {
    status: "capacity", reason: "provider_capacity",
  });
  assert.deepEqual(outcome(limit, rateLimit, codexApi), { status: "capacity", reason: "provider_capacity" });
  assert.deepEqual(outcome(limit, { ...rateLimit, ambiguous: true }, claudeApi), generic);
  assert.deepEqual(outcome(limit, attempt({ kind: "http", status: 200 }), claudeApi), {
    status: "capacity", reason: "provider_capacity",
  });
  assert.deepEqual(outcome(limit, attempt({ kind: "http", status: 402 }), claudeApi), {
    status: "failed", reason: "provider_billing_required",
  });
  assert.deepEqual(outcome(unanswered, rateLimit, claudeApi), { status: "capacity", reason: "provider_capacity" });
});

test("keeps success and exact ContainerHarness reasons ahead of the last HTTP response", () => {
  const rateLimit = attempt({ kind: "http", status: 429 });
  assert.deepEqual(outcome({ status: "done", text: "OK" }, rateLimit), { status: "succeeded", output: "OK" });
  for (const [reason, status, projected] of [
    ["container_lost", "unanswered", "container_lost"],
    ["aborted", "unanswered", "aborted"],
    ["not_found", "unanswered", "harness_operation_not_found"],
    ["container_unavailable", "failed", "container_unavailable"],
  ]) {
    assert.deepEqual(outcome({ status: "unanswered", reason }, rateLimit), { status, reason: projected });
  }
  assert.deepEqual(outcome({ status: "unanswered", reason: "container_lost: raw detail" }, undefined), generic);
});

test("clears a previous result when the next request starts and ignores late completions", () => {
  const old = { id: "old" };
  const fresh = { id: "fresh" };
  const started = nextInference(undefined, old);
  assert.equal(nextInference(started, old), undefined);
  const limited = nextInference(started, { ...old, signal: { kind: "http", status: 429 } });
  const replacement = nextInference(limited, fresh);
  assert.deepEqual(outcome(unanswered, replacement), generic);
  assert.equal(nextInference(replacement, { ...old, signal: { kind: "http", status: 401 } }), undefined);
  const failure = nextInference(replacement, { ...fresh, signal: { kind: "transport_failed" } });
  assert.deepEqual(outcome(unanswered, failure), { status: "failed", reason: "provider_transport_failed" });
  assert.equal(nextInference(failure, { ...fresh, signal: { kind: "http", status: 429 } }), undefined);
});

test("leaves diagnostics generic if authorized requests overlap before their headers", () => {
  const first = nextInference(undefined, { id: "first" });
  const second = nextInference(first, { id: "second" });
  const finished = nextInference(second, { id: "second", signal: { kind: "http", status: 429 } });
  assert.deepEqual(outcome(unanswered, finished), generic);
  assert.equal(nextInference(finished, { id: "first", signal: { kind: "http", status: 401 } }), undefined);
  const later = nextInference(finished, { id: "later" });
  const laterFinished = nextInference(later, { id: "later", signal: { kind: "http", status: 403 } });
  assert.deepEqual(outcome(unanswered, laterFinished), generic);
});
