import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveAccessSettings } from "../worker/access-config.mjs";

const bin = fileURLToPath(new URL("../bin/sandbox-runner.mjs", import.meta.url));
const account = "0123456789abcdef0123456789abcdef";
const worker = "sandbox-runner-access-test";
const url = `https://${worker}.team-sub.workers.dev`;
const appId = "94dd2549-410c-4ea3-b904-21fbf30b69fa";
const otherApp = "11111111-2222-4333-8444-555555555555";
const aud = "4".repeat(64);
const tokenId = "7e3c1b0a-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const manifest = { schemaVersion: 1, cliVersion: "0.1.0", sdkCommit: "f".repeat(40), account, worker, profile: "default" };

/** A project directory and a fake cf that records calls and answers like the Access API. */
async function fixture(t, { plan = "ok", access, extra = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-runner-access-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "sandbox-runner.project.json"), JSON.stringify({ ...manifest, ...extra, ...(access ? { access } : {}) }, null, 2) + "\n");
  const executable = join(directory, "cf.mjs");
  const log = join(directory, "calls.jsonl");
  const script = `#!${process.execPath}\n` + String.raw`
import * as fs from "node:fs";
const { plan, log, account, worker, appId, otherApp, aud, tokenId } = FIXTURE;
const args = process.argv.slice(2);
if (args[0] === "--profile") args.splice(0, 2);
fs.appendFileSync(log, JSON.stringify({ args }) + "\n");
const send = value => console.log(JSON.stringify(value));
const command = args.slice(0, 4).join(" ");
const body = () => JSON.parse(args[args.indexOf("--body") + 1]);
if (args.join(" ") === "accounts get") send({ id: account });
else if (args.join(" ") === "zero-trust organization get") {
  if (plan === "no-organization") { console.error("not found"); process.exitCode = 1; }
  else send({ auth_domain: "team.cloudflareaccess.com", strict_service_token_auth: plan !== "lenient-tokens" });
} else if (command === "zero-trust access applications list") {
  if (plan === "list-fails") { console.error("temporarily unavailable"); process.exitCode = 1; }
  else {
    const domain = worker + ".team-sub.workers.dev/mcp";
    const ours = { id: appId, aud: plan === "foreign-aud" ? "9".repeat(64) : aud, domain, name: "Sandbox Runner MCP (" + worker + ")",
      self_hosted_domains: [domain], destinations: [{ type: "public", uri: domain }],
      allowed_idps: ["verified-idp"], policies: [{ id: "p-managed", name: "Sandbox Runner MCP members (" + worker + ")" }, { id: "p-extra", name: "Require MFA", precedence: 2 }],
      oauth_configuration: { enabled: true, grant: { session_duration: "1h" } } };
    const apps = [{ id: "unrelated", domain: "elsewhere.example.com" }];
    if (plan === "taken") apps.push({ id: otherApp, domain });
    if (["update", "status", "foreign-aud", "adopt"].includes(plan)) apps.push(ours);
    console.log('result_info: {"page":1}');
    send(apps);
  }
} else if (command === "zero-trust access applications create") {
  if (plan === "write-lost") { console.error("connection reset"); process.exitCode = 1; }
  else send({ ...body(), id: appId, aud });
} else if (command === "zero-trust access applications update") send({ ...body(), id: args[4], aud });
else if (command === "zero-trust access applications delete") send({ id: args[4] });
else if (command === "zero-trust access service-tokens list") {
  console.log('result_info: {"page":1}');
  send(["token-taken", "status", "token-adopt"].includes(plan)
    ? [{ id: tokenId, name: "Sandbox Runner clients (" + worker + ")", client_id: "abc123.access", expires_at: "2027-11-18T00:00:00Z" }] : []);
} else if (command === "zero-trust access service-tokens create") {
  send({ id: tokenId, name: body().name, client_id: "abc123.access", client_secret: "s".repeat(64), expires_at: "2027-11-18T00:00:00Z" });
} else if (command === "zero-trust access service-tokens get") send({ id: args[4], expires_at: "2027-11-18T00:00:00Z" });
else if (command === "zero-trust access service-tokens delete") send({ id: args[4] });
else { console.error("Unexpected Cloudflare command " + args.join(" ")); process.exitCode = 2; }
`;
  await writeFile(executable, script.replace("FIXTURE", JSON.stringify({ plan, log, account, worker, appId, otherApp, aud, tokenId })), { mode: 0o700 });
  return {
    directory,
    run(args) {
      const result = spawnSync(process.execPath, [bin, "cloudflare", "access", ...args], { encoding: "utf8",
        env: { ...process.env, SANDBOX_RUNNER_CF_BIN: executable, SANDBOX_RUNNER_TIMEOUT_MS: "10000" } });
      assert.ifError(result.error);
      return { status: result.status, output: result.stdout ? JSON.parse(result.stdout) : undefined, stderr: result.stderr };
    },
    async calls() {
      return existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line).args) : [];
    },
    async manifest() {
      return JSON.parse(await readFile(join(directory, "sandbox-runner.project.json"), "utf8"));
    },
  };
}

