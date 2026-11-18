import { githubFixtureData } from "./github-fixture-data.ts";
import { object } from "./github-auth.ts";
import type { AuthMode } from "./contract.ts";
import { stream } from "./fixtures.ts";

const toolId = "toolu_checkout_witness";
const publicationWitness = "publication fixture edits verified";
const codexCallId = "call_fixture_publication";
const publicationSource = `
import { accessSync, chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
const status = readFileSync("/proc/self/status", "utf8");
if (process.getuid() !== 10001 || process.getgid() !== 10001 || process.cwd() !== "/workspace" ||
    !process.getgroups().every(group => group === 10001) ||
    !/^NoNewPrivs:\\s*1$/m.test(status) || !/^CapEff:\\s*0+$/m.test(status) ||
    !/^CapPrm:\\s*0+$/m.test(status) || !/^CapAmb:\\s*0+$/m.test(status)) process.exit(2);
try { accessSync("/run/sandbox-runner/github-publication.json"); process.exit(3); }
catch (error) { if (error.code !== "EACCES") process.exit(4); }
try { process.setuid(0); process.exit(5); } catch {}
if (readFileSync("witness.txt", "utf8") !== "sandbox-runner fixture base\\n") process.exit(6);
writeFileSync("witness.txt", "sandbox-runner publication fixture\\n");
chmodSync("witness.txt", 0o755);
unlinkSync(".gitattributes");
writeFileSync("created.txt", "new synthetic publication file\\n");
console.log("${publicationWitness}");
`;
const dnsFailures = ["ENOTFOUND", "ENODATA", "EREFUSED", "ESERVFAIL", "ECONNREFUSED", "ETIMEOUT"];
const tlsFailures = ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EACCES", "ETIMEDOUT",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_UNEXPECTED_EOF_WHILE_READING"];
const witnessSource = (timeout: number) => `
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Resolver } from "node:dns";
import { request } from "node:https";
import { connect } from "node:tls";
const status = readFileSync("/proc/self/status", "utf8");
const caPath = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const timeout = ${timeout};
function caps(name) {
  return new RegExp("^" + name + ":\\\\s*([a-f0-9]+)$", "m").exec(status)?.[1] ?? null;
}
function writable(path) {
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
}
function networkError(error, known) {
  return known.includes(error?.code) ? error.code : "error";
}
function dnsProbe() {
  return new Promise(resolve => {
    const resolver = new Resolver();
    const timer = setTimeout(() => { resolve("ETIMEOUT"); resolver.cancel(); }, timeout);
    resolver.resolve4("example.com", error => {
      clearTimeout(timer);
      resolve(error ? networkError(error, ${JSON.stringify(dnsFailures)}) : "resolved");
    });
  });
}
function ipProbe() {
  return new Promise(resolve => {
    const socket = connect({ host: "1.1.1.1", port: 443 });
    let directTcpConnected = false;
    function finish(directIpTls) {
      const peer = socket.getPeerCertificate();
      const directIpPeerPresented = !!peer && Object.keys(peer).length !== 0;
      socket.destroy();
      resolve({ directIpTls, directTcpConnected, directIpPeerPresented });
    }
    socket.setTimeout(timeout);
    socket.once("connect", () => { directTcpConnected = true; });
    socket.once("secureConnect", () => finish("connected"));
    socket.once("timeout", () => finish("ETIMEDOUT"));
    socket.once("error", error => finish(networkError(error, ${JSON.stringify(tlsFailures)})));
  });
}
function gitProbe(path, method) {
  return new Promise(resolve => {
    const post = method === "POST";
    const req = request("https://github.harness.internal" + path, {
      method, ca: readFileSync(caPath), signal: AbortSignal.timeout(timeout),
      ...(post ? { headers: { "content-type": "application/x-git-receive-pack-request" } } : {}),
    }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.once("error", () => resolve(null));
    req.end(post ? "0000" : undefined);
  });
}
const [directDns, directIp, receivePackStatus, otherRepositoryStatus] = await Promise.all([
  dnsProbe(), ipProbe(), gitProbe("/fixture/private.git/git-receive-pack", "POST"),
  gitProbe("/fixture/not-admitted.git/info/refs?service=git-upload-pack", "GET"),
]);
const proof = {
  sha: execFileSync("/usr/bin/git", ["rev-parse", "--verify", "HEAD"], {encoding:"utf8"}).trim(),
  cwd: process.cwd() === "/workspace",
  witness: readFileSync("witness.txt", "utf8") === "sandbox-runner fixture base\\n",
  submoduleNotInitialized: existsSync(".gitmodules") && !existsSync(".git/modules/sub") && !existsSync("sub/.git"),
  filterUnexecuted: readFileSync(".gitattributes", "utf8").includes("filter=must-not-execute"),
  hookUnexecuted: existsSync(".githooks/post-checkout") && !existsSync("hook-must-not-execute"),
  secretsAbsent: ["GITHUB_APP_PRIVATE_KEY","SANDBOX_RUNNER_GITHUB_ALLOWLIST","SANDBOX_RUNNER_TOKEN","GH_TOKEN","GITHUB_TOKEN"]
    .every(name => !Object.hasOwn(process.env, name)),
  uid: process.getuid(), gid: process.getgid(),
  capEff: caps("CapEff"), capPrm: caps("CapPrm"), capAmb: caps("CapAmb"),
  binaryWritable: writable("/usr/local/bin/sandbox-runner-checkout"),
  caWritable: writable(caPath),
  rootRegained: false,
  directDns, ...directIp, receivePackStatus, otherRepositoryStatus,
};
try { process.setuid(0); proof.rootRegained = process.getuid() === 0; } catch {}
console.log(JSON.stringify(proof));
`;

