import type { AuthMode } from "./contract.ts";

type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AgentSettings = { model?: string; effort?: AgentEffort };

export function runSettings({ model, effort }: AgentSettings): AgentSettings {
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

export function sameRunSettings(left?: AgentSettings, right?: AgentSettings): boolean {
  return left?.model === right?.model && left?.effort === right?.effort;
}

export function codexPresetSettings({ model, effort }: AgentSettings, authMode: AuthMode) {
  return {
    model: model ?? (authMode === "subscription" ? "gpt-6.1-sol" : "gpt-5.1"),
    config: effort === undefined ? [] : [`model_reasoning_effort=${JSON.stringify(effort)}`],
  };
}
