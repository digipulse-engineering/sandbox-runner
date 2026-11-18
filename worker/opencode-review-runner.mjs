import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const binary = "/usr/local/bin/opencode";
// OpenCode 2.2.7 allows 30 seconds each for startup and catalog discovery.
// Reserve the same startup allowance for the private OpenCode process itself.
const startupMs = 30_000;
const catalogMs = 30_000;
const pollMs = 250;
const forceKillMs = 1_000;
const serverStopMs = 5_000;

function closed(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

function readEndpoint(server, signal) {
  const lines = createInterface({ input: server.stdout, signal });
  return new Promise((resolve, reject) => {
    lines.once("line", line => {
      try {
        const url = new URL(JSON.parse(line).url);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" ||
            url.username || url.password || url.search || url.hash) throw new Error();
        resolve(url.origin);
      } catch {
        reject(new Error("OpenCode reported an invalid private endpoint"));
      }
    });
    lines.once("close", () => reject(new Error("OpenCode private endpoint unavailable")));
  }).finally(() => {
    lines.close();
    server.stdout.resume();
  });
}

async function waitForConnectors(endpoint, headers, names, signal) {
  const url = new URL("/api/mcp", endpoint);
  const directory = process.cwd();
  url.searchParams.set("location[directory]", directory);
  while (true) {
    const response = await fetch(url, { headers, redirect: "error", signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("OpenCode MCP status unavailable");
    }
    const state = await response.json();
    if (state.location?.directory !== directory || !Array.isArray(state.data)) {
      throw new Error("OpenCode MCP location mismatch");
    }
    const statuses = names.map(name => state.data.find(server => server.name === name)?.status?.status);
    if (statuses.every(status => status === "connected")) return;
    if (statuses.some(status => status !== undefined && status !== "pending" && status !== "connected")) {
      throw new Error("OpenCode MCP connector unavailable");
    }
    await sleep(pollMs, undefined, { signal });
  }
}

async function runReview(names, args) {
  const password = randomBytes(32).toString("base64url");
  const env = { ...process.env, PWD: process.cwd(), OPENCODE_PASSWORD: password };
  delete env.SANDBOX_RUNNER_OPENCODE_REVIEW_CONNECTORS;
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  // The pinned stdio server shuts down when its parent closes stdin, even
  // when the harness has to kill this wrapper during a cancelled turn.
  const server = spawn(binary, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
    env, stdio: ["pipe", "pipe", "ignore"],
  });
  server.stdin.on("error", () => {});
  const serverClosed = closed(server);
  const serverSignal = new AbortController();
  void serverClosed.then(() => serverSignal.abort(), () => serverSignal.abort());
  const lifetime = AbortSignal.any([stop.signal, serverSignal.signal]);
  let client;
  let forceClient;
  const stopClient = () => {
    if (!client || forceClient) return;
    client.kill("SIGTERM");
    // The pinned harness force-kills the wrapper after five seconds.
    // Stop the child before that deadline if it does not handle SIGTERM.
    forceClient = setTimeout(() => client.kill("SIGKILL"), forceKillMs).unref();
  };
  try {
    const endpoint = await readEndpoint(server, AbortSignal.any([lifetime, AbortSignal.timeout(startupMs)]));
    const auth = "Basic " + Buffer.from("opencode:" + password).toString("base64");
    await waitForConnectors(endpoint, { authorization: auth }, names,
      AbortSignal.any([lifetime, AbortSignal.timeout(startupMs + catalogMs)]));
    lifetime.throwIfAborted();
    client = spawn(binary, ["--server", endpoint, ...args], { env, stdio: ["ignore", "inherit", "inherit"] });
    const clientClosed = closed(client);
    lifetime.addEventListener("abort", stopClient, { once: true });
    if (lifetime.aborted) stopClient();
    return await clientClosed;
  } catch {
    if (!stop.signal.aborted) console.log(JSON.stringify({ type: "sandbox_runner_mcp_startup_failed" }));
    return 1;
  } finally {
    lifetime.removeEventListener("abort", stopClient);
    clearTimeout(forceClient);
    server.stdin.end();
    // The upstream MCP client bounds termination requests at one second.
    // Keep a finite fallback if the private server does not exit.
    const force = setTimeout(() => server.kill("SIGKILL"), serverStopMs).unref();
    await serverClosed.catch(() => {});
    clearTimeout(force);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

let names;
try {
  names = JSON.parse(process.env.SANDBOX_RUNNER_OPENCODE_REVIEW_CONNECTORS ?? "null");
} catch {
  // Only the Worker may generate this environment value.
}
if (!Array.isArray(names) || names.length === 0 || !names.every(name => typeof name === "string")) {
  console.log(JSON.stringify({ type: "sandbox_runner_mcp_startup_failed" }));
  process.exitCode = 1;
} else {
  process.exitCode = await runReview(names, process.argv.slice(2)) ?? 1;
}