function fixtureTurn(content: { text: string } | { command: string }): Response {
  const tool = "command" in content;
  const events = [
    { type: "message_start", message: {
      id: tool ? "msg_fixture_checkout_tool" : "msg_fixture_checkout_done",
      type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
    } },
    { type: "content_block_start", index: 0, content_block: tool
      ? { type: "tool_use", id: toolId, name: "Bash", input: {} }
      : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool
      ? { type: "input_json_delta", partial_json: JSON.stringify({ command: content.command }) }
      : { type: "text_delta", text: content.text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n").join(""),
    { headers: { "content-type": "text/event-stream", "request-id": "req_checkout_fixture" } });
}

export async function githubCodexPublicationFixture(body: BodyInit | null | undefined, authMode: AuthMode): Promise<Response> {
  const payload = object(await new Response(body).json().catch(() => undefined));
  const input = Array.isArray(payload?.input) ? payload.input : [];
  const result = input.map(object).find(item => item?.type === "function_call_output" && item.call_id === codexCallId);
  const tools = Array.isArray(payload?.tools) ? payload.tools.map(object) : [];
  const shell = ["shell_command", "exec_command"].find(name =>
    tools.some(tool => tool?.type === "function" && tool.name === name));
  const command = "/usr/local/bin/node --input-type=module --eval '" + publicationSource + "'";
  const output = typeof result?.output === "string" ? result.output :
    Array.isArray(result?.output) ? result.output.map(item => object(item)?.text ?? "").join("\n") : "";
  const text = output.split(/\r?\n/u).includes(publicationWitness)
    ? publicationWitness : "publication fixture witness invalid";
  const item = !result && shell ? {
    type: "function_call", id: "fc_fixture_publication", call_id: codexCallId, name: shell, status: "completed",
    arguments: JSON.stringify({ [shell === "exec_command" ? "cmd" : "command"]: command, workdir: "/workspace" }),
  } : {
    type: "message", id: "msg_fixture_publication", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: result ? text : "publication fixture tool unavailable", annotations: [] }],
  };
  const response = {
    id: item.type === "function_call" ? "resp_fixture_publication_tool" : "resp_fixture_publication_done",
    object: "response", created_at: 0, model: authMode === "subscription" ? "gpt-6.1-sol" : "gpt-5.1",
    status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const initial = item.type === "function_call"
    ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", response_id: response.id, output_index: 0, item: initial },
    { type: "response.output_item.done", response_id: response.id, output_index: 0, item },
    { type: "response.completed", response },
  ];
  return stream(events.map((event, sequence_number) => ({ ...event, sequence_number })), "req_fixture_codex_publication");
}

