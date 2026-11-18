import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/sandbox-runner.mjs", import.meta.url));
const before = "76e62e5b-08f2-4ad3-81e7-5572727e6929";
const after = "7ee58852-e268-467c-9417-cd66bc0ec41b";
const operationId = "09e91564-e43a-4ec1-a4cb-f494a6bc5d62";
const binding = "SANDBOX_RUNNER_MCP_CREDENTIAL_ACME_WRITE";
const scope = "acme.read acme.write";
const connector = "acme-staging";
const runnerHost = "fixture-runner.fixture-account.workers.dev";
const spoofedHost = "fixture-runner.spoofed-account.workers.dev";
const customHost = "sandbox-runner.example.test";
const controlToken = "synthetic-recovery-control-token";
const syntheticRefresh = "synthetic-recovery-refresh-token";
const skipped = !["darwin", "linux"].includes(process.platform) || spawnSync("python3", ["-c", "import pty"]).status !== 0 ||
  spawnSync("openssl", ["version"]).status !== 0;

function send(response, status, data) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}

async function body(request) {
  let value = "";
  request.setEncoding("utf8");
  for await (const chunk of request) value += chunk;
  return value;
}

const driver = [
  "import errno, json, os, pty, signal, sys",
  "node, args, answer = sys.argv[1:]",
  "pid, fd = pty.fork()",
  "if pid == 0: os.execv(node, [node] + json.loads(args))",
  "data = b''",
  "answered = False",
  "signal.alarm(35)",
  "try:",
  "    while True:",
  "        try: chunk = os.read(fd, 65536)",
  "        except OSError as error:",
  "            if error.errno != errno.EIO: raise",
  "            break",
  "        if not chunk: break",
  "        data += chunk",
  "        if not answered and b'[y/N] ' in data:",
  "            os.write(fd, answer.encode() + b'\\n')",
  "            answered = True",
  "    _, status = os.waitpid(pid, 0)",
  "    print(json.dumps({'code': os.waitstatus_to_exitcode(status), 'transcript': data.decode()}))",
  "finally:",
  "    os.close(fd)",
].join("\n");

