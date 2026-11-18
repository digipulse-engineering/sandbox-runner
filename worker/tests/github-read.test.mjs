import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { forwardGithubRead, GithubReadError, githubCloneUrl, githubGitHost, mintGithubReadToken, resolveGithubRepository } from "../github-read.ts";
import { mintGithubCiToken, mintGithubMcpToken } from "../github-auth.ts";

const slug = "Exact-Org/Private.repo";
const repository = { owner: "Exact-Org", name: "Private.repo", repositoryId: 19283 };
const cloneUrl = githubCloneUrl(repository);
const discovery = cloneUrl + "/info/refs?service=git-upload-pack";
const upload = cloneUrl + "/git-upload-pack";
const advertisementType = "application/x-git-upload-pack-advertisement";
const uploadType = "application/x-git-upload-pack-request";
const resultType = "application/x-git-upload-pack-result";
const syntheticToken = "ghs_synthetic.header.payload-signature";
const now = () => Date.parse("2026-11-12T00:00:00Z");
const expiresAt = now() + 3_600_000;
const subject = { containerId: "test-container", contractId: "test-contract" };
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credentials = {
  appClientId: "Iv23Example123",
  installationId: "46823",
  privateKeyPem: privateKey.export({ format: "pem", type: "pkcs1" }),
};

const minted = {
  token: syntheticToken,
  expires_at: new Date(expiresAt).toISOString(),
  permissions: { contents: "read", metadata: "read" },
  repository_selection: "selected",
  repositories: [{ id: repository.repositoryId, full_name: slug, private: true }],
};

function hasCode(code) {
  return error => error instanceof GithubReadError && error.message === code && error.code === code && error.cause === undefined;
}

test("resolves only the operator's exact ASCII repository and safe numeric ID", () => {
  const configured = JSON.stringify({ [slug]: repository.repositoryId, "Other-Org/.github": 123 });
  assert.deepEqual(resolveGithubRepository(slug, configured), repository);
  assert.equal(cloneUrl, "https://github.harness.internal/Exact-Org/Private.repo.git");
  for (const denied of [
    "exact-org/Private.repo", "Exact-Org/private.repo", "Exact-Org/Privatе.repo",
    "Exact-Org/%50rivate.repo", "Exact-Org/Private.repo/", "https://github.com/" + slug,
  ]) {
    assert.throws(() => resolveGithubRepository(denied, configured), { message: "github_repository_not_allowed" });
  }
  for (const invalid of [
    "invalid JSON", "[]", "null", '{"Exact-Org/Private.repo":"19283"}', '{"Exact-Org/Private.repo":0}',
    '{"Exact-Org/Private.repo":9007199254740993}', '{"Exact-Org/../Other":9}', '{"Exact-Org/..":9}',
    '{"Exact-Org/Private.git":9}', '{"Exact-Org/Private%2frepo":9}', '{"Exact-Org/Private?repo":9}',
    '{"Exact-Org/Privatе.repo":9}', '{"Exact-Org/Private.repo":9,"exact-org/private.repo":10}',
  ]) {
    assert.throws(() => resolveGithubRepository(slug, invalid), { message: "github_allowlist_invalid" });
  }
});

test("signs GitHub App claims and requests one repository ID with contents read only", async () => {
  let requests = 0;
  const grant = await mintGithubReadToken(repository, credentials, {
    now,
    async fetcher(url, init) {
      requests++;
      assert.equal(url, "https://api.github.com/app/installations/46823/access_tokens");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.equal(init.cache, "no-store");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("accept"), "application/vnd.github+json");
      assert.equal(headers.get("x-github-api-version"), "2026-03-10");
      const bearer = headers.get("authorization");
      assert(bearer.startsWith("Bearer "));
      const [header, payload, signature] = bearer.slice("Bearer ".length).split(".");
      assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
      const seconds = now() / 1_000;
      assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), {
        iat: seconds - 60, exp: seconds + 600, iss: credentials.appClientId,
      });
      assert(verify("RSA-SHA256", Buffer.from(header + "." + payload), publicKey, Buffer.from(signature, "base64url")));
      assert.deepEqual(JSON.parse(init.body), { repository_ids: [repository.repositoryId], permissions: { contents: "read" } });
      assert(!JSON.stringify(init).includes("BEGIN RSA PRIVATE KEY"));
      return Response.json(minted, { status: 201 });
    },
  });
  assert.equal(requests, 1);
  assert.deepEqual(grant, { repository, token: syntheticToken, expiresAt });
});

