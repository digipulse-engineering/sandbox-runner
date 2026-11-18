import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { prepareGithubPublication as prepareObjects, publishGithubReference as publishReference, reconcileGithubReference }
  from "../github-publish.ts";
import { runDeadlineFetch } from "../agent-deadline.ts";
import { forwardGithubRead, githubCloneUrl } from "../github-read.ts";
import { cancelPublication, claimReference, finishReference, publicationView, recoveryAlarm } from "../publication-state.ts";

const repository = { owner: "Example-Org", name: "private-repo", repositoryId: 1234 };
const slug = repository.owner + "/" + repository.name;
const apiBase = "/repos/" + slug + "/git/";
const id = "c09125cb-95e3-4e63-a094-8c008f1c9427";
const branch = "heads/sandbox-runner/" + id;
const ref = "refs/" + branch;
const syntheticToken = "ghs_synthetic_write.token";
const syntheticReadToken = "ghs_synthetic_read.token";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credentials = {
  appClientId: "Iv23Synthetic",
  installationId: 1212,
  privateKeyPem: privateKey.export({ format: "pem", type: "pkcs1" }),
};
const date = "2026-11-12T06:07:08Z";
const now = () => Date.parse(date);
const identity = { name: "Sandbox Runner", email: "runner@example.invalid", date };
const commit = { message: "Publish verified candidate\n\nRun " + id, author: identity, committer: identity };
const scratch = mkdtempSync(join(tmpdir(), "sandbox-runner-github-publish-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function git(args, input, identities) {
  return execFileSync("git", args, {
    cwd: scratch,
    input,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...identities },
  }).toString("utf8").trim();
}

git(["init", "--quiet", "--object-format=sha1"]);
const makeBlob = bytes => git(["hash-object", "-w", "--stdin"], bytes);
const makeTree = entries => git(["mktree", "-z"], entries.map(entry =>
  `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}\0`).join(""));
const blobEntry = (path, sha, mode = "100644") => ({ path, sha, mode, type: "blob" });
const treeEntry = (path, sha) => ({ path, sha, mode: "040000", type: "tree" });
const existing = makeBlob("original\n");
const oldTree = makeTree([blobEntry("old.txt", existing)]);
const originalEntries = [
  blobEntry("from-file", existing), treeEntry("from-dir", oldTree), treeEntry("gone", oldTree),
  blobEntry("from-file.txt", existing), blobEntry("untouched-link", makeBlob("from-file.txt"), "120000"),
];
const baseTree = makeTree(originalEntries);
const binary = Uint8Array.of(0, 255, 13, 10, 128);
const binarySha = makeBlob(binary);
const folder = makeTree([blobEntry("binary.dat", binarySha, "100755")]);
const expectedTreeSha = makeTree([
  treeEntry("from-file", folder), blobEntry("from-dir", binarySha), ...originalEntries.slice(3),
]);
const emptyTree = makeTree([]);

function makeCommit(tree, message, author, committer, parent) {
  return git(["commit-tree", tree, ...(parent ? ["-p", parent] : [])], message + "\n", {
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date,
    GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: committer.date,
  });
}

const baseSha = makeCommit(baseTree, "Base", identity, identity);
const commitSha = makeCommit(expectedTreeSha, commit.message, identity, identity, baseSha);
const otherSha = makeCommit(expectedTreeSha, "Another commit", identity, identity, baseSha);
const changes = [
  { kind: "delete", path: "from-file" },
  { kind: "put", path: "from-file/binary.dat", mode: "100755", blobSha: binarySha, bytes: binary },
  { kind: "delete", path: "from-dir/old.txt" },
  { kind: "put", path: "from-dir", mode: "100644", blobSha: binarySha, bytes: binary },
  { kind: "delete", path: "gone/old.txt" },
];
const input = { repository, operationId: id, baseSha, expectedBaseTreeSha: baseTree, expectedTreeSha, commit, changes };
const permit = async () => true;
const prepareGithubPublication = (input, options, authorize = permit) => prepareObjects(input, options, authorize);
const publishGithubReference = (receipt, options, claim = permit) => publishReference(receipt, options, claim);
const receipt = { repository, operationId: id, baseSha, treeSha: expectedTreeSha, commitSha };
const commitObject = { sha: commitSha, tree: { sha: expectedTreeSha }, parents: [{ sha: baseSha }], ...commit };
const reference = sha => ({ ref, object: { sha, type: "commit" } });

