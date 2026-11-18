import { gitReferencePattern, isAgentEffort, isClaudeModel, isCodexModel, operationId, parseConnectorNames, parseRepositoryRequest,
  resolveOpenCodeSettings, validGitReference, validRepositorySlug } from "./run-input-validation.mjs";

const reservedSlugs = new Set(["constructor", "prototype"]);
const agentHarnesses = new Set(["claude", "codex", "opencode"]);
const reviewers = new Set(["claude", "codex"]);
const authModes = new Set(["subscription", "api-key"]);
const optionFields = ["repo", "model", "effort"];
const commonFields = ["kind", "description", "usage", "sandboxProvider", "defaults", "allowedOverrides"];
const inputFields = ["source", "prompt", "producerAgent", "authMode", "overrides"];
const shaPattern = "^[a-fA-F0-9]{40}$";
const shaRegex = new RegExp(shaPattern, "u");

export const profileInputErrorMessage = "Correct the profile run inputs and try again.";

/** @typedef {{field: string, code: string, message: string, allowed?: string[]}} ProfileInputIssue */

export class ProfileError extends Error {
  /** @param {string} code @param {string} message @param {ProfileInputIssue[]} [issues] */
  constructor(code, message, issues) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
    this.issues = issues;
  }
}

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyFields(value, fields) {
  return object(value) && Object.keys(value).every(key => fields.includes(key));
}

function validText(value) {
  return typeof value === "string" && value.isWellFormed() && !value.includes("\0");
}

export function validProfileSlug(value) {
  return typeof value === "string" && value.trim() === value && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value) &&
    !reservedSlugs.has(value);
}

function validProfileOption(profile, field, value) {
  if (field === "repo") return validRepositorySlug(value);
  if (field === "effort") return isAgentEffort(value);
  // Claude alias targets can change even when the profile revision stays the same.
  return profile.harness === "claude" ? isClaudeModel(value) && value.startsWith("claude-") : isCodexModel(value);
}

function profileOptionFields(profile) {
  if (reviewers.has(profile.harness)) return optionFields;
  return ["repo"];
}

function validAuthMode(agent, mode) {
  return authModes.has(mode) && (agent !== "opencode" || mode === "api-key");
}

function profileUsages(profile) {
  if (profile.kind === "test") return ["test"];
  if (profile.operation === "review") return ["delivery-review", "tier2-review"];
  return ["executor"];
}

/** The profile's declared purpose is discovery metadata. */
export function profileUsage(profile) {
  return profile.usage ?? (profile.operation === "review" ? "review" : profileUsages(profile)[0]);
}

function checkProfileOptions(profile) {
  const fields = profileOptionFields(profile);
  const defaultFields = profile.harness === "opencode"
    ? ["repo", "model", ...(profile.modelProvider === "anthropic" || profile.operation === "review" ? ["effort"] : [])]
    : fields;
  const { defaults = {}, allowedOverrides = {} } = profile;
  if (!onlyFields(defaults, defaultFields) || !onlyFields(allowedOverrides, fields)) {
    throw new ProfileError("invalid_profile", "A default or override is unavailable for this runner.");
  }
  if (profile.harness === "opencode" && (Object.hasOwn(defaults, "model") && typeof defaults.model !== "string" ||
      Object.hasOwn(defaults, "effort") && typeof defaults.effort !== "string" ||
      !resolveOpenCodeSettings(profile.modelProvider, defaults.model, defaults.effort, profile.operation === "review"))) {
    throw new ProfileError("invalid_profile", "The OpenCode model or effort is unavailable for this provider.");
  }
  for (const field of fields) {
    const hasDefault = Object.hasOwn(defaults, field);
    const hasAllowlist = Object.hasOwn(allowedOverrides, field);
    const allowed = allowedOverrides[field];
    if (hasDefault && !validProfileOption(profile, field, defaults[field])) {
      throw new ProfileError("invalid_profile", `Invalid profile default for ${field}.`);
    }
    if (hasAllowlist) {
      if (!Array.isArray(allowed) || !allowed.length || ![...allowed].every(value => validProfileOption(profile, field, value))) {
        throw new ProfileError("invalid_profile", `Invalid profile allowlist for ${field}.`);
      }
      const unique = field === "repo" ? allowed.map(repo => repo.toLowerCase()) : allowed;
      if (new Set(unique).size !== allowed.length || (hasDefault && !allowed.includes(defaults[field]))) {
        throw new ProfileError("invalid_profile", `The ${field} allowlist must contain distinct values and include any default.`);
      }
    }
  }
  if (!Object.hasOwn(defaults, "repo") && !Object.hasOwn(allowedOverrides, "repo")) {
    throw new ProfileError("invalid_profile", "A profile requires defaults.repo or allowedOverrides.repo.");
  }
}

