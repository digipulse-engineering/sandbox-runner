import { openCodeModels, openCodeReviewEffort, openCodeReviewModel, resolveOpenCodeSettings } from "../worker/run-input-validation.mjs";

export const openCodeProviders = new Map([
  ["openai", { model: openCodeModels.openai, binding: "SANDBOX_RUNNER_OPENCODE_OPENAI_API_KEY" }],
  ["anthropic", { model: openCodeModels.anthropic, binding: "SANDBOX_RUNNER_OPENCODE_ANTHROPIC_API_KEY" }],
]);

export function openCodeOptionsError({ modelProvider, model, effort }, review = false) {
  if (review) {
    if (!resolveOpenCodeSettings(modelProvider, model, effort, true)) {
      return `OpenCode review requires --model-provider openai, --model ${openCodeReviewModel}, and --effort ${openCodeReviewEffort}.`;
    }
    return;
  }
  const provider = openCodeProviders.get(modelProvider);
  if (!provider) return "--model-provider must be openai or anthropic.";
  if (model !== undefined && model !== provider.model) return "The selected OpenCode provider supports only " + provider.model + ".";
  if (effort !== undefined && (modelProvider !== "anthropic" || effort !== "high")) {
    return "OpenCode supports --effort high with the Anthropic provider.";
  }
}