test("GitHub MCP mints one repository token with issue access for the selected mode", async () => {
  for (const [mode, issues] of [["read-only", "read"], ["read-write", "write"]]) {
    let calls = 0;
    const grant = await mintGithubMcpToken(repository, credentials, mode, {
      now,
      async fetcher(url, init) {
        calls++;
        assert.equal(url, "https://api.github.com/app/installations/46823/access_tokens");
        assert.equal(init.redirect, "manual");
        assert.deepEqual(JSON.parse(init.body), { repository_ids: [repository.repositoryId], permissions: { contents: "read", issues } });
        return Response.json({ ...minted, permissions: { ...minted.permissions, issues } }, { status: 201 });
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(grant, { repository, token: syntheticToken, expiresAt });
  }
});

test("GitHub MCP refuses upgraded or unrelated permissions and a changed repository", async () => {
  for (const invalid of [
    { permissions: { contents: "read", issues: "write" } },
    { permissions: { contents: "write", issues: "read" } },
    { permissions: { contents: "read", issues: "read", pull_requests: "read" } },
    { permissions: { contents: "read" } },
    { repositories: [{ ...minted.repositories[0], id: repository.repositoryId + 1 }] },
  ]) {
    await assert.rejects(mintGithubMcpToken(repository, credentials, "read-only", {
      now,
      async fetcher() {
        return Response.json({ ...minted, permissions: { ...minted.permissions, issues: "read" }, ...invalid }, { status: 201 });
      },
    }), hasCode("github_token_invalid"));
  }
});

test("GitHub CI mints a separate read-only token for Actions and Checks", async () => {
  const expected = { actions: "read", checks: "read" };
  const mint = permissions => mintGithubCiToken(repository, credentials, {
    now,
    fetcher: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), { repository_ids: [repository.repositoryId], permissions: expected });
      return Response.json({ ...minted, permissions: { metadata: "read", ...permissions } }, { status: 201 });
    },
  });
  assert.equal((await mint(expected)).token, minted.token);
  for (const permissions of [{ actions: "read" }, { ...expected, contents: "read" }, { ...expected, checks: "write" }]) {
    await assert.rejects(mint(permissions), { code: "github_token_invalid" });
  }
});

test("accepts a historical client ID and attests omitted repository scope with the installation token", async () => {
  const appClientId = "Iv1.0123456789abcdef";
  const { repositories, repository_selection, ...withoutScope } = minted;
  for (const total of [1, 2]) {
    const calls = [];
    const result = mintGithubReadToken(repository, { ...credentials, appClientId }, {
      now,
      async fetcher(url, init) {
        calls.push(url);
        const header = new Headers(init.headers).get("authorization");
        assert.equal(init.redirect, "manual");
        if (init.method === "POST") {
          const claims = JSON.parse(Buffer.from(header.slice("Bearer ".length).split(".")[1], "base64url"));
          assert.equal(claims.iss, appClientId);
          return Response.json(withoutScope, { status: 201 });
        }
        assert.equal(init.method, "GET");
        assert.equal(url, "https://api.github.com/installation/repositories?per_page=2");
        assert.equal(header, "Bearer " + syntheticToken);
        return Response.json({ total_count: total, repositories });
      },
    });
    if (total === 1) assert.deepEqual(await result, { repository, token: syntheticToken, expiresAt });
    else await assert.rejects(result, hasCode("github_token_invalid"));
    assert.equal(calls.length, 2);
  }
});

