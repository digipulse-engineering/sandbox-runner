import { claudeCodeCli, cliAdapter, codexCli, serveFromEnv } from "./pinned-src/harness/container/runtime";
import { githubCheckoutFromEnv, withGithubCheckout } from "./checkout-daemon";
import { withClaudeTerminalDiagnostics } from "./claude-terminal-diagnostics";
import { withCodexPublicationTerminal } from "./codex-publication-terminal";
import { takeMcpConnectorNames, withManagedMcp } from "./mcp-native-adapter";
import { openCodeAdapter } from "./opencode-daemon";

const name = process.env.CF_HARNESS_ADAPTER ?? "claude-code";
const publication = process.env.SANDBOX_RUNNER_GITHUB_PUBLICATION === "1";
const supervisedCodex = publication && name === "codex";
const checkoutTimeout = process.env.SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS;
delete process.env.SANDBOX_RUNNER_GITHUB_PUBLICATION;
const checkout = githubCheckoutFromEnv(process.env, publication);
const connectorNames = takeMcpConnectorNames(process.env);
if (publication && !checkout) process.exit(1);
if (connectorNames.length && name !== "claude-code" && name !== "codex") process.exit(1);
if (name === "opencode") {
  if (publication) process.exit(1);
  const adapter = openCodeAdapter(process.env);
  await serveFromEnv(checkout ? withGithubCheckout(adapter, checkout) : adapter);
} else if (name !== "claude-code" && (name !== "codex" || (!checkout && !connectorNames.length))) {
  await import("./pinned-src/harness/container/runtime/main");
} else {
  // Match the pinned daemon's user and session layout.
  const user = /^(\d+):(\d+)$/.exec(process.env.CF_HARNESS_USER ?? "");
  const cli = name === "codex" ? codexCli : claudeCodeCli;
  const adapter = cliAdapter({
    ...cli,
    ...(name === "claude-code" ? {
      parser: turn => withClaudeTerminalDiagnostics(claudeCodeCli.parser(turn)),
    } : {}),
    ...(supervisedCodex ? {
      parser: turn => withCodexPublicationTerminal(codexCli.parser(turn)),
    } : {}),
    command(turn) {
      const command = withManagedMcp(cli.command(turn), name, connectorNames);
      if (!publication) return command;
      const supervisor = supervisedCodex ? ["supervise-codex", checkoutTimeout ?? ""] : ["agent"];
      return { ...command, argv: ["/usr/local/bin/sandbox-runner-checkout", ...supervisor, ...command.argv] };
    },
    ...(user ? {
      user: { uid: Number(user[1]), gid: Number(user[2]) },
      homes: "/home/agent/.harness/sessions",
      skeleton: "/home/agent",
    } : {}),
  });
  await serveFromEnv(checkout ? withGithubCheckout(adapter, checkout) : adapter).catch((error: unknown) => {
    console.error(`harness-daemon: ${String(error)}`);
    process.exit(1);
  });
}
