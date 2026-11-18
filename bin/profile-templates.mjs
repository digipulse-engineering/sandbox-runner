import { parseProfileConfig, ProfileError, profileInputContract, profileRevision, validProfileSlug } from "../worker/run-profiles.mjs";
import { isAgentEffort, isClaudeModel, isCodexModel, isModelProvider, openCodeModels, openCodeReviewEffort,
  openCodeReviewModel, parseConnectorNames, resolveOpenCodeSettings, validRepositorySlug } from "../worker/run-input-validation.mjs";

const templates = {
  executor: {
    usage: "executor", kind: "agent", operation: "start",
    description: "Implement a scoped change in an approved repository.",
  },
  "delivery-review": {
    usage: "delivery-review", kind: "agent", operation: "review",
    description: "Review a delivered commit against its acceptance criteria and test evidence.",
  },
  vitest: {
    usage: "test", kind: "test", runner: "vitest",
    description: "Run Vitest using the repository's npm lockfile and test configuration.",
  },
  "test-command": {
    usage: "test", kind: "test", runner: "command",
    description: "Run a fixed command after offline installation from the repository's lockfile.",
  },
  "tier2-review": {
    usage: "tier2-review", kind: "agent", operation: "review",
    description: "Prepare an independent adversarial review route for the installation's broker policy.",
  },
};
const agentHarnesses = ["claude", "codex", "opencode"];
const authModes = ["api-key", "subscription"];
const modelProviders = ["openai", "anthropic"];
const defaultModels = { claude: "claude-sonnet-5-5", codex: "gpt-6.1-sol" };
const effortValues = ["low", "medium", "high", "xhigh", "max"];
const commonFields = ["slug", "repo", "description"];
const agentFields = ["harness", "authMode", "modelProvider", "model", "effort", "publish", "connectors"];
const validText = value => typeof value === "string" && value.isWellFormed() && !value.includes("\0");

function details(id) {
  if (typeof id !== "string" || !Object.hasOwn(templates, id)) {
    throw new ProfileError("profile_template_not_found", "Use profile template list to choose an available template.");
  }
  return templates[id];
}

function templateSummary(id) {
  const { usage, kind, description } = details(id);
  return { id, revision: 1, usage, kind, description, sandboxProvider: "cloudflare" };
}

function harnesses(template) {
  return template.usage === "tier2-review" ? ["claude", "codex"] : agentHarnesses;
}

function templateRoute(template, harness) {
  if (template.usage === "tier2-review") {
    return { authModes: ["subscription"], defaultAuthMode: "subscription", defaultEffort: "xhigh", efforts: ["xhigh"],
      acceptsConnectors: false, acceptsPublication: false };
  }
  const review = template.operation === "review";
  if (harness === "opencode") {
    return { authModes: ["api-key"], defaultAuthMode: "api-key", requiredInputs: ["modelProvider"],
      modelProviders: review ? ["openai"] : [...modelProviders],
      defaultsByModelProvider: review ? { openai: { model: openCodeReviewModel, effort: openCodeReviewEffort } }
        : { openai: { model: openCodeModels.openai }, anthropic: { model: openCodeModels.anthropic } },
      effortsByModelProvider: review ? { openai: [openCodeReviewEffort] } : { openai: [], anthropic: ["high"] },
      acceptsConnectors: review, acceptsPublication: false };
  }
  return { authModes: [...authModes], requiredInputs: ["authMode"], defaultModel: defaultModels[harness],
    defaultEffort: "high", efforts: [...effortValues], acceptsConnectors: true, acceptsPublication: !review };
}

export function listProfileTemplates() {
  return { templates: Object.keys(templates).map(templateSummary) };
}

export function getProfileTemplate(id) {
  const template = details(id);
  const isAgent = template.kind === "agent";
  const tier2 = template.usage === "tier2-review";
  return { template: { ...templateSummary(id), ...(isAgent ? { operation: template.operation } : { runner: template.runner }),
    requiredInputs: ["slug", "repo", ...(isAgent ? ["harness"] : []), ...(tier2 ? ["model"] : []),
      ...(template.runner === "command" ? ["argv"] : [])],
    ...(isAgent ? { routes: Object.fromEntries(harnesses(template).map(harness => [harness, templateRoute(template, harness)])),
      ...(tier2 ? { recommendedLaunch: "broker" } : {}) } : {}),
    requirements: isAgent ? ["repository-access", "provider-credential", "route-qualification",
      ...(tier2 ? ["broker-policy", "review-independence"] : [])] : ["repository-access", "compatible-lockfile"],
  } };
}

function templateInputsError(issues) {
  const error = new ProfileError("invalid_profile_template_inputs", "Correct the template inputs before creating a profile.");
  error.issues = issues;
  return error;
}

