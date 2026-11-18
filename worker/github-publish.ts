import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { operationId } from "./contract.ts";
import { discard, githubApiOrigin, githubApiVersion, mintGithubPublicationToken, mintGithubReadToken, object, tokenPattern, validExpiry } from "./github-auth.ts";
import type { GithubAppCredentials, GithubFetchOptions, GithubPublicationToken, GithubReadToken, GithubRepository } from "./github-auth.ts";
import { maxPublicationWireBytes, readPublicationBytes, safePublicationPath } from "./github-export.ts";

type FileMode = "100644" | "100755";
type TreeMode = FileMode | "040000" | "120000" | "160000";
type TreeEntry = { path: string; mode: TreeMode; type: "blob" | "tree" | "commit"; sha: string };
type TreePatch = { base_tree?: string; tree: (Omit<TreeEntry, "sha"> & { sha: string | null })[] };

export type GithubPublicationChange =
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "put"; readonly path: string; readonly mode: FileMode; readonly blobSha: string; readonly bytes: Uint8Array };

type CommitIdentity = { readonly name: string; readonly email: string; readonly date: string };
type CommitMetadata = { readonly message: string; readonly author: CommitIdentity; readonly committer: CommitIdentity };

export type GithubPublicationInput = {
  readonly repository: GithubRepository;
  readonly operationId: string;
  readonly baseSha: string;
  readonly expectedBaseTreeSha: string;
  readonly expectedTreeSha: string;
  readonly changes: readonly GithubPublicationChange[];
  readonly commit: CommitMetadata;
};

/** Store this receipt durably before calling publishGithubReference. It contains no credentials. */
export type GithubPreparedPublication = {
  readonly repository: GithubRepository;
  readonly operationId: string;
  readonly baseSha: string;
  readonly treeSha: string;
  readonly commitSha: string;
};

export type GithubPublicationResult =
  | { status: "published"; ref: string; commitSha: string }
  | { status: "conflict"; ref: string; actualSha: string }
  | { status: "uncertain"; ref: string }
  | { status: "reconcile"; ref: string }
  | { status: "denied"; ref: string };

export type PublicationOptions = GithubFetchOptions & (
  { credentials: GithubAppCredentials; fixtureToken?: never } |
  { credentials?: never; fixtureToken: (repository: GithubRepository, mode: "read" | "write") => GithubReadToken | GithubPublicationToken }
);
type ErrorCode = "github_publication_invalid" | "github_publication_unavailable" |
  "github_base_unverified" | "github_candidate_unverified" | "github_objects_unverified" | "github_publication_authority_closed";

export class GithubPublicationError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(code);
    this.name = "GithubPublicationError";
    this.code = code;
  }
}

type GitData = (method: "GET" | "POST", path: string, data?: unknown) => Promise<Response>;
type Change = { kind: "delete" } | { kind: "put"; mode: FileMode; sha: string };
type Delta = { change?: Change; children: Map<string, Delta> };
type PlannedTree = { sha: string; patch: TreePatch };

function oid(value: unknown): value is string {
  return typeof value === "string" && value.length === 40 && /^[0-9a-f]{40}$/.test(value);
}

function canonicalId(value: string): boolean {
  return typeof value === "string" && operationId(value) === value;
}

function gitObjectSha(type: "blob" | "tree", bytes: Buffer): string {
  return createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
}

function treeSha(entries: TreeEntry[]): string {
  // Git compares a directory name as if it had a trailing slash.
  const names = entries.map(entry => ({
    entry,
    key: Buffer.from(entry.path + (entry.mode === "040000" ? "/" : "")),
  }));
  names.sort((left, right) => Buffer.compare(left.key, right.key));
  return gitObjectSha("tree", Buffer.concat(names.flatMap(({ entry }) => [
    Buffer.from(`${entry.mode === "040000" ? "40000" : entry.mode} ${entry.path}\0`),
    Buffer.from(entry.sha, "hex"),
  ])));
}

function treeMode(value: unknown): TreeMode | undefined {
  if (value === "40000" || value === "040000") return "040000";
  if (value === "100644" || value === "100755" || value === "120000" || value === "160000") return value;
}

function baseTreeEntry(value: unknown): TreeEntry | undefined {
  const entry = object(value);
  const mode = treeMode(entry?.mode);
  if (!entry || !mode || typeof entry.path !== "string" || !entry.path || !entry.path.isWellFormed() ||
      /[/\0]/u.test(entry.path) || !oid(entry.sha)) return;
  const type = mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob";
  if (entry.type === type) return { path: entry.path, mode, type, sha: entry.sha };
}