test("enable creates a path-scoped Access application with managed OAuth and records it", async t => {
  const project = await fixture(t);
  const { status, output } = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com", "--email", "ana@example.com",
    "--scope", "mcp"]);
  assert.equal(status, 0);
  assert.equal(output.status, "enabled");
  assert.equal(output.action, "created");
  assert.equal(output.mcpUrl, `${url}/mcp`);
  const create = (await project.calls()).find(args => args[3] === "create");
  const body = JSON.parse(create[create.indexOf("--body") + 1]);
  assert.equal(body.domain, `${worker}.team-sub.workers.dev/mcp`);
  assert.deepEqual(body.policies[0].include, [{ email: { email: "member@example.com" } }, { email: { email: "ana@example.com" } }]);
  assert.equal(body.oauth_configuration.enabled, true);
  assert.deepEqual(body.oauth_configuration.dynamic_client_registration,
    { enabled: true, allowed_uris: ["https://chatgpt.com/*", "https://claude.ai/*"], allow_any_on_localhost: true, allow_any_on_loopback: true });
  assert.deepEqual((await project.manifest()).access, { appId, aud, teamDomain: "https://team.cloudflareaccess.com", mcpUrl: `${url}/mcp`, scope: "mcp" });
});

test("--web-clients-only refuses loopback redirects for native clients", async t => {
  const project = await fixture(t);
  const { status } = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com", "--web-clients-only"]);
  assert.equal(status, 0);
  const create = (await project.calls()).find(args => args[3] === "create");
  const registration = JSON.parse(create[create.indexOf("--body") + 1]).oauth_configuration.dynamic_client_registration;
  assert.equal(registration.allow_any_on_localhost, false);
  assert.equal(registration.allow_any_on_loopback, false);
  assert.equal(project.run(["status", project.directory, "--web-clients-only"]).status, 2);
});

test("the recorded settings reach the Worker build", async t => {
  const project = await fixture(t);
  project.run(["enable", project.directory, "--url", url, "--email", "member@example.com"]);
  const text = await readFile(join(project.directory, "sandbox-runner.project.json"), "utf8");
  assert.deepEqual(resolveAccessSettings({}, text), { aud, teamDomain: "https://team.cloudflareaccess.com" });
  assert.deepEqual(resolveAccessSettings({ SANDBOX_RUNNER_ACCESS_AUD: "5".repeat(64), SANDBOX_RUNNER_ACCESS_TEAM_DOMAIN: "https://x.cloudflareaccess.com" }, text),
    { aud: "5".repeat(64), teamDomain: "https://x.cloudflareaccess.com" }, "explicit environment wins");
  assert.equal(resolveAccessSettings({}, JSON.stringify(manifest)), undefined, "no access block, no endpoint");
  assert.throws(() => resolveAccessSettings({ SANDBOX_RUNNER_ACCESS_AUD: aud }, undefined), /together/);
  assert.throws(() => resolveAccessSettings({}, JSON.stringify({ ...manifest, access: { aud: "bad" } })), /invalid Access settings/);
});

