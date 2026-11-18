import type { PresetAgent, AuthMode } from "./contract";
import { openCodeHost, openCodeProviders } from "./opencode-settings.ts";
import type { ModelProvider } from "./opencode-settings.ts";

type ProviderBinding = "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "OPENAI_SUBSCRIPTION_OAUTH_TOKEN" |
  typeof openCodeProviders[ModelProvider]["binding"];
export type ProviderEnv = Partial<Record<ProviderBinding, string>> & { SANDBOX_RUNNER_MODE: string };

type ProviderConfig = {
  host: string;
  upstream: string;
  path: string;
  searches: string[];
  binding: ProviderBinding;
  header: "authorization" | "x-api-key";
  originator?: string;
};

const openai = {
  host: "openai.harness.internal",
  upstream: "https://api.openai.com/v1",
  path: "/responses",
  searches: [],
};

const anthropic = {
  host: "anthropic.harness.internal",
  upstream: "https://api.anthropic.com",
  path: "/v1/messages",
  searches: ["?beta=true"],
};

const providers = {
  claude: {
    subscription: { ...anthropic, binding: "CLAUDE_CODE_OAUTH_TOKEN", header: "authorization" },
    "api-key": { ...anthropic, binding: "ANTHROPIC_API_KEY", header: "x-api-key" },
  },
  codex: {
    subscription: {
      ...openai, binding: "OPENAI_SUBSCRIPTION_OAUTH_TOKEN", header: "authorization", originator: "sandbox-runner",
    },
    "api-key": { ...openai, binding: "OPENAI_API_KEY", header: "authorization" },
  },
} satisfies Record<PresetAgent, Record<AuthMode, ProviderConfig>>;

export function providerConfig(agent: PresetAgent, authMode: AuthMode): ProviderConfig {
  return providers[agent][authMode];
}

export function openCodeProviderConfig(modelProvider: ModelProvider, review = false): ProviderConfig {
  return { ...openCodeProviders[modelProvider], host: openCodeHost, searches: [],
    ...(review && modelProvider === "openai" ? { path: "/v1/responses" } : {}) };
}

export function providerCredential(provider: ProviderConfig, env: ProviderEnv): string | undefined {
  const token = env.SANDBOX_RUNNER_MODE === "fixture" ? "sandbox-runner-fixture-upstream" : env[provider.binding];
  if (typeof token !== "string" || !token || /\s/.test(token)) return;
  // Reject the platform API key prefix in the user OAuth binding.
  if (provider.binding === "OPENAI_SUBSCRIPTION_OAUTH_TOKEN" && /^sk-/i.test(token)) return;
  // A compact JWT in the API key slot may be a misplaced user OAuth token.
  if ((provider.binding === "OPENAI_API_KEY" || provider.binding === openCodeProviders.openai.binding ||
      provider.binding === openCodeProviders.anthropic.binding) &&
      /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return;
  // Provisioning outside the CLI must not send a recognizable key to the other provider.
  if (provider.binding === openCodeProviders.openai.binding && /^sk-ant-/i.test(token)) return;
  if (provider.binding === openCodeProviders.anthropic.binding &&
      (/^sk-ant-oat/i.test(token) || /^sk-(?!ant-)/i.test(token))) return;
  return provider.header === "authorization" ? "Bearer " + token : token;
}
