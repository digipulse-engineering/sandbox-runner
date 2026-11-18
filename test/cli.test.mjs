import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { profileInputContract, profileInputErrorMessage, profileReceipt, profileRevision, resolveProfileRequest,
  validateProfileInputs } from "../worker/run-profiles.mjs";

const bin = fileURLToPath(new URL("../bin/sandbox-runner.mjs", import.meta.url));
const token = "synthetic-test-control-token";
const explicitId = "48f9fa4c-cc36-46bd-8b7d-f86f09ec79db";
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

function invoke(url, args, overrides = {}, captureStderr = false) {
  const env = {
    PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ""),
    SANDBOX_RUNNER_URL: url,
    SANDBOX_RUNNER_TOKEN: token,
    ...overrides,
  };
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      try {
        if (!captureStderr) assert.equal(stderr, "");
        assert.ok(!stderr.includes(token));
        assert.equal(stdout.trim().split("\n").length, 1);
        assert.ok(!stdout.includes(token));
        resolve({ code: error?.code ?? 0, output: JSON.parse(stdout), ...(captureStderr ? { stderr } : {}) });
      } catch (assertion) {
        reject(assertion);
      }
    });
  });
}

async function worker(t, handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return "http://127.0.0.1:" + server.address().port;
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function requestBody(request) {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

function runRecord(id, agent, extra = {}) {
  return { id, agent, status: "queued", cleanup: "pending", ...extra };
}

test("team operator CLI creates and updates only with a matching revision and reports denials", async t => {
  const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-team-operator-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const file = join(scratch, "catalog.json");
  const catalog = { schemaVersion: 1, profiles: { tests: { kind: "test", runner: "vitest", defaults: { repo: "Owner/Repo" } } },
    clients: { "lead-engineering": { tokenSha256: "f".repeat(64), profiles: ["tests"] } } };
  const revision = "1".repeat(64);
  const nextRevision = "2".repeat(64);
  const denials = [{ clientId: "lead-engineering", reason: "profile_required", count: 2, lastAt: 1738923000000 }];
  const requests = [];
  let current = null;
  const url = await worker(t, async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer " + token);
    if (request.url === "/v4/team/denials" && request.method === "GET") return json(response, 200, { denials });
    assert.equal(request.url, "/v4/team/catalog");
    if (request.method === "GET") return json(response, 200, { revision: current, config: current === null ? null : catalog });
    assert.equal(request.method, "PUT");
    assert.equal(request.headers["content-type"], "application/json");
    assert.deepEqual(await requestBody(request), catalog);
    const match = request.headers["if-match"];
    const create = request.headers["if-none-match"];
    requests.push({ match, create });
    if (current === null && create === "*" && match === undefined) current = revision;
    else if (create === undefined && match === '"' + current + '"') current = nextRevision;
    else return json(response, 412, { error: "team_catalog_revision_changed" });
    return json(response, 200, { revision: current });
  });
  const get = ["team", "catalog", "get"];
  const publish = ["team", "catalog", "publish", file];
  assert.deepEqual(await invoke(url, get), { code: 0, output: { revision: null, config: null } });
  await writeFile(file, JSON.stringify({ ...catalog, unknown: "sensitive" }));
  assert.equal((await invoke(url, publish)).output.error, "invalid_team_catalog");
  assert.equal(requests.length, 0);
  await writeFile(file, JSON.stringify(catalog));
  assert.deepEqual(await invoke(url, publish), { code: 0, output: { revision } });
  assert.equal((await invoke(url, publish)).output.error, "team_catalog_revision_changed");
  assert.deepEqual(await invoke(url, get), { code: 0, output: { revision, config: catalog } });
  assert.deepEqual(await invoke(url, [...publish, "--revision", revision]), { code: 0, output: { revision: nextRevision } });
  assert.deepEqual(requests, [{ match: undefined, create: "*" }, { match: undefined, create: "*" }, { match: '"' + revision + '"', create: undefined }]);
  assert.deepEqual(await invoke(url, ["team", "denials"]), { code: 0, output: { denials } });
});

test("team CLI pins the catalog revision, retries as the same client and ignores local profiles", async t => {
  const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-team-cli-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const file = join(scratch, "local.json");
  const env = { SANDBOX_RUNNER_TEAM: "1", SANDBOX_RUNNER_PROFILES: file, XDG_STATE_HOME: scratch };
  const sha = "a".repeat(40);
  const slug = "unit-tests";
  const clientId = "lead-engineering";
  const deliveryId = "35f3fd11-4f5e-4835-a426-ecc4066196c4";
  const profile = { kind: "test", runner: "vitest", defaults: { repo: "Owner/Repo" } };
  const revision = await profileRevision(profile);
  const entry = { slug, profile, revision };
  const input = { operationId: explicitId, source: { sha } };
  const receipt = { ...await profileReceipt({ ...input, kind: "profile", profile: { slug, body: profile } }),
    source: "worker-catalog", clientId, deliveryId };
  const view = { id: explicitId, kind: "test", suite: "vitest", phase: "queued", status: "queued", cleanup: "pending",
    sandboxProvider: "cloudflare", repository: { slug: "Owner/Repo", sha }, profile: receipt };
  await writeFile(file, JSON.stringify({ schemaVersion: 1, profiles: { local: profile } }));
  const posts = [];
  let authenticatedClient = clientId;
  let stale = false;
  const url = await worker(t, async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer " + token);
    if (request.url === "/v4/profiles") return json(response, 200, { clientId: authenticatedClient, profiles: [entry] });
    if (request.url === "/v4/profiles/" + slug) return json(response, 200, { clientId: authenticatedClient, ...entry });
    if (request.url.startsWith("/v4/profiles/")) return json(response, 404, { error: "profile_not_found" });
    if (request.url === "/v1/runs/" + explicitId) return json(response, 200, view);
    assert.equal(request.url, "/v4/runs");
    posts.push(await requestBody(request));
    if (posts.length === 1) return response.destroy();
    if (stale) return json(response, 409, { error: "profile_revision_changed" });
    return json(response, 202, view);
  });
  const listed = await invoke(url, ["profile", "list", "--usage", "test", "--repo", "Owner/Repo"], env);
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.output, { slugs: [slug], clientId, profiles: [{
    slug, revision, usage: "test", qualification: "unverified", kind: "test", runner: "vitest",
    defaults: profile.defaults, repositories: ["Owner/Repo"], connectors: [], publish: false,
  }] });
  assert.deepEqual((await invoke(url, ["profile", "list", "--usage", "executor"], env)).output.slugs, []);
  assert.deepEqual(await invoke(url, ["profile", "get", slug], env), { code: 0, output: { ...entry, clientId,
    usage: "test", qualification: "unverified", inputContract: profileInputContract(profile) } });
  assert.equal((await invoke(url, ["profile", "check", slug], env)).output.error, "profile_not_found");
  assert.equal((await invoke(url, ["profile", "get", "local"], env)).output.error, "profile_not_found");
  assert.equal((await invoke(url, ["profile", "list", "--profiles", file], env)).output.error, "usage_error");
  const start = ["start", slug, "--sha", sha, "--operation-id", explicitId, "--delivery-id", deliveryId];
  assert.equal((await invoke(url, [...start, "--revision", "0".repeat(64)], env)).output.error, "profile_revision_changed");
  assert.equal(posts.length, 0);
  assert.equal((await invoke(url, start, env)).output.uncertain, true);
  assert.deepEqual(posts, [{ ...input, kind: "team-profile", profile: slug, revision, deliveryId }]);
  authenticatedClient = "lead-produit";
  assert.equal((await invoke(url, ["retry", explicitId], env)).output.error, "profile_request_mismatch");
  assert.equal((await invoke(url, ["retry", explicitId], { ...env, SANDBOX_RUNNER_TEAM: "0" })).output.error, "profile_request_mismatch");
  assert.equal(posts.length, 1);
  authenticatedClient = clientId;
  const retried = await invoke(url, ["retry", explicitId], env);
  assert.equal(retried.code, 0);
  assert.deepEqual(retried.output.profile, receipt);
  assert.deepEqual(posts[0], posts[1]);
  assert.deepEqual((await invoke(url, ["status", explicitId], env)).output.profile, receipt);
  stale = true;
  assert.equal((await invoke(url, ["retry", explicitId], env)).output.error, "profile_revision_changed");
  assert.deepEqual(posts[0], posts[2]);
});

test("a profile submission is traceable and recoverable after a lost response and config edit", async t => {
  const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-profiles-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const file = join(scratch, "profiles.json");
  const env = { SANDBOX_RUNNER_PROFILES: file, XDG_STATE_HOME: scratch };
  const journal = join(scratch, "sandbox-runner", "profile-requests", explicitId + ".json");
  const profile = { kind: "agent", harness: "claude", operation: "review", sandboxProvider: "cloudflare",
    defaults: { repo: "Owner/Repo", model: "claude-sonnet-5-5", effort: "medium" },
    allowedOverrides: { effort: ["medium", "high"] }, mcp: { connectors: ["github", "acme-staging"] } };
  const config = { schemaVersion: 1, profiles: { "review-claude": profile } };
  await writeFile(file, JSON.stringify(config));
  const requests = [];
  let view;
  const url = await worker(t, async (request, response) => {
    if (request.method === "GET") return json(response, 200, view);
    assert.equal(request.url, "/v4/runs");
    const body = await requestBody(request);
    requests.push(body);
    assert.deepEqual(JSON.parse(await readFile(journal, "utf8")).submission, body);
    const run = resolveProfileRequest(body);
    view = runRecord(explicitId, run.agent, { kind: "agent", sandboxProvider: "cloudflare", repository: run.repository,
      model: run.model, effort: run.effort, review: { producerAgent: run.reviewProducer },
      connectorAccess: { mode: "read-only", connectors: run.connectors }, profile: await profileReceipt(body) });
    if (requests.length === 1) return response.destroy();
    json(response, 202, view);
  });
  assert.deepEqual(await invoke("", ["profile", "get", "review-claude"], env),
    { code: 0, output: { slug: "review-claude", profile, revision: await profileRevision(profile),
      usage: "review", qualification: "unverified", inputContract: profileInputContract(profile) } });
  await writeFile(file, JSON.stringify(config).replace('"harness":"claude"', '"harness":"codex","h\\u0061rness":"claude"'));
  assert.equal((await invoke("", ["profile", "validate"], env)).output.error, "invalid_profile_config");
  await writeFile(file, JSON.stringify(config));
  const args = ["start", "review-claude", "--sha", "a".repeat(40), "--producer-agent", "codex", "--operation-id", explicitId];
  const invalid = await invoke(url, ["start", "review-claude", "--ref", "refs/heads/main",
    "--sha", "bad-sha", "--effort", "max", "--operation-id", explicitId], env);
  assert.equal(invalid.code, 2);
  assert.equal(invalid.output.error, "invalid_profile_inputs");
  assert.equal(invalid.output.profile, "review-claude");
  assert.deepEqual(invalid.output.issues, validateProfileInputs(profile, {
    source: { ref: "refs/heads/main", sha: "bad-sha" }, overrides: { effort: "max" },
  }));
  assert.deepEqual(invalid.output.issues.map(({ field }) => field), ["source", "source.sha", "prompt", "producerAgent", "overrides.effort"]);
  await assert.rejects(stat(journal), { code: "ENOENT" });
  assert.equal(requests.length, 0);
  const uncertain = await invoke(url, [...args, "--effort", "high", "--", "Review changes"], env);
  assert.equal(uncertain.output.uncertain, true);
  assert.match(uncertain.output.message, /sandbox-runner retry/);
  assert.equal((await stat(journal)).mode & 0o777, 0o600);
  assert.equal(requests[0].overrides.effort, "high");
  await writeFile(file, JSON.stringify({ ...config, profiles: { "review-claude": { ...profile, description: "Edited" } } }));
  assert.equal((await invoke(url, [...args, "--effort", "high", "Review changes"], env)).output.error, "operation_conflict");
  assert.equal((await invoke("http://127.0.0.1:1", ["retry", explicitId], env)).output.error, "profile_request_mismatch");
  assert.equal(requests.length, 1);
  const retried = await invoke(url, ["retry", explicitId], env);
  assert.equal(retried.code, 0);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(retried.output.profile.producerSource, "declared");
  assert.equal(retried.output.connectorAccess.mode, "read-only");
  assert.deepEqual((await invoke(url, ["status", explicitId], env)).output.profile, retried.output.profile);
});

test("profile templates emit deterministic standalone drafts without contacting a Worker", async () => {
  const env = { SANDBOX_RUNNER_TEAM: "1" };
  const result = await invoke("", ["profile", "template", "list"], env);
  assert.equal(result.code, 0);
  assert.deepEqual(result.output.templates.map(({ id }) => id), ["executor", "delivery-review", "vitest", "test-command", "tier2-review"]);
  const details = (await invoke("", ["profile", "template", "get", "test-command"], env)).output.template;
  assert.deepEqual(details.requiredInputs, ["slug", "repo", "argv"]);
  const args = ["profile", "create", "test-command", "--slug", "workspace-test", "--repo", "Owner/Repo", "--", "pnpm", "test", "--run"];
  const created = await invoke("", args, env);
  assert.equal(created.code, 0);
  assert.deepEqual(created, await invoke("", args, env));
  assert.deepEqual(created.output.profile.argv, ["pnpm", "test", "--run"]);
  assert.deepEqual(created.output.config, { schemaVersion: 1, profiles: { "workspace-test": created.output.profile } });
  assert.equal(created.output.qualification, "unverified");
  const invalid = await invoke("", ["profile", "create", "executor", "--harness", "codex"], env);
  assert.equal(invalid.output.error, "invalid_profile_template_inputs");
  assert.deepEqual(invalid.output.issues.map(({ field }) => field), ["slug", "repo", "authMode"]);
  assert.equal((await invoke("", ["profile", "create", "test-command", "pnpm"], env)).output.error, "usage_error");
  const optIns = (await invoke("", ["profile", "create", "executor", "--slug", "exec",
    "--repo", "Owner/Repo", "--harness", "claude", "--auth", "subscription", "--publish",
    "--mcp", "github", "--mcp", "context7"], env)).output.profile;
  assert.equal(optIns.publish, true);
  assert.deepEqual(optIns.mcp.connectors, ["context7", "github"]);
});

