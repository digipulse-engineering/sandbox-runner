import { mcpConnectorCodes as code, mcpRetryAfterSeconds } from "./mcp-diagnostic.mjs";
import type { McpConnectorCode } from "./mcp-diagnostic.mjs";
import { readMcpJson } from "./mcp-http.ts";
import { context7Resource, mcpOAuthIssuer, isMcpOAuthBinding, oauthHttpsUrl, oauthObject, oauthOpaque, oauthScopes, oauthTokenFields } from "./mcp-oauth-format.mjs";

export { isMcpOAuthBinding };

type TokenFields = { readonly accessToken: string; readonly refreshToken: string; readonly expiresAt: number };
export type McpOAuthGrant = TokenFields & {
  readonly version: 1;
  readonly generation: string;
  readonly resource: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly scope: string;
};

export function parseMcpOAuthGrant(secret: unknown, resource: string): McpOAuthGrant | undefined {
  if (typeof secret !== "string") return;
  const endpoint = oauthHttpsUrl(resource);
  if (!endpoint) return;
  try {
    const grant = oauthObject(JSON.parse(secret));
    if (grant?.version !== 1 || grant.resource !== resource || !oauthHttpsUrl(grant.tokenEndpoint, mcpOAuthIssuer(resource)) ||
        (resource === context7Resource && grant.tokenEndpoint !== "https://context7.com/api/oauth/token") ||
        typeof grant.generation !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(grant.generation) ||
        !oauthOpaque(grant.clientId) || !oauthScopes(grant.scope) || !oauthOpaque(grant.accessToken) ||
        !oauthOpaque(grant.refreshToken) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= 0) return;
    return {
      version: 1, generation: grant.generation, resource, tokenEndpoint: grant.tokenEndpoint,
      clientId: grant.clientId, scope: grant.scope, accessToken: grant.accessToken,
      refreshToken: grant.refreshToken, expiresAt: grant.expiresAt,
    };
  } catch {
    return;
  }
}

type CredentialFailure = { readonly status: "failed"; readonly code: McpConnectorCode; readonly retryAfterSeconds?: number };
export type McpCredentialResult = { readonly status: "ready"; readonly token: string } | CredentialFailure;
type Rotation =
  | { readonly status: "pending"; readonly resource?: string; readonly failure?: CredentialFailure }
  | { readonly status: "rotated"; readonly resource?: string; readonly token: TokenFields;
    readonly retry?: { readonly code: McpConnectorCode; readonly at: number } };
type Flight = { readonly resource: string; readonly result: Promise<McpCredentialResult> };
type CredentialStorage = Pick<DurableObjectStorage, "get" | "put">;
type Options = { readonly fetcher?: typeof fetch; readonly now?: () => number; readonly signal?: () => AbortSignal };
const oauthResponseBytes = 64 * 1_024;
export const mcpOAuthRequestTimeoutMs = 30_000;
const definiteConfigurationErrors = new Set([
  "invalid_client", "invalid_request", "invalid_scope", "invalid_target", "unauthorized_client", "unsupported_grant_type",
]);

export async function mcpTokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function failure(code: McpConnectorCode): CredentialFailure {
  return { status: "failed", code };
}

/** One coordinator per Worker installation, with a flight per credential generation. */
export class McpOAuthCredentials {
  readonly #storage: CredentialStorage;
  readonly #fetcher: typeof fetch;
  readonly #now: () => number;
  readonly #signal: () => AbortSignal;
  readonly #inFlight = new Map<string, Flight>();

  constructor(storage: CredentialStorage, { fetcher = fetch, now = Date.now,
    // Bound an OAuth subrequest to the same default window as the CLI's network commands.
    signal = () => AbortSignal.timeout(mcpOAuthRequestTimeoutMs),
  }: Options = {}) {
    this.#storage = storage;
    this.#fetcher = fetcher;
    this.#now = now;
    this.#signal = signal;
  }

  async resolve(binding: string, grant: McpOAuthGrant, rejectedFingerprint?: string): Promise<McpCredentialResult> {
    if (!isMcpOAuthBinding(binding) || (rejectedFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(rejectedFingerprint))) {
      return failure(code.configurationInvalid);
    }
    const key = `mcp-oauth:${binding}:${grant.generation}`;
    const existing = this.#inFlight.get(key);
    if (existing) {
      if (existing.resource !== grant.resource) return failure(code.configurationInvalid);
      const result = await existing.result;
      if (result.status !== "ready" || rejectedFingerprint === undefined ||
          await mcpTokenFingerprint(result.token) !== rejectedFingerprint) return result;
      // An ordinary lookup can return the old token before a rejection arrives.
      return this.resolve(binding, grant, rejectedFingerprint);
    }
    const result = this.#readOrRotate(key, grant, rejectedFingerprint).finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, { resource: grant.resource, result });
    return result;
  }