test("enable updates the recorded application instead of creating another", async t => {
  const project = await fixture(t, { plan: "update", access: { appId, aud, teamDomain: "https://team.cloudflareaccess.com", mcpUrl: `${url}/mcp` } });
  const { status, output } = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com", "--redirect-uri", "https://claude.ai/*",
    "--scope", "mcp"]);
  assert.equal(status, 0);
  assert.equal(output.action, "updated");
  const calls = await project.calls();
  assert(!calls.some(args => args[3] === "create"));
  const update = calls.find(args => args[3] === "update");
  assert.equal(update[4], appId);
  const sent = JSON.parse(update[update.indexOf("--body") + 1]);
  assert.deepEqual(sent.oauth_configuration.dynamic_client_registration.allowed_uris, ["https://claude.ai/*"]);
  assert.deepEqual(sent.allowed_idps, ["verified-idp"], "settings made by hand survive");
  assert.deepEqual(sent.policies.slice(1), [{ id: "p-extra", precedence: 2 }], "other policies survive");
  assert.equal(sent.policies.length, 2, "the managed policy is replaced, not duplicated");
});

test("enable adopts an application it created but could not record", async t => {
  const project = await fixture(t, { plan: "adopt" });
  const { status, output } = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com", "--scope", "mcp"]);
  assert.equal(status, 0);
  assert.equal(output.action, "updated");
  assert.equal((await project.manifest()).access.appId, appId);
  assert(!(await project.calls()).some(args => args[3] === "create"));
});

test("a lost write is reported as uncertain and leaves the manifest alone", async t => {
  const project = await fixture(t, { plan: "write-lost" });
  const { status, output } = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com"]);
  assert.notEqual(status, 0);
  assert.equal(output.error, "cloudflare_access_unconfirmed");
  assert.equal(output.uncertain, true);
  assert.equal((await project.manifest()).access, undefined);
});

test("enable refuses to take over a path another Access application protects", async t => {
  const project = await fixture(t, { plan: "taken" });
  const { status, output } = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com", "--scope", "mcp"]);
  assert.notEqual(status, 0);
  assert.equal(output.error, "cloudflare_access_conflict");
  assert(!(await project.calls()).some(args => ["create", "update"].includes(args[3])));
  assert.equal((await project.manifest()).access, undefined);
});

test("enable validates its inputs before calling Cloudflare", async t => {
  const project = await fixture(t);
  for (const args of [
    ["--url", "https://other-worker.team-sub.workers.dev", "--email", "member@example.com"],
    ["--url", `${url}/mcp`, "--email", "member@example.com"],
    ["--url", url, "--email", "Member@Example.com"],
    ["--url", url, "--email", "member@example.com", "--redirect-uri", "http://chatgpt.com/*"],
    ["--url", url, "--email", "member@example.com", "--redirect-uri", "https://chatgpt.co*"],
    ["--url", url, "--email", "member@example.com", "--redirect-uri", "https://chatgpt.com/cb*"],
    ["--url", url, "--email", "member@example.com", "--redirect-uri", "https://a.com/x?*"],
    ["--url", `https://${worker}.team-sub.workers.dev:8443`, "--email", "member@example.com"],
    ["--url", url],
  ]) {
    assert.notEqual(project.run(["enable", project.directory, ...args]).status, 0, args.join(" "));
  }
  assert.deepEqual(await project.calls(), []);
});

test("enable stops when the account has no Zero Trust organization", async t => {
  const project = await fixture(t, { plan: "no-organization" });
  const { status, output } = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com"]);
  assert.notEqual(status, 0);
  assert.equal(output.error, "cloudflare_access_organization_missing");
});

test("dry run shows the application without writing anything", async t => {
  const project = await fixture(t);
  const { status, output } = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com", "--dry-run", "--scope", "mcp"]);
  assert.equal(status, 0);
  assert.equal(output.status, "dry_run");
  assert.equal(output.application.domain, `${worker}.team-sub.workers.dev/mcp`);
  assert(!(await project.calls()).some(args => ["create", "update", "delete"].includes(args[3])));
  assert.equal((await project.manifest()).access, undefined);
});