test("the CLI projects a verified Worker profile input rejection and withholds unsafe diagnostics", async t => {
  const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-worker-profile-inputs-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const slug = "reviewer";
  const profile = { kind: "agent", operation: "review", harness: "claude", authMode: "subscription",
    defaults: { repo: "Owner/Repo", effort: "high" }, allowedOverrides: { effort: ["medium", "high"] } };
  const file = join(scratch, "profiles.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 1, profiles: { [slug]: profile } }));
  const env = { SANDBOX_RUNNER_PROFILES: file, XDG_STATE_HOME: scratch };
  const validInput = { source: { sha: "a".repeat(40) }, producerAgent: "codex", overrides: { effort: "high" }, prompt: "Review." };
  const diagnostic = validateProfileInputs(profile, { ...validInput, source: { ref: "refs/heads/main" }, overrides: { effort: "max" } });
  let issues = diagnostic;
  let submissions = 0;
  const url = await worker(t, async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v4/runs");
    assert.equal(request.headers.authorization, "Bearer " + token);
    const body = await requestBody(request);
    assert.deepEqual(body, { kind: "profile", profile: { slug, body: profile }, operationId: explicitId, ...validInput });
    submissions++;
    json(response, 400, { error: "invalid_profile_inputs", message: "Untrusted Worker response.", profile: "another-profile", issues });
  });
  const args = ["start", slug, "--sha", validInput.source.sha, "--producer-agent", "codex", "--effort", "high",
    "--operation-id", explicitId, "--", "Review."];
  assert.deepEqual(await invoke(url, args, env), { code: 2, output: {
    error: "invalid_profile_inputs", message: profileInputErrorMessage, operationId: explicitId,
    httpStatus: 400, profile: slug, issues: diagnostic,
  } });
  for (const message of [token, "Unexpected\u001b[31m format."]) {
    issues = [{ ...diagnostic[0], message }];
    const rejected = await invoke(url, args, env);
    assert.equal(rejected.code, 6);
    assert.equal(rejected.output.error, "invalid_response");
    assert.equal(rejected.output.uncertain, true);
    assert.equal(rejected.output.operationId, explicitId);
    assert.equal(rejected.output.issues, undefined);
    assert(!JSON.stringify(rejected).includes(JSON.stringify(message).slice(1, -1)));
  }
  assert.equal(submissions, 3);
});

test("profile check verifies the authenticated revision and reports a stale or unsupported Worker", async t => {
  const slug = "test", clientId = "test-client";
  const profile = { kind: "test", runner: "vitest", defaults: { repo: "Owner/Repo" } };
  const revision = await profileRevision(profile);
  const checks = [{ kind: "sandbox", status: "configured" },
    { kind: "repository", status: "blocked", code: "github_checkout_not_configured" },
    { kind: "timeout", status: "configured" }];
  let readinessStatus = 200, actualClient = clientId;
  const url = await worker(t, (request, response) => {
    assert.equal(request.method, "GET");
    if (request.url === "/v4/profiles/test") return json(response, 200, { clientId, slug, revision, profile });
    assert.equal(request.url, "/v4/profiles/test/readiness?revision=" + revision);
    if (readinessStatus === 409) return json(response, 409, { error: "profile_revision_changed" });
    if (readinessStatus === 404) return json(response, 404, { error: "not_found" });
    return json(response, 200, { clientId: actualClient, slug, revision, qualification: "unverified", checks });
  });
  const env = { SANDBOX_RUNNER_TEAM: "1" };
  const args = ["profile", "check", slug];
  assert.deepEqual(await invoke(url, args, env), { code: 0, output: { clientId, slug, revision, qualification: "unverified", checks } });
  actualClient = "other";
  assert.equal((await invoke(url, args, env)).output.error, "invalid_response");
  readinessStatus = 409;
  assert.equal((await invoke(url, args, env)).output.error, "profile_revision_changed");
  readinessStatus = 404;
  assert.equal((await invoke(url, args, env)).output.error, "profile_check_unavailable");
  assert.equal((await invoke(url, args, { SANDBOX_RUNNER_TEAM: "0" })).output.error, "profile_check_requires_team");
});

test("submits full GitHub references over v4 and requires the pinned repository receipt", async t => {
  const slug = "Owner/Repo";
  const ref = "refs/heads/team/release";
  const repository = { slug, sha: "a".repeat(40) };
  const requests = [];
  let receipt = repository;
  const url = await worker(t, async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v4/runs");
    const body = await requestBody(request);
    requests.push(body);
    const shape = body.kind === "test" ? { suite: body.suite, phase: "queued" } : { agent: body.agent };
    return json(response, 202, { id: explicitId, kind: body.kind, sandboxProvider: "cloudflare",
      status: "queued", cleanup: "pending", repository: receipt, ...shape });
  });
  for (const [command, tail, body] of [
    [["claude", "start"], ["Prompt"], { kind: "agent", agent: "claude", prompt: "Prompt" }],
    [["codex", "start"], ["Prompt"], { kind: "agent", agent: "codex", prompt: "Prompt" }],
    [["vitest", "start"], [], { kind: "test", suite: "vitest" }],
    [["test"], ["--", "node", "--version"], { kind: "test", suite: "command", argv: ["node", "--version"] }],
  ]) {
    const args = [...command, "--operation-id", explicitId, "--repo", slug, "--ref", ref, ...tail];
    const result = await invoke(url, args);
    assert.equal(result.code, 0);
    assert.deepEqual(result.output.repository, repository);
    assert.deepEqual(requests.at(-1), { ...body, operationId: explicitId, repository: { slug, ref } });
  }
  const command = ["claude", "start", "--repo", slug, "--operation-id", explicitId];
  for (const options of [["--ref", "main"], ["--ref", "refs/heads/a.lock/x"], ["--ref", ref, "--sha", repository.sha]]) {
    assert.equal((await invoke(url, [...command, ...options, "Prompt"])).output.error, "usage_error");
  }
  assert.equal((await invoke(url, ["review", "--agent", "claude", "--producer-agent", "codex", "--repo", slug, "--ref", ref, "Criteria"])).output.error, "usage_error");
  assert.equal(requests.length, 4);
  for (const bad of [{ slug, ref }, { ...repository, slug: "owner/repo" }, undefined]) {
    receipt = bad;
    assert.equal((await invoke(url, [...command, "--ref", ref, "Prompt"])).output.error, "invalid_response");
  }
});

test("reports reference lookup failures and distinguishes pending admission from cancellation", async t => {
  const url = await worker(t, async (request, response) => {
    if (request.url === "/v4/runs") {
      const { repository } = await requestBody(request);
      const missing = repository.ref === "refs/heads/missing";
      return json(response, missing ? 404 : 503, { operationId: explicitId,
        error: missing ? "github_reference_not_found" : "github_reference_unavailable" });
    }
    const result = request.url.endsWith("/result");
    return json(response, 409, { operationId: explicitId, error: result ? "run_in_progress" : "admission_in_progress" });
  });
  for (const [ref, error, code] of [["refs/heads/missing", "github_reference_not_found", 3],
    ["refs/tags/unavailable", "github_reference_unavailable", 6]]) {
    const result = await invoke(url, ["codex", "start", "--repo", "Owner/Repo", "--ref", ref, "--operation-id", explicitId, "Prompt"]);
    assert.equal(result.code, code);
    assert.equal(result.output.error, error);
    assert.equal(result.output.uncertain, undefined);
  }
  for (const command of ["status", "cancel", "result"]) {
    const { code, output } = await invoke(url, [command, explicitId]);
    assert.equal(code, 6);
    assert.equal(output.error, command === "result" ? "run_in_progress" : "admission_in_progress");
    assert.equal(output.operationId, explicitId);
    assert.equal(output.uncertain, undefined);
    if (command === "cancel") assert.match(output.message, /Retry cancellation after admission/u);
  }
});

test("OpenCode starts only via v4, verifies its provider on replay and reads the result", async t => {
  const base = runRecord(explicitId, "opencode", { kind: "agent", sandboxProvider: "cloudflare",
    authMode: "api-key", modelProvider: "anthropic", model: "claude-sonnet-5-5", effort: "high" });
  const terminal = { ...base, status: "succeeded", cleanup: "destroyed", output: "fixture complete" };
  const calls = [];
  let submission = [202, base];
  const url = await worker(t, async (request, response) => {
    calls.push(request.url);
    if (request.method === "POST") {
      assert.deepEqual(await requestBody(request), { operationId: explicitId, kind: "agent", agent: "opencode",
        modelProvider: "anthropic", effort: "high", authMode: "api-key", prompt: "--a literal prompt" });
      return json(response, ...submission);
    }
    return json(response, 200, terminal);
  });
  const start = ["opencode", "start", "--operation-id", explicitId];
  for (const options of [[], ["--model-provider", "unknown"], ["--model-provider", "openai", "--effort", "high"],
    ["--model-provider", "anthropic", "--model", "opus"], ["--model-provider", "anthropic", "--repo", "owner/repo"],
    ["--model-provider", "anthropic", "--auth", "subscription"], ["--model-provider", "openai", "--publish"],
    ["--model-provider", "openai", "--model-provider", "anthropic"]]) {
    assert.equal((await invoke(url, [...start, ...options, "prompt"])).output.error, "usage_error");
  }
  assert.deepEqual(calls, []);
  const argumentsForRun = [...start, "--model-provider", "anthropic", "--effort", "high", "--", "--a literal prompt"];
  assert.deepEqual(await invoke(url, argumentsForRun), { code: 0, output: base });
  assert.deepEqual(await invoke(url, ["result", explicitId]), { code: 0, output: terminal });
  submission = [202, { ...base, modelProvider: "openai", model: "gpt-4.1-mini", effort: undefined }];
  assert.equal((await invoke(url, argumentsForRun)).output.error, "invalid_response");
  // This is the old Worker's v4 response. Explicit OpenCode never falls back to a legacy route.
  submission = [400, { error: "invalid_request" }];
  const rejected = await invoke(url, argumentsForRun);
  assert.equal(rejected.output.error, "invalid_request");
  assert.equal(rejected.output.uncertain, undefined);
  assert.deepEqual(calls, ["/v4/runs", `/v1/runs/${explicitId}/result`, "/v4/runs", "/v4/runs"]);
});

test("OpenCode start submits and verifies a canonical private checkout only on v4", async t => {
  const repository = { slug: "Owner/Repo", sha: "a".repeat(40) };
  const base = runRecord(explicitId, "opencode", { kind: "agent", sandboxProvider: "cloudflare", authMode: "api-key",
    modelProvider: "openai", model: "gpt-4.1-mini", repository });
  const terminal = { ...base, status: "succeeded", cleanup: "destroyed", output: "fixture complete" };
  const calls = [];
  let requested = repository;
  let submission = [202, base];
  const url = await worker(t, async (request, response) => {
    calls.push(request.url);
    if (request.method === "POST") {
      assert.deepEqual(await requestBody(request), { operationId: explicitId, kind: "agent", agent: "opencode",
        modelProvider: "openai", authMode: "api-key", prompt: "fixture", repository: requested });
      return json(response, ...submission);
    }
    return json(response, 200, terminal);
  });
  const start = ["opencode", "start", "--model-provider", "openai", "--operation-id", explicitId];
  const pair = ["--repo", repository.slug, "--sha", repository.sha.toUpperCase()];
  const ref = "refs/heads/team/release";
  const refPair = ["--repo", repository.slug, "--ref", ref];
  for (const options of [pair.slice(0, 2), pair.slice(2), ["--repo", repository.slug, "--sha", "main"],
    refPair.slice(2), ["--repo", repository.slug, "--ref", "main"], [...pair, "--ref", ref],
    [...pair, "--publish"], [...refPair, "--publish"], [...refPair, "--review-producer", "claude"],
    [...refPair, "--auth", "subscription"]]) {
    assert.equal((await invoke(url, [...start, ...options, "fixture"])).output.error, "usage_error");
  }
  assert.deepEqual(calls, []);
  const command = [...start, ...pair, "fixture"];
  assert.deepEqual(await invoke(url, command), { code: 0, output: base });
  assert.deepEqual(await invoke(url, ["result", explicitId]), { code: 0, output: terminal });
  for (const invalid of [undefined, { ...repository, slug: "owner/repo" }, { ...repository, sha: "b".repeat(40) }]) {
    submission = [202, { ...base, repository: invalid }];
    assert.equal((await invoke(url, command)).output.error, "invalid_response");
  }
  // 69f8888 returns this before reservation. The client keeps the v4 path.
  submission = [400, { error: "invalid_request" }];
  assert.equal((await invoke(url, command)).output.error, "invalid_request");

  requested = { slug: repository.slug, ref };
  const byRef = [...start, ...refPair, "fixture"];
  submission = [202, base];
  assert.deepEqual(await invoke(url, byRef), { code: 0, output: base });
  for (const invalid of [undefined, requested, { ...repository, slug: "owner/repo" }]) {
    submission = [202, { ...base, repository: invalid }];
    assert.equal((await invoke(url, byRef)).output.error, "invalid_response");
  }
  submission = [404, { error: "github_reference_not_found", operationId: explicitId }];
  assert.equal((await invoke(url, byRef)).output.error, "github_reference_not_found");
  assert.deepEqual(calls, ["/v4/runs", `/v1/runs/${explicitId}/result`, ...Array(9).fill("/v4/runs")]);
});

