import { isAgentEffort, isClaudeModel } from "../worker/run-input-validation.mjs";

export function claudeOptionsError(agent, { model, effort }) {
  if (model === undefined && effort === undefined) return;
  if (agent !== "claude") return "--model and --effort are available for Claude only.";
  if (model !== undefined && !isClaudeModel(model)) {
    return "--model must be a supported Claude model alias or an ID up to 5,000 bytes.";
  }
  if (effort !== undefined && !isAgentEffort(effort)) {
    return "--effort must be low, medium, high, xhigh, or max.";
  }
}
