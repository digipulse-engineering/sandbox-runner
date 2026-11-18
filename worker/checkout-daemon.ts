import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContainerAdapter } from "./pinned-src/harness/container/daemon-core";

const exec = promisify(execFile);
const failed = { status: "unanswered", reason: "github_checkout_failed" } as const;
const aborted = { status: "unanswered", reason: "aborted" } as const;

export function githubCheckoutFromEnv(env: Record<string, string | undefined>, captureBaseline = false) {
  const repository = env.SANDBOX_RUNNER_GITHUB_REPOSITORY;
  const sha = env.SANDBOX_RUNNER_GITHUB_SHA;
  const timeout = env.SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS;
  delete env.SANDBOX_RUNNER_GITHUB_REPOSITORY;
  delete env.SANDBOX_RUNNER_GITHUB_SHA;
  delete env.SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS;
  if (repository === undefined && sha === undefined && timeout === undefined) return;

  return async (signal: AbortSignal): Promise<boolean> => {
    const ms = Number(timeout);
    if (!repository || !sha || sha.length !== 40 || !/^[a-f0-9]{40}$/.test(sha) ||
        !Number.isInteger(ms) || ms < 1 || ms > 2_147_483_647) return false;
    const options = {
      uid: 10001,
      gid: 10001,
      encoding: "utf8" as const,
      killSignal: "SIGKILL" as const,
      signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
      env: { PATH: "/nonexistent", SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS: String(ms) },
    };
    try {
      const result = await exec("/usr/local/bin/sandbox-runner-checkout", ["--repo", repository, "--sha", sha], options);
      const receipt = JSON.parse(result.stdout);
      if (receipt?.checkout !== true || receipt.sha !== sha || options.signal.aborted) return false;
      const head = await exec("/usr/bin/git", ["-C", "/workspace", "rev-parse", "--verify", "HEAD"], options);
      if (head.stdout.trim() !== sha || options.signal.aborted) return false;
      if (captureBaseline) {
        await exec("/usr/local/bin/sandbox-runner-checkout", ["snapshot", "--sha", sha], {
          signal: options.signal, killSignal: options.killSignal, env: { PATH: "/nonexistent" },
        });
      }
      return !options.signal.aborted;
    } catch {
      return false;
    }
  };
}

/** The pinned harness can queue a turn before the container starts. Gate the
 * actual agent process here, inside its own container and workspace. */
export function withGithubCheckout(
  adapter: ContainerAdapter, checkout: (signal: AbortSignal) => Promise<boolean>,
): ContainerAdapter {
  let ready: Promise<boolean> | undefined;
  return {
    ...adapter,
    async open(context) {
      const session = await adapter.open(context);
      return {
        close: () => session.close(),
        ...(session.configure ? { configure: session.configure.bind(session) } : {}),
        ...(session.steer ? { steer: session.steer.bind(session) } : {}),
        async run(turn) {
          if (turn.signal.aborted) return aborted;
          // A replay on a live daemon reuses the checked-out workspace. A
          // new daemon never clears a nonempty workspace to retry checkout.
          ready ??= checkout(turn.signal).catch(() => false);
          const checkedOut = await ready;
          if (turn.signal.aborted) return aborted;
          return checkedOut ? session.run(turn) : failed;
        },
      };
    },
  };
}