test("status reports the recorded application and disable removes it", async t => {
  const access = { appId, aud, teamDomain: "https://team.cloudflareaccess.com", mcpUrl: `${url}/mcp` };
  const project = await fixture(t, { plan: "status", access });
  const status = project.run(["status", project.directory]);
  assert.equal(status.output.status, "enabled");
  assert.equal(status.output.oauth, true);
  const disabled = project.run(["disable", project.directory]);
  assert.equal(disabled.output.status, "disabled");
  assert.equal(disabled.output.changed, true);
  const remove = (await project.calls()).find(args => args[3] === "delete");
  assert.deepEqual(remove.slice(4), [appId, "--force"]);
  assert.equal((await project.manifest()).access, undefined);
  assert.equal((await project.manifest()).worker, worker, "the rest of the manifest is kept");
});

test("disable changes nothing when Cloudflare cannot confirm the application", async t => {
  const access = { appId, aud, teamDomain: "https://team.cloudflareaccess.com", mcpUrl: `${url}/mcp` };
  const failing = await fixture(t, { plan: "list-fails", access });
  assert.notEqual(failing.run(["disable", failing.directory]).status, 0);
  assert.deepEqual((await failing.manifest()).access, access, "a transient failure keeps the record");
  const foreign = await fixture(t, { plan: "foreign-aud", access });
  const refused = foreign.run(["disable", foreign.directory]);
  assert.equal(refused.output.error, "cloudflare_access_conflict");
  assert(!(await foreign.calls()).some(args => args[3] === "delete"), "an application that is not this project's is never deleted");
});

test("scope host puts the whole workers.dev host behind Access and keeps the MCP URL", async t => {
  const project = await fixture(t);
  const { status, output } = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com", "--scope", "host"]);
  assert.equal(status, 0);
  assert.equal(output.scope, "host");
  assert.equal(output.mcpUrl, `${url}/mcp`);
  const create = (await project.calls()).find(args => args[3] === "create");
  assert.equal(JSON.parse(create[create.indexOf("--body") + 1]).domain, `${worker}.team-sub.workers.dev`);
  assert.deepEqual((await project.manifest()).access, { appId, aud, teamDomain: "https://team.cloudflareaccess.com", mcpUrl: `${url}/mcp`, scope: "host" });
  assert.notEqual(project.run(["enable", project.directory, "--url", url, "--email", "member@example.com", "--scope", "all"]).status, 0);
});

test("the whole host is the default scope, and a service token admits machine clients", async t => {
  const project = await fixture(t);
  const tokenFile = join(project.directory, "access-client.env");
  const { status, output } = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com",
    "--service-token-file", tokenFile]);
  assert.equal(status, 0, JSON.stringify(output));
  assert.equal(output.scope, "host");
  assert.equal(output.serviceTokenId, tokenId);
  assert(!JSON.stringify(output).includes("s".repeat(64)), "the secret never reaches the output");
  assert.equal(await readFile(tokenFile, "utf8"),
    `CLOUDFLARE_ACCESS_CLIENT_ID=abc123.access\nCLOUDFLARE_ACCESS_CLIENT_SECRET=${"s".repeat(64)}\n`);
  assert.equal((await import("node:fs")).statSync(tokenFile).mode & 0o777, 0o600);
  const create = (await project.calls()).find(args => args[2] === "applications" && args[3] === "create");
  const body = JSON.parse(create[create.indexOf("--body") + 1]);
  assert.equal(body.domain, `${worker}.team-sub.workers.dev`);
  assert.deepEqual(body.policies[1], { name: `Sandbox Runner clients (${worker})`, decision: "non_identity",
    include: [{ service_token: { token_id: tokenId } }] });
  assert.equal((await project.manifest()).access.serviceTokenId, tokenId);
  // A rerun keeps the recorded token without creating another.
  const again = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com"]);
  assert.equal(again.status, 0, JSON.stringify(again.output));
  assert.equal((await project.calls()).filter(args => args[2] === "service-tokens" && args[3] === "create").length, 1);
});