function addChanges(changes: readonly GithubPublicationChange[]): { delta: Delta; blobs: Map<string, string> } {
  const delta: Delta = { children: new Map() };
  const blobs = new Map<string, string>();
  if (!Array.isArray(changes) || changes.length === 0) throw new GithubPublicationError("github_publication_invalid");
  for (const change of changes) {
    if (!change || !safePublicationPath(change.path)) {
      throw new GithubPublicationError("github_publication_invalid");
    }
    const parts = change.path.split("/");
    let node = delta;
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    if (node.change) throw new GithubPublicationError("github_publication_invalid");
    if (change.kind === "delete") {
      node.change = { kind: "delete" };
    } else {
      if (change.kind !== "put" || (change.mode !== "100644" && change.mode !== "100755") ||
          !oid(change.blobSha) || !(change.bytes instanceof Uint8Array)) {
        throw new GithubPublicationError("github_publication_invalid");
      }
      const bytes = Buffer.from(change.bytes);
      if (gitObjectSha("blob", bytes) !== change.blobSha) throw new GithubPublicationError("github_candidate_unverified");
      const base64 = bytes.toString("base64");
      if (blobs.has(change.blobSha) && blobs.get(change.blobSha) !== base64) {
        throw new GithubPublicationError("github_candidate_unverified");
      }
      blobs.set(change.blobSha, base64);
      node.change = { kind: "put", mode: change.mode, sha: change.blobSha };
    }
  }
  return { delta, blobs };
}

function checkedIdentity(identity: CommitIdentity): CommitIdentity {
  if (!identity || typeof identity.name !== "string" || !identity.name.trim() || identity.name !== identity.name.trim() ||
      !identity.name.isWellFormed() || /[<>\p{Cc}\p{Cf}]/u.test(identity.name) ||
      typeof identity.email !== "string" || !identity.email.isWellFormed() ||
      !/^[^<>@\s\p{Cc}\p{Cf}]+@[^<>@\s\p{Cc}\p{Cf}]+$/u.test(identity.email) ||
      typeof identity.date !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(identity.date)) {
    throw new GithubPublicationError("github_publication_invalid");
  }
  const date = new Date(identity.date);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().replace(".000Z", "Z") !== identity.date) {
    throw new GithubPublicationError("github_publication_invalid");
  }
  return { name: identity.name, email: identity.email, date: identity.date };
}

function checkedMetadata(commit: CommitMetadata): CommitMetadata {
  if (!commit || typeof commit.message !== "string" || !commit.message.trim() ||
      !commit.message.isWellFormed() || /[\r\0]/u.test(commit.message)) {
    throw new GithubPublicationError("github_publication_invalid");
  }
  return { message: commit.message, author: checkedIdentity(commit.author), committer: checkedIdentity(commit.committer) };
}

async function gitData(repository: GithubRepository, mode: "read" | "write", {
  credentials, fixtureToken, fetcher = fetch, now = Date.now,
}: PublicationOptions): Promise<GitData> {
  const mint = mode === "write" ? mintGithubPublicationToken : mintGithubReadToken;
  const grant = fixtureToken ? fixtureToken(repository, mode) : await mint(repository, credentials, { fetcher, now })
    .catch(() => { throw new GithubPublicationError("github_publication_unavailable"); });
  if (grant.contents !== (mode === "write" ? "write" : undefined) || !tokenPattern.test(grant.token) ||
      grant.repository.repositoryId !== repository.repositoryId || grant.repository.owner !== repository.owner ||
      grant.repository.name !== repository.name) throw new GithubPublicationError("github_publication_unavailable");
  const origin = `${githubApiOrigin}/repos/${repository.owner}/${repository.name}/git/`;
  return async (method, path, data) => {
    if (!validExpiry(grant.expiresAt, now())) throw new GithubPublicationError("github_publication_unavailable");
    try {
      return await fetcher(origin + path, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: "Bearer " + grant.token,
          "user-agent": "sandbox-runner",
          "x-github-api-version": githubApiVersion,
          ...(data === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        cache: "no-store",
        redirect: "manual",
      });
    } catch {
      throw new GithubPublicationError("github_publication_unavailable");
    }
  };
}

async function apiJson(response: Response, status: number): Promise<unknown> {
  if (response.status !== status) {
    await discard(response);
    throw new GithubPublicationError("github_publication_unavailable");
  }
  try {
    const bytes = await readPublicationBytes(response.body, maxPublicationWireBytes, "github_publication_limit_exceeded");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    await discard(response);
    throw new GithubPublicationError("github_publication_unavailable");
  }
}

