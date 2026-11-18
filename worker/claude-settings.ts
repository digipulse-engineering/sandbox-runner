import { runSettings } from "./agent-settings.ts";
import type { AgentSettings } from "./agent-settings.ts";
import { isAgentEffort, isClaudeModel } from "./run-input-validation.mjs";

export type ClaudeDefaultsEnv = {
  SANDBOX_RUNNER_CLAUDE_MODEL?: string;
  SANDBOX_RUNNER_CLAUDE_EFFORT?: string;
};

export function resolveClaudeSettings(
  requested: AgentSettings | undefined, env: ClaudeDefaultsEnv,
): AgentSettings | "claude_defaults_invalid" {
  const model = requested?.model ?? env.SANDBOX_RUNNER_CLAUDE_MODEL;
  const effort = requested?.effort ?? env.SANDBOX_RUNNER_CLAUDE_EFFORT;
  if ((model !== undefined && !isClaudeModel(model)) || (effort !== undefined && !isAgentEffort(effort))) {
    return "claude_defaults_invalid";
  }
  return runSettings({ model, effort });
}
