import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { githubApiOrigin, object } from "./github-auth.ts";
import type { GithubPublicationToken, GithubReadToken, GithubRepository } from "./github-auth.ts";
import { safePublicationPath } from "./github-export.ts";
import { githubFixtureData } from "./github-fixture-data.ts";

const fixtureRead = "synthetic-publication-read";
const fixtureWrite = "synthetic-publication-write";

export function githubPublicationFixtureToken(
  repository: GithubRepository, mode: "read" | "write",
): GithubReadToken | GithubPublicationToken {
  const grant = { repository, token: mode === "write" ? fixtureWrite : fixtureRead, expiresAt: Date.now() + 60_000 };
  return mode === "write" ? { ...grant, contents: "write" } : grant;
}

type TreeEntry = { path: string; mode: string; type: string; sha: string };
type FixtureCommit = { sha: string; tree: { sha: string }; parents: { sha: string }[]; message: string; author: unknown; committer: unknown };

const oid = (value: unknown): value is string => typeof value === "string" && value.length === 40 && /^[0-9a-f]{40}$/u.test(value);
const hash = (type: string, bytes: Buffer) => createHash("sha1").update(type + " " + bytes.length + "\0").update(bytes).digest("hex");

function gitTreeSha(entries: TreeEntry[]) {
  const entriesByName = entries.map(entry => ({ entry, key: Buffer.from(entry.path + (entry.type === "tree" ? "/" : "")) }));
  entriesByName.sort((left, right) => left.key.compare(right.key));
  return hash("tree", Buffer.concat(entriesByName.flatMap(({ entry }) => [
    Buffer.from((entry.type === "tree" ? "40000" : entry.mode) + " " + entry.path + "\0"), Buffer.from(entry.sha, "hex"),
  ])));
}

function identity(raw: unknown) {
  const value = object(raw);
  if (!value || typeof value.name !== "string" || typeof value.email !== "string" || typeof value.date !== "string") return;
  const time = Date.parse(value.date);
  if (Number.isFinite(time)) return value.name + " <" + value.email + "> " + Math.floor(time / 1000) + " +0000";
}

function notFound() {
  return Response.json({ error: "fixture_not_found" }, { status: 404 });
}

export async function githubPublicationFixtureResponse(
  request: Request, repository: GithubRepository, operationId: string, storage: DurableObjectStorage,
): Promise<Response> {
  const url = new URL(request.url);
  const root = `/repos/${repository.owner}/${repository.name}/git/`;
  const post = request.method === "POST";
  const auth = request.headers.get("authorization");
  if (url.origin !== githubApiOrigin || url.search || !url.pathname.startsWith(root) ||
      (post ? auth !== "Bearer " + fixtureWrite :
        request.method !== "GET" || (auth !== "Bearer " + fixtureRead && auth !== "Bearer " + fixtureWrite))) return notFound();
  const path = url.pathname.slice(root.length);
  const branch = "heads/sandbox-runner/" + operationId;
  const ref = "refs/" + branch;
  const reference = (sha: string) => ({ ref, object: { type: "commit", sha } });
  const original = githubFixtureData.trees as Record<string, readonly TreeEntry[]>;
  const readTree = async (sha: string) => original[sha] ?? await storage.get<TreeEntry[]>("tree:" + sha);
  if (!post) {
    if (path === "commits/" + githubFixtureData.sha) {
      return Response.json({ sha: githubFixtureData.sha, tree: { sha: githubFixtureData.baseTree } });
    }
    if (path.startsWith("commits/") && oid(path.slice(8))) {
      const commit = await storage.get<FixtureCommit>("commit:" + path.slice(8));
      return commit ? Response.json(commit) : notFound();
    }
    if (path.startsWith("trees/") && oid(path.slice(6))) {
      const sha = path.slice(6);
      const tree = await readTree(sha);
      return tree ? Response.json({ sha, tree, truncated: false }) : notFound();
    }
    const current = await storage.get<string>("ref");
    if (path === "ref/" + branch) {
      if (!current) return notFound();
      if (auth !== "Bearer " + fixtureRead) return Response.json({ error: "fixture_requires_read_scope" }, { status: 403 });
      const hidden = await storage.transaction(async transaction => {
        if (!await transaction.get("hide-first-read")) return false;
        await transaction.delete("hide-first-read");
        return true;
      });
      return hidden ? notFound() : Response.json(reference(current));
    }
    if (path === "matching-refs/" + branch) return Response.json(current ? [reference(current)] : []);
    return notFound();
  }

  const input = object(await request.json().catch(() => undefined));
  if (!input) return notFound();
  if (path === "blobs" && input.encoding === "base64" && typeof input.content === "string") {
    const bytes = Buffer.from(input.content, "base64");
    return Response.json({ sha: hash("blob", bytes) }, { status: 201 });
  }
  if (path === "trees" && Array.isArray(input.tree)) {
    const base = input.base_tree === undefined ? [] : oid(input.base_tree) ? await readTree(input.base_tree) : undefined;
    if (!base) return notFound();
    const entries = new Map(base.map(entry => [entry.path, entry]));
    for (const raw of input.tree) {
      const entry = object(raw);
      const { path: name, mode, type, sha } = entry ?? {};
      if (!safePublicationPath(name) || name.includes("/") || typeof mode !== "string" || typeof type !== "string") return notFound();
      if (sha === null) {
        if (!entries.delete(name)) return notFound();
      } else {
        if (!oid(sha)) return notFound();
        entries.set(name, { path: name, mode, type, sha });
      }
    }
    const tree = [...entries.values()];
    const sha = gitTreeSha(tree);
    await storage.put("tree:" + sha, tree);
    return Response.json({ sha }, { status: 201 });
  }
  if (path === "commits" && oid(input.tree) && Array.isArray(input.parents) &&
      input.parents.length === 1 && input.parents[0] === githubFixtureData.sha && typeof input.message === "string" &&
      await readTree(input.tree)) {
    const author = identity(input.author);
    const committer = identity(input.committer);
    if (!author || !committer) return notFound();
    const raw = `tree ${input.tree}\nparent ${input.parents[0]}\nauthor ${author}\ncommitter ${committer}\n\n${input.message}\n`;
    const sha = hash("commit", Buffer.from(raw));
    const commit: FixtureCommit = { sha, tree: { sha: input.tree }, parents: [{ sha: githubFixtureData.sha }],
      author: input.author, committer: input.committer, message: input.message };
    await storage.put("commit:" + sha, commit);
    return Response.json(commit, { status: 201 });
  }
  if (path === "refs" && input.ref === ref && oid(input.sha)) {
    const sha = input.sha;
    const created = await storage.transaction(async transaction => {
      if (await transaction.get("ref") || !await transaction.get("commit:" + sha)) return false;
      await transaction.put("ref", sha);
      await transaction.put("hide-first-read", true);
      return true;
    });
    if (created) throw new Error("synthetic lost reference response");
    return Response.json({ error: "fixture_ref_conflict" }, { status: 422 });
  }
  return notFound();
}