test("the service token is refused for path scope, an existing file, or an unrecorded token of the same name", async t => {
  const project = await fixture(t);
  const tokenFile = join(project.directory, "access-client.env");
  assert.equal(project.run(["enable", project.directory, "--url", url, "--email", "member@example.com", "--scope", "mcp",
    "--service-token-file", tokenFile]).output.error, "cloudflare_access_service_token_scope");
  await writeFile(tokenFile, "keep me\n");
  assert.equal(project.run(["enable", project.directory, "--url", url, "--email", "member@example.com",
    "--service-token-file", tokenFile]).output.error, "cloudflare_access_service_token_file_exists");
  assert.equal(await readFile(tokenFile, "utf8"), "keep me\n");
  const taken = await fixture(t, { plan: "token-taken" });
  assert.equal(taken.run(["enable", taken.directory, "--url", url, "--email", "member@example.com",
    "--service-token-file", join(taken.directory, "new.env")]).output.error, "cloudflare_access_conflict");
  assert(!(await taken.calls()).some(args => args[3] === "create"));
});

test("status reports the service token's expiry and disable deletes the token with the application", async t => {
  const project = await fixture(t, { plan: "status", access: { appId, aud, teamDomain: "https://team.cloudflareaccess.com",
    mcpUrl: `${url}/mcp`, scope: "mcp", serviceTokenId: tokenId } });
  const status = project.run(["status", project.directory]);
  assert.deepEqual(status.output.serviceToken, { id: tokenId, expiresAt: "2027-11-18T00:00:00Z" });
  const disabled = project.run(["disable", project.directory]);
  assert.equal(disabled.status, 0, JSON.stringify(disabled.output));
  assert((await project.calls()).some(args => args.slice(0, 5).join(" ") === `zero-trust access service-tokens delete ${tokenId}`));
});

test("a rerun adopts the token a lost application write left behind, from its credentials file", async t => {
  const project = await fixture(t, { plan: "token-adopt" });
  const tokenFile = join(project.directory, "access-client.env");
  await writeFile(tokenFile, `CLOUDFLARE_ACCESS_CLIENT_ID=abc123.access\nCLOUDFLARE_ACCESS_CLIENT_SECRET=${"s".repeat(64)}\n`, { mode: 0o600 });
  const { status, output } = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com",
    "--service-token-file", tokenFile]);
  assert.equal(status, 0, JSON.stringify(output));
  assert.equal(output.serviceTokenId, tokenId);
  assert(!(await project.calls()).some(args => args[2] === "service-tokens" && args[3] === "create"));
  assert.equal((await project.manifest()).access.serviceTokenId, tokenId);
});

test("a token that cannot get its file is never created", async t => {
  const project = await fixture(t);
  const result = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com",
    "--service-token-file", join(project.directory, "missing-dir", "access-client.env")]);
  assert.equal(result.output.error, "cloudflare_access_service_token_file_exists");
  assert(!(await project.calls()).some(args => args[2] === "service-tokens" && args[3] === "create"));
});

test("a rerun keeps a recorded path scope, and disable finishes when the token is already gone", async t => {
  const recorded = { appId, aud, teamDomain: "https://team.cloudflareaccess.com", mcpUrl: `${url}/mcp`, scope: "mcp" };
  const project = await fixture(t, { plan: "update", access: recorded });
  const rerun = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com"]);
  assert.equal(rerun.status, 0, JSON.stringify(rerun.output));
  assert.equal(rerun.output.scope, "mcp");
  const gone = await fixture(t, { plan: "status", access: { ...recorded, serviceTokenId: "00000000-1111-4222-8333-444444444444" } });
  const disabled = gone.run(["disable", gone.directory]);
  assert.equal(disabled.status, 0, JSON.stringify(disabled.output));
  assert(!(await gone.calls()).some(args => args[3] === "delete" && args[2] === "service-tokens"));
});

test("a rerun with --scope host widens the recorded application in place", async t => {
  const recorded = { appId, aud, teamDomain: "https://team.cloudflareaccess.com", mcpUrl: `${url}/mcp`, scope: "mcp" };
  const project = await fixture(t, { plan: "update", access: recorded });
  const { status, output } = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com", "--scope", "host"]);
  assert.equal(status, 0, JSON.stringify(output));
  assert.equal(output.action, "updated");
  assert.equal(output.appId, appId);
  const update = (await project.calls()).find(args => args[2] === "applications" && args[3] === "update");
  const sent = JSON.parse(update[update.indexOf("--body") + 1]);
  assert.equal(sent.domain, `${worker}.team-sub.workers.dev`);
  assert.equal(sent.destinations, undefined, "the old /mcp destination is not sent with the new domain");
  assert.equal(sent.self_hosted_domains, undefined);
  assert.equal((await project.manifest()).access.scope, "host");
});

