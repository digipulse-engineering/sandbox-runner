import { Buffer } from "node:buffer";
import { createPrivateKey, sign } from "node:crypto";
import { validRepository } from "./run-input-validation.mjs";

export { validRepository };

export const githubApiOrigin = "https://api.github.com";
export const githubApiVersion = "2026-03-10";
export const tokenPattern = /^[a-z0-9._~-]+$/i;
const clockSkewSeconds = 60;
const installationTokenLifetimeSeconds = 60 * 60;

export type GithubRepository = {
  readonly owner: string;
  readonly name: string;
  readonly repositoryId: number;
};

export type GithubAppCredentials = {
  readonly appClientId: string;
  readonly installationId: number | string;
  readonly privateKeyPem: string;
};

type GithubToken = {
  readonly repository: GithubRepository;
  readonly token: string;
  /** Unix timestamp in milliseconds. */
  readonly expiresAt: number;
};
export type GithubReadToken = GithubToken & { readonly contents?: never };
export type GithubPublicationToken = GithubToken & { readonly contents: "write" };
type GithubTokenPermissions = {
  contents?: "read" | "write";
  issues?: "read" | "write";
  actions?: "read";
  checks?: "read";
};

type GithubReadErrorCode = "github_repository_not_allowed" | "github_allowlist_invalid" |
  "github_app_invalid" | "github_token_unavailable" | "github_token_invalid";

export class GithubReadError extends Error {
  readonly code: GithubReadErrorCode;

  constructor(code: GithubReadErrorCode) {
    super(code);
    this.name = "GithubReadError";
    this.code = code;
  }
}

export function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function appJwt(credentials: GithubAppCredentials, now: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  try {
    if (typeof credentials.appClientId !== "string" || credentials.appClientId.trim() !== credentials.appClientId ||
        !/^(?:[a-z0-9]+|Iv1\.[a-f0-9]+)$/i.test(credentials.appClientId)) throw new Error();
    const key = createPrivateKey(credentials.privateKeyPem);
    if (key.asymmetricKeyType !== "rsa") throw new Error();
    const seconds = Math.floor(now / 1_000);
    // GitHub recommends backdating iat by 60 seconds and allows exp at most 10 minutes ahead.
    const payload = encode({ iat: seconds - clockSkewSeconds, exp: seconds + 10 * 60, iss: credentials.appClientId });
    const message = encode({ alg: "RS256", typ: "JWT" }) + "." + payload;
    return message + "." + sign("RSA-SHA256", Buffer.from(message), key).toString("base64url");
  } catch {
    throw new GithubReadError("github_app_invalid");
  }
}

export function validExpiry(expiresAt: number, now: number): boolean {
  return Number.isFinite(expiresAt) && expiresAt > now &&
    expiresAt <= now + (installationTokenLifetimeSeconds + clockSkewSeconds) * 1_000;
}

export type GithubFetchOptions = { fetcher?: typeof fetch; now?: () => number };

export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function matchesRepository(repositories: unknown, repository: GithubRepository): boolean {
  const selected = Array.isArray(repositories) && repositories.length === 1 ? object(repositories[0]) : undefined;
  return selected?.id === repository.repositoryId &&
    selected.full_name === `${repository.owner}/${repository.name}` && selected.private === true;
}

async function verifyTokenRepository(token: string, repository: GithubRepository, fetcher: typeof fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(`${githubApiOrigin}/installation/repositories?per_page=2`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + token,
        "user-agent": "sandbox-runner",
        "x-github-api-version": githubApiVersion,
      },
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    throw new GithubReadError("github_token_unavailable");
  }
  if (response.status !== 200) {
    await discard(response);
    throw new GithubReadError("github_token_unavailable");
  }
  const value = object(await response.json().catch(() => undefined));
  if (value?.total_count !== 1 || !matchesRepository(value.repositories, repository)) {
    throw new GithubReadError("github_token_invalid");
  }
}

/** Mint in the Worker. The returned token must never be persisted or put into the sandbox. */
async function mintGithubToken(
  repository: GithubRepository,
  credentials: GithubAppCredentials,
  requestedPermissions: GithubTokenPermissions,
  { fetcher = fetch, now = Date.now }: GithubFetchOptions = {},
): Promise<GithubToken> {
  const installationId = Number(credentials.installationId);
  if (!positiveId(installationId) || String(installationId) !== String(credentials.installationId) ||
      !positiveId(repository.repositoryId) || !validRepository(repository.owner, repository.name)) {
    throw new GithubReadError("github_app_invalid");
  }
  const jwt = appJwt(credentials, now());
  let response: Response;
  try {
    response = await fetcher(`${githubApiOrigin}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + jwt,
        "content-type": "application/json",
        "user-agent": "sandbox-runner",
        "x-github-api-version": githubApiVersion,
      },
      body: JSON.stringify({ repository_ids: [repository.repositoryId], permissions: requestedPermissions }),
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    throw new GithubReadError("github_token_unavailable");
  }
  if (response.status !== 201) {
    await discard(response);
    throw new GithubReadError("github_token_unavailable");
  }
  let value;
  try {
    value = object(await response.json());
  } catch {
    throw new GithubReadError("github_token_invalid");
  }
  const permissions = object(value?.permissions);
  const { token, expires_at: expires } = value ?? {};
  const expiresAt = typeof expires === "string" ? Date.parse(expires) : NaN;
  if (typeof token !== "string" || token.trim() !== token || !tokenPattern.test(token) || !validExpiry(expiresAt, now()) ||
      !permissions || Object.entries(requestedPermissions).some(([name, level]) => permissions[name] !== level) ||
      Object.entries(permissions).some(([name, level]) =>
        name === "metadata" ? level !== "read" : !Object.hasOwn(requestedPermissions, name)) ||
      (value?.repository_selection !== undefined && value.repository_selection !== "selected")) {
    throw new GithubReadError("github_token_invalid");
  }
  if (value && Object.hasOwn(value, "repositories")) {
    if (!matchesRepository(value.repositories, repository)) throw new GithubReadError("github_token_invalid");
  } else {
    await verifyTokenRepository(token, repository, fetcher);
    if (!validExpiry(expiresAt, now())) throw new GithubReadError("github_token_invalid");
  }
  return { repository, token, expiresAt };
}

export function mintGithubReadToken(
  repository: GithubRepository, credentials: GithubAppCredentials, options?: GithubFetchOptions,
): Promise<GithubReadToken> {
  return mintGithubToken(repository, credentials, { contents: "read" }, options);
}

export async function mintGithubPublicationToken(
  repository: GithubRepository, credentials: GithubAppCredentials, options?: GithubFetchOptions,
): Promise<GithubPublicationToken> {
  const token = await mintGithubToken(repository, credentials, { contents: "write" }, options);
  return { ...token, contents: "write" };
}

/** GitHub MCP issue writes use a separate grant that keeps Contents read-only. */
export function mintGithubMcpToken(
  repository: GithubRepository, credentials: GithubAppCredentials,
  mode: "read-only" | "read-write", options?: GithubFetchOptions,
): Promise<GithubToken> {
  if (mode !== "read-only" && mode !== "read-write") throw new GithubReadError("github_app_invalid");
  return mintGithubToken(repository, credentials, { contents: "read", issues: mode === "read-only" ? "read" : "write" }, options);
}

export function mintGithubCiToken(
  repository: GithubRepository, credentials: GithubAppCredentials, options?: GithubFetchOptions,
): Promise<GithubReadToken> {
  return mintGithubToken(repository, credentials, { actions: "read", checks: "read" }, options);
}
