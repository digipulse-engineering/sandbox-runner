import type { CliParser } from "./pinned-src/harness/container/runtime";
import { openCodeQuotaReason } from "./opencode-settings.ts";

function responseCode(body: unknown): unknown {
  if (typeof body !== "string") return;
  try {
    return JSON.parse(body)?.error?.code;
  } catch {
    return;
  }
}

export function openCodeParser(): CliParser {
  let text = "";
  let stopped = false;
  return {
    line(line) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return {};
      }
      if (event?.type === "sandbox_runner_mcp_startup_failed") {
        return { outcome: { status: "unanswered", reason: "opencode_mcp_startup_failed" } };
      }
      if (event?.type === "step_start") {
        text = "";
        stopped = false;
      }
      if (event?.type === "text" && typeof event.part?.text === "string") text += event.part.text;
      if (event?.type === "step_finish") stopped = event.part?.reason === "stop";
      if (event?.type === "error") {
        const error = event.error;
        const quota = error?.type === "provider.quota" && error.status === 429 &&
          responseCode(error.response?.body) === "insufficient_quota";
        return { outcome: { status: "unanswered", reason: quota ? openCodeQuotaReason : "opencode_terminal_error" } };
      }
      return {};
    },
    end({ code }) {
      if (code === 0 && stopped && text) return { status: "done", text };
      return { status: "unanswered", reason: "opencode_incomplete" };
    },
  };
}