function validateProfile(profile) {
  if (!object(profile) || (profile.kind !== "agent" && profile.kind !== "test") ||
      (Object.hasOwn(profile, "sandboxProvider") && profile.sandboxProvider !== "cloudflare") ||
      (Object.hasOwn(profile, "description") && !validText(profile.description))) {
    throw new ProfileError("invalid_profile", "A profile must select a supported runner and sandbox provider.");
  }
  if (profile.kind === "agent") {
    const { harness, operation, mcp, publish, authMode } = profile;
    const fields = [...commonFields, "harness", "operation", "authMode"];
    if (harness === "opencode") fields.push("modelProvider");
    if (reviewers.has(harness) || harness === "opencode" && operation === "review") fields.push("mcp");
    if (reviewers.has(harness) && operation === "start") fields.push("publish");
    if (!agentHarnesses.has(harness) || (operation !== "start" && operation !== "review") ||
        !onlyFields(profile, fields) || (Object.hasOwn(profile, "publish") && typeof publish !== "boolean")) {
      throw new ProfileError("invalid_profile", "A profile contains an operation or field unavailable for its agent harness.");
    }
    if (Object.hasOwn(profile, "authMode") && !validAuthMode(harness, authMode)) {
      throw new ProfileError("invalid_profile", "The authentication mode is unavailable for this agent harness.");
    }
    if (Object.hasOwn(profile, "mcp") && (!onlyFields(mcp, ["connectors"]) ||
        !parseConnectorNames(mcp.connectors) || ![...mcp.connectors].every(name => typeof name === "string" && name.trim() === name))) {
      throw new ProfileError("invalid_profile", "Supply distinct configured MCP connector names.");
    }
  } else {
    const { runner, argv, checkout } = profile;
    const fields = [...commonFields, "runner", ...(runner === "command" ? ["argv", "checkout"] : [])];
    if ((runner !== "vitest" && runner !== "command") || !onlyFields(profile, fields) ||
        (runner === "command" && (!Array.isArray(argv) || !argv[0] || ![...argv].every(validText) ||
          (Object.hasOwn(profile, "checkout") && checkout !== "shallow")))) {
      throw new ProfileError("invalid_profile", "A test profile must select Vitest or supply a command argument vector.");
    }
  }
  if (Object.hasOwn(profile, "usage") && !profileUsages(profile).includes(profile.usage)) {
    throw new ProfileError("invalid_profile", "The profile usage is unavailable for this runner operation.");
  }
  checkProfileOptions(profile);
  return profile;
}

export function parseProfileConfig(value) {
  if (!onlyFields(value, ["schemaVersion", "profiles"]) || value.schemaVersion !== 1 || !object(value.profiles)) {
    throw new ProfileError("invalid_profile_config", "Expected a JSON object with schemaVersion 1 and a profiles object.");
  }
  for (const [slug, profile] of Object.entries(value.profiles)) {
    if (!validProfileSlug(slug)) throw new ProfileError("invalid_profile_config", "Profile slugs must use lowercase ASCII names.");
    validateProfile(profile);
  }
  return value;
}

function inputRules(profile) {
  const { defaults = {}, allowedOverrides = {} } = profile;
  const agent = profile.kind === "agent";
  const review = agent && profile.operation === "review";
  const pinnedAuth = profile.authMode ?? (profile.harness === "opencode" ? "api-key" : undefined);
  return {
    agent, review, exactSha: review || profile.checkout === "shallow", defaults, allowedOverrides, pinnedAuth,
    requiredOverrides: optionFields.filter(field => Object.hasOwn(allowedOverrides, field) && !Object.hasOwn(defaults, field)),
    producers: [...reviewers].filter(harness => harness !== profile.harness),
    authOptions: pinnedAuth === undefined ? [...authModes] : [pinnedAuth],
  };
}