test("the list opt-in is read-only and works with old and mixed list pages", async t => {
  const entry = { id: explicitId, kind: "agent", agent: "codex", sandboxProvider: "cloudflare",
    status: "succeeded", cleanup: "destroyed" };
  const opencode = { ...entry, id: "34f9fa4c-cc36-46bd-8b7d-f86f09ec79db", agent: "opencode" };
  let mixed = false;
  const url = await worker(t, (request, response) => {
    assert.equal(request.url, "/v4/runs");
    assert.equal(request.method, "GET");
    assert.equal(request.headers["sandbox-runner-list-opencode"], "1");
    return json(response, 200, { runs: mixed ? [opencode, entry] : [entry], nextCursor: null });
  });
  assert.deepEqual(await invoke(url, ["list"]), { code: 0, output: { runs: [entry], nextCursor: null } });
  mixed = true;
  assert.deepEqual(await invoke(url, ["list"]), { code: 0, output: { runs: [opencode, entry], nextCursor: null } });
});

test("an OpenCode run deadline is distinct from the CLI wait timeout", async t => {
  const deadlineAt = 1_800_000_000_000;
  const base = runRecord(explicitId, "opencode", { kind: "agent", sandboxProvider: "cloudflare", authMode: "api-key",
    modelProvider: "openai", model: "gpt-4.1-mini", deadlineAt });
  const terminal = { ...base, status: "timed_out", cleanup: "destroyed", reason: "run_timed_out" };
  let submissions = 0;
  const url = await worker(t, async (request, response) => {
    if (request.method === "POST") {
      assert.equal(request.url, "/v4/runs");
      assert.equal((await requestBody(request)).timeoutMs, 1_200);
      submissions++;
      return json(response, 202, base);
    }
    assert.equal(request.url, `/v1/runs/${explicitId}/result`);
    return json(response, 200, terminal);
  });
  const args = ["opencode", "start", "--model-provider", "openai", "--operation-id", explicitId];
  assert.equal((await invoke(url, [...args, "--run-timeout-ms", "0", "prompt"])).output.error, "usage_error");
  assert.deepEqual(await invoke(url, [...args, "--run-timeout-ms", "1200", "prompt"]), { code: 0, output: base });
  assert.equal(submissions, 1);
  const result = await invoke(url, ["wait", explicitId, "--timeout-ms", "5000"], {}, true);
  assert.equal(result.code, 5);
  assert.deepEqual(result.output, terminal);
});

test("submits MCP connector names and checks the mode assigned to each run", async t => {
  const connectors = ["acme-work-staging", "github"];
  const repository = { slug: "Owner/Repo", sha: "a".repeat(40) };
  const submissions = [];
  let forged = false;
  const url = await worker(t, async (request, response) => {
    assert.equal(request.url, "/v4/runs");
    const body = await requestBody(request);
    submissions.push(body);
    const review = body.reviewProducer === undefined ? {} : { review: { producerAgent: body.reviewProducer } };
    return json(response, 202, runRecord(explicitId, body.agent, {
      kind: "agent", sandboxProvider: "cloudflare", repository, ...review,
      connectorAccess: { connectors, mode: body.reviewProducer && !forged ? "read-only" : "read-write" },
    }));
  });
  const flags = ["--operation-id", explicitId, "--repo", repository.slug, "--sha", repository.sha,
    "--mcp", "github", "--mcp=acme-work-staging", "Check the issue."];
  for (const args of [
    ["run", "--agent", "claude", "--mcp", "github", "Run."],
    ["opencode", "start", "--model-provider", "anthropic", "--mcp", "github", "Run."],
    ["claude", "start", "--mcp", "github", "--mcp", "github", "Run."],
    ["codex", "start", "--mcp", "https://mcp.example.com", "Run."],
  ]) {
    assert.equal((await invoke(url, args)).output.error, "usage_error");
  }
  assert.deepEqual(submissions, []);
  const executor = await invoke(url, ["claude", "start", ...flags]);
  assert.equal(executor.code, 0);
  assert.deepEqual(executor.output.connectorAccess, { connectors, mode: "read-write" });
  const review = ["review", "--agent", "codex", "--producer-agent", "claude", ...flags];
  const reviewer = await invoke(url, review);
  assert.equal(reviewer.code, 0);
  assert.deepEqual(reviewer.output.connectorAccess, { connectors, mode: "read-only" });
  assert.deepEqual(submissions.map(body => body.connectors), [connectors, connectors]);
  assert.ok(submissions.every(body => !Object.hasOwn(body, "connectorAccess")));
  forged = true;
  assert.equal((await invoke(url, review)).output.error, "invalid_response");
});

test("projects connector recovery only for a matching rejected submission", async t => {
  const connector = "acme-staging";
  const code = "mcp_connector_reauth_required";
  const issue = { code, connector, mode: "read-write" };
  const rejection = { error: code, operationId: explicitId, admission: "rejected", connectorIssue: issue };
  let responseBody = { ...rejection, reconnectScope: "acme.read acme.write", workerVersionId: explicitId,
    connectorIssue: { ...issue, upstream: token } };
  const submissions = [];
  const url = await worker(t, async (request, response) => {
    submissions.push(await requestBody(request));
    json(response, 503, responseBody);
  });
  const args = ["claude", "start", "--mcp", connector, "--operation-id", explicitId, "Check ACME"];
  const rejected = await invoke(url, args);
  assert.equal(rejected.code, 3);
  assert.deepEqual(rejected.output, {
    error: code, operationId: explicitId, httpStatus: 503, admission: "rejected", connectorIssue: issue,
    recovery: { action: "connector_login", retry: "same_operation_id" }, message: "Reconnect the connector in your browser.",
  });
  for (const unsafe of [
    { ...rejection, admission: "unknown" },
    { ...rejection, connectorIssue: { ...issue, connector: "different-connector" } },
    { ...rejection, connectorIssue: { ...issue, mode: "read-only" } },
    { ...rejection, operationId: "fae606f3-54b6-4a59-b5f8-25427f7d517c" },
  ]) {
    responseBody = unsafe;
    const rejected = await invoke(url, args);
    assert.equal(rejected.code, 6);
    assert.equal(rejected.output.error, "invalid_response");
    assert.equal(rejected.output.uncertain, true);
    assert.equal(rejected.output.recovery, undefined);
  }
  assert.equal(submissions.length, 5);
  assert.ok(submissions.every(submission => submission.operationId === explicitId));
});

test("retains connector issues in an existing run's result and durable events", async t => {
  const connector = "acme-staging";
  const issue = { code: "mcp_connector_write_unconfirmed", connector, mode: "read-write" };
  const observed = { ...issue, recovery: { action: "verify_write" } };
  const run = runRecord(explicitId, "claude", { kind: "agent", sandboxProvider: "cloudflare",
    status: "failed", cleanup: "destroyed", connectorAccess: { mode: "read-write", connectors: [connector] },
    connectorIssues: [{ ...issue, upstream: token }] });
  const event = { cursor: 1, type: "connector_issue", connectorIssue: observed };
  const wireEvent = { cursor: 1, type: "state", status: "running", connectorIssue: issue };
  const url = await worker(t, (request, response) => {
    if (request.url.endsWith("/result")) return json(response, 200, run);
    assert.ok(request.url.endsWith("/events"));
    return json(response, 200, { id: explicitId, kind: "agent", sandboxProvider: "cloudflare",
      agent: "claude", events: [{ ...wireEvent, connectorIssue: { ...issue, upstream: token } }], nextCursor: 1 });
  });
  const result = await invoke(url, ["result", explicitId], { SANDBOX_RUNNER_LANG: "fr" }, true);
  assert.equal(result.code, 1);
  assert.deepEqual(result.output.connectorIssues, [observed]);
  assert.match(result.stderr, /Vérifiez le résultat de l’écriture/u);
  assert.doesNotMatch(result.stderr, /connector login/u);
  const events = await invoke(url, ["events", explicitId]);
  assert.equal(events.code, 0);
  assert.deepEqual(events.output.events, [event]);
});

test("review submits an exact SHA and returns a checked verdict without raw agent output", async t => {
  const repository = { slug: "Owner/Repo", sha: "a".repeat(40) };
  const review = { producerAgent: "claude" };
  const base = runRecord(explicitId, "codex", { kind: "agent", sandboxProvider: "cloudflare", repository, review });
  const sent = [];
  let final = { ...base, status: "succeeded", cleanup: "destroyed",
    review: { ...review, verdict: "FAIL", findings: ["src/a.ts:4 can throw."] } };
  const url = await worker(t, async (request, response) => {
    if (request.method === "POST") {
      assert.equal(request.url, "/v4/runs");
      sent.push(await requestBody(request));
      return json(response, 202, base);
    }
    assert.equal(request.url, `/v1/runs/${explicitId}/result`);
    return json(response, 200, final);
  });
  const args = ["review", "--agent", "codex", "--repo", repository.slug, "--sha", repository.sha, "--operation-id", explicitId];
  const criteria = "Check the criteria.";
  for (const fields of [[], ["--producer-agent", "codex"], ["--producer-agent", "claude", "--publish"]]) {
    assert.equal((await invoke(url, [...args, ...fields, criteria])).output.error, "usage_error");
  }
  assert.equal(sent.length, 0);
  assert.deepEqual(await invoke(url, [...args, "--producer-agent", "claude", criteria]), { code: 0, output: base });
  assert.deepEqual(sent, [{ kind: "agent", agent: "codex", operationId: explicitId, prompt: criteria,
    repository, reviewProducer: "claude" }]);
  assert.deepEqual(await invoke(url, ["wait", explicitId]), { code: 0, output: final });
  for (const bad of [
    { ...final, output: "raw private output" },
    { ...final, review: { ...final.review, findings: [] } },
    { ...final, review: { ...final.review, producerAgent: "codex" } },
  ]) {
    final = bad;
    assert.equal((await invoke(url, ["result", explicitId])).output.error, "invalid_response");
  }
});

test("lists admitted runs with a resumable cursor and projects only summaries", async t => {
  const first = { id: explicitId, kind: "test", suite: "command", sandboxProvider: "cloudflare", status: "failed", cleanup: "destroyed" };
  const older = { id: "885a04dd-6407-4d96-bed1-b1599ab7b969", kind: "agent", agent: "codex", sandboxProvider: "cloudflare", status: "running", cleanup: "pending" };
  const expected = ["/v4/runs?limit=1", "/v4/runs?cursor=9007199254740993&limit=1"];
  const seen = [];
  const url = await worker(t, (request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    seen.push(request.url);
    if (request.url === expected[0]) return json(response, 200, {
      runs: [{ ...first, argv: ["excluded"], output: "excluded", repository: { slug: "excluded" } }], nextCursor: "9007199254740993",
    });
    assert.equal(request.url, expected[1]);
    return json(response, 200, { runs: [{ ...older, prompt: "excluded", authMode: "subscription" }], nextCursor: null });
  });
  for (const args of [["list", "--limit=0"], ["list", "--limit=25"], ["list", "--cursor=01"], ["list", "--cursor=1\n"],
    ["list", "--limit=1", "--limit=2"], ["list", explicitId]]) {
    assert.equal((await invoke(url, args)).output.error, "usage_error");
  }
  assert.deepEqual(seen, []);
  assert.deepEqual(await invoke(url, ["list", "--limit", "1"]), { code: 0, output: { runs: [first], nextCursor: "9007199254740993" } });
  assert.deepEqual(await invoke(url, ["list", "--cursor=9007199254740993", "--limit=1"]), { code: 0, output: { runs: [older], nextCursor: null } });
  assert.deepEqual(seen, expected);
});

test("list failures keep reads unambiguous and index admission errors preserve the operation ID", async t => {
  let response = [405, { error: "method_not_allowed" }];
  const url = await worker(t, (_request, reply) => json(reply, ...response));
  assert.equal((await invoke(url, ["list"])).output.error, "run_list_unsupported");
  response = [503, { error: "run_list_unavailable" }];
  const unavailable = await invoke(url, ["list"]);
  assert.equal(unavailable.output.error, "run_list_unavailable");
  assert.equal(unavailable.output.uncertain, undefined);
  response = [200, { runs: [], nextCursor: "2" }];
  assert.equal((await invoke(url, ["list", "--limit=1", "--cursor=2"])).output.error, "invalid_response");
  response = [503, { error: "run_index_unavailable" }];
  const admission = await invoke(url, ["claude", "start", "--operation-id", explicitId, "fixture"]);
  assert.equal(admission.output.error, "run_index_unavailable");
  assert.equal(admission.output.operationId, explicitId);
  assert.equal(admission.output.uncertain, true);
});

test("classifies installation capacity separately from an ambiguous admission on every submission route", async t => {
  let response;
  const seen = [];
  const url = await worker(t, async (request, reply) => {
    assert.equal(request.method, "POST");
    const body = await requestBody(request);
    assert.equal(body.operationId, explicitId);
    seen.push(request.url);
    json(reply, ...response);
  });
  const input = ["--operation-id", explicitId, "fixture"];
  const routes = [
    ["/v1/runs", ["run", "--agent", "codex", ...input]],
    ["/v2/runs", ["run", "--agent", "codex", "--auth", "api-key", ...input]],
    ["/v3/runs", ["run", "--agent", "claude", "--effort", "medium", ...input]],
    ["/v4/runs", ["claude", "start", ...input]],
  ];
  const outcomes = [
    [429, "installation_capacity", 4, undefined],
    [503, "admission_unconfirmed", 6, true],
    [503, "installation_maintenance", 6, undefined],
    [503, "legacy_unverified", 3, undefined],
    [503, "installation_admission_invalid", 3, undefined],
  ];
  for (const [route, args] of routes) {
    for (const [status, error, code, uncertain] of outcomes) {
      response = [status, { error, operationId: explicitId }];
      const result = await invoke(url, args);
      assert.equal(result.code, code);
      assert.equal(result.output.error, error);
      assert.equal(result.output.operationId, explicitId);
      assert.equal(result.output.uncertain, uncertain);
      assert.equal(seen.at(-1), route);
    }
  }
  assert.equal(seen.length, routes.length * outcomes.length);
  response = [429, { error: "installation_capacity", operationId: "another-operation" }];
  const unconfirmed = await invoke(url, ["claude", "start", ...input]);
  assert.equal(unconfirmed.code, 6);
  assert.equal(unconfirmed.output.uncertain, true);
});

