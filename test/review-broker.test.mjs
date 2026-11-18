import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import test from "node:test";
import { advanceReview } from "../bin/review-broker.mjs";
import { profileReceipt, profileRevision } from "../worker/run-profiles.mjs";

const token = "f".repeat(64);
const installation = "staging-review";
const clientId = "staging-broker";
const source = { slug: "example/repo", sha: "a".repeat(40) };
const reference = id => ({ id, reference: `${id}.json`, digest: "d".repeat(64), summary: `sealed ${id}` });
const review = { producerAgent: "claude", verdict: "PASS", findings: [JSON.stringify({
  axis: "delivery", verdict: "PASS", evidence: ["AC1", "Q0"], assessment: "Verified evidence.",
})] };

async function fixture(t) {
  const settings = [
    ["open-code", "opencode", "api-key", "gpt-6.1-sol"], ["codex-sol", "codex", "subscription", "gpt-6.1-sol"],
    ["codex-astra", "codex", "subscription", "gpt-6-astra"], ["claude-fable", "claude", "subscription", "claude-fable-5-2"],
    ["claude-opus", "claude", "subscription", "claude-opus-5-5"],
  ];
  const profiles = await Promise.all(settings.map(async ([slug, harness, authMode, model]) => {
    const profile = { kind: "agent", operation: "review", harness, authMode,
      ...(harness === "opencode" ? { modelProvider: "openai" } : {}),
      defaults: { repo: source.slug, model, effort: "xhigh" } };
    return { slug, profile, revision: await profileRevision(profile) };
  }));
  const [api, subscription, astra, fable, opus] = profiles.map(({ slug, revision, profile }) => ({ slug, revision,
    reviewerSubject: `${installation}-${slug}`, model: profile.defaults.model, effort: "xhigh" }));
  const input = {
    policy: { schemaVersion: 1, installation, clientId, repository: source.slug,
      routes: { delivery: [api, subscription], tier2Lead: [astra], tier2Ceo: [fable, opus] } },
    admission: { installation, risk: { stage: "candidate", requiresTier2: false }, packet: {
      contractId: "story", contractRevision: "3", planRevision: "2", contract: "Verify checkout.", plan: "Check admission scope.",
      sealedDiff: "sealed diff", acceptance: [reference("AC1")], tests: [{ ...reference("Q0"), sha: source.sha, outcome: "PASS" }],
      target: source, producer: { subject: "producer", model: "claude-sonnet-5-5", harness: "claude", evidenceDigest: "b".repeat(64) },
    } }, source, allowSubmission: true,
    qualifications: profiles.map(({ slug, revision }) => ({ installation, slug, revision, status: "qualified", evidence: "receipt" })),
  };
  const events = [];
  const runs = new Map();
  const posts = [];
  const respond = (res, status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  const state = { input, events, runs, posts, catalog: { clientId, profiles }, respond };
  const server = createServer(async (req, res) => {
    try {
      const { url, method } = req;
      events.push(`${method} ${url}`);
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      if (url === "/v4/profiles") {
        if (state.onCatalog) return state.onCatalog(res);
        return respond(res, 200, state.catalog);
      }
      if (method === "POST" && url === "/v4/runs") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8");
        posts.push(body);
        const request = JSON.parse(body);
        const entry = profiles.find(entry => entry.slug === request.profile);
        const expected = await profileReceipt({ kind: "profile", operationId: request.operationId, profile: { slug: entry.slug, body: entry.profile },
          source: request.source, producerAgent: request.producerAgent, prompt: request.prompt });
        const run = { id: request.operationId, kind: "agent", sandboxProvider: "cloudflare", status: "running", cleanup: "pending",
          repository: source, agent: entry.profile.harness, model: entry.profile.defaults.model, effort: entry.profile.defaults.effort,
          authMode: entry.profile.authMode, modelProvider: entry.profile.modelProvider,
          profile: { ...expected, clientId, source: "worker-catalog" }, review: { producerAgent: request.producerAgent } };
        if (state.onPost) return state.onPost(res, run);
        runs.set(run.id, run);
        return respond(res, 202, run);
      }
      const [, id, result] = /^\/v1\/runs\/([a-f0-9-]+)(\/result)?$/.exec(url) ?? [];
      if (method === "GET" && id) {
        if (state.onRead) return state.onRead(res, id, result);
        const run = runs.get(id);
        return run ? respond(res, 200, run) : respond(res, 404, { error: "run_not_found" });
      }
      assert.fail(`Unexpected ${method} ${url}`);
    } catch (error) {
      state.failure = error;
      res.destroy();
    }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); assert.ifError(state.failure); });
  state.origin = `http://127.0.0.1:${server.address().port}`;
  state.advance = (changes = {}, options = {}) => advanceReview({ ...input,
    ...(state.attempt ? { previous: { attempt: state.attempt } } : {}), ...changes }, {
    origin: state.origin, token, allowLoopbackFixture: true,
    async persist(attempt) { events.push(`persist ${attempt.stage}`); state.attempt = structuredClone(attempt); },
    async authorizeSubmission(id) { events.push(`authorize ${id}`); return { allowed: true }; }, ...options,
  });
  state.finish = (changes = {}) => {
    const run = runs.get(state.attempt.journal.operationId);
    Object.assign(run, { status: "succeeded", cleanup: "destroyed", review }, changes);
  };
  return state;
}