/** JSON Schema for the business inputs of this profile, excluding the transport envelope. */
export function profileInputContract(profile) {
  const rules = inputRules(validateProfile(profile));
  const sha = { type: "string", minLength: 40, maxLength: 40, pattern: shaPattern };
  const ref = { type: "string", pattern: gitReferencePattern, description: "Full Git branch or tag reference in well-formed Unicode." };
  const source = { type: "object", additionalProperties: false,
    properties: rules.exactSha ? { sha } : { sha, ref }, minProperties: 1, maxProperties: 1,
    ...(rules.exactSha ? { required: ["sha"] } : {}) };
  const overrideFields = Object.fromEntries(optionFields.filter(field => Object.hasOwn(rules.allowedOverrides, field))
    .map(field => [field, { type: "string", enum: [...rules.allowedOverrides[field]],
      ...(Object.hasOwn(rules.defaults, field) ? { default: rules.defaults[field] } : {}) }]));
  const required = ["source"];
  const properties = { source };
  if (rules.agent) {
    properties.prompt = { type: "string", pattern: "[^\\s\\u0000]", not: { pattern: "\\u0000" },
      description: "Nonempty task or review criteria in well-formed Unicode." };
    required.push("prompt");
    if (rules.review) {
      properties.producerAgent = { type: "string", enum: rules.producers, description: "Harness that produced the candidate." };
      required.push("producerAgent");
    }
    properties.authMode = { type: "string", enum: rules.authOptions,
      ...(rules.pinnedAuth === undefined ? {} : { default: rules.pinnedAuth }) };
  }
  properties.overrides = { type: "object", additionalProperties: false, properties: overrideFields,
    ...(rules.requiredOverrides.length ? { required: rules.requiredOverrides } : {}) };
  if (rules.requiredOverrides.length) required.push("overrides");
  return { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false, required, properties };
}

function sourceIssues(rules, source, add) {
  if (source === undefined) return add("source", "required", rules.exactSha
    ? "Supply an exact commit SHA for this profile." : "Supply the source for the run.");
  if (!object(source)) return add("source", "invalid_type", "Source must be an object.");
  const hasSha = Object.hasOwn(source, "sha");
  const hasRef = Object.hasOwn(source, "ref");
  if (Object.keys(source).some(field => field !== "sha" && field !== "ref")) {
    add("source", "unexpected_field", "Source accepts only a commit SHA or Git reference.");
  }
  if (rules.exactSha && hasRef) add("source", "exact_sha_required", "Supply an exact commit SHA for this profile.");
  else if (hasSha && hasRef) add("source", "source_conflict", "Supply exactly one commit SHA or Git reference.");
  else if (!hasSha && !hasRef) add("source", "required", rules.exactSha
    ? "Supply an exact commit SHA for this profile." : "Supply a commit SHA or an allowed Git reference.");
  if (hasSha && (typeof source.sha !== "string" || source.sha.length !== 40 || !shaRegex.test(source.sha))) {
    add("source.sha", "invalid_sha", "Supply a full 40-character hexadecimal commit SHA.");
  }
  if (hasRef && !rules.exactSha && !validGitReference(source.ref)) {
    add("source.ref", "invalid_ref", "Supply a full Git branch or tag reference.");
  }
}

function agentIssues(rules, input, add) {
  if (!rules.agent) {
    for (const field of ["prompt", "producerAgent", "authMode"]) {
      if (Object.hasOwn(input, field)) add(field, "unexpected_field", "This field is available only for agent profiles.");
    }
    return;
  }
  if (!Object.hasOwn(input, "prompt")) add("prompt", "required", "Supply a task or review criteria.");
  else if (typeof input.prompt !== "string") add("prompt", "invalid_type", "The prompt must be text.");
  else if (!validText(input.prompt) || !input.prompt.trim()) add("prompt", "invalid_value", "Supply a nonempty, valid prompt.");
  if (rules.review) {
    if (!Object.hasOwn(input, "producerAgent")) add("producerAgent", "required", "Identify the harness that produced the candidate.", rules.producers);
    else if (reviewers.has(input.producerAgent) && !rules.producers.includes(input.producerAgent)) {
      add("producerAgent", "same_harness", "Use a different harness from the one that produced the candidate.", rules.producers);
    } else if (!rules.producers.includes(input.producerAgent)) {
      add("producerAgent", "invalid_value", "Supply a supported producer harness.", rules.producers);
    }
  } else if (Object.hasOwn(input, "producerAgent")) {
    add("producerAgent", "unexpected_field", "Only review profiles accept a producer harness.");
  }
  if (Object.hasOwn(input, "authMode") && !rules.authOptions.includes(input.authMode)) {
    if (rules.pinnedAuth !== undefined && authModes.has(input.authMode)) {
      add("authMode", "override_not_allowed", "This profile pins a different authentication mode.", rules.authOptions);
    } else add("authMode", "invalid_value", "Supply a supported authentication mode.", rules.authOptions);
  }
}

