import { openCodeProviderConfig } from "./provider.ts";
import { githubGitHost } from "./github-read.ts";
import { openCodeAnthropicVersion, openCodePlaceholder } from "./opencode-settings.ts";
import type { ModelProvider } from "./opencode-settings.ts";

const dnsResults = ["resolved", "negative", "timed_out", "error"] as const;
const ipResults = ["tcp_failed", "tcp_timed_out", "tls_failed", "tls_timed_out", "tls_established"] as const;
const routes = ["method", "query", "path", "credential"] as const;
const gitRoutes = ["receivePack", "otherRepository", "wrongCase"] as const;

export type OpenCodeNetworkProof = {
  unprivileged: boolean;
  keysAbsent: boolean;
  placeholderPresent: boolean;
  dns: typeof dnsResults[number];
  ip: typeof ipResults[number];
  refusals: Record<typeof routes[number], number | null>;
  checkout?: {
    capabilitiesCleared: boolean;
    rootRegained: boolean;
    trustedFilesWritable: boolean;
    refusals: Record<typeof gitRoutes[number], number | null>;
  };
};

export function readOpenCodeNetworkProof(value: unknown): OpenCodeNetworkProof | undefined {
  if (!value || typeof value !== "object") return;
  const proof = value as Partial<OpenCodeNetworkProof>;
  const { unprivileged, keysAbsent, placeholderPresent, dns, ip, refusals, checkout } = proof;
  if (typeof unprivileged !== "boolean" || typeof keysAbsent !== "boolean" || typeof placeholderPresent !== "boolean" ||
      dns === undefined || !dnsResults.includes(dns) || ip === undefined || !ipResults.includes(ip) ||
      !refusals || typeof refusals !== "object") return;
  const validStatus = (status: unknown) => status === null ||
    (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599);
  const { method, query, path, credential } = refusals;
  if (![method, query, path, credential].every(validStatus)) return;
  let git: OpenCodeNetworkProof["checkout"];
  if (checkout !== undefined) {
    if (!checkout || typeof checkout.capabilitiesCleared !== "boolean" || typeof checkout.rootRegained !== "boolean" ||
        typeof checkout.trustedFilesWritable !== "boolean" || !checkout.refusals) return;
    const { capabilitiesCleared, rootRegained, trustedFilesWritable } = checkout;
    const { receivePack, otherRepository, wrongCase } = checkout.refusals;
    if (![receivePack, otherRepository, wrongCase].every(validStatus)) return;
    git = { capabilitiesCleared, rootRegained, trustedFilesWritable, refusals: { receivePack, otherRepository, wrongCase } };
  }
  return { unprivileged, keysAbsent, placeholderPresent, dns, ip, refusals: { method, query, path, credential },
    ...(git === undefined ? {} : { checkout: git }) };
}

export function openCodeNetworkBlocked(proof: OpenCodeNetworkProof | undefined, requireCheckout = false): boolean {
  const git = proof?.checkout;
  return !!proof && proof.unprivileged && proof.keysAbsent && proof.placeholderPresent &&
    (proof.dns === "negative" || proof.dns === "timed_out") && proof.ip !== "tls_established" &&
    routes.every(route => proof.refusals[route] === 403) &&
    (!requireCheckout || (!!git && git.capabilitiesCleared && !git.rootRegained && !git.trustedFilesWritable &&
      gitRoutes.every(route => git.refusals[route] === 403)));
}