async function readTree(sha: string, api: GitData): Promise<Map<string, TreeEntry>> {
  const tree = object(await apiJson(await api("GET", "trees/" + sha), 200));
  if (tree?.sha !== sha || tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new GithubPublicationError("github_base_unverified");
  }
  const entries = new Map<string, TreeEntry>();
  for (const value of tree.tree) {
    const entry = baseTreeEntry(value);
    if (!entry || entries.has(entry.path)) throw new GithubPublicationError("github_base_unverified");
    entries.set(entry.path, entry);
  }
  if (treeSha([...entries.values()]) !== sha) throw new GithubPublicationError("github_base_unverified");
  return entries;
}

function hasPut(delta: Delta): boolean {
  return delta.change?.kind === "put" || [...delta.children.values()].some(hasPut);
}

async function planTree(
  baseSha: string | undefined, delta: Delta, api: GitData, plans: PlannedTree[], root = false,
): Promise<string | undefined> {
  const entries = baseSha ? await readTree(baseSha, api) : new Map<string, TreeEntry>();
  const changes: TreePatch["tree"] = [];
  for (const [path, node] of delta.children) {
    const base = entries.get(path);
    const change = node.change;
    if (change?.kind === "delete" && !base) throw new GithubPublicationError("github_publication_invalid");
    let next: TreeEntry | undefined;
    if (change?.kind === "put") {
      // Deleting the former directory's leaves is redundant when a file replaces it.
      if ([...node.children.values()].some(hasPut)) throw new GithubPublicationError("github_publication_invalid");
      next = { path, mode: change.mode, type: "blob", sha: change.sha };
    } else if (node.children.size > 0) {
      if (base && base.mode !== "040000" && change?.kind !== "delete") {
        throw new GithubPublicationError("github_publication_invalid");
      }
      const previous = change?.kind === "delete" ? undefined : base?.sha;
      const sha = await planTree(previous, node, api, plans);
      if (sha) next = { path, mode: "040000", type: "tree", sha };
    } else if (!base) {
      throw new GithubPublicationError("github_publication_invalid");
    }
    if (next) entries.set(path, next);
    else entries.delete(path);
    if (next?.sha !== base?.sha || next?.mode !== base?.mode) {
      if (next) changes.push(next);
      else if (base) changes.push({ ...base, sha: null });
    }
  }
  // Parent directories disappear when their last entry is removed. The root may be empty.
  if (entries.size === 0 && !root) return;
  const sha = treeSha([...entries.values()]);
  if (sha !== baseSha) {
    plans.push({ sha, patch: { ...(baseSha ? { base_tree: baseSha } : {}), tree: changes } });
  }
  return sha;
}

function matchesCommit(value: unknown, baseSha: string, treeSha: string): value is Record<string, unknown> & { sha: string } {
  const commit = object(value);
  return !!commit && oid(commit.sha) && commit.sha !== baseSha && object(commit.tree)?.sha === treeSha &&
    Array.isArray(commit.parents) && commit.parents.length === 1 && object(commit.parents[0])?.sha === baseSha;
}

function matchesIdentity(value: unknown, expected: CommitIdentity): boolean {
  const identity = object(value);
  return identity?.name === expected.name && identity.email === expected.email &&
    typeof identity.date === "string" && Date.parse(identity.date) === Date.parse(expected.date);
}

/** Create immutable objects and verify the one-parent commit. This phase never creates a ref. */
export async function prepareGithubPublication(
  input: GithubPublicationInput, options: PublicationOptions, allowObjectWrite: () => Promise<boolean>,
): Promise<GithubPreparedPublication> {
  const { operationId: id, baseSha, expectedBaseTreeSha, expectedTreeSha } = input;
  const repository = { ...input.repository };
  if (!canonicalId(id) || !oid(baseSha) || !oid(expectedBaseTreeSha) || !oid(expectedTreeSha)) {
    throw new GithubPublicationError("github_publication_invalid");
  }
  const metadata = checkedMetadata(input.commit);
  const { delta, blobs } = addChanges(input.changes);
  const api = await gitData(repository, "write", options);
  const create = async (path: string, data: unknown) => {
    if (!await allowObjectWrite()) throw new GithubPublicationError("github_publication_authority_closed");
    return apiJson(await api("POST", path, data), 201);
  };
  const base = object(await apiJson(await api("GET", "commits/" + baseSha), 200));
  const baseTree = object(base?.tree)?.sha;
  if (base?.sha !== baseSha || baseTree !== expectedBaseTreeSha) throw new GithubPublicationError("github_base_unverified");
  const plans: PlannedTree[] = [];
  const candidateTree = await planTree(baseTree, delta, api, plans, true);
  if (candidateTree !== expectedTreeSha || candidateTree === baseTree) throw new GithubPublicationError("github_candidate_unverified");
  for (const [sha, content] of blobs) {
    const blob = object(await create("blobs", { content, encoding: "base64" }));
    if (blob?.sha !== sha) throw new GithubPublicationError("github_objects_unverified");
  }
  for (const plan of plans) {
    const tree = object(await create("trees", plan.patch));
    if (tree?.sha !== plan.sha) throw new GithubPublicationError("github_objects_unverified");
  }
  const commit = await create("commits", { ...metadata, tree: candidateTree, parents: [baseSha] });
  if (!matchesCommit(commit, baseSha, candidateTree) || typeof commit.message !== "string" ||
      commit.message.replace(/\n$/u, "") !== metadata.message.replace(/\n$/u, "") ||
      !matchesIdentity(commit.author, metadata.author) || !matchesIdentity(commit.committer, metadata.committer)) {
    throw new GithubPublicationError("github_objects_unverified");
  }
  return { repository, operationId: id, baseSha, treeSha: candidateTree, commitSha: commit.sha };
}