function github(plan = {}) {
  const calls = [];
  const dataPosts = () => calls.filter(call => call.method === "POST" && call.path.startsWith(apiBase));
  const refs = () => dataPosts().filter(call => call.path.endsWith("/refs"));
  const trees = new Map([[baseTree, originalEntries], [oldTree, [blobEntry("old.txt", existing)]]]);
  let currentRef = plan.ref;
  let hiddenReads = 0;
  return {
    calls, dataPosts, refs,
    options: { credentials, now, async fetcher(rawUrl, init) {
      const url = new URL(rawUrl);
      const headers = new Headers(init.headers);
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(url.search, "");
      assert.equal(init.redirect, "manual");
      assert.equal(init.cache, "no-store");
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ method: init.method, path: url.pathname, body });
      if (url.pathname === "/app/installations/1212/access_tokens") {
        assert.equal(init.method, "POST");
        assert.match(headers.get("authorization"), /^Bearer [a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$/i);
        const scope = body?.permissions?.contents;
        assert(scope === "read" || scope === "write");
        if (plan.scope) assert.equal(scope, plan.scope);
        assert.deepEqual(body, { repository_ids: [repository.repositoryId], permissions: { contents: scope } });
        return Response.json({
          token: scope === "read" ? syntheticReadToken : syntheticToken, expires_at: "2026-11-12T07:07:08Z",
          permissions: { contents: plan.tokenPermission ?? scope, metadata: "read" }, repository_selection: "selected",
          repositories: [{ id: repository.repositoryId, full_name: slug, private: true }],
        }, { status: 201 });
      }
      assert(url.pathname.startsWith(apiBase));
      const auth = headers.get("authorization");
      assert(auth === "Bearer " + syntheticToken || (init.method === "GET" && auth === "Bearer " + syntheticReadToken));
      const path = url.pathname.slice(apiBase.length);
      if (init.method === "GET") {
        if (path === "commits/" + baseSha) {
          return Response.json({ sha: plan.badBase ? otherSha : baseSha, tree: { sha: baseTree } });
        }
        if (path === "commits/" + commitSha) {
          return Response.json(plan.badCandidateCommit ? { ...commitObject, parents: [{ sha: otherSha }] } : commitObject);
        }
        if (path.startsWith("trees/")) {
          const sha = path.slice("trees/".length);
          const entries = trees.get(sha);
          assert(entries);
          return Response.json({
            sha, tree: plan.badBaseTree ? [] : entries, truncated: false,
          });
        }
        if (path === "ref/" + branch) {
          if (plan.refStatus !== undefined) return Response.json({ message: syntheticToken }, { status: plan.refStatus });
          if (hiddenReads > 0) {
            hiddenReads -= 1;
            return Response.json({}, { status: 404 });
          }
          return currentRef ? Response.json(reference(currentRef)) : Response.json({}, { status: 404 });
        }
        if (path === "matching-refs/" + branch) {
          if (plan.refDuringMatch) {
            currentRef = plan.refDuringMatch;
            return Response.json([reference(currentRef)]);
          }
          return Response.json(plan.matches ?? [], { status: plan.matchStatus ?? 200 });
        }
      }
      if (init.method === "POST") {
        if (path === "blobs") {
          assert.equal(body.encoding, "base64");
          const sha = makeBlob(Buffer.from(body.content, body.encoding));
          return Response.json({ sha: plan.badBlob ? existing : sha }, { status: 201 });
        }
        if (path === "trees") {
          const old = body.base_tree ? trees.get(body.base_tree) : [];
          assert(old);
          assert(body.tree.every(entry => !entry.path.includes("/")));
          const map = new Map(old.map(entry => [entry.path, entry]));
          for (const entry of body.tree) {
            if (entry.sha === null) assert(map.delete(entry.path));
            else map.set(entry.path, entry);
          }
          const tree = [...map.values()];
          const sha = makeTree(tree);
          trees.set(sha, tree);
          return Response.json({ sha: plan.badTree ? baseTree : sha, tree, truncated: false }, { status: 201 });
        }
        if (path === "commits") {
          assert.deepEqual(body, { ...commit, tree: body.tree, parents: [baseSha] });
          const sha = makeCommit(body.tree, body.message, body.author, body.committer, body.parents[0]);
          return Response.json({
            sha, tree: { sha: body.tree }, parents: [{ sha: baseSha }], ...commit,
            ...(plan.badCommit ? { committer: { ...identity, date: "2026-11-12T00:00:00Z" } } : {}),
          }, { status: 201 });
        }
        if (path === "refs") {
          assert.deepEqual(body, { ref, sha: commitSha });
          assert.equal(currentRef, undefined);
          currentRef = plan.racingRef ?? (plan.dropWithoutCreate ? undefined : commitSha);
          hiddenReads = plan.hideAfterPost ?? 0;
          plan.onPost?.();
          if (plan.lostReply) throw new Error("raw provider detail " + syntheticToken);
          return Response.json(currentRef ? reference(currentRef) : {}, { status: plan.racingRef ? 422 : 201 });
        }
      }
      assert.fail("unexpected GitHub call: " + init.method + " " + path);
    } },
  };
}

