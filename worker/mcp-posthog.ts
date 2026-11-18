import { readMcpJson } from "./mcp-http.ts";
import type { McpConnector } from "./mcp-policy.ts";

export const posthogBinding = "SANDBOX_RUNNER_MCP_API_KEY_POSTHOG";
export const posthogTool = "posthog_count_events";
const projectPath = /^\/api\/projects\/[1-9][0-9]*\/query\/$/;
const eventName = /^[a-zA-Z_$][a-zA-Z0-9_.$:-]{0,127}$/;
const testRunId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const runProperty = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const windows = [15, 30, 60];

export const posthogMcpTools = [{
  name: posthogTool,
  description: "Count a configured event from a tagged test run in the configured PostHog project.",
  inputSchema: { type: "object", required: ["event", "testRunProperty", "testRunId", "minutes"], additionalProperties: false,
    properties: { event: { type: "string" }, testRunProperty: { type: "string" }, testRunId: { type: "string", pattern: testRunId.source },
      minutes: { type: "integer", enum: windows } } },
}];

export function isPosthogQueryUrl(url: URL): boolean {
  return ["https://us.posthog.com", "https://eu.posthog.com"].includes(url.origin) && projectPath.test(url.pathname) &&
    !url.search && !url.hash && !url.username && !url.password;
}

export function isPosthogPolicy(connector: McpConnector): boolean {
  return isPosthogQueryUrl(new URL(connector.url)) && connector.readAuth === posthogBinding &&
    connector.writeAuth === posthogBinding && !connector.write.length && connector.read.length > 0 &&
    connector.read.every(rule => rule.tool === posthogTool && Object.keys(rule.match).length === 2 &&
      typeof rule.match.event === "string" && eventName.test(rule.match.event) &&
      typeof rule.match.testRunProperty === "string" && runProperty.test(rule.match.testRunProperty) &&
      rule.arguments.length === 2 && rule.arguments.includes("minutes") && rule.arguments.includes("testRunId"));
}

export function isPosthogKey(key: unknown): key is string {
  return typeof key === "string" && /^phx_[a-zA-Z0-9_-]+$/.test(key);
}

export async function callPosthogTool({ url, name, args, token, signal, fetcher = fetch }: {
  url: string; name: string; args: Record<string, unknown>; token: string; signal?: AbortSignal; fetcher?: typeof fetch;
}): Promise<Response> {
  const { event, testRunProperty, testRunId: runId, minutes } = args;
  if (name !== posthogTool || !isPosthogQueryUrl(new URL(url)) || Object.keys(args).length !== 4 ||
      typeof event !== "string" || !eventName.test(event) || typeof testRunProperty !== "string" || !runProperty.test(testRunProperty) ||
      typeof runId !== "string" || !testRunId.test(runId) || typeof minutes !== "number" || !windows.includes(minutes)) {
    return new Response(null, { status: 400 });
  }
  if (!isPosthogKey(token)) return new Response(null, { status: 401 });
  // Values interpolated here are constrained to literals without quotes, escapes, or whitespace.
  const query = `SELECT count() FROM events WHERE event = '${event}' AND timestamp >= now() - INTERVAL ${minutes} MINUTE AND timestamp <= now() AND properties.${testRunProperty} = '${runId}'`;
  const response = await fetcher(url, { method: "POST", redirect: "manual", cache: "no-store", signal,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ refresh: "force_blocking", query: { kind: "HogQLQuery", query, name: "Sandbox Runner test event count" } }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const status = [401, 403, 429, 503].includes(response.status) ? response.status : 502;
    const retryAfter = response.headers.get("retry-after");
    return new Response(null, { status,
      ...(retryAfter && [429, 503].includes(status) ? { headers: { "retry-after": retryAfter } } : {}) });
  }
  const results = (await readMcpJson(response, 128 * 1024))?.results;
  const count = Array.isArray(results) && results.length === 1 && Array.isArray(results[0]) && results[0].length === 1
    ? results[0][0] : undefined;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return new Response(null, { status: 502 });
  return Response.json({ event, testRunId: runId, minutes, count });
}
