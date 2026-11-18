import { GithubReadError, resolveGithubRepository } from "./github-read.ts";
import type { GithubAppCredentials, GithubRepository } from "./github-read.ts";

export type GithubCheckoutEnv = {
  SANDBOX_RUNNER_MODE: string;
  SANDBOX_RUNNER_GITHUB_FIXTURES?: string;
  SANDBOX_RUNNER_GITHUB_ALLOWLIST?: string;
  SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS: string;
  SANDBOX_RUNNER_API_TIMEOUT_MS?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
};

export type GithubCheckoutError =
  "github_repository_not_allowed" | "github_allowlist_invalid" | "github_checkout_not_configured";

const fixtureRepositories = '{"fixture/private":101,"fixture/fallback":102,"fixture/vitest":103,"fixture/OpenCode":104}';

export function githubAppCredentials(env: GithubCheckoutEnv): GithubAppCredentials | undefined {
  if (env.SANDBOX_RUNNER_MODE !== "real") return;
  const {
    GITHUB_APP_CLIENT_ID: appClientId,
    GITHUB_APP_INSTALLATION_ID: installationId,
    GITHUB_APP_PRIVATE_KEY: privateKeyPem,
  } = env;
  if (appClientId && installationId && privateKeyPem) return { appClientId, installationId, privateKeyPem };
}

export function githubCheckoutFixture(env: GithubCheckoutEnv): boolean {
  return env.SANDBOX_RUNNER_MODE === "fixture" && env.SANDBOX_RUNNER_GITHUB_FIXTURES === "1";
}

export function admitGithubCheckout(
  repository: { slug: string }, env: GithubCheckoutEnv,
): GithubRepository | GithubCheckoutError {
  const allowlist = githubCheckoutFixture(env) ? fixtureRepositories : env.SANDBOX_RUNNER_GITHUB_ALLOWLIST;
  if (!allowlist || (!githubCheckoutFixture(env) && !githubAppCredentials(env))) {
    return "github_checkout_not_configured";
  }
  try {
    return resolveGithubRepository(repository.slug, allowlist);
  } catch (error) {
    if (error instanceof GithubReadError && error.code === "github_repository_not_allowed") return error.code;
    return "github_allowlist_invalid";
  }
}

/**
 * The deadline for each operation the Worker runs against GitHub or an MCP connector: reference resolution, connector
 * preflight (and the admission owner's lease around them), and branch publication or its reconciliation. Some run
 * inside a client request, so it must stay below the client's request timeout. The checkout setting bounds only the
 * container's Git fetch. A Worker built without this setting keeps the checkout setting for both, as before.
 */
export function apiTimeoutMs(env: Pick<GithubCheckoutEnv, "SANDBOX_RUNNER_API_TIMEOUT_MS" | "SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS">):
  number | undefined {
  const timeout = Number(env.SANDBOX_RUNNER_API_TIMEOUT_MS ?? env.SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS);
  return Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 2_147_483_647 ? timeout : undefined;
}
