import { Buffer } from "node:buffer";
import { discard, GithubReadError, object, positiveId, tokenPattern, validExpiry, validRepository } from "./github-auth.ts";
import type { GithubReadToken, GithubRepository } from "./github-auth.ts";
import { guardedForward } from "./relay.ts";
import type { EgressSubject, Journal } from "./relay.ts";

export { GithubReadError, mintGithubReadToken } from "./github-auth.ts";
export type { GithubAppCredentials, GithubReadToken, GithubRepository } from "./github-auth.ts";

const gitOrigin = "https://github.com";
export const githubGitHost = "github.harness.internal";
const interceptOrigin = "https://" + githubGitHost;
const discoveryQuery = "?service=git-upload-pack";
const uploadRequest = "application/x-git-upload-pack-request";

/** Bind an exact ASCII slug to the immutable repository ID selected by the operator. */
export function resolveGithubRepository(slug: string, allowlistJson: string): GithubRepository {
  let allowlist;
  try {
    allowlist = object(JSON.parse(allowlistJson));
  } catch {
    throw new GithubReadError("github_allowlist_invalid");
  }
  if (!allowlist) throw new GithubReadError("github_allowlist_invalid");
  const seen = new Set<string>();
  let admitted: GithubRepository | undefined;
  for (const [key, repositoryId] of Object.entries(allowlist)) {
    const [owner, name, extra] = key.split("/");
    const folded = key.toLowerCase();
    if (extra !== undefined || name === undefined || !validRepository(owner, name) ||
        !positiveId(repositoryId) || seen.has(folded)) {
      throw new GithubReadError("github_allowlist_invalid");
    }
    seen.add(folded);
    if (key === slug) admitted = { owner, name, repositoryId };
  }
  if (!admitted) throw new GithubReadError("github_repository_not_allowed");
  return admitted;
}

export function githubCloneUrl(repository: GithubRepository): string {
  return `${interceptOrigin}/${repository.owner}/${repository.name}.git`;
}

type GithubRelay = {
  readonly repository: GithubRepository;
  readonly getToken: (repository: GithubRepository) => Promise<GithubReadToken>;
  readonly subject: EgressSubject;
  readonly journal: Journal;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
};

function failure(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

/** Call only from the authenticated run's Git egress entrypoint. */
export async function forwardGithubRead(request: Request, {
  repository, getToken, subject, journal, fetcher = fetch, now = Date.now,
}: GithubRelay): Promise<Response> {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (!validRepository(repository.owner, repository.name) || !positiveId(repository.repositoryId) ||
      url.origin !== interceptOrigin ||
      (host !== null && host.toLowerCase() !== githubGitHost)) {
    return failure("github_egress_denied", 403);
  }
  const cloneUrl = githubCloneUrl(repository);
  const encoding = request.headers.get("content-encoding");
  const discovery = request.method === "GET" && request.url === cloneUrl + "/info/refs" + discoveryQuery;
  const upload = request.method === "POST" && request.url === cloneUrl + "/git-upload-pack" &&
    request.headers.get("content-type") === uploadRequest && request.body !== null &&
    (encoding === null || encoding === "gzip");
  if (!discovery && !upload) {
    return failure("github_egress_denied", 403);
  }

  try {
    const grant = await getToken(repository);
    if (grant.contents !== undefined || grant.repository.repositoryId !== repository.repositoryId || grant.repository.owner !== repository.owner ||
        grant.repository.name !== repository.name || typeof grant.token !== "string" ||
        !tokenPattern.test(grant.token) || !validExpiry(grant.expiresAt, now())) {
      return failure("github_read_unavailable", 502);
    }
    const contentType = discovery ? "application/x-git-upload-pack-advertisement" : "application/x-git-upload-pack-result";
    const protocol = request.headers.get("git-protocol");
    const response = await guardedForward(request, [{
      host: githubGitHost,
      upstream: gitOrigin,
      headers: { authorization: "Basic " + Buffer.from("x-access-token:" + grant.token).toString("base64") },
      strip: [],
      allow: [{ method: request.method, path: url.pathname, ...(discovery ? { searches: [discoveryQuery] } : {}) }],
    }], subject, journal, (target, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      const headers = new Headers({ accept: contentType, "accept-encoding": "identity", "user-agent": "sandbox-runner" });
      if (authorization) headers.set("authorization", authorization);
      if (upload) headers.set("content-type", uploadRequest);
      if (upload && encoding) headers.set("content-encoding", encoding);
      if (protocol === "version=1" || protocol === "version=2") headers.set("git-protocol", protocol);
      return fetcher(target, { ...init, headers, cache: "no-store" });
    });
    if (response.status !== 200 || response.headers.get("content-type") !== contentType) {
      await discard(response);
      const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
      return failure("github_read_failed", status);
    }
    // Keep the pack/advertisement stream intact and expose only its framing headers.
    const filtered = new Response(response.body, response);
    for (const name of [...filtered.headers.keys()]) {
      if (name !== "content-type" && name !== "content-length" && name !== "content-encoding") {
        filtered.headers.delete(name);
      }
    }
    filtered.headers.set("cache-control", "no-store");
    return filtered;
  } catch {
    return failure("github_read_unavailable", 502);
  }
}