// This script sends no credentials to the public test destination. The
// TLS probe uses the published resolver IPv4 directly, without a DNS lookup.
const probeSource = `
import { access, constants, readFile } from "node:fs/promises";
import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { connect } from "node:tls";
const [host, path, header, placeholder, version, gitHost, slug] = process.argv.slice(1);
// Match the native verifier's failure containment if a child stops responding.
setTimeout(() => process.exit(1), 15_000).unref();
const initial = (await readFile("/proc/1/environ", "utf8")).split("\\0");
const names = new Set(initial.map(entry => entry.slice(0, entry.indexOf("="))));
const keysAbsent = [
  "SANDBOX_RUNNER_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_SUBSCRIPTION_OAUTH_TOKEN",
  "SANDBOX_RUNNER_OPENCODE_OPENAI_API_KEY", "SANDBOX_RUNNER_OPENCODE_ANTHROPIC_API_KEY",
  "GITHUB_APP_CLIENT_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY", "SANDBOX_RUNNER_GITHUB_ALLOWLIST",
  "GITHUB_TOKEN", "GH_TOKEN",
].every(name => !names.has(name) && !Object.hasOwn(process.env, name));
const placeholderPresent = initial.includes("SANDBOX_RUNNER_OPENCODE_PLACEHOLDER=" + placeholder);
process.setgroups([]);
process.setgid(10001);
process.setuid(10001);
const identity = await readFile("/proc/self/status", "utf8");
const unprivileged = process.getuid() === 10001 && process.getgid() === 10001 && /^CapEff:\\s+0+$/m.test(identity);
if (!unprivileged) process.exit(1);

const validHeaders = header === "authorization" ? { authorization: "Bearer " + placeholder }
  : { "x-api-key": placeholder, "anthropic-version": version };
const forbidden = header === "authorization" ? "x-api-key" : "authorization";
const route = async (target, method, headers) => {
  try {
    const response = await fetch("http://" + host + target, { method, headers, redirect: "error", signal: AbortSignal.timeout(3_000) });
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
};
const directTls = new Promise(resolve => {
  const socket = connect({ host: "1.1.1.1", port: 443, servername: "one.one.one.one", rejectUnauthorized: true });
  let connected = false;
  const finish = outcome => {
    socket.destroy();
    resolve(outcome);
  };
  socket.once("connect", () => { connected = true; });
  socket.once("secureConnect", () => finish("tls_established"));
  socket.once("error", () => finish(connected ? "tls_failed" : "tcp_failed"));
  socket.setTimeout(3_000, () => finish(connected ? "tls_timed_out" : "tcp_timed_out"));
});
const directDns = new Promise(resolve => {
  const resolver = new Resolver();
  const timeout = setTimeout(() => {
    resolve("timed_out");
    resolver.cancel();
  }, 3_000);
  const finish = outcome => {
    clearTimeout(timeout);
    resolve(outcome);
  };
  resolver.resolve4("one.one.one.one").then(
    addresses => finish(addresses.length ? "resolved" : "negative"),
    error => finish(error?.code === "ETIMEOUT" ? "timed_out"
      : ["ENOTFOUND", "ENODATA", "EREFUSED"].includes(error?.code) ? "negative" : "error"),
  );
});
async function checkoutProof() {
  const capabilitiesCleared = [/^CapEff:\\s+0+$/m, /^CapPrm:\\s+0+$/m, /^CapAmb:\\s+0+$/m]
    .every(pattern => pattern.test(identity));
  try { process.setuid(0); } catch {}
  const rootRegained = process.getuid() === 0;
  const caPath = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
  const writable = path => access(path, constants.W_OK).then(() => true, () => false);
  const trustedFilesWritable = await writable("/usr/local/bin/sandbox-runner-checkout") ||
    await writable("/usr/local/bin/opencode") || await writable(caPath);
  if (rootRegained) return { capabilitiesCleared, rootRegained, trustedFilesWritable, refusals: {
    receivePack: null, otherRepository: null, wrongCase: null,
  } };
  const ca = await readFile(caPath);
  const git = (target, method) => new Promise(resolve => {
    const post = method === "POST";
    const req = request("https://" + gitHost + target, { method, ca, signal: AbortSignal.timeout(3_000),
      ...(post ? { headers: { "content-type": "application/x-git-receive-pack-request" } } : {}),
    }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.once("error", () => resolve(null));
    req.end(post ? "0000" : undefined);
  });
  const discovery = ".git/info/refs?service=git-upload-pack";
  const [receivePack, otherRepository, wrongCase] = await Promise.all([
    git("/" + slug + ".git/git-receive-pack", "POST"),
    git("/fixture/not-admitted" + discovery, "GET"),
    git("/" + slug.toLowerCase() + discovery, "GET"),
  ]);
  return { capabilitiesCleared, rootRegained, trustedFilesWritable, refusals: { receivePack, otherRepository, wrongCase } };
}
const [method, query, wrongPath, credential, dns, ip, checkout] = await Promise.all([
  route(path, "GET", validHeaders),
  route(path + "?probe=1", "POST", validHeaders),
  route(path === "/v1/messages" ? "/v1/chat/completions" : "/v1/messages", "POST", validHeaders),
  route(path, "POST", { ...validHeaders, [forbidden]: "synthetic-forbidden" }),
  directDns, directTls, slug === undefined ? undefined : checkoutProof(),
]);
const proof = { unprivileged, keysAbsent, placeholderPresent, dns, ip, refusals: { method, query, path: wrongPath, credential }, checkout };
process.stdout.write(JSON.stringify(proof) + "\\n", () => process.exit(0));
`;

export async function verifyOpenCodeNetwork(container: Container | undefined, modelProvider: ModelProvider, checkoutSlug?: string):
Promise<OpenCodeNetworkProof | undefined> {
  if (!container?.running) return;
  const { host, path, header } = openCodeProviderConfig(modelProvider);
  try {
    const process = await container.exec(
      ["/usr/local/bin/node", "--input-type=module", "--eval", probeSource, "--",
        host, path, header, openCodePlaceholder, openCodeAnthropicVersion,
        ...(checkoutSlug === undefined ? [] : [githubGitHost, checkoutSlug])],
      { stdout: "pipe", stderr: "ignore" },
    );
    const { exitCode, stdout } = await process.output();
    if (exitCode !== 0) return;
    return readOpenCodeNetworkProof(JSON.parse(new TextDecoder().decode(stdout)));
  } catch {
    return;
  }
}