test("a service token can be bound to client addresses, which reruns keep and replace", async t => {
  const project = await fixture(t);
  const tokenFile = join(project.directory, "access-client.env");
  const first = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com", "--service-token-file", tokenFile,
    "--service-token-ip", "203.0.113.7", "--service-token-ip", "2001:DB8::1/128"]);
  assert.equal(first.status, 0, JSON.stringify(first.output));
  assert.deepEqual(first.output.serviceTokenIps, ["203.0.113.7/32", "2001:db8::1/128"]);
  const create = (await project.calls()).find(args => args[2] === "applications" && args[3] === "create");
  const policies = JSON.parse(create[create.indexOf("--body") + 1]).policies.slice(1);
  assert.deepEqual(policies.map(policy => policy.require), [[{ ip: { ip: "203.0.113.7/32" } }], [{ ip: { ip: "2001:db8::1/128" } }]]);
  assert(policies.every(policy => policy.decision === "non_identity" && policy.include[0].service_token.token_id === tokenId));
  assert.deepEqual((await project.manifest()).access.serviceTokenIps, ["203.0.113.7/32", "2001:db8::1/128"]);
  for (const ip of ["203.0.113.7/33", "not-an-ip", "fe80::1%en0", "0.0.0.0/0", "::/0", "203.0.113.7/24", "::ffff:203.0.113.7"]) {
    assert.equal(project.run(["enable", project.directory, "--url", url, "--email", "member@example.com", "--service-token-ip", ip]).output.error,
      "cloudflare_access_ip_invalid");
  }
  const bare = await fixture(t);
  assert.equal(bare.run(["enable", bare.directory, "--url", url, "--email", "member@example.com", "--service-token-ip", "203.0.113.7"]).output.error,
    "cloudflare_access_service_token_missing");
});

test("address binding needs strict service token authentication, and CIDRs normalize", async t => {
  const lenient = await fixture(t, { plan: "lenient-tokens" });
  const refused = lenient.run(["enable", lenient.directory, "--url", url, "--email", "member@example.com",
    "--service-token-file", join(lenient.directory, "access-client.env"), "--service-token-ip", "203.0.113.7"]);
  assert.equal(refused.output.error, "cloudflare_access_strict_service_tokens_off");
  assert(!(await lenient.calls()).some(args => args[3] === "create"));
  const project = await fixture(t);
  const ok = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com",
    "--service-token-file", join(project.directory, "access-client.env"), "--service-token-ip", "203.0.113.0/24",
    "--service-token-ip", "2001:db8:1:2000::2504", "--service-token-ip", "2001:DB8:0:0::/64"]);
  assert.equal(ok.status, 0, JSON.stringify(ok.output));
  assert.deepEqual(ok.output.serviceTokenIps, ["203.0.113.0/24", "2001:db8:1:2000::2504/128", "2001:db8::/64"]);
});

test("a custom domain becomes the published entrance, and one application protects both addresses", async t => {
  const project = await fixture(t, { extra: { domain: "sandbox-runner.example.com" } });
  const { status, output } = project.run(["enable", project.directory, "--url", url, "--email", "member@example.com"]);
  assert.equal(status, 0);
  assert.equal(output.mcpUrl, "https://sandbox-runner.example.com/mcp");
  const create = (await project.calls()).find(args => args[3] === "create");
  const body = JSON.parse(create[create.indexOf("--body") + 1]);
  assert.equal(body.domain, "sandbox-runner.example.com");
  assert.deepEqual(body.destinations, [{ type: "public", uri: "sandbox-runner.example.com" }, { type: "public", uri: `${worker}.team-sub.workers.dev` }]);
  assert.equal((await project.manifest()).access.mcpUrl, "https://sandbox-runner.example.com/mcp");
  const invalid = await fixture(t, { extra: { domain: "Not_A_Domain" } });
  assert.equal(invalid.run(["enable", invalid.directory, "--url", url, "--email", "member@example.com"]).output.error, "cloudflare_project_invalid");
});