test("authenticate, commit exact bytes, and reconcile a finished run without a catalog", async t => {
  const f = await fixture(t);
  const submitted = await f.advance();
  const { operationId } = submitted;
  assert.equal(submitted.reason, "run_admitted");
  assert.deepEqual(f.events, ["GET /v4/profiles", "persist uncertain", `authorize ${operationId}`, "POST /v4/runs", "persist admitted"]);
  assert.equal(f.posts[0], f.attempt.body);
  assert(!f.attempt.body.includes(token));
  f.finish();
  f.onCatalog = res => f.respond(res, 503, { error: "team_configuration_invalid" });
  f.events.length = 0;
  const decision = await f.advance({ allowSubmission: false });
  assert.equal(decision.status, "PASS");
  assert.deepEqual(f.events, [`GET /v1/runs/${operationId}`, `GET /v1/runs/${operationId}/result`, "persist settled"]);
  f.events.length = 0;
  assert.deepEqual(await f.advance({ previous: { attempt: f.attempt } }), decision);
  assert.deepEqual(f.events, []);
  const differentAdmission = structuredClone(f.input.admission);
  differentAdmission.packet.contractRevision = "4";
  assert.equal((await f.advance({ admission: differentAdmission, previous: { attempt: f.attempt, decision } })).reason,
    "journal_scope_mismatch");
  assert.equal((await f.advance({ admission: differentAdmission })).reason, "journal_scope_mismatch");
  assert.equal((await f.advance({ previous: { decision } })).reason, "journal_scope_mismatch");
  assert.equal(f.posts.length, 1);
});

test("a missing acknowledgement never admits a second run when the original exists", async t => {
  const f = await fixture(t);
  f.onPost = (res, run) => { f.runs.set(run.id, run); res.destroy(); };
  assert.equal((await f.advance()).reason, "worker_request_unconfirmed");
  const { operationId } = f.attempt.journal;
  assert.equal(f.attempt.stage, "uncertain");
  f.finish();
  f.events.length = 0;
  const decision = await f.advance({ admission: undefined, allowSubmission: false });
  assert.equal(decision.reason, "installation_mismatch");
  assert.equal(f.attempt.receipt.id, operationId);
  assert.deepEqual(f.events, [`GET /v1/runs/${operationId}`, "persist admitted", `GET /v1/runs/${operationId}/result`, "persist settled"]);
  assert.equal(f.posts.length, 1);
});