test("rejects malformed app credentials and token scope, identity and expiry without disclosing details", async () => {
  for (const invalid of [
    { installationId: "46823/../3" }, { installationId: "0046823" }, { appClientId: "contains space" },
    { privateKeyPem: "private-error-witness" },
  ]) {
    await assert.rejects(mintGithubReadToken(repository, { ...credentials, ...invalid }, {
      now, fetcher() { assert.fail("Invalid app credentials must never reach GitHub"); },
    }), hasCode("github_app_invalid"));
  }
  for (const invalid of [
    { expires_at: new Date(now()).toISOString() }, { expires_at: new Date(expiresAt + 61_000).toISOString() },
    { expires_at: "invalid" }, { token: syntheticToken + "\n" },
    { permissions: { contents: "write" } }, { permissions: { contents: "read", issues: "read" } },
    { repository_selection: "all" }, { repositories: [] }, { repositories: [...minted.repositories, ...minted.repositories] },
    { repositories: [{ ...minted.repositories[0], id: repository.repositoryId + 1 }] },
    { repositories: [{ ...minted.repositories[0], full_name: "Exact-Org/Replacement" }] },
    { repositories: [{ ...minted.repositories[0], private: false }] },
  ]) {
    await assert.rejects(mintGithubReadToken(repository, credentials, {
      now, fetcher: async () => Response.json({ ...minted, ...invalid }, { status: 201 }),
    }), hasCode("github_token_invalid"));
  }
  let redirects = 0;
  await assert.rejects(mintGithubReadToken(repository, credentials, {
    now,
    fetcher: async (_url, init) => {
      redirects++;
      assert.equal(init.redirect, "manual");
      return new Response(syntheticToken, { status: 307, headers: { location: "https://elsewhere.invalid/" } });
    },
  }), hasCode("github_token_unavailable"));
  assert.equal(redirects, 1);
});

test("relays smart discovery and binary upload-pack streams with only the scoped GitHub credential", async () => {
  const seen = [];
  const journal = [];
  const allowed = {
    repository, subject, now, journal: entry => journal.push(entry),
    getToken: async requested => {
      assert.deepEqual(requested, repository);
      return { repository, expiresAt, token: syntheticToken };
    },
    fetcher: async (url, init) => {
      seen.push({ url, init, headers: Object.fromEntries(new Headers(init.headers)) });
      const isDiscovery = init.method === "GET";
      const responseBody = new ReadableStream({ start(controller) {
        controller.enqueue(Uint8Array.of(0, 1, 255));
        controller.close();
      } });
      return new Response(responseBody, { headers: {
        "content-type": isDiscovery ? advertisementType : resultType,
        "content-length": "3",
        authorization: syntheticToken,
        "set-cookie": syntheticToken,
        "x-echo-token": syntheticToken,
      } });
    },
  };
  const attackerHeaders = {
    host: githubGitHost, authorization: "attacker-basic", "proxy-authorization": "attacker-proxy",
    "x-api-key": "attacker-key", cookie: "attacker-cookie", "x-forwarded-host": "attacker.invalid",
    "x-http-method-override": "PUT", "git-protocol": "version=2",
  };
  const advertised = await forwardGithubRead(new Request(discovery, { headers: attackerHeaders }), allowed);
  const requestBody = new ReadableStream({ start(controller) {
    controller.enqueue(Uint8Array.of(31, 139, 8));
    controller.close();
  } });
  const uploadRequest = new Request(upload, {
    method: "POST", body: requestBody, duplex: "half",
    headers: { ...attackerHeaders, "content-type": uploadType, "content-encoding": "gzip" },
  });
  const pack = await forwardGithubRead(uploadRequest, allowed);
  assert.equal(seen[0].url, "https://github.com/" + slug + ".git/info/refs?service=git-upload-pack");
  assert.equal(seen[1].url, "https://github.com/" + slug + ".git/git-upload-pack");
  for (const { init, headers } of seen) {
    assert.equal(init.redirect, "manual");
    assert.equal(init.cache, "no-store");
    const allowedHeaders = {
      accept: init.method === "GET" ? advertisementType : resultType,
      "accept-encoding": "identity", "git-protocol": "version=2", "user-agent": "sandbox-runner",
      authorization: "Basic " + Buffer.from("x-access-token:" + syntheticToken).toString("base64"),
    };
    if (init.method === "POST") Object.assign(allowedHeaders, { "content-type": uploadType, "content-encoding": "gzip" });
    assert.deepEqual(headers, allowedHeaders);
  }
  assert.equal(seen[0].init.body, undefined);
  assert.equal(seen[1].init.body, uploadRequest.body);
  assert.deepEqual(new Uint8Array(await new Response(seen[1].init.body).arrayBuffer()), Uint8Array.of(31, 139, 8));
  for (const [result, type] of [[advertised, advertisementType], [pack, resultType]]) {
    assert.equal(result.status, 200);
    assert.deepEqual(Object.fromEntries(result.headers), {
      "cache-control": "no-store", "content-length": "3", "content-type": type,
    });
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), Uint8Array.of(0, 1, 255));
  }
  assert.equal(journal.length, 2);
  assert(!JSON.stringify(journal).includes(syntheticToken));
  assert(!JSON.stringify(journal).includes("attacker"));
});

