import { Buffer } from "node:buffer";
import { githubApiOrigin } from "./github-auth.ts";
import { githubFixtureData as data } from "./github-fixture-data.ts";
import { commitShaMediaType } from "./github-reference.ts";
import type { GithubReadToken, GithubRepository } from "./github-read.ts";
import { vitestFixtureData } from "./vitest/fixture-data.ts";

const token = "sandbox-runner-synthetic-github-read-token";
const basic = "Basic " + Buffer.from("x-access-token:" + token).toString("base64");

export function githubFixtureReadToken(repository: GithubRepository): GithubReadToken {
  return { repository, token, expiresAt: Date.now() + 60_000 };
}

export function githubReferenceFixtureFetcher(repository: GithubRepository): typeof fetch {
  const path = `/repos/${repository.owner}/${repository.name}/commits/`;
  return async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.origin !== githubApiOrigin || !url.pathname.startsWith(path) || url.search || init?.method !== "GET" ||
        init.redirect !== "manual" || headers.get("accept") !== commitShaMediaType ||
        headers.get("authorization") !== "Bearer " + token) return new Response(null, { status: 403 });
    const ref = url.pathname.slice(path.length);
    if (ref === encodeURIComponent("refs/heads/reference/blocked")) {
      const signal = init.signal!;
      signal.throwIfAborted();
      await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    const knownRef = ["refs/heads/reference/main", "refs/tags/lightweight", "refs/tags/annotated"]
      .some(name => ref === encodeURIComponent(name));
    const sha = knownRef ? repository.name === "vitest" ? vitestFixtureData.entries.pass.sha
      : repository.name === "OpenCode" ? data.opencode.sha : repository.name === "fallback" ? data.tip : data.sha
      : repository.name === "vitest" && ref === encodeURIComponent("refs/heads/reference/command")
        ? vitestFixtureData.entries.command.sha : undefined;
    return sha ? new Response(sha, { headers: { "content-type": commitShaMediaType } }) : new Response(null, { status: 422 });
  };
}

function smartResponse(encoded: string, type: string): Response {
  const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
  return new Response(bytes, {
    headers: { "content-type": type, "content-length": String(bytes.byteLength) },
  });
}

/** A fixed test upstream behind the same production egress guard. */
export function githubFixtureFetcher(repository: GithubRepository): typeof fetch {
  const root = `/${repository.owner}/${repository.name}.git`;
  const fallback = repository.name === "fallback";
  const vitest = repository.name === "vitest";
  const openCode = repository.name === "OpenCode";
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://github.com" || init?.redirect !== "manual" ||
        new Headers(init.headers).get("authorization") !== basic) {
      return new Response(null, { status: 401 });
    }
    if (init.method === "GET" && url.pathname === root + "/info/refs" && url.search === "?service=git-upload-pack") {
      const advertisement = vitest ? vitestFixtureData.advertisement : openCode ? data.opencode.advertisement
        : fallback ? data.fallbackAdvertisement : data.exactAdvertisement;
      return smartResponse(advertisement,
        "application/x-git-upload-pack-advertisement");
    }
    if (init.method === "POST" && url.pathname === root + "/git-upload-pack" && !url.search && init.body) {
      const response = new Response(init.body);
      const body = new Headers(init.headers).get("content-encoding") === "gzip"
        ? new Response(response.body?.pipeThrough(new DecompressionStream("gzip"))) : response;
      const want = /^[a-f0-9]{4}want ([a-f0-9]{40})[ \n]/.exec(await body.text())?.[1];
      if (vitest) {
        const selected = Object.values(vitestFixtureData.entries).find(entry => entry.sha === want);
        return selected ? smartResponse(selected.pack, "application/x-git-upload-pack-result") : new Response(null, { status: 400 });
      }
      if (openCode) {
        return want === data.opencode.sha ? smartResponse(data.opencode.pack, "application/x-git-upload-pack-result")
          : new Response(null, { status: 400 });
      }
      if (want === (fallback ? data.tip : data.sha)) {
        return smartResponse(fallback ? data.fallbackPack : data.exactPack, "application/x-git-upload-pack-result");
      }
    }
    return new Response(null, { status: 400 });
  };
}