test("offers reconnect only on the verified active Worker and replays the exact request after browser consent",
  { skip: skipped }, async t => {
    const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-reconnect-"));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const tls = join(scratch, "tls.cnf");
    const key = join(scratch, "key.pem");
    const cert = join(scratch, "cert.pem");
    const state = join(scratch, "state.json");
    const routeChanged = join(scratch, "route-changed");
    const cf = join(scratch, "cf");
    const browser = join(scratch, "browser.mjs");
    await writeFile(tls, "[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ext\n" +
      "[dn]\nCN=localhost\n[ext]\n" +
      "subjectAltName=IP:127.0.0.1,DNS:" + [runnerHost, spoofedHost, customHost].join(",DNS:") +
      "\nbasicConstraints=critical,CA:TRUE\n");
    await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", tls, "-keyout", key, "-out", cert]);
    await writeFile(cf, `#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const args = process.argv.slice(2);
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, "a".repeat(32));
assert.equal(process.env.SANDBOX_RUNNER_TOKEN, undefined);
assert.ok(args.includes("fixture-runner"));
const { FIXTURE_STATE, FIXTURE_ROUTE_CHANGED, FIXTURE_RESOURCE, FIXTURE_INITIAL_VERSION } = process.env;
const id = fs.existsSync(FIXTURE_STATE) ? ${JSON.stringify(after)} : FIXTURE_INITIAL_VERSION;
const binding = ${JSON.stringify(binding)};
const output = body => console.log(JSON.stringify(body));
if (args[1] === "deployments") {
  output({ deployments: [{ versions: [{ version_id: id, percentage: 100 }] }] });
} else if (args[1] === "get") {
  assert.deepEqual(args, ["workers", "get", "fixture-runner", "-q"]);
  const enabled = !fs.existsSync(FIXTURE_ROUTE_CHANGED);
  output({ id: "b".repeat(32), name: "fixture-runner",
    subdomain: { enabled, url: ${JSON.stringify("https://" + runnerHost)} },
    references: { domains: enabled ? [{ hostname: ${JSON.stringify(customHost)} }] : [] },
  });
} else if (args[1] === "versions") {
  assert.equal(args[3], id);
  output({ id, bindings: [
    { type: "plain_text", name: "SANDBOX_RUNNER_MODE", text: "real" },
    { type: "secret_text", name: "SANDBOX_RUNNER_TOKEN" },
    { type: "secret_text", name: binding },
    { type: "plain_text", name: "SANDBOX_RUNNER_MCP_CONNECTORS", text: JSON.stringify({
      "acme-staging": { url: FIXTURE_RESOURCE, writeAuth: binding },
    }) },
  ] });
} else {
  assert.deepEqual(args.slice(0, 4), ["workers", "secrets", "update", binding]);
  const payload = JSON.parse(fs.readFileSync(args.at(-1).slice(1), "utf8"));
  assert.equal(payload.name, binding);
  const grant = JSON.parse(payload.text);
  assert.equal(grant.resource, FIXTURE_RESOURCE);
  assert.equal(grant.scope, ${JSON.stringify(scope)});
  assert.equal(grant.refreshToken, ${JSON.stringify(syntheticRefresh)});
  fs.writeFileSync(FIXTURE_STATE, JSON.stringify({ resource: grant.resource, scope: grant.scope }), { flag: "wx" });
  if (process.env.FIXTURE_UNCONFIRMED === "1") process.exit(1);
  output({ name: binding, type: "secret_text" });
}
`, { mode: 0o700 });
    await writeFile(browser, `
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
const runnerHosts = ${JSON.stringify([runnerHost, spoofedHost, customHost])};
const request = https.request;
https.request = (url, options, callback) => {
  if (!(url instanceof URL) || !runnerHosts.includes(url.hostname)) return request(url, options, callback);
  const local = new URL(url.pathname + url.search, process.env.FIXTURE_RESOURCE);
  return request(local, { ...options, servername: url.hostname, headers: { ...options.headers, host: url.host } }, callback);
};
const exec = childProcess.execFile;
childProcess.execFile = (command, args, options, callback) => {
  if (command !== "/usr/bin/open" && command !== "xdg-open") return exec(command, args, options, callback);
  const authorization = new URL(args[0]);
  assert.equal(authorization.searchParams.get("scope"), ${JSON.stringify(scope)});
  assert.equal(authorization.searchParams.get("resource"), process.env.FIXTURE_RESOURCE);
  const callbackUrl = new URL(authorization.searchParams.get("redirect_uri"));
  assert.equal(callbackUrl.hostname, "127.0.0.1");
  callbackUrl.searchParams.set("state", authorization.searchParams.get("state"));
  callbackUrl.searchParams.set("code", "synthetic-recovery-code");
  fetch(callbackUrl, { signal: options.signal }).then(async response => {
    await response.text();
    assert.equal(response.status, 200);
    callback(null, "", "");
  }).catch(callback);
};
syncBuiltinESMExports();
`);
    const submitted = [];
    const oauthRequests = [];
    let changeRouteAfterExchange = false;
    let origin;
    const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
      try {
        if (request.url === "/v4/runs") {
          assert.equal(request.headers.authorization, "Bearer " + controlToken);
          submitted.push(JSON.parse(await body(request)));
          const saved = await readFile(state, "utf8").catch(error => {
            if (error.code !== "ENOENT") throw error;
          });
          if (saved) return send(response, 202, { id: operationId, kind: "agent", agent: "claude",
            sandboxProvider: "cloudflare", status: "queued", cleanup: "pending",
            connectorAccess: { mode: "read-write", connectors: [connector] } });
          const code = "mcp_connector_reauth_required";
          return send(response, 503, { error: code, operationId, admission: "rejected",
            connectorIssue: { code, connector, mode: "read-write" }, reconnectScope: scope, workerVersionId: before });
        }
        oauthRequests.push(request.url);
        const resource = origin + "/mcp";
        if (request.url === "/.well-known/oauth-protected-resource/mcp") {
          return send(response, 200, { resource, authorization_servers: [origin] });
        }
        if (request.url === "/.well-known/oauth-authorization-server") {
          return send(response, 200, { issuer: origin, authorization_endpoint: origin + "/authorize",
            registration_endpoint: origin + "/register", token_endpoint: origin + "/token",
            code_challenge_methods_supported: ["S256"], response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"] });
        }
        if (request.url === "/register") return send(response, 201, { ...JSON.parse(await body(request)), client_id: "fixture-client" });
        assert.equal(request.url, "/token");
        assert.equal(new URLSearchParams(await body(request)).get("resource"), resource);
        if (changeRouteAfterExchange) await writeFile(routeChanged, "");
        return send(response, 200, { access_token: "synthetic-recovery-access-token", refresh_token: syntheticRefresh,
          token_type: "Bearer", expires_in: 3600, scope, resource });
      } catch {
        response.destroy();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    origin = "https://127.0.0.1:" + server.address().port;
    const args = [bin, "claude", "start", "--mcp", connector, "--operation-id", operationId, "Check ACME"];
    const invoke = async (version, answer, { unconfirmed = false, host = runnerHost } = {}) => {
      const { stdout } = await exec("python3", ["-c", driver, process.execPath, JSON.stringify(args), answer], {
        env: {
          PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ""), TERM: "dumb", SANDBOX_RUNNER_LANG: "en",
          SANDBOX_RUNNER_URL: "https://" + host, SANDBOX_RUNNER_TOKEN: controlToken,
          CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), SANDBOX_RUNNER_WORKER: "fixture-runner", SANDBOX_RUNNER_CF_BIN: cf,
          NODE_EXTRA_CA_CERTS: cert, NODE_OPTIONS: "--import=" + pathToFileURL(browser).href,
          FIXTURE_STATE: state, FIXTURE_ROUTE_CHANGED: routeChanged, FIXTURE_INITIAL_VERSION: version, FIXTURE_RESOURCE: origin + "/mcp",
          FIXTURE_UNCONFIRMED: unconfirmed ? "1" : "0",
        },
      });
      const result = JSON.parse(stdout);
      assert.ok(!result.transcript.includes(controlToken));
      assert.ok(!result.transcript.includes(syntheticRefresh));
      const lines = result.transcript.split(/\r?\n/u).filter(line => line.startsWith("{"));
      assert.equal(lines.length, 1, result.transcript);
      result.output = JSON.parse(lines[0]);
      return result;
    };
    const mismatch = await invoke(after, "y");
    assert.equal(mismatch.code, 3);
    assert.match(mismatch.transcript, /does not match the Worker/u);
    assert.doesNotMatch(mismatch.transcript, /\[y\/N\]/u);
    const spoofed = await invoke(before, "y", { host: spoofedHost });
    assert.equal(spoofed.code, 3);
    assert.match(spoofed.transcript, /did not confirm the Runner URL belongs to this Worker/u);
    assert.doesNotMatch(spoofed.transcript, /\[y\/N\]/u);
    const custom = await invoke(before, "y", { host: customHost });
    assert.equal(custom.code, 3);
    assert.equal(custom.output.recovery.action, "connector_login");
    assert.match(custom.transcript, /did not confirm the Runner URL belongs to this Worker/u);
    assert.doesNotMatch(custom.transcript, /\[y\/N\]/u);
    const declined = await invoke(before, "n");
    assert.equal(declined.code, 3);
    assert.match(declined.transcript, /\[y\/N\]/u);
    assert.deepEqual(oauthRequests, []);
    assert.equal(submitted.length, 4);
    changeRouteAfterExchange = true;
    const changedRoute = await invoke(before, "y");
    assert.equal(changedRoute.code, 3);
    assert.match(changedRoute.transcript, /did not confirm the Runner URL belongs to this Worker/u);
    await assert.rejects(readFile(state), { code: "ENOENT" });
    assert.equal(submitted.length, 5);
    changeRouteAfterExchange = false;
    await rm(routeChanged);
    oauthRequests.length = 0;
    const unconfirmed = await invoke(before, "y", { unconfirmed: true });
    assert.equal(unconfirmed.code, 6);
    assert.equal(unconfirmed.output.admission, "rejected");
    assert.equal(unconfirmed.output.recovery.action, "check_configuration");
    assert.match(unconfirmed.transcript, /Could not confirm the credential update/u);
    assert.doesNotMatch(unconfirmed.transcript, /connector login/u);
    assert.equal(submitted.length, 6);
    await rm(state);
    oauthRequests.length = 0;
    const approved = await invoke(before, "y");
    assert.equal(approved.code, 0);
    assert.equal(approved.output.id, operationId);
    assert.deepEqual(submitted, Array.from({ length: 8 }, () => submitted[0]));
    assert.deepEqual(JSON.parse(await readFile(state, "utf8")), { resource: origin + "/mcp", scope });
    assert.deepEqual(oauthRequests, ["/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server", "/register", "/token"]);
  });
