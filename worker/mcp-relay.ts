import { mcpConnectorCodes as issueCode, mcpRetryAfterSeconds } from "./mcp-diagnostic.mjs";
import type { McpConnectorCode, McpConnectorIssue } from "./mcp-diagnostic.mjs";
import { positiveId } from "./github-auth.ts";
import { readGithubCi } from "./github-ci.ts";
import { readMcpJson, readMcpResponse } from "./mcp-http.ts";
import type { McpRequestId } from "./mcp-http.ts";
import { context7Resource, oauthOpaque } from "./mcp-oauth-format.mjs";
import { mcpTokenFingerprint } from "./mcp-oauth.ts";
import type { McpCredentialResult } from "./mcp-oauth.ts";
import { githubCiToolName, isMcpJsonLiteral, isPublicContext7, mcpConnectorName, mcpObject, mcpToolAccess, projectMcpTools } from "./mcp-policy.ts";
import type { McpAccessMode, McpConnector } from "./mcp-policy.ts";
import type { McpInitializeResult, McpSessionAccess } from "./mcp-session.ts";

type McpRelayOptions = {
  readonly connector: McpConnector;
  readonly mode: McpAccessMode;
  readonly authorize: () => Promise<boolean>;
  readonly claimWrite: (requestId: McpRequestId) => Promise<boolean>;
  readonly settleWrite?: (requestId: McpRequestId, dispatched: boolean) => Promise<boolean>;
  readonly credentials: (reference: string, connector: McpConnector, mode: McpAccessMode,
    rejectedFingerprint?: string) => Promise<McpCredentialResult>;
  readonly diagnose?: (issue: McpConnectorIssue) => Promise<void>;
  readonly session: McpSessionAccess;
  readonly maxBytes: number;
  readonly fetcher?: typeof fetch;
  readonly githubCi?: Pick<Parameters<typeof readGithubCi>[3], "getToken"> & {
    repository: Parameters<typeof readGithubCi>[0]; sha: string;
  };
};

type McpCall = {
  readonly id: McpRequestId | undefined;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly write: boolean;
};

const legacyDefaultVersion = "2025-03-26";
const modernVersion = "2026-07-28";
const sessionHeader = "mcp-session-id";
const protocolHeader = "mcp-protocol-version";
const protocolPattern = /^\d{4}-\d{2}-\d{2}$/;
const sessionIdPattern = /^[\x21-\x7e]+$/;
const bridgeInfo = { name: "sandbox-runner", version: "1" };

function json(body: unknown, status = 200, sessionId?: string): Response {
  return Response.json(body, { status, headers: {
    "cache-control": "no-store", ...(sessionId ? { [sessionHeader]: sessionId } : {}),
  } });
}

function httpError(status: number, code: string): Response {
  return json({ error: code }, status);
}

function rpcError(id: McpRequestId | undefined, code: number, message: string): Response {
  return id === undefined ? httpError(400, message) : json({ jsonrpc: "2.0", id, error: { code, message } });
}

function noBody(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { "cache-control": "no-store", allow: "POST, DELETE" } });
}

function version(value: unknown): string | undefined {
  if (typeof value === "string" && protocolPattern.test(value)) return value;
}