/** Parse the agent's synthetic tool response only inside the fixture upstream. */
export async function githubAgentFixture(
  body: BodyInit | null | undefined, timeoutMs: string, mode: "checkout" | "review" | "publication" = "checkout",
): Promise<Response> {
  const payload = object(await new Response(body).json().catch(() => undefined));
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const blocks = messages.flatMap(message => Array.isArray(object(message)?.content) ? message.content : []);
  const result = blocks.map(object).find(block => block?.type === "tool_result" && block.tool_use_id === toolId);
  if (!result) {
    const hasBash = Array.isArray(payload?.tools) && payload.tools.some(tool => object(tool)?.name === "Bash");
    if (!hasBash) return fixtureTurn({ text: "checkout fixture tool unavailable" });
    const source = mode === "publication" ? publicationSource : witnessSource(Number(timeoutMs));
    return fixtureTurn({ command: "/usr/local/bin/node --input-type=module --eval '" + source + "'" });
  }

  const text = typeof result.content === "string" ? result.content
    : Array.isArray(result.content) ? result.content.map(item => object(item)?.text ?? "").join("\n") : "";
  if (mode === "publication") {
    return fixtureTurn({ text: !result.is_error && text.trim() === publicationWitness
      ? publicationWitness : "publication fixture witness invalid" });
  }
  let proof: Record<string, unknown> | undefined;
  try {
    proof = object(JSON.parse(text.trim()));
  } catch {
    return fixtureTurn({ text: "checkout fixture witness invalid" });
  }
  if (result.is_error || proof?.sha !== githubFixtureData.sha || proof.cwd !== true || proof.witness !== true ||
      proof.submoduleNotInitialized !== true || proof.filterUnexecuted !== true || proof.hookUnexecuted !== true ||
      proof.secretsAbsent !== true || proof.uid !== 10001 || proof.gid !== 10001) {
    return fixtureTurn({ text: "checkout fixture workspace mismatch" });
  }
  const cap = (value: unknown) => typeof value === "string" && /^[a-f0-9]+$/.test(value) ? value : null;
  const code = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value : null;
  if (mode === "review") {
    const denied = proof.receivePackStatus === 403 && proof.otherRepositoryStatus === 403 && proof.secretsAbsent === true;
    return fixtureTurn({ text: JSON.stringify({
      verdict: denied ? "PASS" : "FAIL",
      findings: [denied ? "Verified the exact SHA. GitHub push and another repository both returned HTTP 403."
        : "The reviewer did not observe the expected read-only GitHub permissions."],
    }) });
  }
  const verdict = (value: unknown, known: string[]) => typeof value === "string" && known.includes(value) ? value : "error";
  return fixtureTurn({ text: JSON.stringify({
    sha: proof.sha, cwd: true, witness: true, submoduleNotInitialized: true,
    filterUnexecuted: true, hookUnexecuted: true, secretsAbsent: true,
    uid: proof.uid, gid: proof.gid, capEff: cap(proof.capEff), capPrm: cap(proof.capPrm), capAmb: cap(proof.capAmb),
    binaryWritable: proof.binaryWritable === true, caWritable: proof.caWritable === true,
    rootRegained: proof.rootRegained === true,
    directDns: verdict(proof.directDns, [...dnsFailures, "resolved"]),
    directIpTls: verdict(proof.directIpTls, [...tlsFailures, "connected"]),
    directTcpConnected: proof.directTcpConnected === true,
    directIpPeerPresented: proof.directIpPeerPresented === true,
    receivePackStatus: code(proof.receivePackStatus), otherRepositoryStatus: code(proof.otherRepositoryStatus),
  }) });
}
