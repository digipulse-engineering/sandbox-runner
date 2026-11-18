import type { InferenceEvent, InferenceSignal } from "./diagnostics";
import { codexApiCreditPromoRestriction, observeCodexApiRejection } from "./codex-api-diagnostics.ts";

/**
 * Guarded transparent relay for container egress.
 *
 * The Worker enforces egress policy through the request target and headers.
 *
 *  1. Data. It does not read the request body or rewrite the response stream.
 *     The Codex API route can identify one known rejection from a bounded error envelope.
 *     It strips credential headers while preserving provider metadata, so anything the
 *     CLI adds later (for example in `anthropic-beta`) keeps flowing.
 *  2. Injection. Fixed https upstream per intercepted host, allow-listed
 *     method + path, inbound credential headers dropped, the real ones set,
 *     redirects never followed.
 *  3. Observation. One metadata-only journal entry per request, whether it
 *     was relayed, denied or failed. No request header, no body and no
 *     credential is ever journaled.
 *
 * This module has no Workers import, so it runs under plain Node for tests.
 * `GuardedRoute` is the route shape of `agents/harness/container`
 * (`host`, `upstream`, `headers`, `strip`) plus an `allow` list.
 */

/** One request shape a route lets through. */
export type AllowRule = {
  readonly method: string;
  readonly path: string;
  /** Exact query strings accepted besides the empty one, such as `?beta=true`. */
  readonly searches?: readonly string[];
};

/** One intercepted host, where its requests go, and what may go there. */
export type GuardedRoute = {
  /** The placeholder hostname the CLI calls. */
  readonly host: string;
  /** The real https base URL. The request's path and query are appended. */
  readonly upstream: string;
  /** Headers to set on the forwarded request, such as credentials. */
  readonly headers: { readonly [name: string]: string };
  /** Additional credential or session headers to drop in both directions. */
  readonly strip: readonly string[];
  /** The only requests this route forwards. Anything else is denied. */
  readonly allow: readonly AllowRule[];
};

/** Who the traffic is attributed to. */
export type EgressSubject = {
  readonly containerId: string;
  readonly contractId: string | null;
};

export type DenyReason = "no_route" | "bad_upstream" | "not_allowed";

/** Metadata about one request. Never holds a request header or any body. */
export type JournalEntry = {
  readonly at: string;
  readonly containerId: string;
  readonly contractId: string | null;
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly decision: "relayed" | "denied" | "failed";
  readonly reason: DenyReason | null;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly limits: { readonly [name: string]: string };
};

export type Journal = (entry: JournalEntry) => void | Promise<void>;
type ObserveInference = (event: InferenceEvent) => boolean | Promise<boolean>;

const SAFE_VALUE = /^[a-z0-9_.:-]{1,96}$/i;
const REQUEST_ID = /^req_[a-z0-9_-]{1,96}$/i;
const LIMIT_PREFIX = "anthropic-ratelimit-";
const MAX_FIELD = 200;

const CREDENTIAL_HEADERS = [
  "authorization", "proxy-authorization", "x-api-key", "api-key", "cf-aig-authorization",
  "openai-organization", "openai-project", "cookie", "set-cookie", "set-cookie2",
] as const;

/** Container-controlled text, made safe to write to a log line. */
function clip(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, MAX_FIELD);
}

/** The upstream as a base URL without a trailing slash, or null if unusable. */
function upstreamBase(upstream: string): string | null {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.search || url.hash) return null;
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function safeRequestId(headers: Headers): string | null {
  const id = headers.get("request-id");
  return id && REQUEST_ID.test(id) ? id : null;
}

function safeLimits(headers: Headers): { [name: string]: string } {
  const limits: { [name: string]: string } = {};
  for (const [name, value] of headers) {
    if (name.startsWith(LIMIT_PREFIX) && SAFE_VALUE.test(value)) limits[name] = value;
  }
  return limits;
}