test("denies noncanonical paths, hosts, methods, queries and writes before acquiring a token", async () => {
  const notCalled = () => assert.fail("Denied egress must never acquire a token or call GitHub");
  const origin = "https://" + githubGitHost;
  const post = (url, headers = { "content-type": uploadType }) => new Request(url, { method: "POST", body: "0000", headers });
  for (const request of [
    new Request(discovery.replace("https:", "http:")), new Request(discovery.replace(githubGitHost, "github.com")),
    new Request(discovery.replace(githubGitHost, githubGitHost + ":8443")),
    new Request(discovery, { headers: { host: "github.com" } }),
    new Request(discovery.replace("Exact-Org", "exact-org")),
    new Request(discovery.replace("Private.repo", "Private%2Erepo")),
    new Request(discovery.replace("Private.repo", "Privatе.repo")),
    new Request(discovery.replace("Private.repo", "Other.repo")),
    new Request(discovery.replace("/info/refs", "/INFO/refs")),
    new Request(discovery.replace("/info/refs", "/info%2frefs")),
    new Request(discovery.split("?")[0]),
    new Request(discovery + "&service=git-upload-pack"),
    new Request(discovery.replace("service=", "Service=")),
    new Request(discovery.replace("git-upload-pack", "git%2dupload-pack")),
    new Request(discovery.replace("git-upload-pack", "git-receive-pack")),
    new Request(discovery, { method: "HEAD" }),
    new Request(origin + "/api/v3/repos/" + slug),
    new Request(upload), new Request(upload, { method: "POST", headers: { "content-type": uploadType } }),
    post(upload + "?"), post(upload + "?any=1"), post(upload.replace("upload-pack", "receive-pack")),
    post(upload.replace("Private.repo", "Other.repo")),
    post(upload, { "content-type": "application/json" }),
    post(upload, { "content-type": uploadType, "content-encoding": "deflate" }),
  ]) {
    const response = await forwardGithubRead(request, { repository, subject, now, journal: notCalled, getToken: notCalled, fetcher: notCalled });
    assert.equal(response.status, 403, request.method + " " + request.url);
    assert.deepEqual(await response.json(), { error: "github_egress_denied" });
  }
});

test("does not send invalid grants or expose upstream redirects, errors or non-Git success bodies", async () => {
  for (const grant of [
    { repository: { ...repository, repositoryId: 123 }, expiresAt, token: syntheticToken },
    { repository, expiresAt: now(), token: syntheticToken },
    { repository, expiresAt, token: syntheticToken + "\r\n" },
  ]) {
    let requests = 0;
    const response = await forwardGithubRead(new Request(discovery), {
      repository, subject, now, journal() {}, getToken: async () => grant,
      fetcher: async () => { requests++; return new Response(); },
    });
    assert.equal(requests, 0);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "github_read_unavailable" });
  }
  for (const [status, headers, expected] of [
    [302, { location: "https://elsewhere.invalid/" + syntheticToken }, 502],
    [401, { "www-authenticate": syntheticToken }, 401],
    [200, { "content-type": "text/html" }, 502],
  ]) {
    let requests = 0;
    const response = await forwardGithubRead(new Request(discovery), {
      repository, subject, now, journal() {},
      getToken: async () => ({ repository, token: syntheticToken, expiresAt }),
      fetcher: async (_url, init) => {
        requests++;
        assert.equal(init.redirect, "manual");
        return new Response(syntheticToken, { status, headers });
      },
    });
    assert.equal(requests, 1);
    assert.equal(response.status, expected);
    assert.deepEqual(await response.json(), { error: "github_read_failed" });
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("www-authenticate"), null);
  }
});