function fixedError(code) {
  return error => error.code === code && error.message === code && error.cause === undefined;
}

test("prepares a deterministic one-parent commit from verified Git binary data and tree transitions without creating a ref", async () => {
  const mock = github();
  const prepared = await prepareGithubPublication(input, mock.options);
  assert.deepEqual(prepared, receipt);
  assert.deepEqual(await prepareGithubPublication(input, mock.options), prepared);
  assert.equal(mock.refs().length, 0);
  const [blob, subtree, root, createdCommit] = mock.dataPosts();
  assert.deepEqual(blob.body, { content: Buffer.from(binary).toString("base64"), encoding: "base64" });
  assert.deepEqual(subtree.body, { tree: [blobEntry("binary.dat", binarySha, "100755")] });
  assert.deepEqual(root.body, { base_tree: baseTree, tree: [
    treeEntry("from-file", folder), blobEntry("from-dir", binarySha), treeEntry("gone", null),
  ] });
  assert.deepEqual(createdCommit.body, { ...commit, tree: expectedTreeSha, parents: [baseSha] });
  assert(!JSON.stringify(prepared).includes(syntheticToken));
});

test("can prepare a verified empty root tree while pruning empty nested directories", async () => {
  const mock = github();
  const output = await prepareGithubPublication({
    ...input, expectedTreeSha: emptyTree, changes: originalEntries.map(({ path }) => ({ kind: "delete", path })),
  }, mock.options);
  assert.equal(output.treeSha, emptyTree);
  assert.deepEqual(mock.dataPosts()[0].body, {
    base_tree: baseTree, tree: originalEntries.map(entry => ({ ...entry, sha: null })),
  });
});

test("rejects ambiguous paths, identities, unverified blobs and trees before any Git object mutation", async () => {
  const never = () => assert.fail("Invalid input must fail before opening an installation grant");
  for (const path of ["/root", "x//file", "x/../file", ".git/config", ".GIT./config", "ＧＩＴ~1/config",
    "x/one\\two", "x/a\0b", "x/one／two", "x/one\u202Etwo", "x\ud800"]) {
    await assert.rejects(prepareGithubPublication({ ...input, changes: [{ ...changes[1], path }] }, {
      credentials, now, fetcher: never,
    }), fixedError("github_publication_invalid"));
  }
  for (const override of [
    { operationId: id.toUpperCase() }, { baseSha: baseSha + "/refs" },
    { commit: { ...commit, author: { ...identity, name: "Author\ncommitter Malicious" } } },
    { commit: { ...commit, author: { ...identity, email: "author@example.invalid> \nparent" } } },
    { commit: { ...commit, committer: { ...identity, date: "2026-02-30T00:00:00Z" } } },
    { changes: [changes[0], changes[0]] }, { changes: [{ ...changes[1], mode: "120000" }] },
  ]) {
    await assert.rejects(prepareGithubPublication({ ...input, ...override }, {
      credentials, now, fetcher: never,
    }), fixedError("github_publication_invalid"));
  }
  await assert.rejects(prepareGithubPublication({ ...input, changes: [{ ...changes[1], blobSha: existing }] }, {
    credentials, now, fetcher: never,
  }), fixedError("github_candidate_unverified"));
  for (const [plan, candidate, error] of [
    [{ badBase: true }, input, "github_base_unverified"],
    [{ badBaseTree: true }, input, "github_base_unverified"],
    [{}, { ...input, expectedBaseTreeSha: emptyTree }, "github_base_unverified"],
    [{}, { ...input, expectedTreeSha: emptyTree }, "github_candidate_unverified"],
    [{}, { ...input, changes: [{ ...changes[1], path: "from-file/new.txt" }] }, "github_publication_invalid"],
    [{}, { ...input, changes: [{ kind: "delete", path: "absent" }, { ...changes[1], path: "absent/new.txt" }] },
      "github_publication_invalid"],
  ]) {
    const mock = github(plan);
    await assert.rejects(prepareGithubPublication(candidate, mock.options), fixedError(error));
    assert.equal(mock.dataPosts().length, 0);
  }
});

