import type { CliParser } from "./pinned-src/harness/container/runtime/cli-adapter";
import type { ContainerOutcome } from "./pinned-src/harness/container/protocol";

// cliAdapter prefers a reported terminal outcome over the process exit code.
// Keep the pinned parser's last outcome private until the supervisor has exited.
export function withCodexPublicationTerminal(parser: CliParser): CliParser {
  let terminal: ContainerOutcome | undefined;
  return {
    line(text) {
      const { outcome, ...updates } = parser.line(text);
      if (outcome) terminal = outcome;
      return updates;
    },
    end(exit) {
      if (terminal?.status === "done" && exit.code !== 0) {
        return { status: "unanswered", reason: "github_publication_supervisor_unverified" };
      }
      return terminal ?? parser.end(exit);
    },
  };
}