test("only an authenticated missing uncertain attempt can replay the same bytes and UUID", async t => {
  const f = await fixture(t);
  f.onPost = res => res.destroy();
  await f.advance();
  const { operationId } = f.attempt.journal;
  f.onPost = undefined;
  f.events.length = 0;
  const qualifications = [...f.input.qualifications, f.input.qualifications[0]];
  assert.equal((await f.advance({ qualifications })).reason, "required_route_unqualified");
  assert.equal(f.posts.length, 1);
  f.events.length = 0;
  assert.equal((await f.advance()).operationId, operationId);
  assert.deepEqual(f.events, [`GET /v1/runs/${operationId}`, "GET /v4/profiles", `authorize ${operationId}`, "POST /v4/runs", "persist admitted"]);
  assert.deepEqual(f.posts, [f.attempt.body, f.attempt.body]);
  f.runs.delete(operationId);
  assert.equal((await f.advance()).reason, "submission_unconfirmed");
  assert.equal(f.posts.length, 2);
});

test("check current catalog and fresh admission before a quota fallback", async t => {
  const f = await fixture(t);
  const first = await f.advance();
  f.finish({ status: "capacity", reason: "provider_quota_exhausted", review: { producerAgent: "claude" } });
  assert.equal((await f.advance({ allowSubmission: false })).reason, "admission_not_current");
  assert.equal(f.attempt.stage, "settled");
  const primary = f.attempt;
  assert.equal(f.posts.length, 1);
  const second = await f.advance();
  assert.notEqual(second.operationId, first.operationId);
  assert.equal(f.attempt.journal.slug, "codex-sol");
  assert.equal(f.attempt.journal.packetDigest, primary.journal.packetDigest);
  assert.equal(JSON.parse(f.attempt.body).prompt, JSON.parse(primary.body).prompt);
  assert.equal(f.posts.length, 2);
});

test("redirects, another client, and a mismatched origin fail closed", async t => {
  const f = await fixture(t);
  await assert.rejects(f.advance({}, { origin: `${f.origin}/callback` }), /trusted HTTPS Worker origin/);
  f.onCatalog = res => res.writeHead(307, { location: "/unexpected" }).end();
  assert.equal((await f.advance()).reason, "worker_redirect_refused");
  assert.deepEqual(f.events, ["GET /v4/profiles"]);
  f.onCatalog = res => f.respond(res, 200, { ...f.catalog, unused: "a".repeat(2 * 1024 * 1024) });
  assert.equal((await f.advance()).reason, "worker_response_unverified");
  f.onCatalog = undefined;
  f.catalog.clientId = "other-team";
  assert.equal((await f.advance()).reason, "catalog_authority_unverified");
  f.catalog.clientId = clientId;
  await f.advance();
  f.events.length = 0;
  assert.equal((await f.advance({ previous: { attempt: { ...f.attempt, origin: "https://elsewhere.example" } } })).reason,
    "journal_scope_mismatch");
  assert.deepEqual(f.events, []);
});

test("result conflicts never certify a verdict or authorize another POST", async t => {
  const f = await fixture(t);
  await f.advance();
  f.finish();
  f.onRead = (res, id, result) => f.respond(res, 200, { ...f.runs.get(id),
    ...(result ? { review: { ...review, findings: ["different result"] } } : {}) });
  assert.equal((await f.advance()).reason, "run_result_unverified");
  assert.equal(f.attempt.stage, "admitted");
  assert.equal(f.posts.length, 1);
});

test("a confirmed read-only connector rejection exposes a safe recovery action and blocks replay", async t => {
  const f = await fixture(t);
  const entry = f.catalog.profiles[0];
  entry.profile.mcp = { connectors: ["acme-staging"] };
  entry.revision = await profileRevision(entry.profile);
  f.input.policy.routes.delivery[0].revision = entry.revision;
  f.input.qualifications[0].revision = entry.revision;
  const reason = "mcp_connector_reauth_required";
  const connectorIssue = { code: reason, mode: "read-only", connector: "acme-staging" };
  const rejected = operationId => ({ error: reason, operationId, admission: "rejected",
    connectorIssue,
    reconnectScope: "acme.read", providerDetail: "Untrusted provider diagnostic." });
  f.onPost = res => f.respond(res, 503, rejected("00000000-0000-4000-8000-000000000000"));
  assert.equal((await f.advance()).reason, "submission_unconfirmed");
  f.onPost = (res, run) => f.respond(res, 503, rejected(run.id));
  const expected = { status: "ESCALATE", operationId: f.attempt.journal.operationId, reason, connectorIssue,
    recovery: { action: "connector_login" } };
  assert.deepEqual(await f.advance(), expected);
  assert.deepEqual(f.attempt.rejection, connectorIssue);
  f.events.length = 0;
  assert.deepEqual(await f.advance(), expected);
  assert.deepEqual(f.events, []);
  assert.equal(f.posts.length, 2);
});