test("submits test argv after the first separator and preserves the child exit in the receipt", async t => {
  const repository = { slug: "fixture/vitest", sha: "a".repeat(40) };
  const source = ["--repo", repository.slug, "--sha", repository.sha, "--operation-id", explicitId];
  const argv = ["node", "--", "", "$(touch outside)", "--repo", "é\n🚀"];
  const root = { id: explicitId, kind: "test", suite: "command", sandboxProvider: "cloudflare", repository };
  const accepted = { ...root, status: "queued", phase: "queued", cleanup: "pending" };
  const output = { text: "diagnostic", bytes: 10, truncated: false };
  const finished = { ...root, status: "failed", phase: "test", cleanup: "destroyed", reason: "test_command_failed",
    exitCode: 125, stdout: output, stderr: output, versions: { nodeVersion: "v24.22.2", npmVersion: "11.19.1" } };
  const page = { id: explicitId, kind: "test", suite: "command", sandboxProvider: "cloudflare", events: [], nextCursor: 0 };
  let reads = 0;
  const url = await worker(t, async (request, response) => {
    reads++;
    if (request.url === "/v4/runs") {
      assert.deepEqual(await requestBody(request), { kind: "test", suite: "command", operationId: explicitId, repository, argv });
      return json(response, 202, accepted);
    }
    if (request.url.endsWith("/events")) return json(response, 200, page);
    assert.equal(request.url, `/v1/runs/${explicitId}/result`);
    return json(response, 200, finished);
  });
  for (const args of [[], ["node"], ["--"], ["--", ""]]) {
    assert.equal((await invoke(url, ["test", ...source, ...args])).output.error, "usage_error");
  }
  assert.equal(reads, 0);
  assert.deepEqual(await invoke(url, ["test", ...source, "--", ...argv]), { code: 0, output: accepted });
  const failure = await invoke(url, ["result", explicitId], {}, true);
  assert.equal(failure.code, 1);
  assert.deepEqual(failure.output, finished);
  assert.match(failure.stderr, /returned a nonzero exit code/);
  assert.deepEqual(await invoke(url, ["events", explicitId]), { code: 0, output: page });
});

test("Cloudflare agent canary reconciles a lost submission and checks the exact answer after cleanup", async t => {
  const submissions = [];
  const answer = `SANDBOX_RUNNER_CANARY_${explicitId}`;
  const base = runRecord(explicitId, "claude", { kind: "agent", sandboxProvider: "cloudflare", authMode: "subscription" });
  let output = answer;
  let reads = 0;
  const url = await worker(t, async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.method === "POST") {
      assert.equal(request.url, "/v4/runs");
      submissions.push(await requestBody(request));
      if (submissions.length === 1) return response.destroy();
      return json(response, 202, base);
    }
    assert.equal(request.url, `/v1/runs/${explicitId}/result`);
    if (++reads === 1) return json(response, 409, { error: "run_in_progress" });
    return json(response, 200, { ...base, status: "succeeded", cleanup: "destroyed", output });
  });
  const args = ["cloudflare", "canary", "claude", "--auth=subscription", "--operation-id", explicitId];
  const lost = await invoke(url, args);
  assert.equal(lost.output.uncertain, true);
  assert.equal(lost.output.operationId, explicitId);
  assert.deepEqual(await invoke(url, args), { code: 0, output: {
    status: "passed", id: explicitId, kind: "agent", agent: "claude", sandboxProvider: "cloudflare",
    runStatus: "succeeded", cleanup: "destroyed", authMode: "subscription",
  } });
  output = "unexpected private output";
  const wrongAnswer = await invoke(url, args, {}, true);
  assert.equal(wrongAnswer.code, 1);
  assert.equal(wrongAnswer.output.reason, "canary_result_unverified");
  assert.equal(wrongAnswer.output.output, undefined);
  assert.equal((await invoke(url, [...args, "--timeout-ms=0"])).output.error, "usage_error");
  assert.deepEqual(submissions, Array.from({ length: 3 }, () => ({
    kind: "agent", agent: "claude", authMode: "subscription", sandboxProvider: "cloudflare", operationId: explicitId,
    prompt: `Reply with exactly ${answer} and nothing else. Do not use tools.`,
  })));
});

test("Cloudflare Vitest canary requires the exact commit and a terminal image digest", async t => {
  const repository = { slug: "Owner/Project", sha: "a".repeat(40) };
  const base = { id: explicitId, kind: "test", suite: "vitest", sandboxProvider: "cloudflare", repository };
  const versions = { nodeVersion: "v24.22.2", npmVersion: "11.19.1", vitestVersion: "5.1.0" };
  const log = { text: "private test output", bytes: 19, truncated: false };
  const digest = `sha256:${"e".repeat(64)}`;
  let imageDigest = digest;
  let installFailed = false;
  const url = await worker(t, async (request, response) => {
    if (request.method === "POST") {
      assert.deepEqual(await requestBody(request), { kind: "test", suite: "vitest", operationId: explicitId,
        sandboxProvider: "cloudflare", repository });
      return json(response, 202, { ...base, status: "queued", phase: "queued", cleanup: "pending" });
    }
    return json(response, 200, { ...base, cleanup: "destroyed", imageDigest,
      checkoutSha: repository.sha, lockSha256: "b".repeat(64), versions, stdout: log, stderr: log,
      ...(installFailed ? { status: "failed", phase: "install", reason: "test_install_failed", exitCode: 1 }
        : { status: "succeeded", phase: "test", exitCode: 0 }) });
  });
  const args = ["cloudflare", "canary", "vitest", "--repo", repository.slug, "--sha", repository.sha,
    "--operation-id", explicitId];
  assert.equal((await invoke(url, ["cloudflare", "canary", "vitest"])).output.error, "usage_error");
  assert.deepEqual(await invoke(url, args), { code: 0, output: {
    status: "passed", ...base, runStatus: "succeeded", cleanup: "destroyed", imageDigest: digest,
    checkoutSha: repository.sha, lockSha256: "b".repeat(64), processExitCode: 0, versions,
  } });
  imageDigest = undefined;
  assert.equal((await invoke(url, args, {}, true)).output.reason, "canary_result_unverified");
  installFailed = true;
  const failed = await invoke(url, args, {}, true);
  assert.equal(failed.code, 6);
  assert.match(failed.stderr, new RegExp(`sandbox-runner result ${explicitId}`));
  assert.equal(failed.output.stderr, undefined);
});

test("submits Vitest on v4 and keeps a separate test receipt through wait and cancel", async t => {
  const repository = { slug: "fixture/vitest", sha: "a".repeat(40) };
  const base = { id: explicitId, kind: "test", suite: "vitest", repository, sandboxProvider: "cloudflare" };
  const log = { text: "Vitest passed", bytes: 13, truncated: false };
  const finished = { ...base, status: "succeeded", phase: "test", cleanup: "destroyed", checkoutSha: repository.sha,
    imageDigest: "sha256:" + "c".repeat(64), lockSha256: "b".repeat(64), durationMs: 100, exitCode: 0,
    versions: { nodeVersion: "v24.22.2", npmVersion: "11.21.1", vitestVersion: "5.1.0" }, stdout: log, stderr: log };
  const requests = [];
  let outcome = finished;
  const url = await worker(t, async (request, response) => {
    requests.push([request.method, request.url]);
    if (request.url === "/v4/runs") {
      assert.deepEqual(await requestBody(request), { kind: "test", suite: "vitest", operationId: explicitId,
        repository, sandboxProvider: "cloudflare" });
      return json(response, 202, { ...base, phase: "queued", status: "queued", cleanup: "pending" });
    }
    if (request.method === "POST") {
      assert.equal(request.url, `/v4/runs/${explicitId}/cancel`);
      outcome = { ...base, phase: "test", status: "cancelled", cleanup: "pending", reason: "run_cancelled" };
      return json(response, 202, outcome);
    }
    return json(response, 200, outcome);
  });
  const args = ["vitest", "start", "--repo", repository.slug, "--sha", repository.sha.toUpperCase(),
    "--sandbox-provider", "cloudflare", "--operation-id", explicitId];
  assert.equal((await invoke(url, args)).output.kind, "test");
  assert.deepEqual(await invoke(url, ["wait", explicitId]), { code: 0, output: finished });
  outcome = { ...finished, status: "failed", reason: "test_failed", exitCode: 1 };
  assert.equal((await invoke(url, ["result", explicitId])).code, 1);
  outcome = { ...finished, status: "failed", reason: "test_runtime_failed", exitCode: 125 };
  assert.equal((await invoke(url, ["result", explicitId], {}, true)).code, 6);
  const stop = await invoke(url, ["cancel", explicitId]);
  assert.equal(stop.output.status, "cancelled");
  outcome = { ...outcome, cleanup: "destroyed" };
  const waited = await invoke(url, ["wait", explicitId], {}, true);
  assert.equal(waited.output.status, "cancelled");
  assert.equal(waited.output.cleanup, "destroyed");
  assert.equal(requests.filter(([method]) => method === "POST").length, 2);
});

test("rejects Vitest mutations with nonexact Git input and preserves the ID for mismatched receipts", async t => {
  let requests = 0;
  const repository = { slug: "fixture/vitest", sha: "a".repeat(40) };
  const url = await worker(t, async (request, response) => {
    requests++;
    const input = await requestBody(request);
    return json(response, 202, { id: input.operationId, kind: "test", suite: "vitest", repository: { ...repository, sha: "b".repeat(40) },
      status: "queued", phase: "queued", cleanup: "pending", sandboxProvider: "cloudflare" });
  });
  for (const args of [["--repo", repository.slug], ["--repo", repository.slug, "--sha", "main"],
    ["--repo", repository.slug, "--sha", repository.sha, "--auth", "api-key"]]) {
    const result = await invoke(url, ["vitest", "start", ...args]);
    assert.equal(result.output.error, "usage_error");
  }
  assert.equal(requests, 0);
  const rejected = await invoke(url, ["vitest", "start", "--repo", repository.slug, "--sha", repository.sha,
    "--operation-id", explicitId]);
  assert.equal(rejected.output.error, "invalid_response");
  assert.equal(rejected.output.operationId, explicitId);
  assert.equal(rejected.output.uncertain, true);
});

function eventPage(events, nextCursor) {
  return { id: explicitId, kind: "agent", sandboxProvider: "cloudflare", agent: "claude", events, nextCursor };
}

test("resumes the same event read after a dropped response and keeps the cursor on an empty read", async t => {
  const route = `/v4/runs/${explicitId}/events`;
  const seen = [];
  const admission = { cursor: 1, type: "admitted", status: "queued", cleanup: "pending" };
  const terminal = [{ cursor: 2, type: "state", status: "succeeded" }, { cursor: 3, type: "cleanup", cleanup: "destroyed" }];
  const url = await worker(t, (request, response) => {
    seen.push([request.method, request.url, request.headers.authorization]);
    if (seen.length === 2) return response.destroy();
    if (request.url === route) return json(response, 200, eventPage([{ ...admission, prompt: "hidden" }], 1));
    if (request.url === route + "?after=1") return json(response, 200, {
      ...eventPage(terminal, 3), output: "hidden", repository: { slug: "hidden", sha: "hidden" },
    });
    if (request.url === route + "?after=3") return json(response, 200, eventPage([], 3));
    assert.fail("unexpected route");
  });
  assert.deepEqual(await invoke(url, ["events", explicitId.toUpperCase()]), { code: 0, output: eventPage([admission], 1) });
  const dropped = await invoke(url, ["events", explicitId, "--after", "1"]);
  assert.equal(dropped.output.error, "network_error");
  assert.equal(dropped.output.operationId, explicitId);
  assert.equal(dropped.output.uncertain, undefined);
  assert.deepEqual(await invoke(url, ["events", explicitId, "--after=1"]), { code: 0, output: eventPage(terminal, 3) });
  assert.deepEqual(await invoke(url, ["events", explicitId, "--after", "3"]), { code: 0, output: eventPage([], 3) });
  assert.deepEqual(seen, [route, route + "?after=1", route + "?after=1", route + "?after=3"].map(path => ["GET", path, `Bearer ${token}`]));
});

test("rejects invalid event cursors and replies for another run or a discontinuous journal", async t => {
  const event = { cursor: 1, type: "state", status: "succeeded" };
  let response = [200, eventPage([event], 1)];
  let reads = 0;
  const url = await worker(t, (_request, reply) => { reads++; json(reply, ...response); });
  for (const args of [["--after=-1"], ["--after=01"], ["--after=9007199254740992"], ["--after=1", "--after=2"]]) {
    assert.equal((await invoke(url, ["events", explicitId, ...args])).output.error, "usage_error");
  }
  assert.equal(reads, 0);
  for (const payload of [
    { ...eventPage([event], 1), id: "e92b45da-4a1d-499d-b705-85c922e36171" },
    eventPage([event], 2), eventPage([{ ...event, cursor: 2 }], 1),
    eventPage([event, { ...event, cursor: 1 }], 2), eventPage([{ ...event, type: "raw_output" }], 1),
  ]) {
    response = [200, payload];
    assert.equal((await invoke(url, ["events", explicitId])).output.error, "invalid_response");
  }
  for (const [status, error, code] of [[400, "invalid_cursor", 2], [404, "run_not_found", 6], [404, "not_found", 3]]) {
    response = [status, { error }];
    const result = await invoke(url, ["events", explicitId]);
    assert.equal(result.output.error, error);
    assert.equal(result.code, code);
  }
});

