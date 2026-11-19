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

// Web search runs on OpenAI's side, never from the container, for every auth mode. "cached" serves results from
// OpenAI's search index rather than live pages, so the agent can look up documentation with less exposure to pages
// written for it. Codex would otherwise choose "live", because the run bypasses its own sandbox.
export const codexWebSearch = 'web_search="cached"';

export function codexPresetSettings({ model, effort }: AgentSettings, authMode: AuthMode) {
  return {
    model: model ?? (authMode === "subscription" ? "gpt-6.1-sol" : "gpt-5.1"),
    config: [codexWebSearch, ...(effort === undefined ? [] : [`model_reasoning_effort=${JSON.stringify(effort)}`])],
  };
}