  async #readOrRotate(key: string, grant: McpOAuthGrant, rejectedFingerprint?: string): Promise<McpCredentialResult> {
    const rotation = await this.#storage.get<Rotation>(key);
    if (rotation?.resource !== undefined && rotation.resource !== grant.resource) return failure(code.configurationInvalid);
    // Older pending records may have spent the refresh token before an interruption.
    if (rotation?.status === "pending") return rotation.failure ?? failure(code.refreshUnconfirmed);
    const current = rotation?.status === "rotated" ? rotation.token : grant;
    const now = this.#now();
    const rejected = rejectedFingerprint !== undefined && await mcpTokenFingerprint(current.accessToken) === rejectedFingerprint;
    if (!rejected && current.expiresAt > now) return { status: "ready", token: current.accessToken };
    if (rotation?.status === "rotated" && rotation.retry && rotation.retry.at > now) {
      return { ...failure(rotation.retry.code), retryAfterSeconds: Math.ceil((rotation.retry.at - now) / 1_000) };
    }

    // This marker must commit before a rotating refresh token can leave the Worker.
    try {
      await this.#storage.put(key, { status: "pending", resource: grant.resource } satisfies Rotation);
    } catch {
      return failure(code.unavailable);
    }
    let response: Response;
    let body: Record<string, unknown> | undefined;
    try {
      // The Workers runtime rejects global fetch when it receives this object as a receiver.
      const fetcher = this.#fetcher;
      response = await fetcher(grant.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token", refresh_token: current.refreshToken,
          client_id: grant.clientId, resource: grant.resource,
        }),
        redirect: "manual", cache: "no-store", signal: this.#signal(),
      });
      body = await readMcpJson(response, oauthResponseBytes);
    } catch {
      return failure(code.refreshUnconfirmed);
    }
    if (response.status !== 200) {
      if (response.status === 400 && body?.error === "invalid_grant") {
        return this.#block(key, grant.resource, code.reauthRequired);
      }
      if ([400, 401].includes(response.status) && typeof body?.error === "string" && definiteConfigurationErrors.has(body.error)) {
        return this.#block(key, grant.resource, code.configurationInvalid);
      }
      // Only an explicit OAuth refusal is safe to retry. Retry-After alone controls
      // timing, so a bare 429/5xx may still have spent the current refresh token.
      if ([429, 503].includes(response.status) && body?.error === "temporarily_unavailable") {
        const responseAt = this.#now();
        const retryAfterSeconds = mcpRetryAfterSeconds(response.headers.get("retry-after"), responseAt);
        const token = { accessToken: current.accessToken, refreshToken: current.refreshToken, expiresAt: 0 };
        const retryCode = response.status === 429 ? code.rateLimited : code.unavailable;
        const recorded = await this.#record(key, { status: "rotated", resource: grant.resource, token,
          ...(retryAfterSeconds === undefined ? {} : { retry: { code: retryCode, at: responseAt + retryAfterSeconds * 1_000 } }),
        });
        if (!recorded) return failure(code.refreshUnconfirmed);
        return { ...failure(retryCode),
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        };
      }
      return failure(code.refreshUnconfirmed);
    }
    const token = oauthTokenFields(body, grant.resource, oauthScopes(grant.scope), now, current.refreshToken);
    if (!token) return failure(code.refreshUnconfirmed);
    if (rejectedFingerprint !== undefined && await mcpTokenFingerprint(token.accessToken) === rejectedFingerprint) {
      return this.#block(key, grant.resource, code.authRejected);
    }
    if (!await this.#record(key, { status: "rotated", resource: grant.resource, token })) {
      return failure(code.refreshUnconfirmed);
    }
    return token.expiresAt > this.#now() ? { status: "ready", token: token.accessToken } : failure(code.unavailable);
  }

  async #block(key: string, resource: string, reason: McpConnectorCode): Promise<CredentialFailure> {
    const blocked = failure(reason);
    return await this.#record(key, { status: "pending", resource, failure: blocked })
      ? blocked : failure(code.refreshUnconfirmed);
  }

  async #record(key: string, state: Rotation): Promise<boolean> {
    try {
      await this.#storage.put(key, state);
      return true;
    } catch {
      return false;
    }
  }
}