export async function createProfileFromTemplate(id, input) {
  const template = details(id);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw templateInputsError([{ field: "$", code: "invalid_type", message: "Supply a template input object." }]);
  }
  const issues = [];
  const issue = (field, code, message, allowed) => issues.push({ field, code, message, ...(allowed ? { allowed } : {}) });
  const check = (field, valid, message, { required = false, allowed } = {}) => {
    if (!Object.hasOwn(input, field)) {
      if (required) issue(field, "required", message, allowed);
    } else if (!valid(input[field])) issue(field, "invalid_value", message, allowed);
  };
  const isAgent = template.kind === "agent";
  const command = template.runner === "command";
  const tier2 = template.usage === "tier2-review";
  const accepted = [...commonFields, ...(isAgent ? agentFields : command ? ["argv"] : [])];
  if (Object.keys(input).some(key => !accepted.includes(key))) issue("$", "unexpected_field", "Remove fields that this template does not accept.");
  check("slug", validProfileSlug, "Supply a lowercase profile slug with hyphens.", { required: true });
  check("repo", validRepositorySlug, "Supply the approved OWNER/REPO.", { required: true });
  check("description", value => validText(value) && value.trim().length > 0, "Supply a nonempty description.");
  if (command) check("argv", value => Array.isArray(value) && !!value[0]?.length && [...value].every(validText),
    "Supply the executable and its ordered arguments.", { required: true });

  const { slug, repo, description = template.description, harness, modelProvider, connectors, publish } = input;
  let { authMode, model, effort } = input;
  if (isAgent) {
    const supportedHarnesses = harnesses(template);
    const review = template.operation === "review";
    check("harness", value => supportedHarnesses.includes(value), "Choose a harness supported by this template.",
      { required: true, allowed: supportedHarnesses });
    const route = supportedHarnesses.includes(harness) ? templateRoute(template, harness) : undefined;
    const availableAuthModes = route?.authModes ?? (tier2 ? ["subscription"] : authModes);
    check("authMode", value => availableAuthModes.includes(value), "Choose an authorized authentication mode.",
      { required: route?.requiredInputs?.includes("authMode"), allowed: availableAuthModes });
    if (route && harness === "opencode") {
      const providers = route.modelProviders;
      check("modelProvider", value => providers.includes(value), "Choose a model provider supported by the OpenCode route.",
        { required: true, allowed: providers });
      if (isModelProvider(modelProvider) && providers.includes(modelProvider)) {
        const settings = resolveOpenCodeSettings(modelProvider, review ? openCodeReviewModel : undefined,
          review ? openCodeReviewEffort : undefined, review);
        check("model", value => value === settings.model, "Use the model supported by the OpenCode route.", { allowed: [settings.model] });
        const efforts = route.effortsByModelProvider[modelProvider];
        check("effort", value => efforts.includes(value), "Use an effort supported by the OpenCode route.", { allowed: efforts });
        model ??= settings.model;
        effort ??= settings.effort;
      }
    } else if (route) {
      check("modelProvider", () => false, "Remove modelProvider for this harness.");
      const validModel = harness === "claude" ? value => isClaudeModel(value) && value.startsWith("claude-") : isCodexModel;
      check("model", validModel, "Supply an exact model ID for this harness.", { required: tier2 });
      check("effort", value => isAgentEffort(value) && route.efforts.includes(value), "Choose an effort supported by this route.",
        { allowed: route.efforts });
      model ??= route.defaultModel;
      effort ??= route.defaultEffort;
    }
    check("publish", value => typeof value === "boolean" && (!value || (route?.acceptsPublication ?? !review)),
      "Publication is available for Claude and Codex executors.");
    check("connectors", value => (route?.acceptsConnectors ?? !tier2) && parseConnectorNames(value) !== undefined,
      "Supply distinct managed connectors supported by this route.");
    authMode ??= route?.defaultAuthMode;
  }
  if (issues.length) throw templateInputsError(issues);

  const profile = { kind: template.kind, usage: template.usage, description, sandboxProvider: "cloudflare", defaults: { repo } };
  if (isAgent) {
    Object.assign(profile, { harness, operation: template.operation, authMode });
    Object.assign(profile.defaults, { model, ...(effort === undefined ? {} : { effort }) });
    if (harness === "opencode") profile.modelProvider = modelProvider;
    if (connectors !== undefined) profile.mcp = { connectors: parseConnectorNames(connectors) };
    if (publish) profile.publish = true;
  } else {
    profile.runner = template.runner;
    if (command) profile.argv = [...input.argv];
  }
  const config = parseProfileConfig({ schemaVersion: 1, profiles: { [slug]: profile } });
  return { slug, profile, config, revision: await profileRevision(profile), inputContract: profileInputContract(profile),
    template: { id, revision: 1 }, qualification: "unverified" };
}