test("rechecks object authority at every write and closes before the next mutation", async () => {
  const mock = github();
  let checks = 0;
  await assert.rejects(prepareGithubPublication(input, mock.options, async () => ++checks === 1),
    fixedError("github_publication_authority_closed"));
  assert.equal(checks, 2);
  assert.deepEqual(mock.dataPosts().map(call => call.path), [apiBase + "blobs"]);
  assert.equal(mock.refs().length, 0);
});

test("rejects invalid write scope and mismatching GitHub object receipts before publication", async () => {
  for (const [plan, count, error] of [
    [{ tokenPermission: "read" }, 0, "github_publication_unavailable"],
    [{ badBlob: true }, 1, "github_objects_unverified"],
    [{ badTree: true }, 2, "github_objects_unverified"],
    [{ badCommit: true }, 4, "github_objects_unverified"],
  ]) {
    const mock = github(plan);
    await assert.rejects(prepareGithubPublication(input, mock.options), fixedError(error));
    assert.equal(mock.dataPosts().length, count);
    assert.equal(mock.refs().length, 0);
  }
  let fetched = false;
  const response = await forwardGithubRead(new Request(githubCloneUrl(repository) + "/info/refs?service=git-upload-pack"), {
    repository, now, subject: { containerId: "synthetic", contractId: null }, journal() {},
    getToken: async () => ({ repository, token: syntheticToken, expiresAt: now() + 3_600_000, contents: "write" }),
    fetcher: async () => { fetched = true; return new Response(); },
  });
  assert.equal(response.status, 502);
  assert.equal(fetched, false);
});

test("creates only the fixed run ref after confirmed absence and recovers a lost POST reply without a second write", async () => {
  const mock = github({ lostReply: true });
  const result = { status: "published", ref, commitSha };
  assert.deepEqual(await publishGithubReference(structuredClone(receipt), mock.options), { status: "reconcile", ref });
  assert.deepEqual(await reconcileGithubReference(structuredClone(receipt), mock.options), result);
  assert.equal(mock.refs().length, 1);
  assert.deepEqual(mock.refs()[0].body, { ref, sha: commitSha });
  assert.deepEqual(mock.calls.map(({ path }) => path).filter(path => path.startsWith(apiBase)), [
    apiBase + "commits/" + commitSha, apiBase + "ref/" + branch,
    apiBase + "matching-refs/" + branch, apiBase + "refs",
    apiBase + "commits/" + commitSha, apiBase + "ref/" + branch,
  ]);
});

test("fails closed on ambiguous reads and never replaces a reference with another SHA", async () => {
  for (const plan of [
    { refStatus: 401 }, { refStatus: 403 }, { refStatus: 500 }, { refStatus: 302 },
    { matchStatus: 404 }, { matchStatus: 403 }, { matchStatus: 500 }, { matches: {} },
    { matches: [{ ...reference(otherSha), ref: ref + "-other" }] },
    { badCandidateCommit: true },
  ]) {
    const mock = github(plan);
    assert.deepEqual(await publishGithubReference(receipt, mock.options), { status: "uncertain", ref });
    assert.equal(mock.refs().length, 0);
  }
  for (const plan of [{ ref: otherSha }, { refDuringMatch: otherSha }, { racingRef: otherSha }]) {
    const mock = github(plan);
    let result = await publishGithubReference(receipt, mock.options);
    if (plan.racingRef) {
      assert.deepEqual(result, { status: "reconcile", ref });
      result = await reconcileGithubReference(receipt, mock.options);
    }
    assert.deepEqual(result, { status: "conflict", ref, actualSha: otherSha });
    assert.equal(mock.refs().length, plan.racingRef ? 1 : 0);
  }
  const publishedDuringMatch = github({ refDuringMatch: commitSha });
  assert.deepEqual(await publishGithubReference(receipt, publishedDuringMatch.options), { status: "published", ref, commitSha });
  assert.equal(publishedDuringMatch.refs().length, 0);
  const lost = github({ lostReply: true, dropWithoutCreate: true });
  assert.deepEqual(await publishGithubReference(receipt, lost.options), { status: "reconcile", ref });
  assert.deepEqual(await reconcileGithubReference(receipt, lost.options), { status: "uncertain", ref });
  assert.equal(lost.refs().length, 1);
});