async function readReference(api: GitData, branch: string, ref: string): Promise<string | "missing"> {
  const response = await api("GET", "ref/" + branch);
  if (response.status === 404) {
    await discard(response);
    return "missing";
  }
  const current = object(await apiJson(response, 200));
  const target = object(current?.object);
  if (current?.ref !== ref || target?.type !== "commit" || !oid(target.sha)) {
    throw new GithubPublicationError("github_objects_unverified");
  }
  return target.sha;
}

export function verifiedPublicationReceipt(receipt: GithubPreparedPublication): boolean {
  return canonicalId(receipt.operationId) && oid(receipt.baseSha) && oid(receipt.treeSha) && oid(receipt.commitSha) &&
    receipt.baseSha !== receipt.commitSha;
}

async function reconcileReference(
  receipt: GithubPreparedPublication, api: GitData, claim?: () => Promise<boolean>,
): Promise<GithubPublicationResult> {
  const { operationId: id, baseSha, treeSha, commitSha } = receipt;
  const branch = "heads/sandbox-runner/" + id;
  const ref = "refs/" + branch;
  const uncertain = { status: "uncertain", ref } as const;
  const reconcile = (sha: string): GithubPublicationResult => sha === commitSha
    ? { status: "published", ref, commitSha }
    : { status: "conflict", ref, actualSha: sha };
  try {
    const commit = await apiJson(await api("GET", "commits/" + commitSha), 200);
    if (!matchesCommit(commit, baseSha, treeSha) || commit.sha !== commitSha) return uncertain;
    const before = await readReference(api, branch, ref);
    if (before !== "missing") return reconcile(before);
    if (!claim) return uncertain;
    // A singular 404 can conceal lack of access. A successful empty prefix query proves absence.
    const matches = await apiJson(await api("GET", "matching-refs/" + branch), 200);
    if (!Array.isArray(matches)) return uncertain;
    if (matches.length !== 0) {
      const observed = await readReference(api, branch, ref);
      return observed === "missing" ? uncertain : reconcile(observed);
    }
    // The caller durably reserves the sole POST after the final readback and
    // with an already attested credential. Do not perform another I/O first.
    if (!await claim()) return { status: "denied", ref };
    try {
      await discard(await api("POST", "refs", { ref, sha: commitSha }));
    } catch {
      // The POST may have succeeded before its reply was lost. Never repeat it here.
    }
    // The submission may have exhausted its deadline. A separate alarm
    // reads the ref with a fresh deadline and a read-scoped grant.
    return { status: "reconcile", ref };
  } catch {
    return uncertain;
  }
}

/** Create only the fixed run branch, under the caller's durable claim. */
export async function publishGithubReference(
  receipt: GithubPreparedPublication, options: PublicationOptions, claim: () => Promise<boolean>,
): Promise<GithubPublicationResult> {
  if (!verifiedPublicationReceipt(receipt)) throw new GithubPublicationError("github_publication_invalid");
  return reconcileReference(receipt, await gitData(receipt.repository, "write", options), claim);
}

/** Recover an ambiguous write with a read-scoped token and no reference mutation. */
export async function reconcileGithubReference(
  receipt: GithubPreparedPublication, options: PublicationOptions,
): Promise<GithubPublicationResult> {
  if (!verifiedPublicationReceipt(receipt)) throw new GithubPublicationError("github_publication_invalid");
  return reconcileReference(receipt, await gitData(receipt.repository, "read", options));
}
