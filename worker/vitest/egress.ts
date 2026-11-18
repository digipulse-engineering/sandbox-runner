import { registryTarballUrl } from "./lockfile.ts";

type OpenPhase = "checkout" | "install";
type EgressPhase = OpenPhase | "draining_checkout" | "closed";
export type EgressGate = { phase: EgressPhase; leases: string[] };

export function advanceEgress(gate: EgressGate, phase: Exclude<EgressPhase, "checkout">): EgressGate | undefined {
  if (phase === "closed" || (gate.phase === "checkout" && phase === "draining_checkout") ||
      (gate.phase === "draining_checkout" && phase === "install" && gate.leases.length === 0)) {
    return { ...gate, phase };
  }
}

export function leaseEgress(gate: EgressGate, phase: OpenPhase, lease: string): EgressGate | undefined {
  if (gate.phase === phase && !gate.leases.includes(lease)) return { ...gate, leases: [...gate.leases, lease] };
}

export function releaseEgress(gate: EgressGate, lease: string): EgressGate {
  return { ...gate, leases: gate.leases.filter(active => active !== lease) };
}

export function npmEgressTarget(request: Request): string | undefined {
  if ((request.method !== "GET" && request.method !== "HEAD") || request.body !== null) return;
  const host = request.headers.get("host");
  if (host === null || host.toLowerCase() === "registry.npmjs.org") return registryTarballUrl(request.url);
}

/** Release after the caller consumes or cancels the body, even when the upstream fails. */
export async function withEgressLease(forward: () => Promise<Response>, release: () => Promise<void>,
  background?: (work: Promise<void>) => void): Promise<Response> {
  let response;
  try {
    response = await forward();
  } catch (error) {
    await release();
    throw error;
  }
  if (!response.body) {
    await release();
    return response;
  }
  const length = response.headers.get("content-length");
  if (background && typeof FixedLengthStream !== "undefined" && !response.headers.has("content-encoding") && length !== null && /^\d+$/.test(length) &&
      Number.isSafeInteger(Number(length))) {
    const { readable, writable } = new FixedLengthStream(Number(length));
    background(response.body.pipeTo(writable).catch(() => {}).finally(release).catch(() => {}));
    return new Response(readable, response);
  }
  const reader = response.body.getReader();
  let released = false;
  async function finish() {
    if (released) return;
    released = true;
    await release();
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await finish();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        try {
          await finish();
        } finally {
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await finish();
      }
    },
  }, { highWaterMark: 0 });
  return new Response(stream, response);
}

export async function fetchLockedTarball(target: string, method: string, fetcher = fetch): Promise<Response> {
  const response = await fetcher(target, { method, redirect: "manual" });
  if (response.status !== 200) {
    await response.body?.cancel();
    return new Response(null, { status: 502 });
  }
  return new Response(response.body, { headers: { "content-type": "application/octet-stream" } });
}