function parseCall(value: Record<string, unknown>, connector: McpConnector, mode: McpAccessMode): McpCall | Response | "policy-denied" {
  const { id, jsonrpc, method } = value;
  if (jsonrpc !== "2.0" || typeof method !== "string" ||
      (id !== undefined && typeof id !== "string" && !(typeof id === "number" && Number.isSafeInteger(id)))) {
    return httpError(400, "mcp_invalid_request");
  }
  const params = mcpObject(value.params);
  if (value.params !== undefined && !params) return rpcError(id, -32602, "mcp_invalid_params");
  if (method === "notifications/initialized" && id === undefined) return { id, method, params: {}, write: false };
  if (id === undefined) return httpError(400, "mcp_notification_not_allowed");
  switch (method) {
    case "initialize": {
      const protocolVersion = version(params?.protocolVersion);
      if (!protocolVersion) return rpcError(id, -32602, "mcp_invalid_protocol");
      return { id, method, params: { protocolVersion, capabilities: {}, clientInfo: bridgeInfo }, write: false };
    }
    case "ping":
      return { id, method, params: {}, write: false };
    case "tools/list": {
      const cursor = params?.cursor;
      if (cursor !== undefined && typeof cursor !== "string") return rpcError(id, -32602, "mcp_invalid_params");
      return { id, method, params: cursor === undefined ? {} : { cursor }, write: false };
    }
    case "tools/call": {
      const name = params?.name;
      const supplied = params?.arguments;
      const args = supplied === undefined ? {} : mcpObject(supplied);
      if (typeof name !== "string" || !args || !isMcpJsonLiteral(args)) return rpcError(id, -32602, "mcp_invalid_params");
      const permission = mcpToolAccess(connector, mode, name, args);
      if (!permission) return "policy-denied";
      return { id, method, params: { name, arguments: args }, write: permission === "write" };
    }
    default:
      return rpcError(id, -32601, "mcp_method_not_allowed");
  }
}

function outboundBody(call: McpCall, negotiated?: string): string {
  const params = negotiated === modernVersion ? { ...call.params, _meta: {
    "io.modelcontextprotocol/protocolVersion": modernVersion,
    "io.modelcontextprotocol/clientInfo": bridgeInfo,
    "io.modelcontextprotocol/clientCapabilities": {},
  } } : call.params;
  return JSON.stringify({ jsonrpc: "2.0", ...(call.id === undefined ? {} : { id: call.id }), method: call.method, params });
}

function upstreamHeaders(
  token: string | undefined, connector: McpConnector, mode: McpAccessMode, negotiated?: string, call?: McpCall, upstreamId?: string,
): Headers {
  const headers = new Headers({ accept: "application/json, text/event-stream" });
  if (token !== undefined) headers.set("authorization", "Bearer " + token);
  if (call) headers.set("content-type", "application/json");
  if (negotiated) headers.set(protocolHeader, negotiated);
  if (upstreamId) headers.set(sessionHeader, upstreamId);
  if (negotiated === modernVersion && call) {
    headers.set("mcp-method", call.method);
    if (typeof call.params.name === "string") headers.set("mcp-name", call.params.name);
  }
  if (mode === "read-only" && new URL(connector.url).origin === "https://api.githubcopilot.com") {
    headers.set("x-mcp-readonly", "true");
  }
  return headers;
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value)) return value.some(entry => containsSecret(entry, secret));
  const record = mcpObject(value);
  return record !== undefined && Object.entries(record).some(([key, entry]) =>
    key.includes(secret) || containsSecret(entry, secret));
}

function projectInitialization(value: Record<string, unknown>): McpInitializeResult | undefined {
  const protocolVersion = version(value.protocolVersion);
  const info = mcpObject(value.serverInfo);
  if (!protocolVersion || typeof info?.name !== "string" || typeof info.version !== "string") return;
  return { protocolVersion, serverInfo: { name: info.name, version: info.version },
    capabilities: { tools: {} }, ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}) };
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Recognize a Bearer error without treating quoted descriptions or other schemes as OAuth signals. */
function bearerError(header: string | null): string | undefined {
  if (!header) return;
  const fields: string[] = [];
  let start = 0;
  let end = 0;
  for (const match of header.matchAll(/"(?:[^"\\]|\\.)*"|,|[^",]+/g)) {
    if (match.index !== end) return;
    end += match[0].length;
    if (match[0] === ",") {
      fields.push(header.slice(start, match.index).trim());
      start = end;
    }
  }
  if (end !== header.length) return;
  fields.push(header.slice(start).trim());

  let bearer = false;
  let error: string | undefined;
  for (let field of fields) {
    if (!/^[\w-]+[ \t]*=/.test(field)) {
      const challenge = /^([\w-]+)(?:[ \t]+(.+))?$/.exec(field);
      bearer = challenge?.[1].toLowerCase() === "bearer";
      field = challenge?.[2] ?? "";
    }
    if (!bearer) continue;
    const parameter = /^error[ \t]*=[ \t]*(?:"([a-z_]+)"|([a-z_]+))$/i.exec(field);
    if (parameter) {
      if (error !== undefined) return;
      error = parameter[1] ?? parameter[2];
    }
  }
  return error;
}

