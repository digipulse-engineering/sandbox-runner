export const context7Resource = "https://mcp.context7.com/mcp/oauth";
export const context7Issuer = "https://context7.com";

// Context7 serves its MCP resource and authorization server on separate origins.
export function mcpOAuthIssuer(resource) {
  return resource === context7Resource ? context7Issuer : oauthHttpsUrl(resource)?.origin;
}

export const mcpOAuthBindingPrefix = "SANDBOX_RUNNER_MCP_CREDENTIAL_";

export function isMcpOAuthBinding(value) {
  return typeof value === "string" && /^SANDBOX_RUNNER_MCP_CREDENTIAL_[A-Z][A-Z0-9_]*$/.test(value);
}

export function oauthHttpsUrl(value, origin) {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.href === value && url.protocol === "https:" && !url.username && !url.password &&
        !url.search && !url.hash && (origin === undefined || url.origin === origin)) return url;
  } catch {
    return;
  }
}

export function oauthObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function oauthOpaque(value) {
  // Some providers issue opaque tokens containing colons. Exclude spaces and header delimiters.
  return typeof value === "string" && /^[\x21-\x2b\x2d-\x7e]+$/.test(value);
}

export function oauthScopes(value) {
  if (typeof value !== "string") return;
  const scopes = value.split(" ");
  // OAuth 2.0 scope-token grammar, RFC 6749 §3.3.
  if (scopes.every(scope => /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)) && new Set(scopes).size === scopes.length) {
    return scopes;
  }
}

export function sameOAuthScopes(first, second) {
  return first.length === second.length && first.every(scope => second.includes(scope));
}

export function oauthTokenFields(value, resource, requestedScopes, now, previousRefreshToken) {
  const token = oauthObject(value);
  const refreshToken = token?.refresh_token === undefined ? previousRefreshToken : token.refresh_token;
  if (!token || typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer" ||
      !oauthOpaque(token.access_token) || !oauthOpaque(refreshToken) ||
      !Number.isSafeInteger(token.expires_in) || token.expires_in <= 0) return;
  // Some servers omit resource. Check it whenever the issuer returns it.
  if (token.resource !== undefined && token.resource !== resource &&
      !(Array.isArray(token.resource) && token.resource.length === 1 && token.resource[0] === resource)) return;
  const actualScopes = token.scope === undefined ? requestedScopes : oauthScopes(token.scope);
  if (!actualScopes || !sameOAuthScopes(requestedScopes, actualScopes)) return;
  const expiresAt = now + token.expires_in * 1_000;
  if (!Number.isSafeInteger(expiresAt)) return;
  return { accessToken: token.access_token, refreshToken, expiresAt };
}
