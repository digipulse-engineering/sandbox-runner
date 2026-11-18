import { runDeadlineFetch } from "./agent-deadline.ts";
import { discard, githubApiOrigin, githubApiVersion, tokenPattern, validExpiry } from "./github-auth.ts";
import type { GithubReadToken, GithubRepository } from "./github-auth.ts";
import { validGitReference } from "./github-source.ts";

export const commitShaMediaType = "application/vnd.github.sha";
export type GithubReferenceError = "github_reference_not_found" | "github_reference_unavailable";

async function readCommitSha(response: Response): Promise<string | undefined> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== commitShaMediaType || !response.body) {
    await discard(response);
    return;
  }
  // The negotiated representation is one SHA-1 (40 ASCII hex bytes).
  const result = new Uint8Array(40);
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.byteLength > result.length) {
        await reader.cancel();
        return;
      }
      result.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== result.length) return;
  const sha = new TextDecoder().decode(result);
  if (/^[a-f0-9]{40}$/u.test(sha)) return sha;
}

export async function resolveGithubReference(repository: GithubRepository, ref: string, deadlineAt: number, options: {
  getToken: (repository: GithubRepository, fetcher: typeof fetch) => Promise<GithubReadToken>;
  fetcher?: typeof fetch;
}): Promise<{ sha: string } | GithubReferenceError> {
  if (!validGitReference(ref) || Date.now() >= deadlineAt) return "github_reference_unavailable";
  const fetcher = runDeadlineFetch(options.fetcher ?? fetch, deadlineAt);
  try {
    const grant = await options.getToken(repository, fetcher);
    if (grant.contents !== undefined || !tokenPattern.test(grant.token) || !validExpiry(grant.expiresAt, Date.now()) ||
        grant.repository.repositoryId !== repository.repositoryId || grant.repository.owner !== repository.owner ||
        grant.repository.name !== repository.name) return "github_reference_unavailable";
    const url = `${githubApiOrigin}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}` +
      `/commits/${encodeURIComponent(ref)}`;
    const response = await fetcher(url, { method: "GET", redirect: "manual", cache: "no-store", headers: {
      accept: commitShaMediaType, authorization: "Bearer " + grant.token,
      "user-agent": "sandbox-runner", "x-github-api-version": githubApiVersion,
    } });
    if (response.status !== 200) {
      await discard(response);
      return response.status === 404 || response.status === 422 ? "github_reference_not_found" : "github_reference_unavailable";
    }
    const sha = await readCommitSha(response);
    return sha && Date.now() < deadlineAt ? { sha } : "github_reference_unavailable";
  } catch {
    return "github_reference_unavailable";
  }
}