/** Journaling must never break or delay the failure path of the relay. */
async function record(journal: Journal, entry: JournalEntry): Promise<void> {
  try {
    await journal(entry);
  } catch {
    // A lost journal line is acceptable. A broken relay is not.
  }
}

/**
 * Forward one intercepted request to its route's upstream, if allowed.
 *
 * @param request - The request the container made.
 * @param routes - The routes, by placeholder host.
 * @param subject - The container and contract the traffic is attributed to.
 * @param journal - Receives one metadata entry per request.
 * @param fetcher - How to make the upstream request. Default `fetch`.
 * @param now - Clock, for tests.
 * @param observe - Authorizes and attributes the allowed inference attempt.
 * @param codexApiKey - Enables the fixed rejection diagnostic for Codex API-key requests.
 * @returns The upstream's response stream with credential headers removed, or 403 when denied.
 */
export async function guardedForward(
  request: Request,
  routes: readonly GuardedRoute[],
  subject: EgressSubject,
  journal: Journal,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
  observe?: ObserveInference,
  codexApiKey = false,
): Promise<Response> {
  const url = new URL(request.url);
  const base = {
    at: now().toISOString(),
    containerId: subject.containerId,
    contractId: subject.contractId,
    host: clip(url.hostname),
    method: clip(request.method),
    path: clip(url.pathname),
  };
  const deny = async (reason: DenyReason): Promise<Response> => {
    await record(journal, {
      ...base, decision: "denied", reason, status: null, requestId: null, limits: {},
    });
    return new Response(JSON.stringify({ error: "egress denied" }), {
      status: 403,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  };

  const route = routes.find((each) => each.host === url.hostname);
  if (!route) return deny("no_route");
  const upstream = upstreamBase(route.upstream);
  if (!upstream) return deny("bad_upstream");
  const allowed = route.allow.some((rule) =>
    rule.method === request.method &&
    rule.path === url.pathname &&
    (url.search === "" || (rule.searches ?? []).includes(url.search))
  );
  if (!allowed) return deny("not_allowed");

  const id = observe ? crypto.randomUUID() : undefined;
  if (id && observe && !await observe({ id })) return deny("not_allowed");
  const finish = async (signal: InferenceSignal): Promise<void> => {
    if (!id || !observe) return;
    try {
      await observe({ id, signal });
    } catch {
      // An incomplete attempt suppresses classification. Preserve the upstream response.
    }
  };

  const headers = new Headers(request.headers);
  const stripped = [...CREDENTIAL_HEADERS, ...route.strip];
  headers.delete("host");
  for (const name of stripped) headers.delete(name);
  for (const [name, value] of Object.entries(route.headers)) headers.set(name, value);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  let response: Response;
  try {
    response = await fetcher(upstream + url.pathname + url.search, {
      method: request.method,
      headers,
      ...(hasBody ? { body: request.body } : {}),
      // Never follow a redirect with the credentials attached.
      redirect: "manual",
    });
  } catch (error) {
    await finish({ kind: error instanceof Error && error.name === "TimeoutError" ? "transport_timeout" : "transport_failed" });
    await record(journal, {
      ...base, decision: "failed", reason: null, status: null, requestId: null, limits: {},
    });
    throw error;
  }
  await finish(response.status >= 300 && response.status < 400
    ? { kind: "redirect" } : { kind: "http", status: response.status });
  await record(journal, {
    ...base,
    decision: "relayed",
    reason: null,
    status: response.status,
    requestId: safeRequestId(response.headers),
    limits: safeLimits(response.headers),
  });
  if (codexApiKey && observe) {
    response = observeCodexApiRejection(response, () => finish({
      kind: "http", status: 400, restriction: codexApiCreditPromoRestriction,
    }));
  }
  if (!stripped.some(name => response.headers.has(name))) return response;
  const filtered = new Response(response.body, response);
  for (const name of stripped) filtered.headers.delete(name);
  return filtered;
}
