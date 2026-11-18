import { discard, githubApiOrigin, githubApiVersion, object, positiveId, tokenPattern, validExpiry, validRepository } from "./github-auth.ts";
import type { GithubReadToken, GithubRepository } from "./github-auth.ts";
import { readMcpJson } from "./mcp-http.ts";

const statuses = new Set(["completed", "in_progress", "pending", "queued", "requested", "waiting"]);
const conclusions = new Set(["action_required", "cancelled", "failure", "neutral", "skipped", "stale", "startup_failure", "success", "timed_out"]);

function projectEntry(value: unknown, kind: "actions" | "checks", slug: string, sha: string, token: string) {
  const item = object(value);
  if (!item || item.head_sha !== sha || !positiveId(item.id) ||
      (kind === "actions" && object(item.repository)?.full_name !== slug)) return;
  const status = typeof item.status === "string" && statuses.has(item.status) ? item.status : "unknown";
  const conclusion = item.conclusion === null ? null
    : typeof item.conclusion === "string" && conclusions.has(item.conclusion) ? item.conclusion : "unknown";
  const name = typeof item.name === "string" && !item.name.includes(token) ? item.name : undefined;
  const path = kind === "actions" ? `actions/runs/${item.id}` : `runs/${item.id}`;
  return { id: item.id, ...(name === undefined ? {} : { name }), status, conclusion,
    url: `https://github.com/${slug}/${path}` };
}

type GithubCiResult = { status: "ready"; value: Record<string, unknown> } | {
  status: "denied" | "unavailable" | "rate-limited";
};

/** Fetch only an authorized run's immutable SHA and project GitHub's responses onto status metadata. */
export async function readGithubCi(repository: GithubRepository, sha: string, page: number, options: {
  readonly getToken: () => Promise<GithubReadToken>;
  readonly authorize: () => Promise<boolean>;
  readonly fetcher: typeof fetch;
  readonly signal: AbortSignal;
  readonly maxBytes: number;
}): Promise<GithubCiResult> {
  if (!validRepository(repository.owner, repository.name) || !/^[a-f0-9]{40}$/u.test(sha) || !positiveId(page)) {
    return { status: "denied" };
  }
  const { getToken, authorize, fetcher, signal, maxBytes } = options;
  try {
    if (signal.aborted || !await authorize()) return { status: "denied" };
    const grant = await getToken();
    if (!validExpiry(grant.expiresAt, Date.now()) || !tokenPattern.test(grant.token) || grant.contents !== undefined ||
        grant.repository.repositoryId !== repository.repositoryId || grant.repository.owner !== repository.owner ||
        grant.repository.name !== repository.name) return { status: "unavailable" };
    if (signal.aborted || !await authorize()) return { status: "denied" };
    const slug = `${repository.owner}/${repository.name}`;
    const root = `${githubApiOrigin}/repos/${slug}`;
    const headers = { accept: "application/vnd.github+json", authorization: "Bearer " + grant.token,
      "user-agent": "sandbox-runner", "x-github-api-version": githubApiVersion };
    const query = async (path: string, field: string, kind: "actions" | "checks") => {
      const response = await fetcher(`${root}/${path}&page=${page}`, { method: "GET", headers, redirect: "manual", cache: "no-store", signal });
      if (response.status !== 200) {
        await discard(response);
        if (response.status === 429 || (response.status === 403 &&
            (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")))) return "rate-limited" as const;
        return response.status === 403 ? "denied" as const : "unavailable" as const;
      }
      const data = await readMcpJson(response, maxBytes, ["application/json", "application/vnd.github+json"]);
      const rows = data?.[field];
      if (!data || typeof data.total_count !== "number" || !Number.isSafeInteger(data.total_count) ||
          !Array.isArray(rows) || data.total_count < rows.length) {
        return "unavailable" as const;
      }
      const entries = rows.map(value => projectEntry(value, kind, slug, sha, grant.token));
      if (entries.some(entry => entry === undefined)) return "unavailable" as const;
      return { totalCount: data.total_count, entries };
    };
    const [actions, checks] = await Promise.all([
      query(`actions/runs?head_sha=${sha}`, "workflow_runs", "actions"),
      query(`commits/${sha}/check-runs?filter=latest`, "check_runs", "checks"),
    ]);
    if (signal.aborted || !await authorize()) return { status: "denied" };
    if (typeof actions === "string") return { status: actions };
    if (typeof checks === "string") return { status: checks };
    return { status: "ready", value: { repository: slug, sha, page, actions, checks } };
  } catch {
    return { status: "unavailable" };
  }
}