test("resumes a Vitest event cursor and projects only the shared lifecycle fields", async t => {
  const route = `/v4/runs/${explicitId}/events`;
  const identity = { id: explicitId, kind: "test", sandboxProvider: "cloudflare", suite: "vitest" };
  const admitted = { cursor: 1, type: "admitted", status: "queued", cleanup: "pending" };
  const checkout = { cursor: 2, type: "phase", phase: "checkout" };
  const empty = { ...identity, events: [], nextCursor: 0 };
  let body = empty;
  let expectedRoute = route;
  const url = await worker(t, (request, response) => {
    assert.equal(request.url, expectedRoute);
    assert.equal(request.method, "GET");
    json(response, 200, body);
  });
  assert.deepEqual(await invoke(url, ["events", explicitId]), { code: 0, output: empty });
  body = { ...identity, events: [admitted], nextCursor: 1 };
  assert.deepEqual(await invoke(url, ["events", explicitId, "--after", "0"]), { code: 0, output: body });
  expectedRoute = route + "?after=1";
  body = { ...identity, nextCursor: 2, repository: { slug: "excluded", sha: "excluded" },
    events: [{ ...checkout, stdout: "excluded", reason: "excluded", credential: "excluded" }] };
  assert.deepEqual(await invoke(url, ["events", explicitId, "--after", "1"]), {
    code: 0, output: { ...identity, events: [checkout], nextCursor: 2 },
  });
  for (const invalid of [
    { ...identity, suite: "other", events: [checkout], nextCursor: 2 },
    { ...identity, events: [{ ...checkout, phase: "shell" }], nextCursor: 2 },
    { ...identity, events: [{ cursor: 2, type: "attempt_state", operationId: explicitId, status: "running" }], nextCursor: 2 },
    { ...identity, events: [{ cursor: 2, type: "state", status: "capacity" }], nextCursor: 2 },
    eventPage([checkout], 2),
  ]) {
    body = invalid;
    assert.equal((await invoke(url, ["events", explicitId, "--after=1"])).output.error, "invalid_response");
  }
});

test("agent start sends only an exact repository slug and full SHA through v4", async t => {
  const seen = [];
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const repository = { slug: "Exact-Org/Private.repo", sha };
  const url = await worker(t, async (request, response) => {
    const input = await requestBody(request);
    seen.push({ path: request.url, input });
    if (input.repository.slug === "Other/repo") return json(response, 403, { error: "github_repository_not_allowed" });
    return json(response, 202, runRecord(input.operationId, input.agent, {
      kind: "agent", sandboxProvider: "cloudflare", repository: input.repository,
    }));
  });
  const start = ["claude", "start", "--operation-id", explicitId];
  const result = await invoke(url, [...start, "--repo", repository.slug, "--sha", sha.toUpperCase(), "Task"]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.output.repository, repository);
  assert.deepEqual(seen, [{ path: "/v4/runs", input: {
    agent: "claude", prompt: "Task", operationId: explicitId, kind: "agent", repository,
  } }]);
  for (const flags of [
    ["--repo", repository.slug],
    ["--sha", sha],
    ["--repo", "https://github.com/" + repository.slug, "--sha", sha],
    ["--repo", "Exact-Org\n/Private.repo", "--sha", sha],
    ["--repo", repository.slug, "--sha", "main"],
  ]) {
    const invalid = await invoke(url, [...start, ...flags, "Task"]);
    assert.equal(invalid.output.error, "usage_error");
  }
  assert.equal(seen.length, 1);
  const denied = await invoke(url, [...start, "--repo", "Other/repo", "--sha", sha, "Task"]);
  assert.equal(denied.code, 3);
  assert.equal(denied.output.error, "github_repository_not_allowed");
});

test("publication is explicit, waits for its receipt, and preserves the agent result", async t => {
  const seen = [];
  const repository = { slug: "Exact-Org/Private.repo", sha: "a".repeat(40) };
  const published = { status: "published", branch: "sandbox-runner/" + explicitId, commitSha: "b".repeat(40), treeSha: "c".repeat(40) };
  const success = { id: explicitId, agent: "claude", kind: "agent", sandboxProvider: "cloudflare", repository,
    status: "succeeded", cleanup: "destroyed", output: "agent result" };
  let result = { ...success, publication: published };
  const url = await worker(t, async (request, response) => {
    seen.push([request.method, request.url]);
    if (request.method === "POST") {
      assert.deepEqual(await requestBody(request), {
        operationId: explicitId, agent: "claude", kind: "agent", prompt: "Task", repository, publish: true,
      });
      return json(response, 202, runRecord(explicitId, "claude", {
        kind: "agent", sandboxProvider: "cloudflare", repository, publication: { status: "pending" },
      }));
    }
    if (seen.length === 2) return json(response, 409, { error: "run_in_progress" });
    return json(response, 200, result);
  });
  assert.equal((await invoke(url, ["claude", "start", "--publish", "Task"])).output.error, "usage_error");
  assert.equal((await invoke(url, ["run", "--agent", "claude", "--publish", "Task"])).output.error, "usage_error");
  assert.deepEqual(seen, []);
  const started = await invoke(url, ["claude", "start", "--repo", repository.slug, "--sha", repository.sha,
    "--operation-id", explicitId, "--publish", "Task"]);
  assert.equal(started.code, 0);
  assert.deepEqual(started.output.publication, { status: "pending" });
  assert.deepEqual(await invoke(url, ["wait", explicitId]), { code: 0, output: result });
  assert.deepEqual(seen, [["POST", "/v4/runs"], ["GET", "/v1/runs/" + explicitId + "/result"],
    ["GET", "/v1/runs/" + explicitId + "/result"]]);

  result = { ...success, publication: { status: "uncertain", branch: published.branch } };
  const uncertain = await invoke(url, ["result", explicitId], {}, true);
  assert.equal(uncertain.code, 1);
  assert.deepEqual(uncertain.output, result);
  assert.match(uncertain.stderr, /could not be verified/);
  result = { ...success, publication: { ...published, branch: "main" } };
  assert.equal((await invoke(url, ["result", explicitId])).output.error, "invalid_response");
});

test("cancels the same run after a lost response and reads cleanup through wait", async t => {
  const requests = [];
  const cancelled = runRecord(explicitId, "claude", {
    kind: "agent", sandboxProvider: "cloudflare", status: "cancelled", reason: "run_cancelled",
  });
  const url = await worker(t, (request, response) => {
    requests.push([request.method, request.url, request.headers.authorization]);
    if (requests.length === 1) return response.destroy();
    if (requests.length === 2) return json(response, 202, cancelled);
    return json(response, 200, { ...cancelled, cleanup: "destroyed" });
  });
  const first = await invoke(url, ["cancel", explicitId]);
  assert.equal(first.output.operationId, explicitId);
  assert.equal(first.output.uncertain, true);
  assert.deepEqual(await invoke(url, ["cancel", explicitId]), { code: 0, output: cancelled });
  const waited = await invoke(url, ["wait", explicitId], {}, true);
  assert.equal(waited.code, 1);
  assert.deepEqual(waited.output, { ...cancelled, cleanup: "destroyed" });
  assert.match(waited.stderr, /cancelled/);
  assert.deepEqual(requests, [
    ["POST", `/v4/runs/${explicitId}/cancel`, `Bearer ${token}`],
    ["POST", `/v4/runs/${explicitId}/cancel`, `Bearer ${token}`],
    ["GET", `/v1/runs/${explicitId}/result`, `Bearer ${token}`],
  ]);
});

test("reports cancellation on a legacy run as a configuration error", async t => {
  const url = await worker(t, (_request, response) => json(response, 409, { error: "cancel_unsupported" }));
  const result = await invoke(url, ["cancel", explicitId]);
  assert.equal(result.code, 3);
  assert.equal(result.output.error, "cancel_unsupported");
  assert.equal(result.output.uncertain, undefined);
});

test("requires a cancellation acknowledgement while the run is still active", async t => {
  const url = await worker(t, (_request, response) => json(response, 202, runRecord(explicitId, "claude", {
    kind: "agent", sandboxProvider: "cloudflare", status: "running",
  })));
  const result = await invoke(url, ["cancel", explicitId]);
  assert.equal(result.output.error, "invalid_response");
  assert.equal(result.output.operationId, explicitId);
  assert.equal(result.output.uncertain, true);
});

test("wait recovers the same result after a dropped read and pending cleanup", async t => {
  const requests = [];
  const final = runRecord(explicitId, "codex", { status: "capacity", cleanup: "destroyed", reason: "provider_capacity" });
  const url = await worker(t, (request, response) => {
    requests.push([request.method, request.url, request.headers.authorization]);
    if (requests.length === 1) return response.destroy();
    if (requests.length === 2) return json(response, 409, { error: "run_in_progress" });
    return json(response, 200, final);
  });
  const result = await invoke(url, ["wait", explicitId], {}, true);
  assert.equal(result.code, 4);
  assert.deepEqual(result.output, final);
  assert.match(result.stderr, /capacity/i);
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ["GET", `/v1/runs/${explicitId}/result`, `Bearer ${token}`]));
});

test("wait deadline leaves the run ID available for a later wait and missing runs fail immediately", async t => {
  let state = "pending";
  const final = runRecord(explicitId, "claude", { status: "succeeded", cleanup: "destroyed" });
  const url = await worker(t, (_request, response) => {
    if (state === "missing") return json(response, 404, { error: "run_not_found" });
    if (state === "pending") return json(response, 409, { error: "run_in_progress" });
    return json(response, 200, final);
  });
  const waiting = await invoke(url, ["wait", explicitId, "--timeout-ms", "100"]);
  assert.equal(waiting.code, 5);
  assert.equal(waiting.output.error, "wait_timeout");
  assert.equal(waiting.output.operationId, explicitId);
  state = "complete";
  assert.deepEqual(await invoke(url, ["wait", explicitId]), { code: 0, output: final });
  state = "missing";
  const missing = await invoke(url, ["wait", explicitId, "--timeout-ms", "500"]);
  assert.equal(missing.output.error, "run_not_found");
});

test("submits, reads and reuses runs for Claude and Codex through the bin", async t => {
  const submissions = [];
  const requests = [];
  const runs = new Map();
  const url = await worker(t, async (request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.method === "POST" && request.url === "/v1/runs") {
      const input = await requestBody(request);
      submissions.push(input);
      const existing = runs.get(input.operationId);
      if (existing && (existing.agent !== input.agent || existing.prompt !== input.prompt)) {
        return json(response, 409, { error: "operation_conflict" });
      }
      if (!existing) runs.set(input.operationId, { agent: input.agent, prompt: input.prompt, state: runRecord(input.operationId, input.agent) });
      return json(response, 202, runs.get(input.operationId).state);
    }
    const [, , , id, suffix] = request.url.split("/");
    const entry = runs.get(id);
    if (!entry) return json(response, 404, { error: "run_not_found" });
    if (suffix === "result" && entry.state.cleanup === "pending") {
      return json(response, 409, { error: "run_in_progress" });
    }
    return json(response, 200, entry.state);
  });

  const prompt = "  --explain\nÉvalue ce résultat 🧪  ";
  const claude = await invoke(url, ["run", "--agent", "claude", "--operation-id", explicitId.toUpperCase(), "--", prompt]);
  assert.deepEqual(claude, { code: 0, output: runRecord(explicitId, "claude") });
  assert.deepEqual(submissions[0], { agent: "claude", prompt, operationId: explicitId });
  assert.deepEqual(await invoke(url, ["status", explicitId.toUpperCase()]), claude);
  const pending = await invoke(url, ["result", explicitId]);
  assert.equal(pending.code, 6);
  assert.equal(pending.output.error, "run_in_progress");
  assert.equal(pending.output.httpStatus, 409);
  assert.equal(pending.output.operationId, explicitId);

  runs.get(explicitId).state = runRecord(explicitId, "claude", {
    status: "succeeded", cleanup: "destroyed", output: "Résultat de Claude",
  });
  assert.deepEqual(await invoke(url, ["result", explicitId]), {
    code: 0, output: runs.get(explicitId).state,
  });
  assert.deepEqual(await invoke(url, ["run", "--agent=claude", "--operation-id=" + explicitId, "--", prompt]), {
    code: 0, output: runs.get(explicitId).state,
  });
  const conflict = await invoke(url, ["run", "--agent", "codex", "--operation-id", explicitId, prompt]);
  assert.equal(conflict.code, 6);
  assert.equal(conflict.output.error, "operation_conflict");
  assert.equal(conflict.output.operationId, explicitId);
  assert.equal(conflict.output.uncertain, undefined);

  const codex = await invoke(url, ["run", "--agent", "codex", "Run a test"]);
  assert.equal(codex.code, 0);
  assert.match(codex.output.id, uuidPattern);
  assert.equal(codex.output.agent, "codex");
  const codexId = codex.output.id;
  assert.deepEqual(await invoke(url, ["status", codexId]), codex);
  runs.get(codexId).state = runRecord(codexId, "codex", {
    status: "capacity", cleanup: "destroyed", reason: "rate_limit",
  });
  assert.deepEqual(await invoke(url, ["result", codexId]), {
    code: 4, output: runs.get(codexId).state,
  });
  assert.equal(runs.size, 2);
  assert.ok(requests.every(request => request.authorization === "Bearer " + token));
});

test("recovers a submission stored before the socket closes using the generated ID", async t => {
  const requests = [];
  let stored;
  const url = await worker(t, async (request, response) => {
    const input = await requestBody(request);
    requests.push(input);
    if (stored) return json(response, 202, runRecord(stored.operationId, stored.agent));
    stored = input;
    response.destroy();
  });

  const first = await invoke(url, ["run", "--agent", "codex", "Preserve this submission"]);
  assert.equal(first.code, 6);
  assert.equal(first.output.error, "network_error");
  assert.equal(first.output.uncertain, true);
  assert.match(first.output.operationId, uuidPattern);
  assert.equal(first.output.operationId, stored.operationId);
  assert.equal(requests.length, 1);

  const replay = await invoke(url, ["run", "--agent", "codex", "--operation-id", first.output.operationId, "Preserve this submission"]);
  assert.deepEqual(replay, { code: 0, output: runRecord(stored.operationId, "codex") });
  assert.deepEqual(requests, [stored, stored]);
});

