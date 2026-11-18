import { cliAdapter } from "./pinned-src/harness/container/runtime";
import { openCodeParser } from "./opencode-parser";
import { openCodeModelRef, openCodeVersion, resolveOpenCodeSettings } from "./opencode-settings";
import { openCodeReviewModel } from "./run-input-validation.mjs";

export function openCodeAdapter(env: NodeJS.ProcessEnv) {
  const settings = resolveOpenCodeSettings(env.SANDBOX_RUNNER_OPENCODE_PROVIDER, env.SANDBOX_RUNNER_OPENCODE_MODEL,
    env.SANDBOX_RUNNER_OPENCODE_EFFORT, env.SANDBOX_RUNNER_OPENCODE_MODEL === openCodeReviewModel);
  if (!settings) throw new Error("Invalid OpenCode settings");
  const model = openCodeModelRef(settings);
  const supervised = env.SANDBOX_RUNNER_OPENCODE_REVIEW_CONNECTORS !== undefined;
  if (supervised && settings.model !== openCodeReviewModel) throw new Error("Invalid OpenCode reviewer");
  return cliAdapter({
    id: "opencode", version: openCodeVersion, cwd: "/workspace", user: { uid: 10001, gid: 10001 },
    homes: "/home/agent/.harness/sessions",
    command(turn) {
      if (turn.settings.model !== model) throw new Error("Invalid OpenCode turn model");
      const launcher = supervised ? ["/usr/local/bin/node", "/opt/sandbox-runner/opencode-review-runner.mjs", "run"]
        : ["/usr/local/bin/opencode", "run", "--standalone"];
      return { argv: [...launcher, "--format", "json", "--title", "Sandbox Runner", "--model", model, "--", turn.prompt] };
    },
    parser: openCodeParser,
  });
}