test("a nested Worker auth strategy cannot attest a review or trigger broker fallback", async t => {
  const f = await fixture(t);
  await f.advance();
  f.finish({ status: "capacity", reason: "provider_quota_exhausted", review: { producerAgent: "claude" },
    strategy: "api-key-first-then-subscription", attempts: [], fallbackReason: "provider_quota_exhausted" });
  assert.equal((await f.advance()).reason, "run_status_unverified");
  assert.equal(f.attempt.stage, "admitted");
  assert.equal(f.posts.length, 1);
});

function bridge(f) {
  const child = spawn(process.execPath, [new URL("../bin/review-broker-stdio.mjs", import.meta.url).pathname], {
    env: { SANDBOX_RUNNER_URL: f.origin, SANDBOX_RUNNER_TOKEN: token, SANDBOX_RUNNER_BROKER_LOOPBACK_FIXTURE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exit = once(child, "exit");
  const write = value => child.stdin.write(JSON.stringify(value) + "\n");
  const read = async () => JSON.parse((await lines.next()).value);
  write({ type: "advance", input: f.input });
  return { child, exit, write, read };
}

test("private stdio waits for journal commit and fresh authorization before POST", async t => {
  const f = await fixture(t);
  const b = bridge(f);
  t.after(() => b.child.kill());
  const prepared = await b.read();
  const { operationId } = prepared.attempt.journal;
  assert.equal(prepared.type, "persist");
  assert.equal(prepared.attempt.stage, "uncertain");
  assert.deepEqual(f.events, ["GET /v4/profiles"]);
  b.write({ type: "persisted", operationId, stage: "uncertain" });
  assert.deepEqual(await b.read(), { type: "authorize", operationId });
  assert.deepEqual(f.events, ["GET /v4/profiles"]);
  b.write({ type: "authorization", operationId, allowed: true });
  assert.equal((await b.read()).attempt.stage, "admitted");
  assert.deepEqual(f.posts, [prepared.attempt.body]);
  b.write({ type: "persisted", operationId, stage: "admitted" });
  assert.deepEqual(await b.read(), { type: "result", decision: { status: "reconcile", operationId, reason: "run_admitted" } });
  b.child.stdin.end();
  assert.deepEqual(await b.exit, [0, null]);
});

test("private stdio refuses EOF before journal commit and denied or expired admission", async t => {
  for (const revoked of [undefined, { allowed: false }, { allowed: true, expiresAt: 1 }]) {
    const f = await fixture(t);
    const b = bridge(f);
    t.after(() => b.child.kill());
    const prepared = await b.read();
    const { operationId } = prepared.attempt.journal;
    if (revoked === undefined) {
      b.child.stdin.end();
      assert.deepEqual(await b.read(), { type: "error", code: "review_broker_step_unconfirmed" });
      assert.deepEqual(await b.exit, [1, null]);
    } else {
      b.write({ type: "persisted", operationId, stage: "uncertain" });
      assert.equal((await b.read()).type, "authorize");
      b.write({ type: "authorization", operationId, ...revoked });
      assert.deepEqual(await b.read(), { type: "result", decision: { status: "ESCALATE", reason: "admission_not_current" } });
      b.child.stdin.end();
      assert.deepEqual(await b.exit, [0, null]);
    }
    assert.equal(f.posts.length, 0);
  }
});