test("sends explicit auth only to v2 and requires its mode to match the response", async t => {
  let input;
  let returnedMode = "api-key";
  const url = await worker(t, async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v2/runs");
    input = await requestBody(request);
    json(response, 202, runRecord(input.operationId, input.agent, { authMode: returnedMode }));
  });
  const args = ["run", "--agent", "claude", "--auth", "api-key", "--operation-id", explicitId, "Explicit mode"];
  assert.deepEqual(await invoke(url, args), {
    code: 0, output: runRecord(explicitId, "claude", { authMode: "api-key" }),
  });
  assert.deepEqual(input, { agent: "claude", authMode: "api-key", operationId: explicitId, prompt: "Explicit mode" });

  for (const authMode of ["subscription", undefined, "other"]) {
    returnedMode = authMode;
    const rejected = await invoke(url, args);
    assert.equal(rejected.output.error, "invalid_response");
    assert.equal(rejected.output.operationId, explicitId);
    assert.equal(rejected.output.uncertain, true);
  }
});

test("uses v3 only for supplied Claude overrides and preserves explicit auth", async t => {
  const seen = [];
  const url = await worker(t, async (request, response) => {
    const input = await requestBody(request);
    seen.push({ path: request.url, input });
    return json(response, 202, runRecord(input.operationId, input.agent, {
      authMode: input.authMode ?? "subscription", model: input.model ?? "sonnet", effort: input.effort ?? "medium",
    }));
  });
  const args = ["run", "--agent", "claude", "--operation-id", explicitId, "Prompt"];
  const base = { agent: "claude", operationId: explicitId, prompt: "Prompt" };
  const maxModel = "claude-" + "a".repeat(4_993);
  for (const [flags, route, input, output] of [
    [["--model", "opus[1m]"], "/v3/runs", { model: "opus[1m]" }, { model: "opus[1m]", effort: "medium", authMode: "subscription" }],
    [["--effort", "xhigh", "--auth", "api-key"], "/v3/runs", { authMode: "api-key", effort: "xhigh" },
      { model: "sonnet", effort: "xhigh", authMode: "api-key" }],
    [["--model", "claude-opus-4-8", "--effort", "max"], "/v3/runs", { model: "claude-opus-4-8", effort: "max" },
      { model: "claude-opus-4-8", effort: "max", authMode: "subscription" }],
    [["--model", maxModel], "/v3/runs", { model: maxModel },
      { model: maxModel, effort: "medium", authMode: "subscription" }],
    [["--auth", "api-key"], "/v2/runs", { authMode: "api-key" }, { model: "sonnet", effort: "medium", authMode: "api-key" }],
    [[], "/v1/runs", {}, { model: "sonnet", effort: "medium", authMode: "subscription" }],
  ]) {
    assert.deepEqual(await invoke(url, [...args, ...flags]), {
      code: 0, output: runRecord(explicitId, "claude", output),
    });
    assert.deepEqual(seen.at(-1), { path: route, input: { ...base, ...input } });
  }
});

test("sends Codex model and effort over v4 and verifies the echoed receipt", async t => {
  const seen = [];
  const model = "gpt-6.1-sol";
  const effort = "xhigh";
  let echo = { model, effort };
  const url = await worker(t, async (request, response) => {
    const input = await requestBody(request);
    seen.push({ path: request.url, input });
    json(response, 202, runRecord(input.operationId, "codex", {
      kind: "agent", sandboxProvider: "cloudflare", authMode: "api-key", ...echo,
    }));
  });
  const args = ["run", "--agent", "codex", "--auth", "api-key", "--operation-id", explicitId,
    "--model", model, "--effort", effort, "Prompt"];
  const result = await invoke(url, args);
  assert.equal(result.code, 0);
  assert.equal(result.output.model, model);
  assert.equal(result.output.effort, effort);
  assert.deepEqual(seen[0], { path: "/v4/runs", input: {
    kind: "agent", agent: "codex", authMode: "api-key", operationId: explicitId, model, effort, prompt: "Prompt",
  } });
  echo = { model, effort: "high" };
  const rejected = await invoke(url, args);
  assert.equal(rejected.output.error, "invalid_response");
  assert.equal(rejected.output.operationId, explicitId);
});

test("rejects invalid agent run overrides before contacting the Worker", async t => {
  let requests = 0;
  const url = await worker(t, (_request, response) => {
    requests++;
    json(response, 500, {});
  });
  for (const [agent, flags] of [
    ["codex", ["--model", "opus"]],
    ["codex", ["--effort", "auto"]],
    ["codex", ["--model", "gpt-6.1-sol\n"]],
    ["claude", ["--model", "claude-opus-4-8\n"]],
    ["claude", ["--model", "haiku[1m]"]],
    ["claude", ["--model", "claude-" + "a".repeat(4_994)]],
    ["claude", ["--effort", "HIGH"]],
    ["claude", ["--effort", "low", "--effort", "high"]],
  ]) {
    const rejected = await invoke(url, ["run", "--agent", agent, ...flags, "Prompt"]);
    assert.equal(rejected.code, 2);
    assert.equal(rejected.output.error, "usage_error");
  }
  assert.equal(requests, 0);
});

test("never falls back from v3 and preserves the operation ID on a mismatching override echo", async t => {
  const paths = [];
  let reply = response => json(response, 404, { error: "not_found" });
  const url = await worker(t, async (request, response) => {
    paths.push(request.url);
    await requestBody(request);
    reply(response);
  });
  const args = ["run", "--agent", "claude", "--operation-id", explicitId, "--model", "opus", "--effort", "high", "Prompt"];
  const oldWorker = await invoke(url, args);
  assert.equal(oldWorker.code, 3);
  assert.equal(oldWorker.output.httpStatus, 404);
  assert.equal(oldWorker.output.operationId, explicitId);
  assert.match(oldWorker.output.message, /support for Claude run overrides/);
  assert.deepEqual(paths, ["/v3/runs"]);

  for (const echo of [{}, { model: "sonnet", effort: "high" }, { model: "opus" }, { model: "opus", effort: "low" }]) {
    reply = response => json(response, 202, runRecord(explicitId, "claude", { authMode: "subscription", ...echo }));
    const rejected = await invoke(url, args);
    assert.equal(rejected.code, 6);
    assert.equal(rejected.output.error, "invalid_response");
    assert.equal(rejected.output.operationId, explicitId);
    assert.equal(rejected.output.uncertain, true);
  }
  assert(paths.every(path => path === "/v3/runs"));
});

test("replays an ambiguous Claude override submission with the original operation ID and values", async t => {
  const submissions = [];
  const url = await worker(t, async (request, response) => {
    assert.equal(request.url, "/v3/runs");
    const input = await requestBody(request);
    submissions.push(input);
    if (submissions.length === 1) return response.destroy();
    json(response, 202, runRecord(input.operationId, input.agent, { model: input.model, effort: input.effort }));
  });
  const args = ["run", "--agent", "claude", "--model", "fable", "--effort", "max", "Keep the overrides"];
  const first = await invoke(url, args);
  assert.equal(first.output.error, "network_error");
  assert.equal(first.output.uncertain, true);
  assert.match(first.output.operationId, uuidPattern);
  assert.equal(first.output.operationId, submissions[0].operationId);
  const replay = await invoke(url, [...args, "--operation-id", first.output.operationId]);
  assert.equal(replay.code, 0);
  assert.deepEqual(submissions, [submissions[0], submissions[0]]);
});

test("starts both agents on v4 and reads provider metadata through existing status and result routes", async t => {
  const seen = [];
  const runs = new Map();
  const url = await worker(t, async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer " + token);
    if (request.method === "POST") {
      const input = await requestBody(request);
      seen.push({ path: request.url, input });
      const run = runRecord(input.operationId, input.agent, {
        authMode: input.authMode ?? (input.agent === "claude" ? "subscription" : "api-key"),
        kind: "agent", sandboxProvider: "cloudflare", model: input.model, effort: input.effort,
      });
      runs.set(run.id, run);
      return json(response, 202, run);
    }
    const [, , , id, suffix] = request.url.split("/");
    const run = runs.get(id);
    assert.equal(request.url, `/v1/runs/${id}${suffix === "result" ? "/result" : ""}`);
    if (suffix !== "result") return json(response, 200, run);
    return json(response, 200, { ...run, status: "succeeded", cleanup: "destroyed", output: "READY" });
  });
  for (const [agent, flags, inputOptions, resultOptions] of [
    ["claude", ["--auth", "api-key", "--model", "opus", "--effort", "high"],
      { authMode: "api-key", model: "opus", effort: "high" }, { authMode: "api-key", model: "opus", effort: "high" }],
    ["codex", ["--sandbox-provider", "cloudflare"], { sandboxProvider: "cloudflare" }, { authMode: "api-key" }],
  ]) {
    const { code, output } = await invoke(url, [agent, "start", ...flags, "Reply READY"]);
    assert.equal(code, 0);
    assert.match(output.id, uuidPattern);
    assert.deepEqual(seen.at(-1), { path: "/v4/runs", input: {
      agent, prompt: "Reply READY", operationId: output.id, kind: "agent", ...inputOptions,
    } });
    assert.deepEqual(output, runRecord(output.id, agent, { kind: "agent", sandboxProvider: "cloudflare", ...resultOptions }));
    assert.deepEqual(await invoke(url, ["status", output.id]), { code: 0, output });
    assert.deepEqual(await invoke(url, ["result", output.id]), {
      code: 0, output: { ...output, status: "succeeded", cleanup: "destroyed", output: "READY" },
    });
  }
});

test("replays a provider-aware run submission with the original ID, provider and auth mode", async t => {
  const seen = [];
  const url = await worker(t, async (request, response) => {
    assert.equal(request.url, "/v4/runs");
    const input = await requestBody(request);
    seen.push(input);
    if (seen.length === 1) return response.destroy();
    json(response, 202, runRecord(input.operationId, input.agent, {
      kind: "agent", sandboxProvider: input.sandboxProvider, authMode: input.authMode,
    }));
  });
  const args = ["run", "--agent", "codex", "--auth", "subscription", "--sandbox-provider", "cloudflare", "Keep this run"];
  const { output } = await invoke(url, args);
  assert.equal(output.error, "network_error");
  assert.equal(output.uncertain, true);
  assert.match(output.operationId, uuidPattern);
  const expected = { operationId: output.operationId, agent: "codex", kind: "agent", prompt: "Keep this run",
    sandboxProvider: "cloudflare", authMode: "subscription" };
  assert.equal((await invoke(url, [...args, "--operation-id", output.operationId])).code, 0);
  assert.deepEqual(seen, [expected, expected]);
});

test("distinguishes provider selection errors, old Workers and malformed v4 replies without route fallback", async t => {
  const seen = [];
  let reply;
  const url = await worker(t, async (request, response) => {
    const input = await requestBody(request);
    seen.push({ path: request.url, input });
    reply(response);
  });
  const args = ["claude", "start", "--operation-id", explicitId, "Prompt"];
  const providerArgs = [...args, "--sandbox-provider", "future-provider"];
  for (const [invocation, status, error] of [
    [providerArgs, 503, "sandbox_provider_unavailable"],
    [args, 503, "sandbox_provider_default_invalid"],
    [args, 404, "not_found"],
  ]) {
    reply = response => json(response, status, { error, detail: token });
    const result = await invoke(url, invocation);
    assert.equal(result.code, 3);
    assert.equal(result.output.error, error);
    assert.equal(result.output.httpStatus, status);
    assert.equal(result.output.operationId, explicitId);
    assert.equal(result.output.uncertain, undefined);
  }
  assert.equal(seen[0].input.sandboxProvider, "future-provider");
  assert.equal(seen[1].input.sandboxProvider, undefined);
  for (const [invocation, extra] of [
    [args, {}],
    [args, { kind: "test", sandboxProvider: "cloudflare" }],
    [args, { kind: "agent", sandboxProvider: "https://untrusted.test" }],
    [providerArgs, { kind: "agent", sandboxProvider: "cloudflare" }],
  ]) {
    reply = response => json(response, 202, runRecord(explicitId, "claude", extra));
    const result = await invoke(url, invocation);
    assert.equal(result.code, 6);
    assert.equal(result.output.error, "invalid_response");
    assert.equal(result.output.operationId, explicitId);
    assert.equal(result.output.uncertain, true);
  }
  assert.equal(seen.length, 7);
  assert(seen.every(({ path }) => path === "/v4/runs"));
});

test("rejects malformed provider names and mismatched start options before reaching the Worker", async t => {
  let requests = 0;
  const url = await worker(t, (_request, response) => {
    requests++;
    return json(response, 500, {});
  });
  for (const args of [
    ["claude", "start", "--sandbox-provider", "cloudflare\n", "Prompt"],
    ["claude", "start", "--sandbox-provider", "https://invalid.test", "Prompt"],
    ["claude", "start", "--sandbox-provider", "cloudflare", "--sandbox-provider", "local", "Prompt"],
    ["claude", "start", "--agent", "codex", "Prompt"],
    ["codex", "start", "--effort", "MEDIUM", "Prompt"],
    ["run", "--agent", "codex", "--sandbox-provider", "Cloudflare", "Prompt"],
  ]) {
    const result = await invoke(url, args);
    assert.equal(result.code, 2);
    assert.equal(result.output.error, "usage_error");
  }
  assert.equal(requests, 0);
});

