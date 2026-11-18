import assert from "node:assert/strict";
import test from "node:test";
import { routeReview, submitReview, validateReviewPolicy } from "../bin/review-routing.mjs";
import { profileReceipt, profileRevision } from "../worker/run-profiles.mjs";

const id = number => "00000000-0000-4000-8000-" + String(number).padStart(12, "0");
const target = { slug: "example/repo", sha: "a".repeat(40) };
const reference = name => ({ id: name, reference: name + ".json", digest: "d".repeat(64), summary: "sealed evidence for " + name });

async function scenario(installation = "staging-one") {
  const routes = [
    ["review-api", "opencode", "api-key", "gpt-6.1-sol"],
    ["review-sub", "codex", "subscription", "gpt-6.1-sol"],
    ["lead-astra", "codex", "subscription", "gpt-6-astra"],
    ["ceo-fable", "claude", "subscription", "claude-fable-5-2"],
    ["ceo-opus", "claude", "subscription", "claude-opus-5-5"],
  ];
  const profiles = await Promise.all(routes.map(async ([name, harness, authMode, model]) => {
    const profile = { kind: "agent", operation: "review", harness, authMode,
      ...(harness === "opencode" ? { modelProvider: "openai" } : {}),
      defaults: { repo: target.slug, model, effort: "xhigh" } };
    return { slug: installation + "-" + name, profile, revision: await profileRevision(profile) };
  }));
  const [api, sub, astra, fable, opus] = profiles.map(({ slug, revision, profile }, index) => ({
    slug, revision, reviewerSubject: installation + "-reviewer-" + index, model: profile.defaults.model, effort: "xhigh",
  }));
  return {
    policy: { schemaVersion: 1, installation, clientId: installation + "-broker", repository: target.slug,
      routes: { delivery: [api, sub], tier2Lead: [astra], tier2Ceo: [fable, opus] } },
    admission: {
      installation,
      risk: { stage: "candidate", requiresTier2: false },
      packet: {
        contractId: "story", contractRevision: "3", planRevision: "2", contract: "Verify checkout admission.", plan: "Check scope at admission.",
        sealedDiff: "sealed diff", acceptance: [reference("AC1")],
        tests: [{ ...reference("Q0"), sha: target.sha, outcome: "PASS" }], target,
        producer: { subject: "producer", model: "claude-sonnet-5-5", harness: "claude", evidenceDigest: "b".repeat(64) },
        producerReasoning: "secret trace",
      },
    },
    catalog: { clientId: installation + "-broker", profiles },
    qualifications: profiles.map(({ slug, revision }) => ({ installation, slug, revision, status: "qualified", evidence: "staging receipt" })),
    nextOperationId: id(1),
    source: { ...target },
  };
}

function tier2(input, authority, includeDelivery = true) {
  input.admission.risk = { stage: "candidate", requiresTier2: true, authority, includeDelivery,
    trigger: "authorization", surfaces: [reference("AUTHZ")] };
}

async function withReceipt(input, decision, changes = {}) {
  const request = decision.request;
  const { profile } = input.catalog.profiles.find(entry => entry.slug === request.profile);
  const expected = await profileReceipt({ kind: "profile", operationId: request.operationId,
    profile: { slug: request.profile, body: profile }, source: request.source, prompt: request.prompt,
    producerAgent: request.producerAgent });
  return { ...input, nextOperationId: id(2), previous: { ...decision.journal, receipt: {
    id: request.operationId, kind: "agent", sandboxProvider: "cloudflare", status: "succeeded", cleanup: "destroyed", repository: target, agent: profile.harness,
    model: profile.defaults.model, effort: profile.defaults.effort, modelProvider: profile.modelProvider, authMode: profile.authMode,
    profile: { ...expected, source: "worker-catalog", clientId: input.catalog.clientId },
    review: { producerAgent: request.producerAgent, verdict: "PASS", findings: [] },
    ...changes,
  } } };
}

const checked = (axis, evidence) => JSON.stringify({ axis, evidence, verdict: "PASS", assessment: "Verified evidence." });

