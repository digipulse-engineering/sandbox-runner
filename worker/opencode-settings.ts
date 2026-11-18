import { openCodeModels, openCodeReviewEffort, openCodeReviewModel } from "./run-input-validation.mjs";

export { isModelProvider, resolveOpenCodeSettings } from "./run-input-validation.mjs";

export const openCodeVersion = "2.2.7";
export const openCodeHost = "opencode.harness.internal";
export const openCodePlaceholder = "sandbox-runner-opencode-placeholder";
export const openCodeAnthropicVersion = "2023-06-01";
export const openCodeQuotaReason = "opencode_quota_confirmed";

export const openCodeProviders = {
  openai: {
    model: openCodeModels.openai, package: "@opencode/ai/providers/openai-compatible",
    upstream: "https://api.openai.com", path: "/v1/chat/completions",
    header: "authorization", binding: "SANDBOX_RUNNER_OPENCODE_OPENAI_API_KEY",
  },
  anthropic: {
    model: openCodeModels.anthropic, package: "@opencode/ai/providers/anthropic",
    upstream: "https://api.anthropic.com", path: "/v1/messages",
    header: "x-api-key", binding: "SANDBOX_RUNNER_OPENCODE_ANTHROPIC_API_KEY",
  },
} as const;

export type ModelProvider = keyof typeof openCodeProviders;
export type OpenCodeSettings = { modelProvider: ModelProvider; model: string; effort?: "high" | "xhigh" };

export function isOpenCodeReview(settings: OpenCodeSettings): boolean {
  return settings.modelProvider === "openai" && settings.model === openCodeReviewModel && settings.effort === openCodeReviewEffort;
}

export function openCodeModelRef(settings: OpenCodeSettings): string {
  const { model, effort } = settings;
  return "gateway/" + model + (effort === undefined ? "" : "#" + effort);
}

export function openCodeConfig(settings: OpenCodeSettings, connectors: readonly string[] = []) {
  const { modelProvider, model } = settings;
  const review = isOpenCodeReview(settings);
  const baseURL = "http://" + openCodeHost + "/v1";
  const readActions = ["read", "glob", "grep", ...connectors.map(name => name + "_*")];
  const deniedActions = ["edit", "shell", "subagent", "webfetch", "websearch", "execute", "skill"];
  return {
    model: openCodeModelRef(settings),
    autoupdate: false,
    ...(review ? {
      plugins: ["-opencode.tool.skill"],
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        ...readActions.map(action => ({ action, resource: "*", effect: "allow" })),
        ...deniedActions.map(action => ({ action, resource: "*", effect: "deny" })),
      ],
      policies: [
        { action: "tool.use", resource: "*", effect: "deny" },
        ...readActions.map(action => ({ action: "tool.use", resource: action + ":*", effect: "allow" })),
        ...deniedActions.map(action => ({ action: "tool.use", resource: action + ":*", effect: "deny" })),
      ],
      ...(connectors.length ? { mcp: { servers: Object.fromEntries(connectors.map(name => [name, {
        type: "remote", url: `http://mcp.harness.internal/${name}/mcp`, oauth: false, codemode: false,
      }])) } } : {}),
    } : {}),
    providers: {
      gateway: {
        name: "Sandbox Runner",
        env: ["SANDBOX_RUNNER_OPENCODE_PLACEHOLDER"],
        package: review ? "@opencode/ai/providers/openai/responses" : openCodeProviders[modelProvider].package,
        settings: review ? { baseURL, transport: "http", encoding: "none" } : { baseURL },
        models: { [model]: {
          name: model,
          ...(review ? { capabilities: { toolCall: true }, variants: [{
            id: openCodeReviewEffort, settings: { reasoningEffort: openCodeReviewEffort },
          }] } : {}),
          ...(modelProvider === "anthropic" ? { variants: [{
            id: "high",
            body: { thinking: { type: "adaptive" }, output_config: { effort: "high" } },
          }] } : {}),
        } },
      },
    },
  };
}

export function openCodeEnv(settings: OpenCodeSettings, connectors?: readonly string[]): Record<string, string> {
  return {
    SANDBOX_RUNNER_OPENCODE_PROVIDER: settings.modelProvider,
    SANDBOX_RUNNER_OPENCODE_MODEL: settings.model,
    ...(settings.effort === undefined ? {} : { SANDBOX_RUNNER_OPENCODE_EFFORT: settings.effort }),
    SANDBOX_RUNNER_OPENCODE_PLACEHOLDER: openCodePlaceholder,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig(settings, connectors)),
    ...(isOpenCodeReview(settings) && connectors?.length
      ? { SANDBOX_RUNNER_OPENCODE_REVIEW_CONNECTORS: JSON.stringify(connectors) } : {}),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    DO_NOT_TRACK: "1",
  };
}
