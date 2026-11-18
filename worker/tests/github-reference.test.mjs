import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProviderRunInput, matchesRunInput } from "../contract.ts";
import { githubFixtureData } from "../github-fixture-data.ts";
import { githubFixtureReadToken, githubReferenceFixtureFetcher } from "../github-fixtures.ts";
import { commitShaMediaType, resolveGithubReference } from "../github-reference.ts";
import { parseRepositoryRequest } from "../github-source.ts";
import { newStrategyRun, strategyView } from "../strategy.ts";
import { parseTestSubmission, sameTestSubmission } from "../vitest/admission.ts";

const repository = { owner: "Exact-Org", name: "Exact.Repo", repositoryId: 12 };
const slug = `${repository.owner}/${repository.name}`;
const sha = "a".repeat(40);
const id = "23379c56-913b-43b8-9b49-717d31498d15";
const token = "synthetic-reference-token";
const ref = "refs/heads/team/release";
const request = { operationId: id, kind: "agent", agent: "claude", prompt: "fixture", repository: { slug, ref } };
const readGrant = selected => ({ repository: selected, token, expiresAt: Date.now() + 60_000 });

test("accepts full branch and tag names and preserves the exact SHA input grammar", () => {
  for (const accepted of [ref, "refs/tags/release/1.0", "refs/heads/résumé/%2F", "refs/heads/closing]bracket"]) {
    assert.deepEqual(parseRepositoryRequest({ slug, ref: accepted }), { slug, ref: accepted });
  }
  for (const rejected of ["main", "HEAD", "refs/pull/123/head", "refs/heads/", "refs/heads/a//b", "refs/heads/a/..",
    "refs/tags/a..b", "refs/tags/.foo", "refs/heads/a.lock/b", "refs/heads/a.", "refs/heads/a@{b",
    "refs/heads/a?b", "refs/heads/a\\b", "refs/tags/a[b", "refs/tags/a b", "refs/tags/a\n", "refs/heads/\ud800"]) {
    assert.equal(parseRepositoryRequest({ slug, ref: rejected }), undefined, rejected);
  }
  assert.equal(parseRepositoryRequest({ slug, sha, ref }), undefined);
  assert.deepEqual(parseRepositoryRequest({ slug, sha: sha.toUpperCase() }), { slug, sha });
});

test("preserves the requested reference in root replay while publishing only the verified commit", () => {
  const { input, providerRequest } = parseProviderRunInput(request);
  assert.deepEqual(input.repositoryRef, { slug, ref });
  assert.equal(input.repository, undefined);
  assert.equal(parseProviderRunInput({ ...request, reviewProducer: "codex" }), undefined);
  assert.equal(parseProviderRunInput({ ...request, publish: true }).input.publish, true);
  const pinned = { ...input, repository: { slug, sha } };
  assert(matchesRunInput(pinned, input));
  assert(!matchesRunInput(pinned, parseProviderRunInput({ ...request, repository: { slug, sha } }).input));
  assert(!matchesRunInput(pinned, parseProviderRunInput({ ...request, repository: { slug, ref: "refs/tags/team/release" } }).input));
  const strategy = newStrategyRun(pinned, { strategy: "subscription-only" }, {}, { request: providerRequest, sandboxProvider: "cloudflare" });
  assert.deepEqual(strategy.repositoryRef, input.repositoryRef);
  assert.deepEqual(strategyView(strategy).repository, pinned.repository);
  assert.equal(strategyView(strategy).repositoryRef, undefined);
  const vitest = parseTestSubmission({ ...request, kind: "test", suite: "vitest", agent: undefined, prompt: undefined });
  assert.equal(vitest, undefined); // Agent fields stay forbidden on the test route.
  for (const task of [{ suite: "vitest" }, { suite: "command", argv: ["node", "--version"] }]) {
    const testRequest = { operationId: id, kind: "test", ...task, repository: { slug, ref } };
    const test = parseTestSubmission(testRequest);
    assert(sameTestSubmission({ ...test, repository: { slug, sha } }, test));
    assert(!sameTestSubmission(test, parseTestSubmission({ ...testRequest, repository: { slug, sha } })));
  }
});

test("the OpenCode fixture resolves its non-tip commit for a branch and an annotated tag", async () => {
  const repository = { owner: "fixture", name: "OpenCode", repositoryId: 104 };
  const { sha, tip } = githubFixtureData.opencode;
  assert.notEqual(sha, tip);
  for (const ref of ["refs/heads/reference/main", "refs/tags/annotated"]) {
    const result = await resolveGithubReference(repository, ref, Date.now() + 5_000, {
      getToken: async selected => githubFixtureReadToken(selected),
      fetcher: githubReferenceFixtureFetcher(repository),
    });
    assert.deepEqual(result, { sha });
  }
});

test("uses a scoped read token and a single encoded HTTPS path for a branch or tag", async () => {
  for (const requested of [ref, "refs/tags/lightweight", "refs/tags/annotated", "refs/heads/release/%2F"]) {
    const result = await resolveGithubReference(repository, requested, Date.now() + 5_000, {
      getToken: async (selected, fetcher) => {
        assert.deepEqual(selected, repository);
        assert.equal(typeof fetcher, "function");
        return readGrant(selected);
      },
      fetcher: async (url, init) => {
        assert.equal(url, `https://api.github.com/repos/${slug}/commits/${encodeURIComponent(requested)}`);
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "manual");
        assert.equal(init.cache, "no-store");
        assert(init.signal instanceof AbortSignal);
        assert.equal(init.headers.accept, commitShaMediaType);
        assert.equal(init.headers.authorization, "Bearer " + token);
        return new Response(sha, { headers: { "content-type": `${commitShaMediaType}; charset=utf-8` } });
      },
    });
    assert.deepEqual(result, { sha });
  }
});

test("rejects stale or cross-repository grants, redirects and noncanonical commit responses", async () => {
  const getToken = async selected => readGrant(selected);
  for (const grant of [{ ...readGrant(repository), contents: "write" }, { ...readGrant(repository), expiresAt: 0 },
    { ...readGrant(repository), repository: { ...repository, repositoryId: 99 } }]) {
    assert.equal(await resolveGithubReference(repository, ref, Date.now() + 5_000, {
      getToken: async () => grant, fetcher: () => assert.fail("invalid grant reached upstream"),
    }), "github_reference_unavailable");
  }
  for (const [status, body, type, expected] of [
    [422, null, null, "github_reference_not_found"], [404, null, null, "github_reference_not_found"],
    [302, null, null, "github_reference_unavailable"], [403, null, null, "github_reference_unavailable"],
    [200, sha, "text/plain", "github_reference_unavailable"], [200, sha + "\n", commitShaMediaType, "github_reference_unavailable"],
    [200, sha.slice(1), commitShaMediaType, "github_reference_unavailable"], [200, "z".repeat(40), commitShaMediaType, "github_reference_unavailable"],
  ]) {
    let calls = 0;
    assert.equal(await resolveGithubReference(repository, ref, Date.now() + 5_000, { getToken, fetcher: async () => {
      calls++;
      return new Response(body, { status, headers: type ? { "content-type": type } : { location: "https://other.invalid" } });
    } }), expected);
    assert.equal(calls, 1);
  }
  assert.equal(await resolveGithubReference(repository, ref, Date.now() - 1, {
    getToken: () => assert.fail("expired lookup minted a token"),
  }), "github_reference_unavailable");
});