test("ordinary reviews share one resolver across installations and persist a frozen request first", async () => {
  for (const installation of ["staging-one", "staging-two"]) {
    const input = await scenario(installation);
    const trace = [];
    const decision = await submitReview(input, {
      persist: async (journal, request) => { trace.push("persist"); assert.equal(journal.slug, request.profile); },
      submit: async request => { trace.push("submit"); return request.source.sha; },
    });
    assert.deepEqual(trace, ["persist", "submit"]);
    assert.equal(decision.request.profile, installation + "-review-api");
    assert.deepEqual(decision.axes, ["delivery"]);
    assert.equal(decision.response, target.sha);
    assert(!decision.request.prompt.includes("secret trace"));
    assert(decision.request.prompt.includes("sealed evidence for Q0"));
    assert.match(decision.request.prompt, /bare strings copied verbatim from the packet's id fields/);
    assert.match(decision.request.prompt, /Put comments, paths, observations and what you could or could not verify in assessment/);
    assert.match(decision.request.prompt, /R7 is illustrative and may only be used if it is present in the packet/);
    assert(!decision.request.prompt.includes(input.admission.packet.producer.model));
  }
});

test("quota fallback preserves exact scope, rejects ambiguity, and uses a fresh operation", async () => {
  const input = await scenario();
  const first = await routeReview(input);
  const quota = { status: "capacity", reason: "provider_quota_exhausted", review: { producerAgent: "claude" } };
  const settled = await withReceipt(input, first, quota);
  const next = await routeReview(settled);
  assert.equal(next.request.profile, input.policy.routes.delivery[1].slug);
  assert.equal(next.request.operationId, id(2));
  assert.equal(next.request.prompt, first.request.prompt);
  assert.deepEqual(next.request.source, first.request.source);
  assert.equal((await routeReview({ ...settled, nextOperationId: id(1) })).reason, "operation_id_unverified");
  assert.equal((await routeReview(await withReceipt(input, first, { ...quota, reason: "provider_overloaded" }))).status, "ESCALATE");
  assert.equal((await routeReview(await withReceipt(input, first, { ...quota, cleanup: "pending" }))).status, "reconcile");
  assert.deepEqual(await routeReview({ ...input, previous: first.journal }), { status: "reconcile", operationId: id(1) });
});

test("Tier-2 uses ratified routes and requires evidence for both axes to close a combined review", async () => {
  const input = await scenario();
  tier2(input, "lead");
  const decision = await routeReview(input);
  assert.equal(decision.request.profile, input.policy.routes.tier2Lead[0].slug);
  assert.deepEqual(decision.axes, ["delivery", "tier2"]);
  const review = { producerAgent: "claude", verdict: "PASS", findings: [checked("delivery", ["AC1", "Q0"]), checked("tier2", ["AUTHZ"])] };
  assert.equal((await routeReview(await withReceipt(input, decision, { review }))).status, "PASS");
  const annotated = { ...review, findings: [checked("delivery", ["AC1: checked the diff", "Q0"]), checked("tier2", ["AUTHZ"])] };
  assert.equal((await routeReview(await withReceipt(input, decision, { review: annotated }))).reason, "review_coverage_unverified");
  assert.equal((await routeReview(await withReceipt(input, decision))).reason, "review_coverage_unverified");
  assert.equal((await routeReview(await withReceipt(input, decision, {
    status: "capacity", reason: "provider_quota_exhausted", review: { producerAgent: "claude" },
  }))).reason, "required_route_failed");
});

test("a previously journaled prompt is still verifiable and stays exact on quota fallback", async () => {
  const input = await scenario();
  const current = await routeReview(input);
  const lines = current.request.prompt.split("\n");
  const evidence = lines.findIndex(line => line.startsWith("In evidence, "));
  assert.notEqual(evidence, -1);
  lines.splice(evidence, 3,
    "For PASS, evidence must cite every packet reference ID for that axis. State what you verified or could not verify in assessment.");
  const legacy = { ...current, request: { ...current.request, prompt: lines.join("\n") } };
  const review = { producerAgent: "claude", verdict: "PASS", findings: [checked("delivery", ["AC1", "Q0"])] };
  const settled = await withReceipt(input, legacy, { review });
  const quota = await withReceipt(input, legacy, {
    status: "capacity", reason: "provider_quota_exhausted", review: { producerAgent: "claude" },
  });
  for (const requestBody of [undefined, JSON.stringify(legacy.request)]) {
    settled.previous.requestBody = quota.previous.requestBody = requestBody;
    assert.equal((await routeReview(settled)).status, "PASS");
    const fallback = await routeReview(quota);
    assert.equal(fallback.status, "submit");
    assert.equal(fallback.request.prompt, legacy.request.prompt);
  }
  assert.deepEqual(await routeReview({ ...input, replay: true,
    previous: { ...legacy.journal, requestBody: JSON.stringify(legacy.request) } }),
  { status: "reconcile", operationId: legacy.request.operationId });
  settled.previous.requestBody = JSON.stringify({ ...legacy.request, prompt: legacy.request.prompt + "\nextra" });
  assert.equal((await routeReview(settled)).reason, "journal_request_mismatch");
  delete settled.previous.requestBody;
  settled.previous.receipt.profile.requestDigest = "e".repeat(64);
  assert.equal((await routeReview(settled)).reason, "review_receipt_unverified");
});

test("the ceo authority may use its fallback after confirmed primary unavailability; Discovery is separate", async () => {
  const input = await scenario();
  tier2(input, "ceo", false);
  Object.assign(input.admission.packet.producer, { harness: "codex", model: "gpt-6.1-sol" });
  assert.equal((await routeReview(input)).request.profile, input.policy.routes.tier2Ceo[0].slug);
  input.qualifications.find(item => item.slug.endsWith("ceo-fable")).status = "unavailable";
  const decision = await routeReview(input);
  assert.equal(decision.request.profile, input.policy.routes.tier2Ceo[1].slug);
  assert.deepEqual(decision.axes, ["tier2"]);
  input.admission.risk.stage = "discovery";
  assert.equal((await routeReview(input)).reason, "discovery_without_sha_unsupported");
});

test("denies mismatched repository and exact SHA, missing or shared provenance, and wrong client", async () => {
  const input = await scenario();
  for (const source of [{ ...target, sha: "b".repeat(40) }, { ...target, slug: "other/repo" }]) {
    assert.equal((await routeReview({ ...input, source })).reason, "sealed_scope_mismatch");
  }
  assert.equal((await routeReview({ ...input, catalog: { ...input.catalog, clientId: "unrelated" } })).reason, "catalog_authority_unverified");
  input.admission.packet.tests[0].sha = "c".repeat(40);
  assert.equal((await routeReview(input)).reason, "sealed_scope_mismatch");
  input.admission.packet.tests[0].sha = target.sha;
  tier2(input, "ceo");
  assert.equal((await routeReview(input)).reason, "independence_unverified");
  input.admission.packet.producer.model = undefined;
  assert.equal((await routeReview(input)).reason, "producer_provenance_unverified");
});

test("unqualified, out-of-catalog, and write-capable routes do not submit", async () => {
  const input = await scenario();
  tier2(input, "lead");
  assert.equal((await routeReview({ ...input, qualifications: [] })).reason, "required_route_unqualified");
  const pin = input.policy.routes.tier2Lead[0];
  const entry = input.catalog.profiles.find(item => item.slug === pin.slug);
  entry.profile.mcp = { connectors: ["github-ci"] };
  entry.revision = pin.revision = await profileRevision(entry.profile);
  input.qualifications.find(item => item.slug === pin.slug).revision = pin.revision;
  assert.equal((await routeReview(input)).reason, "route_scope_unverified");
  assert.throws(() => validateReviewPolicy({ ...input.policy, routes: { ...input.policy.routes, tier2Lead: input.policy.routes.delivery } }));
});

test("managed connector issues or write authority never certify a verdict or quota fallback", async () => {
  const input = await scenario();
  for (const entry of input.catalog.profiles.slice(0, 2)) {
    entry.profile.mcp = { connectors: ["github-ci"] };
    entry.revision = await profileRevision(entry.profile);
    input.policy.routes.delivery.find(item => item.slug === entry.slug).revision = entry.revision;
    input.qualifications.find(item => item.slug === entry.slug).revision = entry.revision;
  }
  const first = await routeReview(input);
  const quota = { status: "capacity", reason: "provider_quota_exhausted", review: { producerAgent: "claude" } };
  assert.equal((await routeReview(await withReceipt(input, first, {
    ...quota, connectorAccess: { mode: "read-only", connectors: ["github-ci"] },
  }))).reason, "connector_fallback_unqualified");
  assert.equal((await routeReview(await withReceipt(input, first, {
    connectorAccess: { mode: "read-write", connectors: ["github-ci"] },
  }))).reason, "review_receipt_unverified");
  assert.equal((await routeReview(await withReceipt(input, first, {
    connectorAccess: { mode: "read-only", connectors: ["github-ci"] }, connectorIssues: [{ code: "unavailable" }],
  }))).reason, "review_receipt_unverified");
});