function overrideIssues(rules, overrides, add) {
  if (overrides !== undefined && !object(overrides)) {
    return add("overrides", "invalid_type", "Overrides must be an object.");
  }
  const values = overrides ?? {};
  if (Object.keys(values).some(field => !optionFields.includes(field))) {
    add("overrides", "override_not_allowed", "Overrides contain a field that this profile does not accept.");
  }
  for (const field of optionFields) {
    const allowed = Object.hasOwn(rules.allowedOverrides, field) ? rules.allowedOverrides[field] : undefined;
    if (Object.hasOwn(values, field)) {
      if (!allowed || !allowed.includes(values[field])) {
        const code = allowed && typeof values[field] !== "string" ? "invalid_type" : "override_not_allowed";
        add(`overrides.${field}`, code, `Supply an allowed value for ${field}.`, allowed);
      }
    } else if (rules.requiredOverrides.includes(field)) {
      add(`overrides.${field}`, "required", `Supply a value for ${field}.`, allowed);
    }
  }
}

function inputIssues(profile, input) {
  /** @type {ProfileInputIssue[]} */
  const issues = [];
  const add = (field, code, message, allowed) => {
    issues.push({ field, code, message, ...(allowed ? { allowed: [...allowed] } : {}) });
  };
  if (!object(input)) {
    add("$", "invalid_type", "Profile inputs must be an object.");
    return issues;
  }
  const rules = inputRules(profile);
  sourceIssues(rules, input.source, add);
  agentIssues(rules, input, add);
  overrideIssues(rules, input.overrides, add);
  if (Object.keys(input).some(field => !inputFields.includes(field))) {
    add("$", "unexpected_field", "Profile inputs contain an unknown field.");
  }
  return issues;
}

/** Report all independent issues in a profile's business inputs. */
export function validateProfileInputs(profile, input) {
  return inputIssues(validateProfile(profile), input);
}

export function resolveProfileRequest(value) {
  if (!object(value) || value.kind !== "profile" ||
      !onlyFields(value.profile, ["slug", "body"]) || !validProfileSlug(value.profile.slug)) {
    throw new ProfileError("invalid_profile_request", "Expected a named profile and its definition.");
  }
  const { kind: _kind, operationId: rawId, profile: selectedProfile, ...input } = value;
  const id = operationId(rawId);
  if (!id) throw new ProfileError("invalid_profile_request", "A valid operation UUID is required.");
  const profile = validateProfile(selectedProfile.body);
  const issues = inputIssues(profile, input);
  if (issues.length) throw new ProfileError("invalid_profile_inputs", profileInputErrorMessage, issues);
  const { repo, model, effort } = { ...profile.defaults, ...input.overrides };
  const repository = parseRepositoryRequest({ slug: repo, ...input.source });
  const base = { operationId: id, repository,
    ...(profile.sandboxProvider === undefined ? {} : { sandboxProvider: profile.sandboxProvider }) };
  if (profile.kind === "test") {
    return { ...base, kind: "test", suite: profile.runner, ...(profile.runner === "command" ? { argv: [...profile.argv],
      ...(profile.checkout === "shallow" ? { checkout: "shallow" } : {}) } : {}) };
  }

  const { prompt, authMode: requestedAuth, producerAgent } = input;
  const { harness: agent, operation, publish, mcp, modelProvider } = profile;
  const authMode = profile.authMode ?? requestedAuth;
  return { ...base, kind: "agent", agent, prompt,
    ...(agent === "opencode" ? { modelProvider, authMode: "api-key" } : authMode === undefined ? {} : { authMode }),
    ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }),
    ...(operation === "review" ? { reviewProducer: producerAgent } : {}),
    ...(mcp ? { connectors: parseConnectorNames(mcp.connectors) } : {}), ...(publish ? { publish: true } : {}) };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (object(value)) {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export async function profileRevision(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** @returns {Promise<{slug: string, revision: string, source: "client-supplied", requestDigest: string, producerSource?: "declared"}>} */
export async function profileReceipt(value) {
  resolveProfileRequest(value);
  const { slug, body } = value.profile;
  const [revision, requestDigest] = await Promise.all([profileRevision(body), profileRevision(value)]);
  return { slug, revision, source: "client-supplied", requestDigest,
    ...(body.operation === "review" ? { producerSource: "declared" } : {}) };
}