test("an expired ref POST schedules fresh read-only recovery through a temporary 404 and cancellation", async () => {
  const signal = new AbortController();
  const mock = github({ lostReply: true, hideAfterPost: 1, onPost: () => signal.abort() });
  let state = { phase: "prepared", receipt };
  const write = await publishGithubReference(receipt, { ...mock.options, fetcher(target, init) {
    signal.signal.throwIfAborted();
    return mock.options.fetcher(target, init);
  } }, async () => {
    state = claimReference(state, receipt, now() + 30_000);
    return !!state;
  });
  assert.equal(signal.signal.aborted, true);
  assert.deepEqual(write, { status: "reconcile", ref });
  assert.equal(recoveryAlarm(state, "prepared", receipt, write, now(), 2_000), now());
  state = structuredClone(cancelPublication(state));
  assert.equal(state.cancelRequested, true);
  const firstRead = await reconcileGithubReference(receipt, mock.options);
  assert.deepEqual(firstRead, { status: "uncertain", ref });
  assert.equal(recoveryAlarm(state, "claimed", receipt, firstRead, now(), 2_000), now() + 2_000);
  const confirmed = await reconcileGithubReference(receipt, mock.options);
  assert.deepEqual(publicationView(finishReference(state, receipt, confirmed)), {
    status: "published", branch: "sandbox-runner/" + id, commitSha, treeSha: expectedTreeSha,
  });
  assert.equal(mock.refs().length, 1);
  assert.deepEqual(mock.calls.filter(call => call.path.endsWith("/access_tokens")).map(call => call.body.permissions.contents),
    ["write", "read", "read"]);
});

test("denies ref creation after authoritative readback and reconciles claimed refs with read permission only", async () => {
  const mock = github();
  const result = await publishGithubReference(receipt, mock.options, async () => {
    assert.deepEqual(mock.calls.filter(call => call.path.startsWith(apiBase)).map(call => call.path), [
      apiBase + "commits/" + commitSha, apiBase + "ref/" + branch, apiBase + "matching-refs/" + branch,
    ]);
    return false;
  });
  assert.deepEqual(result, { status: "denied", ref });
  assert.equal(mock.refs().length, 0);
  const recovered = github({ scope: "read", ref: commitSha });
  assert.deepEqual(await reconcileGithubReference(receipt, recovered.options), { status: "published", ref, commitSha });
  assert.equal(recovered.dataPosts().length, 0);
  const absent = github({ scope: "read" });
  assert.deepEqual(await reconcileGithubReference(receipt, absent.options), { status: "uncertain", ref });
  assert.equal(absent.dataPosts().length, 0);
});

test("a claim racing the deadline never dispatches a new ref POST at or after the deadline", async t => {
  const deadlineAt = now() + 100;
  t.mock.timers.enable({ apis: ["Date"], now: now() });
  for (const crossesAfterClaim of [false, true]) {
    t.mock.timers.setTime(now());
    const mock = github();
    let state = { phase: "prepared", receipt };
    const result = await publishGithubReference(receipt, { ...mock.options,
      fetcher: runDeadlineFetch(mock.options.fetcher, deadlineAt),
    }, async () => {
      if (!crossesAfterClaim) t.mock.timers.setTime(deadlineAt);
      const claimed = claimReference(state, receipt, now() + 30_000, deadlineAt, Date.now());
      if (!claimed) return false;
      state = claimed;
      t.mock.timers.setTime(deadlineAt);
      return true;
    });
    assert.equal(mock.refs().length, 0);
    assert.deepEqual(result, { status: crossesAfterClaim ? "reconcile" : "denied", ref });
    assert.equal(state.phase, crossesAfterClaim ? "claimed" : "prepared");
    const readback = await reconcileGithubReference(receipt, mock.options);
    assert.equal(readback.status, "uncertain");
    assert.deepEqual(mock.calls.filter(call => call.path.endsWith("/access_tokens")).map(call => call.body.permissions.contents), ["write", "read"]);
  }
});
