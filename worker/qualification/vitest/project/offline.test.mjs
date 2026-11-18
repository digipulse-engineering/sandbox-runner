import { Resolver } from "node:dns/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect as connectTls } from "node:tls";
import { expect, test } from "vitest";

const probeTimeout = Number(process.env.QUALIFICATION_PROBE_TIMEOUT_MS ?? 3000);
const witnessUrl = process.env.QUALIFICATION_WITNESS_URL;
const dnsBlocked = ["deadline", "ETIMEOUT", "ENOTFOUND", "ENODATA", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"];
const tlsBlocked = ["deadline", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"];

test.concurrent("loopback remains available to tests", async () => {
  const server = createServer((_request, response) => response.end("QUALIFICATION_LOOPBACK"));
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, { signal: AbortSignal.timeout(probeTimeout) });
    expect(await response.text()).toBe("QUALIFICATION_LOOPBACK");
    console.log("QUALIFICATION_LOOPBACK_OK");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test.concurrent("a previously allowed registry tarball is denied", async () => {
  const response = await fetch("https://registry.npmjs.org/vitest/-/vitest-5.1.0.tgz", {
    signal: AbortSignal.timeout(probeTimeout), redirect: "manual",
  });
  await response.body?.cancel();
  expect(response.status).toBe(403);
  expect(response.headers.get("x-qualification-registry")).toBe("sealed");
  console.log("QUALIFICATION_REGISTRY_SEALED");
});

async function dnsProbe(server) {
  const resolver = new Resolver({ timeout: probeTimeout, tries: 1 });
  if (server) resolver.setServers([server]);
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    resolver.cancel();
  }, probeTimeout);
  try {
    await resolver.resolve4("example.com");
    return "resolved";
  } catch (error) {
    return expired && error.code === "ECANCELLED" ? "deadline" : error.code;
  } finally {
    clearTimeout(timer);
  }
}

test.concurrent("DNS outside the registry route is blocked", async () => {
  const [defaultResolver, publicResolver] = await Promise.all([dnsProbe(), dnsProbe("1.1.1.1")]);
  expect(dnsBlocked).toContain(defaultResolver);
  expect(dnsBlocked).toContain(publicResolver);
  console.log("QUALIFICATION_DNS_BLOCKED", { defaultResolver, publicResolver });
});

function tlsProbe(port, servername) {
  return new Promise(resolve => {
    const socket = connectTls({ host: "1.1.1.1", port, servername });
    let tcpConnected = false;
    const finish = outcome => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ tcpConnected, outcome });
    };
    const timer = setTimeout(() => finish("deadline"), probeTimeout);
    socket.once("connect", () => { tcpConnected = true; });
    socket.once("secureConnect", () => finish("secureConnect"));
    socket.once("error", error => finish(error.code));
  });
}

test.concurrent("direct public IP cannot establish HTTPS TLS", async () => {
  const result = await tlsProbe(443, "cloudflare-dns.com");
  expect(tlsBlocked).toContain(result.outcome);
  console.log("QUALIFICATION_DIRECT_IP_TLS_BLOCKED", result);
});

test.concurrent("direct public IP cannot establish DNS-over-TLS", async () => {
  const result = await tlsProbe(853, "cloudflare-dns.com");
  expect(tlsBlocked).toContain(result.outcome);
  console.log("QUALIFICATION_DIRECT_DOT_BLOCKED", result);
});

test.skipIf(!witnessUrl)("an HTTPS request cannot reach the external witness", async () => {
  let reached = false;
  try {
    const response = await fetch(witnessUrl, { signal: AbortSignal.timeout(probeTimeout), redirect: "manual" });
    reached = true;
    await response.body?.cancel();
  } catch {
    // The independent witness record verifies the nonce was never received.
  }
  expect(reached).toBe(false);
  console.log("QUALIFICATION_HTTPS_WITNESS_BLOCKED");
});