test("reports corrupt Claude defaults as a definite configuration error", async t => {
  const url = await worker(t, async (request, response) => {
    assert.equal(request.url, "/v3/runs");
    await requestBody(request);
    json(response, 503, { error: "claude_defaults_invalid", detail: token });
  });
  const result = await invoke(url, ["run", "--agent", "claude", "--auth", "api-key", "--model", "sonnet",
    "--operation-id", explicitId, "Prompt"]);
  assert.equal(result.code, 3);
  assert.equal(result.output.error, "claude_defaults_invalid");
  assert.equal(result.output.httpStatus, 503);
  assert.equal(result.output.operationId, explicitId);
  assert.equal(result.output.uncertain, undefined);
});

test("accepts a verified strategy on implicit runs and preserves its attempt history", async t => {
  const firstId = "9fa305fe-2aec-429f-859b-27068fabeff3";
  const secondId = "e1614bd8-d11b-4599-8de8-758ce3026c67";
  const overrideId = "43ea3a44-d497-4227-a4b5-e1b4bc3e67bd";
  const providerRunId = "c3982431-3622-428d-a21f-c6f4c9ea20f9";
  const providerView = { id: providerRunId, kind: "agent", sandboxProvider: "cloudflare" };
  const strategy = "api-key-first-then-subscription";
  const settings = { model: "opus", effort: "high" };
  const requests = [];
  const started = runRecord(explicitId, "claude", {
    authMode: "api-key", status: "queued", cleanup: "pending", strategy, ...settings,
    attempts: [{ operationId: firstId, authMode: "api-key", status: "queued", cleanup: "pending", ...settings }],
  });
  const finished = runRecord(explicitId, "claude", {
    authMode: "subscription", status: "succeeded", cleanup: "destroyed", output: "OK", strategy, ...settings,
    fallbackReason: "provider_quota_exhausted",
    attempts: [
      { operationId: firstId, authMode: "api-key", status: "capacity", cleanup: "destroyed", reason: "provider_quota_exhausted", ...settings },
      { operationId: secondId, authMode: "subscription", status: "succeeded", cleanup: "destroyed", ...settings },
    ],
  });
  const url = await worker(t, async (request, response) => {
    requests.push(request.url);
    if (request.method === "POST") {
      const input = await requestBody(request);
      if (request.url === "/v3/runs") {
        assert.deepEqual(input, { operationId: overrideId, agent: "claude", prompt: "Use the policy", model: "opus" });
        return json(response, 202, { ...started, id: overrideId });
      }
      if (request.url === "/v4/runs") {
        assert.deepEqual(input, { operationId: providerRunId, agent: "claude", prompt: "Use the policy", kind: "agent" });
        return json(response, 202, { ...started, ...providerView });
      }
      assert.deepEqual(input, { operationId: explicitId, agent: "claude", prompt: "Use the policy" });
      return json(response, 202, started);
    }
    return json(response, 200, request.url.includes(providerRunId) ? { ...finished, ...providerView } : finished);
  });
  assert.deepEqual(await invoke(url, ["run", "--agent", "claude", "--operation-id", explicitId, "Use the policy"]), {
    code: 0, output: started,
  });
  assert.deepEqual(await invoke(url, ["run", "--agent", "claude", "--operation-id", overrideId, "--model", "opus", "Use the policy"]), {
    code: 0, output: { ...started, id: overrideId },
  });
  assert.deepEqual(await invoke(url, ["claude", "start", "--operation-id", providerRunId, "Use the policy"]), {
    code: 0, output: { ...started, ...providerView },
  });
  assert.deepEqual(await invoke(url, ["status", explicitId]), { code: 0, output: finished });
  assert.deepEqual(await invoke(url, ["result", explicitId]), { code: 0, output: finished });
  assert.deepEqual(await invoke(url, ["result", providerRunId]), { code: 0, output: { ...finished, ...providerView } });
  assert.deepEqual(requests, ["/v1/runs", "/v3/runs", "/v4/runs", `/v1/runs/${explicitId}`,
    `/v1/runs/${explicitId}/result`, `/v1/runs/${providerRunId}/result`]);
});

test("rejects invalid strategy attempts and forbids strategy metadata for explicit auth", async t => {
  const strategy = "api-key-only";
  const attempt = { operationId: "9fa305fe-2aec-429f-859b-27068fabeff3", authMode: "api-key", status: "queued", cleanup: "pending" };
  const record = runRecord(explicitId, "claude", {
    authMode: "api-key", status: "queued", cleanup: "pending", strategy, attempts: [attempt],
  });
  let returned = record;
  const url = await worker(t, async (request, response) => {
    await requestBody(request);
    return json(response, 202, returned);
  });
  const args = ["run", "--agent", "claude", "--operation-id", explicitId, "Check response"];
  const explicit = await invoke(url, [...args, "--auth", "api-key"]);
  assert.equal(explicit.output.error, "invalid_response");
  for (const invalid of [
    { strategy: "unsupported" },
    { attempts: [] },
    { attempts: undefined },
    { attempts: [{ ...attempt, operationId: "invalid-id" }] },
    { attempts: [{ ...attempt, operationId: explicitId }] },
    { attempts: [{ ...attempt, authMode: "subscription" }] },
    { attempts: [{ ...attempt, status: "running" }] },
    { attempts: [{ ...attempt, model: "sonnet" }] },
    { model: "sonnet" },
    { fallbackReason: "provider_quota_exhausted" },
    { strategy: undefined, attempts: undefined },
  ]) {
    returned = { ...record, ...invalid };
    const result = await invoke(url, args);
    assert.equal(result.output.error, "invalid_response");
    assert.equal(result.output.operationId, explicitId);
    assert.equal(result.output.uncertain, true);
  }
});

test("reports a corrupt implicit auth strategy as a definite configuration error", async t => {
  const paths = [];
  const url = await worker(t, async (request, response) => {
    paths.push(request.url);
    await requestBody(request);
    return json(response, 503, { error: "auth_strategy_invalid", details: token });
  });
  const args = ["run", "--agent", "codex", "--operation-id", explicitId, "Check strategy"];
  const implicit = await invoke(url, args);
  assert.equal(implicit.code, 3);
  assert.equal(implicit.output.error, "auth_strategy_invalid");
  assert.equal(implicit.output.operationId, explicitId);
  assert.equal(implicit.output.httpStatus, 503);
  assert.equal(implicit.output.uncertain, undefined);
  assert.match(implicit.output.message, /sandbox-runner codex setup/);
  assert(!JSON.stringify(implicit).includes(token));
  const explicit = await invoke(url, [...args, "--auth", "subscription"]);
  assert.equal(explicit.code, 6);
  assert.equal(explicit.output.uncertain, true);
  assert.deepEqual(paths, ["/v1/runs", "/v2/runs"]);
});

test("an explicit subscription request cannot fall back to an older worker's API key route", async t => {
  const paths = [];
  const url = await worker(t, (request, response) => {
    paths.push(request.url);
    if (request.url === "/v1/runs") {
      return json(response, 202, runRecord(explicitId, "codex"));
    }
    return json(response, 404, { error: "not_found" });
  });
  const result = await invoke(url, ["run", "--agent", "codex", "--auth=subscription", "--operation-id", explicitId, "Prompt"]);
  assert.equal(result.code, 3);
  assert.equal(result.output.httpStatus, 404);
  assert.deepEqual(paths, ["/v2/runs"]);
});

test("uses a configurable deadline while reading a response body", async t => {
  let requestCount = 0;
  const url = await worker(t, async (request, response) => {
    await requestBody(request);
    requestCount++;
    response.writeHead(202, { "content-type": "application/json" });
    response.write('{"id":');
  });
  const result = await invoke(url, ["run", "--agent", "claude", "--operation-id", explicitId, "Timeout"], {
    SANDBOX_RUNNER_TIMEOUT_MS: "700",
  });
  assert.equal(requestCount, 1);
  assert.deepEqual(result, {
    code: 5,
    output: { error: "timeout", message: "The request timed out.", operationId: explicitId, uncertain: true },
  });
});

test("never follows a redirect or sends a control token to its target", async t => {
  let targetHits = 0;
  const target = await worker(t, (_request, response) => {
    targetHits++;
    response.end();
  });
  const url = await worker(t, (request, response) => {
    assert.equal(request.headers.authorization, "Bearer " + token);
    response.writeHead(307, { location: target + "/redirected" });
    response.end();
  });

  const result = await invoke(url, ["run", "--agent", "claude", "--operation-id", explicitId, "No redirects"]);
  assert.equal(result.code, 6);
  assert.equal(result.output.error, "redirect_rejected");
  assert.equal(result.output.httpStatus, 307);
  assert.equal(result.output.operationId, explicitId);
  assert.equal(targetHits, 0);
});

test("connects directly to loopback even if Node environment proxying is enabled", async t => {
  let proxyHits = 0;
  let originHost;
  const proxy = await worker(t, (_request, response) => {
    proxyHits++;
    response.end();
  });
  const numeric = await worker(t, (request, response) => {
    originHost = request.headers.host;
    json(response, 200, runRecord(explicitId, "claude"));
  });
  const url = numeric.replace("127.0.0.1", "localhost");
  const result = await invoke(url, ["status", explicitId], {
    NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxy, NO_PROXY: "",
  });
  assert.deepEqual(result, { code: 0, output: runRecord(explicitId, "claude") });
  assert.equal(originHost, new URL(url).host);
  assert.equal(proxyHits, 0);
});

test("rejects invalid commands and unsafe configuration before sending any request", async t => {
  let calls = 0;
  const url = await worker(t, (_request, response) => {
    calls++;
    response.end();
  });
  for (const args of [
    ["run", "--agent", "other", "Prompt"],
    ["run", "--agent", "claude", "  "],
    ["run", "--agent", "claude", "two", "arguments"],
    ["run", "--agent", "claude", "--agent", "codex", "Prompt"],
    ["run", "--agent", "claude", "--auth", "oauth", "Prompt"],
    ["run", "--agent", "claude", "--auth", "api-key", "--auth", "subscription", "Prompt"],
    ["run", "--agent", "claude", "--operation-id", "not-a-uuid", "Prompt"],
    ["status", "../wrong-path"],
  ]) {
    const result = await invoke(url, args);
    assert.equal(result.code, 2);
    assert.equal(result.output.error, "usage_error");
  }
  for (const invalid of [
    "", "http://example.invalid", "http://localhost.example.invalid",
    "https://user:password@example.invalid", "https://example.invalid/subpath",
    "https://example.invalid/subpath/..",
    "https://example.invalid?", "https://example.invalid#fragment",
  ]) {
    const result = await invoke(invalid, ["status", explicitId]);
    assert.equal(result.code, 3);
    assert.equal(result.output.error, "configuration_error");
  }
  const invalidToken = await invoke(url, ["status", explicitId], { SANDBOX_RUNNER_TOKEN: "unsafe\r\nsecret" });
  assert.equal(invalidToken.code, 3);
  assert.equal(invalidToken.output.error, "configuration_error");
  assert.ok(!JSON.stringify(invalidToken.output).includes("unsafe"));
  assert.equal(calls, 0);
});

test("keeps the ID for server errors and malformed or mismatched responses", async t => {
  let reply = () => {};
  const url = await worker(t, (_request, response) => reply(response));
  const args = ["run", "--agent", "claude", "--operation-id", explicitId, "Keep the identifier"];
  reply = response => json(response, 400, { error: "invalid_request" });
  const invalidInput = await invoke(url, args);
  assert.equal(invalidInput.code, 2);
  assert.equal(invalidInput.output.error, "invalid_request");
  assert.equal(invalidInput.output.operationId, explicitId);
  assert.equal(invalidInput.output.uncertain, undefined);

  reply = response => json(response, 503, { detail: token });
  const rejected = await invoke(url, args);
  assert.equal(rejected.code, 6);
  assert.equal(rejected.output.error, "request_failed");
  assert.equal(rejected.output.httpStatus, 503);
  assert.equal(rejected.output.operationId, explicitId);
  assert.equal(rejected.output.uncertain, true);

  reply = response => {
    response.writeHead(202, { "content-type": "application/json" });
    response.end("{not-json}");
  };
  const malformed = await invoke(url, args);
  assert.equal(malformed.output.error, "invalid_response");
  assert.equal(malformed.output.operationId, explicitId);

  reply = response => json(response, 202, runRecord("11111111-1111-1111-1111-111111111111", "claude"));
  const mismatched = await invoke(url, args);
  assert.equal(mismatched.output.error, "invalid_response");
  assert.equal(mismatched.output.uncertain, true);

  reply = response => json(response, 200, runRecord(explicitId, "claude"));
  const invalidResult = await invoke(url, ["result", explicitId]);
  assert.equal(invalidResult.output.error, "invalid_response");
  assert.equal(invalidResult.output.uncertain, undefined);
});

test("distinguishes access denial, unknown runs and terminal failure results", async t => {
  let status = 404;
  let body = { error: "not_found" };
  const url = await worker(t, (_request, response) => json(response, status, body));
  const denied = await invoke(url, ["status", explicitId]);
  assert.equal(denied.code, 3);
  assert.equal(denied.output.error, "not_found");

  body = { error: "run_not_found" };
  const missing = await invoke(url, ["status", explicitId]);
  assert.equal(missing.code, 6);
  assert.equal(missing.output.error, "run_not_found");

  status = 200;
  body = runRecord(explicitId, "codex", { status: "auth_required", cleanup: "destroyed", reason: "authentication_failed" });
  assert.deepEqual(await invoke(url, ["result", explicitId]), { code: 3, output: body });

  body = runRecord(explicitId, "codex", { status: "succeeded", cleanup: "failed", output: "Test passed" });
  assert.deepEqual(await invoke(url, ["result", explicitId], {}, true), {
    code: 1, output: body, stderr: "Container cleanup failed. Check the run in Cloudflare Containers.\n",
  });
  assert.deepEqual(await invoke(url, ["status", explicitId]), { code: 0, output: body });
});