function credentialHttpStatus(code: McpConnectorCode): number {
  if (code === issueCode.rateLimited) return 429;
  if (code === issueCode.accessDenied) return 403;
  return 503;
}

function toolError(result: Record<string, unknown>): McpConnectorCode | undefined {
  if (result.isError !== true) return;
  let upstreamCode = mcpObject(result.structuredContent)?.code;
  if (upstreamCode === undefined && Array.isArray(result.content) && result.content.length === 1) {
    const block = mcpObject(result.content[0]);
    if (block?.type === "text" && typeof block.text === "string") {
      try { upstreamCode = mcpObject(JSON.parse(block.text))?.code; } catch { /* Ordinary text error. */ }
    }
  }
  return upstreamCode === "TOOL_UNAVAILABLE" || upstreamCode === "MODULE_NOT_ENABLED"
    ? issueCode.toolUnavailable : issueCode.toolFailed;
}

function completedWrite(result: Record<string, unknown> | undefined): boolean {
  return result !== undefined && (result.isError === undefined || result.isError === false) &&
    (result.resultType === undefined || result.resultType === "complete") &&
    Array.isArray(result.content) && result.content.every(block => typeof mcpObject(block)?.type === "string");
}

/** The caller supplies a connector already pinned to the trusted run and the request's alias name. */
export async function forwardMcp(request: Request, options: McpRelayOptions): Promise<Response> {
  const { connector, mode, session } = options;
  const publicContext7 = isPublicContext7(connector);
  const context7 = publicContext7 || connector.url === context7Resource;
  const name = mcpConnectorName(request);
  let initializing: string | undefined;
  let claimedWrite: McpRequestId | undefined;
  let writeDispatched = false;
  let authorized = false;
  async function diagnose(code: McpConnectorCode, retryAfterSeconds?: number) {
    if (name === undefined || !authorized) return;
    const issue = { code, connector: name, mode, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) };
    await options.diagnose?.(issue).catch(() => undefined);
  }
  async function connectorError(status: number, code: McpConnectorCode, retryAfterSeconds?: number): Promise<Response> {
    await diagnose(code, retryAfterSeconds);
    const response = httpError(status, code);
    if (retryAfterSeconds !== undefined) response.headers.set("retry-after", String(retryAfterSeconds));
    return response;
  }
  async function settleWrite(): Promise<boolean> {
    if (claimedWrite === undefined || options.settleWrite === undefined) return true;
    return options.settleWrite(claimedWrite, writeDispatched).catch(() => false);
  }
  try {
    if (!name || !await options.authorize()) return httpError(403, "mcp_egress_denied");
    authorized = true;
    if (request.method !== "POST" && request.method !== "DELETE") return methodNotAllowed();
    let call: McpCall | undefined;
    if (request.method === "POST") {
      const parsed = await readMcpJson(request, options.maxBytes);
      if (!parsed) return httpError(400, "mcp_invalid_request");
      const checked = parseCall(parsed, connector, mode);
      if (checked === "policy-denied") {
        await diagnose(issueCode.policyDenied);
        const id = typeof parsed.id === "string" || typeof parsed.id === "number" ? parsed.id : undefined;
        return rpcError(id, -32000, issueCode.policyDenied);
      }
      if (checked instanceof Response) return checked;
      if (context7 && checked.method === "tools/list" && Object.hasOwn(checked.params, "cursor")) {
        return rpcError(checked.id, -32602, "mcp_invalid_params");
      }
      call = checked;
    }
    const current = await session.read();
    const clientSession = request.headers.get(sessionHeader);
    const requestedVersion = request.headers.get(protocolHeader);
    if (requestedVersion !== null && !version(requestedVersion)) return httpError(400, "mcp_invalid_protocol");
    const initializeVersion = call?.method === "initialize" ? version(call.params.protocolVersion) : undefined;
    if (initializeVersion) {
      if (clientSession !== null) return httpError(409, "mcp_session_conflict");
      if (current?.upstreamId !== undefined) {
        if (!current.awaitingAcknowledgement) return httpError(409, "mcp_session_conflict");
        if (!await options.authorize() || request.signal.aborted) return httpError(403, "mcp_egress_denied");
        const reply = await session.replay(current.id, initializeVersion);
        if (!reply) return httpError(409, "mcp_session_conflict");
        if (!await options.authorize() || request.signal.aborted) return httpError(403, "mcp_egress_denied");
        return json({ jsonrpc: "2.0", id: call?.id, result: reply }, 200, current.id);
      }
      const id = crypto.randomUUID();
      if (!await session.claim(id, current?.id)) return httpError(409, "mcp_session_conflict");
      initializing = id;
    } else if (current ? clientSession !== current.id || !current.upstreamId : clientSession !== null) {
      return httpError(404, "mcp_session_not_found");
    }
    if (request.method === "DELETE" && !current) return methodNotAllowed();
    if (current?.protocolVersion && requestedVersion !== null && requestedVersion !== current.protocolVersion) {
      return httpError(400, "mcp_invalid_protocol");
    }
    if (current?.awaitingAcknowledgement && !await session.acknowledge(current.id)) {
      return httpError(404, "mcp_session_not_found");
    }
    async function sessionMatches(): Promise<boolean> {
      const activeSession = await session.read();
      return activeSession?.id === (initializing ?? current?.id) && activeSession?.upstreamId === current?.upstreamId;
    }
    if (call?.method === "tools/call" && call.params.name === githubCiToolName && connector.readAuth === "github-app") {
      const args = mcpObject(call.params.arguments);
      const ci = options.githubCi;
      if (!ci || !args || args.owner !== ci.repository.owner || args.repo !== ci.repository.name) {
        return connectorError(403, issueCode.accessDenied);
      }
      const page = args.page === undefined ? 1 : args.page;
      if (!positiveId(page)) return rpcError(call.id, -32602, "mcp_invalid_params");
      const result = await readGithubCi(ci.repository, ci.sha, page, {
        getToken: ci.getToken, authorize: async () => await sessionMatches() && await options.authorize(),
        fetcher: options.fetcher ?? fetch, signal: request.signal,
        maxBytes: options.maxBytes,
      });
      if (!await sessionMatches()) return httpError(404, "mcp_session_not_found");
      if (result.status === "denied") return connectorError(403, issueCode.accessDenied);
      if (result.status === "rate-limited") return connectorError(429, issueCode.rateLimited);
      if (result.status !== "ready") return connectorError(502, issueCode.unavailable);
      return json({ jsonrpc: "2.0", id: call.id, result: {
        content: [{ type: "text", text: JSON.stringify(result.value) }], structuredContent: result.value,
      } });
    }
    // Context7 receives only relay-generated IDs and the pinned upstream protocol.
    const negotiated = initializeVersion ? undefined : context7 ? legacyDefaultVersion
      : current?.protocolVersion ?? requestedVersion ?? legacyDefaultVersion;
    const upstreamCall = context7 && call ? {
      ...call,
      id: call.id === undefined ? undefined : crypto.randomUUID(),
      params: initializeVersion ? { ...call.params, protocolVersion: legacyDefaultVersion } : call.params,
    } : call;
    const reference = mode === "read-only" ? connector.readAuth : connector.writeAuth;
    let token: string | undefined;
    if (!publicContext7) {
      const resolved = await options.credentials(reference, connector, mode);
      if (resolved.status === "failed") return connectorError(credentialHttpStatus(resolved.code), resolved.code, resolved.retryAfterSeconds);
      if (!oauthOpaque(resolved.token)) return connectorError(503, issueCode.authRequired);
      token = resolved.token;
    }
    if (request.signal.aborted || !await options.authorize()) return httpError(403, "mcp_egress_denied");
    if (call?.write) {
      if (call.id === undefined || !await options.claimWrite(call.id)) {
        return rpcError(call.id, -32000, "mcp_write_already_claimed");
      }
      claimedWrite = call.id;
    }
    if (!await sessionMatches()) return httpError(404, "mcp_session_not_found");
    if (request.signal.aborted || !await options.authorize()) return httpError(403, "mcp_egress_denied");
    const tokens = token === undefined ? [] : [token];
    function send(token: string | undefined): Promise<Response> {
      const init: RequestInit = {
        method: request.method,
        headers: upstreamHeaders(token, connector, mode, negotiated, upstreamCall, current?.upstreamId),
        ...(upstreamCall ? { body: outboundBody(upstreamCall, negotiated) } : {}),
        signal: request.signal,
        redirect: "manual",
        cache: "no-store",
      };
      writeDispatched = claimedWrite !== undefined;
      return (options.fetcher ?? fetch)(connector.url, init);
    }
    let response = await send(token);
    const rejected = response.status === 401 && bearerError(response.headers.get("www-authenticate")) === "invalid_token";
    if (rejected && writeDispatched && token !== undefined) {
      await cancelBody(response);
      let authIssue: McpConnectorCode = issueCode.authRejected;
      if (!request.signal.aborted && await options.authorize()) {
        // Recover the credential for future calls while preserving this write's pending claim.
        const recovery = await options.credentials(reference, connector, mode, await mcpTokenFingerprint(token))
          .catch(() => undefined);
        if (recovery?.status === "failed") authIssue = recovery.code;
      }
      await diagnose(authIssue);
      return connectorError(502, issueCode.writeUnconfirmed);
    }
    if (rejected && call?.id !== undefined && !call.write && token !== undefined) {
      await cancelBody(response);
      if (request.signal.aborted || !await options.authorize()) return httpError(403, "mcp_egress_denied");
      const rejectedFingerprint = await mcpTokenFingerprint(token);
      const fresh = await options.credentials(reference, connector, mode, rejectedFingerprint);
      if (fresh.status === "failed") return connectorError(credentialHttpStatus(fresh.code), fresh.code, fresh.retryAfterSeconds);
      if (!oauthOpaque(fresh.token) || await mcpTokenFingerprint(fresh.token) === rejectedFingerprint) {
        return connectorError(503, issueCode.authRejected);
      }
      if (!await sessionMatches()) return httpError(404, "mcp_session_not_found");
      if (request.signal.aborted || !await options.authorize()) return httpError(403, "mcp_egress_denied");
      tokens.push(fresh.token);
      response = await send(fresh.token);
    }
    if (writeDispatched && (response.status < 200 || response.status >= 300)) {
      await cancelBody(response);
      if (response.status === 401) await diagnose(issueCode.authRejected);
      if (response.status === 403) await diagnose(issueCode.accessDenied);
      return connectorError(502, issueCode.writeUnconfirmed);
    }
    if (response.status === 404 && current?.upstreamId !== undefined) {
      await cancelBody(response);
      await session.release(current.id);
      return httpError(404, "mcp_session_not_found");
    }
    if (response.status < 200 || response.status >= 300) {
      const retryAfterSeconds = mcpRetryAfterSeconds(response.headers.get("retry-after"), Date.now());
      await cancelBody(response);
      if (response.status === 401) return connectorError(503, issueCode.authRejected);
      if (response.status === 403) return connectorError(403, issueCode.accessDenied);
      if (response.status === 429) return connectorError(429, issueCode.rateLimited, retryAfterSeconds);
      return connectorError(502, issueCode.unavailable, response.status === 503 ? retryAfterSeconds : undefined);
    }
    if (!call) {
      await cancelBody(response);
      if (current) await session.release(current.id);
      return noBody(204);
    }
    if (upstreamCall?.id === undefined || call.id === undefined) {
      await cancelBody(response);
      return response.status === 202 ? noBody(202) : httpError(502, "mcp_invalid_response");
    }
    const upstreamId = response.headers.get(sessionHeader);
    const reply = await readMcpResponse(response, upstreamCall.id, options.maxBytes);
    if (!reply || tokens.some(token => containsSecret(reply, token) || upstreamId?.includes(token)) ||
        (upstreamId !== null && containsSecret(reply, upstreamId)) ||
        (current?.upstreamId && containsSecret(reply, current.upstreamId))) {
      if (writeDispatched) return connectorError(502, issueCode.writeUnconfirmed);
      await diagnose(issueCode.unavailable);
      return httpError(502, "mcp_invalid_response");
    }
    if (Object.hasOwn(reply, "error")) {
      if (writeDispatched) {
        await diagnose(issueCode.toolFailed);
        return connectorError(502, issueCode.writeUnconfirmed);
      }
      if (!await options.authorize()) return httpError(403, "mcp_egress_denied");
      await diagnose(issueCode.toolFailed);
      return rpcError(call.id, -32000, "mcp_upstream_call_failed");
    }
    let result = mcpObject(reply.result);
    if (writeDispatched) {
      const issue = result && toolError(result);
      if (issue) await diagnose(issue);
      if (!completedWrite(result) || request.signal.aborted || !await options.authorize() || !await settleWrite()) {
        return connectorError(502, issueCode.writeUnconfirmed);
      }
      if (request.signal.aborted || !await options.authorize()) return connectorError(502, issueCode.writeUnconfirmed);
      writeDispatched = false;
      claimedWrite = undefined;
    } else if (!await options.authorize()) return httpError(403, "mcp_egress_denied");
    if (initializeVersion) {
      const projected = result && projectInitialization(result);
      if (!projected || !initializing || (context7 && projected.protocolVersion !== legacyDefaultVersion)) {
        return httpError(502, "mcp_invalid_response");
      }
      let downstreamId: string | undefined;
      if (upstreamId === null) {
        if (!await session.release(initializing, true)) return httpError(502, "mcp_invalid_session");
      } else {
        if (!sessionIdPattern.test(upstreamId) || !await session.commit(initializing, upstreamId, projected.protocolVersion,
          { requestedVersion: initializeVersion, result: projected })) return httpError(502, "mcp_invalid_session");
        downstreamId = initializing;
      }
      initializing = undefined;
      if (!await options.authorize() || request.signal.aborted) return httpError(403, "mcp_egress_denied");
      return json({ jsonrpc: "2.0", id: call.id, result: projected }, 200, downstreamId);
    }
    if (call.method === "tools/list") {
      if (context7 && result?.nextCursor !== undefined) return httpError(502, "mcp_invalid_response");
      result = result && projectMcpTools(result, connector, mode, options.githubCi !== undefined && call.params.cursor === undefined);
    }
    if (!result) return httpError(502, "mcp_invalid_response");
    const toolIssue = call.method === "tools/call" ? toolError(result) : undefined;
    if (toolIssue) await diagnose(toolIssue);
    return json({ jsonrpc: "2.0", id: call.id, result });
  } catch {
    return connectorError(502, writeDispatched ? issueCode.writeUnconfirmed : issueCode.unavailable);
  } finally {
    if (claimedWrite !== undefined && !writeDispatched && !await settleWrite()) await diagnose(issueCode.writeUnconfirmed);
    // A lost commit acknowledgement can leave a ready session for the retry.
    if (initializing) await session.release(initializing, true).catch(() => undefined);
  }
}