test("explains allowlisted result failures on stderr with stable JSON and exits", async t => {
  let run;
  let calls = 0;
  const url = await worker(t, (_request, response) => {
    calls++;
    json(response, 200, run);
  });
  for (const [status, reason, code, hint] of [
    ["capacity", "provider_capacity", 4, /usage or rate limit/],
    ["capacity", "provider_quota_exhausted", 4, /insufficient quota/],
    ["capacity", "provider_overloaded", 4, /overloaded/],
    ["auth_required", "provider_auth_required", 3, /rejected authentication/],
    ["failed", "provider_permission_denied", 1, /denied access/],
    ["failed", "provider_billing_required", 1, /billing restriction/],
    ["failed", "provider_timeout", 1, /provider request timed out/],
    ["unanswered", "container_lost", 1, /container stopped/],
  ]) {
    run = runRecord(explicitId, "claude", { status, reason, cleanup: "destroyed" });
    const result = await invoke(url, ["result", explicitId], {}, true);
    assert.equal(result.code, code);
    assert.deepEqual(result.output, run);
    assert.match(result.stderr, hint);
    assert.doesNotMatch(result.stderr, /expired|quota exhausted/i);
    assert.deepEqual(await invoke(url, ["status", explicitId]), { code: 0, output: run });
  }
  run = { ...run, status: "capacity", cleanup: "failed", reason: "provider_overloaded" };
  const cleanup = await invoke(url, ["result", explicitId], {}, true);
  assert.equal(cleanup.code, 1);
  assert.deepEqual(cleanup.output, run);
  assert.match(cleanup.stderr, /cleanup failed/);
  assert.doesNotMatch(cleanup.stderr, /overloaded/);
  assert.equal(calls, 17);
});

test("explains the Codex API-credit restriction in English and French while preserving the receipt", async t => {
  const run = runRecord(explicitId, "codex", { authMode: "api-key", status: "failed", cleanup: "destroyed",
    reason: "provider_codex_api_credit_promo_restricted" });
  const url = await worker(t, (_request, response) => json(response, 200, run));
  for (const [locale, hint] of [
    ["en", /Configure a key from an eligible API organization or explicitly select subscription/],
    ["fr-BE", /Configurez une clé d’une organisation API éligible ou sélectionnez explicitement/],
    ["es", /Configure a key from an eligible API organization or explicitly select subscription/],
  ]) {
    const result = await invoke(url, ["result", explicitId], { SANDBOX_RUNNER_LANG: locale }, true);
    assert.equal(result.code, 1);
    assert.deepEqual(result.output, run);
    assert.match(result.stderr, hint);
  }
});

test("submits an explicit execution deadline over v4 and verifies the server acknowledgement", async t => {
  let reply = { status: 202, body: runRecord(explicitId, "codex", {
    kind: "agent", sandboxProvider: "cloudflare", authMode: "api-key", deadlineAt: 1_795_000_000_000,
  }) };
  let submissions = 0;
  const url = await worker(t, async (request, response) => {
    assert.equal(request.url, "/v4/runs");
    assert.equal(request.method, "POST");
    assert.deepEqual(await requestBody(request), { operationId: explicitId, kind: "agent", agent: "codex", authMode: "api-key",
      prompt: "Fixture", timeoutMs: 60_000 });
    submissions += 1;
    json(response, reply.status, reply.body);
  });
  const args = ["run", "--agent", "codex", "--auth", "api-key", "--operation-id", explicitId, "--run-timeout-ms", "60000", "Fixture"];
  assert.deepEqual(await invoke(url, args), { code: 0, output: reply.body });
  assert.deepEqual(await invoke(url, ["codex", "start", ...args.slice(3)]), { code: 0, output: reply.body });
  reply = { status: 202, body: { ...reply.body, deadlineAt: undefined } };
  const missingEcho = await invoke(url, args);
  assert.equal(missingEcho.output.error, "invalid_response");
  assert.equal(missingEcho.output.operationId, explicitId);
  assert.equal(missingEcho.output.uncertain, true);
  reply = { status: 400, body: { error: "run_timeout_exceeds_limit" } };
  const aboveCap = await invoke(url, args);
  assert.equal(aboveCap.code, 2);
  assert.equal(aboveCap.output.error, "run_timeout_exceeds_limit");
  assert.equal(aboveCap.output.uncertain, undefined);
  for (const badValue of ["0", "-1", "1.5", "1\n", "3153600000001"]) {
    const invalid = await invoke(url, [...args.slice(0, -3), `--run-timeout-ms=${badValue}`, "Fixture"]);
    assert.equal(invalid.code, 2);
    assert.equal(invalid.output.error, "usage_error");
  }
  assert.equal(submissions, 4);
});

test("reads a root deadline separately from the active attempt, and waits for cleanup", async t => {
  const deadlineAt = 1_795_000_000_000;
  const attempt = { operationId: "c839ca8c-9154-4ba3-807f-f437f9c9c056", authMode: "api-key",
    status: "capacity", reason: "provider_quota_exhausted", cleanup: "destroyed" };
  const root = runRecord(explicitId, "claude", { kind: "agent", sandboxProvider: "cloudflare", authMode: "api-key",
    deadlineAt, status: "timed_out", reason: "run_timed_out", cleanup: "destroyed", strategy: "api-key-first-then-subscription", attempts: [attempt] });
  let run = { ...root, cleanup: "pending", attempts: [{ ...attempt, status: "running", reason: undefined, cleanup: "pending" }] };
  const event = { type: "state", cursor: 1, status: "timed_out" };
  const summary = { id: explicitId, kind: "agent", agent: "claude", sandboxProvider: "cloudflare", status: "timed_out", cleanup: "destroyed" };
  const url = await worker(t, (request, response) => {
    assert.equal(request.method, "GET");
    if (request.url === `/v1/runs/${explicitId}`) return json(response, 200, run);
    if (request.url === `/v1/runs/${explicitId}/result`) {
      return run.cleanup === "pending" ? json(response, 409, { error: "run_in_progress" }) : json(response, 200, run);
    }
    if (request.url === "/v4/runs") return json(response, 200, { runs: [summary], nextCursor: null });
    assert.equal(request.url, `/v4/runs/${explicitId}/events`);
    return json(response, 200, { id: explicitId, kind: "agent", agent: "claude", sandboxProvider: "cloudflare",
      events: [event], nextCursor: 1 });
  });
  assert.deepEqual(await invoke(url, ["status", explicitId]), { code: 0, output: JSON.parse(JSON.stringify(run)) });
  const waiting = await invoke(url, ["wait", explicitId, "--timeout-ms", "50"]);
  assert.equal(waiting.code, 5);
  assert.equal(waiting.output.error, "wait_timeout");
  run = root;
  const finished = await invoke(url, ["wait", explicitId], {}, true);
  assert.equal(finished.code, 5);
  assert.deepEqual(finished.output, run);
  assert.match(finished.stderr, /configured deadline/);
  assert.deepEqual((await invoke(url, ["list"])).output, { runs: [summary], nextCursor: null });
  assert.deepEqual((await invoke(url, ["events", explicitId])).output.events, [event]);
  run = { ...root, cleanup: "failed", attempts: [{ ...attempt, cleanup: "failed" }] };
  const failedCleanup = await invoke(url, ["result", explicitId], {}, true);
  assert.equal(failedCleanup.code, 1);
  assert.match(failedCleanup.stderr, /cleanup failed/);
});

test("a deadline publication remains running and reports a verified ref with timeout exit after readback", async t => {
  const repository = { slug: "fixture/private", sha: "a".repeat(40) };
  const deadlineAt = 1_795_000_000_000;
  const attempt = { operationId: "c839ca8c-9154-4ba3-807f-f437f9c9c056", authMode: "subscription",
    status: "succeeded", cleanup: "destroyed" };
  let run = runRecord(explicitId, "claude", { kind: "agent", sandboxProvider: "cloudflare", authMode: "subscription",
    deadlineAt, status: "running", cleanup: "destroyed", repository, publication: { status: "pending" },
    strategy: "subscription-only", attempts: [attempt] });
  const url = await worker(t, (request, response) => {
    assert.equal(request.method, "GET");
    const pending = request.url.endsWith("/result") && run.publication.status === "pending";
    json(response, pending ? 409 : 200, pending ? { error: "run_in_progress" } : run);
  });
  assert.deepEqual(await invoke(url, ["status", explicitId]), { code: 0, output: run });
  run = { ...run, status: "timed_out", reason: "run_timed_out", publication: { status: "published",
    branch: "sandbox-runner/" + explicitId, commitSha: "b".repeat(40), treeSha: "c".repeat(40) } };
  const result = await invoke(url, ["wait", explicitId], {}, true);
  assert.equal(result.code, 5);
  assert.deepEqual(result.output, run);
  run = { ...run, publication: { ...run.publication, branch: "other" } };
  const wrongBranch = await invoke(url, ["result", explicitId]);
  assert.equal(wrongBranch.output.error, "invalid_response");
});

test("review accepts a v4 deadline and retains the producer identity without a late verdict", async t => {
  const repository = { slug: "fixture/private", sha: "a".repeat(40) };
  const pending = runRecord(explicitId, "codex", { kind: "agent", sandboxProvider: "cloudflare", deadlineAt: 1_795_000_000_000,
    authMode: "api-key", repository, review: { producerAgent: "claude" } });
  const expired = { ...pending, status: "timed_out", reason: "run_timed_out", cleanup: "destroyed" };
  const url = await worker(t, async (request, response) => {
    if (request.method === "POST") {
      assert.equal(request.url, "/v4/runs");
      assert.deepEqual(await requestBody(request), { kind: "agent", agent: "codex", operationId: explicitId,
        prompt: "Check the SHA", repository, reviewProducer: "claude", timeoutMs: 10_000 });
      return json(response, 202, pending);
    }
    return json(response, 200, expired);
  });
  assert.deepEqual(await invoke(url, ["review", "--agent", "codex", "--producer-agent", "claude", "--repo", repository.slug,
    "--sha", repository.sha, "--operation-id", explicitId, "--run-timeout-ms", "10000", "Check the SHA"]), { code: 0, output: pending });
  const result = await invoke(url, ["wait", explicitId], {}, true);
  assert.equal(result.code, 5);
  assert.deepEqual(result.output, expired);
});

test("OpenCode review submits an exact SHA with qualified Responses settings and read-only connectors", async t => {
  const repository = { slug: "Owner/Repo", sha: "a".repeat(40) };
  const review = { producerAgent: "claude" };
  const connectorAccess = { mode: "read-only", connectors: ["acme-staging", "github"] };
  const base = runRecord(explicitId, "opencode", { kind: "agent", sandboxProvider: "cloudflare",
    authMode: "api-key", modelProvider: "openai", model: "gpt-6.1-sol", effort: "xhigh", repository, review, connectorAccess });
  const terminal = { ...base, status: "succeeded", cleanup: "destroyed", review: { ...review, verdict: "PASS", findings: [] } };
  let submission = base;
  let submitted = 0;
  const url = await worker(t, async (request, response) => {
    if (request.method === "POST") {
      assert.equal(request.url, "/v4/runs");
      assert.deepEqual(await requestBody(request), {
        kind: "agent", operationId: explicitId, agent: "opencode", modelProvider: "openai", model: "gpt-6.1-sol",
        effort: "xhigh", authMode: "api-key", repository, reviewProducer: "claude", connectors: connectorAccess.connectors,
        prompt: "fixture review",
      });
      submitted++;
      return json(response, 202, submission);
    }
    return json(response, 200, terminal);
  });
  const reviewArgs = ["review", "--agent", "opencode", "--producer-agent", "claude", "--repo", repository.slug,
    "--sha", repository.sha, "--mcp", "github", "--mcp", "acme-staging", "--operation-id", explicitId];
  for (const args of [[], ["--model-provider", "anthropic", "--model", "gpt-6.1-sol", "--effort", "xhigh"],
    ["--model-provider", "openai", "--model", "gpt-6.1-sol", "--effort", "high"]]) {
    assert.equal((await invoke(url, [...reviewArgs, ...args, "fixture review"])).output.error, "usage_error");
  }
  const args = [...reviewArgs, "--model-provider", "openai", "--model", "gpt-6.1-sol", "--effort", "xhigh"];
  for (const extra of [["--publish"], ["--auth", "subscription"]]) {
    assert.equal((await invoke(url, [...args, ...extra, "fixture review"])).output.error, "usage_error");
  }
  assert.equal(submitted, 0);
  assert.deepEqual(await invoke(url, [...args, "fixture review"]), { code: 0, output: base });
  assert.deepEqual(await invoke(url, ["result", explicitId]), { code: 0, output: terminal });
  submission = { ...base, connectorAccess: { ...connectorAccess, mode: "read-write" } };
  assert.equal((await invoke(url, [...args, "fixture review"])).output.error, "invalid_response");
});

test("an Access service token travels with every Worker request and a half-set one is refused", async t => {
  const seen = [];
  const url = await worker(t, async (request, response) => {
    seen.push([request.headers["cf-access-client-id"], request.headers["cf-access-client-secret"]]);
    return json(response, 200, { revision: null, config: null });
  });
  const access = { CLOUDFLARE_ACCESS_CLIENT_ID: "abc123.access", CLOUDFLARE_ACCESS_CLIENT_SECRET: "f".repeat(64) };
  assert.equal((await invoke(url, ["team", "catalog", "get"], access)).code, 0);
  assert.deepEqual(seen, [["abc123.access", "f".repeat(64)]]);
  const half = await invoke(url, ["team", "catalog", "get"], { CLOUDFLARE_ACCESS_CLIENT_ID: "abc123.access" });
  assert.equal(half.code, 3);
  assert.equal(half.output.error, "configuration_error");
  assert.equal(seen.length, 1);
});
