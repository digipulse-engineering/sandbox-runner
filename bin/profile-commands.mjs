import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { hasDuplicateJsonKeys } from "../worker/profile-json.mjs";
import { parseProfileConfig, ProfileError, profileInputContract, profileInputErrorMessage, profileReceipt, profileRevision,
  profileUsage, resolveProfileRequest, validateProfileInputs, validProfileSlug } from "../worker/run-profiles.mjs";
import { validRepositorySlug } from "../worker/run-input-validation.mjs";
import { CliError, exit } from "./cli-errors.mjs";
import { createProfileFromTemplate, getProfileTemplate, listProfileTemplates } from "./profile-templates.mjs";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const digest = /^[0-9a-f]{64}$/u;
const stringOption = { type: "string" };
const profileUsages = new Set(["executor", "review", "delivery-review", "tier2-review", "test"]);
const issueFields = new Set(["$", "source", "source.sha", "source.ref", "prompt", "producerAgent", "authMode",
  "overrides", "overrides.repo", "overrides.model", "overrides.effort"]);
const issueCodes = new Set(["required", "invalid_type", "invalid_sha", "invalid_ref", "exact_sha_required", "source_conflict",
  "unexpected_field", "invalid_value", "same_harness", "override_not_allowed"]);
const readinessCodes = {
  sandbox: ["sandbox_provider_unavailable", "sandbox_provider_default_invalid", "opencode_disabled"],
  repository: ["github_checkout_not_configured", "github_allowlist_invalid", "github_repository_not_allowed"],
  credentials: ["provider_credential_not_configured"],
  settings: ["claude_defaults_invalid"],
  connectors: ["mcp_connector_not_allowed", "mcp_connector_configuration_invalid", "mcp_connector_auth_required", "mcp_connector_repository_unverified"],
  publication: ["github_publication_configuration_invalid"],
  timeout: ["agent_deadline_invalid", "vitest_not_configured"],
};

function invalidArguments(message) {
  return new CliError("usage_error", message, exit.usage);
}

function profileOptions(args, options, message) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, tokens: true, options });
  } catch {
    throw invalidArguments(message);
  }
  const names = parsed.tokens.filter(token => token.kind === "option" && !options[token.name]?.multiple).map(token => token.name);
  if (new Set(names).size !== names.length) throw invalidArguments("Supply each profile option once.");
  return parsed;
}

function absoluteHome(configured, ...fallback) {
  return configured && isAbsolute(configured) ? configured : join(homedir(), ...fallback);
}

async function readProfiles(file, env) {
  if (file === undefined && env.SANDBOX_RUNNER_PROFILES !== undefined && !isAbsolute(env.SANDBOX_RUNNER_PROFILES)) {
    throw new CliError("invalid_profile_config", "SANDBOX_RUNNER_PROFILES must be an absolute file path.", exit.configuration);
  }
  const configHome = absoluteHome(env.XDG_CONFIG_HOME, ".config");
  const path = file ?? env.SANDBOX_RUNNER_PROFILES ?? join(configHome, "sandbox-runner", "profiles.json");
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch {
    throw new CliError("profile_file_unavailable", "Could not read the profiles file. Check --profiles or SANDBOX_RUNNER_PROFILES.", exit.configuration);
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CliError("invalid_profile_config", "The profiles file must contain valid JSON.", exit.configuration);
  }
  if (hasDuplicateJsonKeys(content)) {
    throw new CliError("invalid_profile_config", "The profiles file must use unique JSON keys in each object.", exit.configuration);
  }
  return parseProfileConfig(parsed);
}

function lookupProfile(config, slug) {
  if (!validProfileSlug(slug)) throw invalidArguments("Supply a valid profile slug.");
  if (!Object.hasOwn(config.profiles, slug)) throw new CliError("profile_not_found", "The profiles file does not contain that profile.", exit.configuration);
  return config.profiles[slug];
}

async function checkedCatalogEntry(entry, slug) {
  if (!entry || !validProfileSlug(entry.slug) || (slug !== undefined && entry.slug !== slug) ||
      !validDigest(entry.revision)) return;
  try {
    parseProfileConfig({ schemaVersion: 1, profiles: { [entry.slug]: entry.profile } });
    if (await profileRevision(entry.profile) === entry.revision) {
      return { slug: entry.slug, profile: entry.profile, revision: entry.revision };
    }
  } catch (error) {
    if (!(error instanceof ProfileError)) throw error;
  }
}

function invalidCatalog() {
  return new CliError("invalid_response", "The Worker returned an invalid team profile catalog.", exit.requestFailure);
}

async function teamProfile(readCatalog, slug) {
  const value = await readCatalog(slug);
  const entry = await checkedCatalogEntry(value, slug);
  if (!entry || !validProfileSlug(value.clientId)) throw invalidCatalog();
  return { ...entry, clientId: value.clientId };
}

async function teamProfiles(readCatalog) {
  const value = await readCatalog();
  if (!validProfileSlug(value?.clientId) || !Array.isArray(value.profiles)) throw invalidCatalog();
  const profiles = await Promise.all(value.profiles.map(entry => checkedCatalogEntry(entry)));
  if (profiles.some(entry => !entry)) throw invalidCatalog();
  if (new Set(profiles.map(entry => entry.slug)).size !== profiles.length) throw invalidCatalog();
  return { clientId: value.clientId, profiles };
}

function checkCatalogSelection(readCatalog, file) {
  if (readCatalog && file !== undefined) {
    throw invalidArguments("Team mode uses the Worker's catalog. Remove --profiles.");
  }
}

function profileMetadata(profile) {
  const usage = profileUsage(profile);
  return { usage, qualification: "unverified", ...(usage === "tier2-review" ? { recommendedLaunch: "broker" } : {}) };
}

function describeProfile(entry) {
  return { ...entry, ...profileMetadata(entry.profile), inputContract: profileInputContract(entry.profile) };
}

function profileSummary({ slug, profile, revision }) {
  const { kind, description, sandboxProvider, harness, operation, runner, modelProvider, authMode, defaults, allowedOverrides, mcp, publish } = profile;
  return { slug, revision, ...profileMetadata(profile), kind, description, sandboxProvider, harness, operation, runner, modelProvider,
    authMode, defaults, repositories: allowedOverrides?.repo ?? [defaults?.repo], connectors: mcp?.connectors ?? [], publish: publish === true };
}

async function profileReadiness(readCatalog, slug) {
  const entry = await teamProfile(readCatalog, slug);
  const result = await readCatalog(slug, { readinessRevision: entry.revision });
  const { kind, harness, mcp, publish } = entry.profile;
  const expected = new Set(["sandbox", "repository", "timeout"]);
  if (kind === "agent") expected.add("credentials");
  if (harness === "claude") expected.add("settings");
  if (mcp) expected.add("connectors");
  if (publish) expected.add("publication");
  if (result?.slug !== slug || result.clientId !== entry.clientId || result.revision !== entry.revision ||
      result.qualification !== "unverified" || !Array.isArray(result.checks) || result.checks.length !== expected.size) throw invalidCatalog();
  const checks = [];
  for (const check of result.checks) {
    const { kind, status, code } = check ?? {};
    if (!expected.delete(kind) ||
        (status === "configured" ? code !== undefined : status !== "blocked" || !readinessCodes[kind].includes(code))) {
      throw invalidCatalog();
    }
    checks.push({ kind, status, ...(code === undefined ? {} : { code }) });
  }
  return { slug, clientId: entry.clientId, revision: entry.revision, checks, qualification: "unverified" };
}

function templateCommand(action, args) {
  if (action === "template") {
    if (args.length === 1 && args[0] === "list") return listProfileTemplates();
    if (args.length === 2 && args[0] === "get") return getProfileTemplate(args[1]);
    throw invalidArguments("Use profile template list or profile template get <id>.");
  }
  const usage = "Use profile create <template> --slug <slug> --repo OWNER/REPO [options] [-- <executable> <args...>].";
  const { values, tokens } = profileOptions(args, {
    slug: stringOption, repo: stringOption, harness: stringOption, auth: stringOption, "model-provider": stringOption,
    model: stringOption, effort: stringOption, description: stringOption, publish: { type: "boolean" },
    mcp: { ...stringOption, multiple: true },
  }, usage);
  const separator = tokens.find(token => token.kind === "option-terminator")?.index ?? Infinity;
  const positionals = tokens.filter(token => token.kind === "positional");
  const [template, ...argumentsForTest] = positionals;
  if (!template || template.index >= separator || argumentsForTest.some(token => token.index < separator)) {
    throw invalidArguments(usage);
  }
  const { auth: authMode, "model-provider": modelProvider, mcp: connectors, ...rest } = values;
  const input = { ...rest, authMode, modelProvider, connectors, argv: argumentsForTest.length ? argumentsForTest.map(token => token.value) : undefined };
  return createProfileFromTemplate(template.value, Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)));
}

export async function inspectProfiles([, action, ...args], env, getCatalog) {
  if (action === "template" || action === "create") return templateCommand(action, args);
  const usage = "Use profile list [--usage <usage>] [--repo OWNER/REPO], profile get <slug>, profile check <slug>, or profile validate.";
  const { values, positionals } = profileOptions(args, { profiles: stringOption,
    ...(action === "list" ? { usage: stringOption, repo: stringOption } : {}) }, usage);
  if (!["list", "get", "check", "validate"].includes(action) || positionals.length !== (["get", "check"].includes(action) ? 1 : 0)) {
    throw invalidArguments(usage);
  }
  if ((values.usage !== undefined && !profileUsages.has(values.usage)) || (values.repo !== undefined && !validRepositorySlug(values.repo))) {
    throw invalidArguments("Use a supported profile usage and an exact OWNER/REPO filter.");
  }
  const readCatalog = getCatalog?.();
  checkCatalogSelection(readCatalog, values.profiles);
  if (action === "check") {
    const [slug] = positionals;
    if (!validProfileSlug(slug)) throw invalidArguments(usage);
    if (!readCatalog) throw new CliError("profile_check_requires_team", "Use SANDBOX_RUNNER_TEAM=1 to check a published profile on its Worker.", exit.configuration);
    return profileReadiness(readCatalog, slug);
  }
  let entries, clientId;
  if (readCatalog) {
    if (action === "get") {
      const [slug] = positionals;
      if (!validProfileSlug(slug)) throw invalidArguments("Supply a valid profile slug.");
      return describeProfile(await teamProfile(readCatalog, slug));
    }
    ({ profiles: entries, clientId } = await teamProfiles(readCatalog));
  } else {
    const config = await readProfiles(values.profiles, env);
    if (action === "get") {
      const [slug] = positionals;
      const profile = lookupProfile(config, slug);
      return describeProfile({ slug, profile, revision: await profileRevision(profile) });
    }
    entries = await Promise.all(Object.entries(config.profiles).map(async ([slug, profile]) => ({ slug, profile,
      ...(action === "list" ? { revision: await profileRevision(profile) } : {}) })));
  }
  const identity = clientId === undefined ? {} : { clientId };
  entries.sort((left, right) => left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0);
  if (action === "validate") return { valid: true, ...identity, slugs: entries.map(entry => entry.slug) };
  const profiles = entries.map(profileSummary).filter(profile => (values.usage === undefined || profile.usage === values.usage) &&
    (values.repo === undefined || profile.repositories.includes(values.repo)));
  return { ...identity, slugs: profiles.map(profile => profile.slug), profiles };
}

function operationId(raw) {
  if (typeof raw !== "string" || raw.length !== 36 || !uuid.test(raw)) throw invalidArguments("A valid operation ID is required.");
  return raw.toLowerCase();
}

async function profileCommand(submission, { retry = false, team } = {}) {
  let resolved;
  try {
    resolved = resolveProfileRequest(submission);
  } catch (error) {
    if (error instanceof ProfileError && error.code === "invalid_profile_inputs") error.profile = submission.profile?.slug;
    throw error;
  }
  const receipt = await profileReceipt(submission);
  const { profile, kind, ...input } = submission;
  if (team && (!validProfileSlug(team.clientId) || team.revision !== receipt.revision ||
      (team.deliveryId !== undefined && !validDeliveryId(team.deliveryId)))) throw journalUnavailable();
  return {
    name: "run", version: "v4", id: resolved.operationId, kind: resolved.kind, suite: resolved.suite,
    repository: resolved.repository, sandboxProvider: resolved.sandboxProvider, agent: resolved.agent,
    authMode: resolved.authMode ?? (resolved.agent === "claude" ? "subscription" : "api-key"),
    explicitAuth: resolved.authMode !== undefined,
    reviewProducer: resolved.reviewProducer, modelProvider: resolved.modelProvider,
    connectors: resolved.connectors, publish: resolved.publish,
    overrides: { model: resolved.model, effort: resolved.effort },
    profileSubmission: team ? { ...input, kind: "team-profile", profile: profile.slug, revision: receipt.revision,
      ...(team.deliveryId === undefined ? {} : { deliveryId: team.deliveryId }) } : submission,
    profileReceipt: team ? { ...receipt, source: "worker-catalog", clientId: team.clientId,
      ...(team.deliveryId === undefined ? {} : { deliveryId: team.deliveryId }) } : receipt,
    profileJournal: { submission, ...(team ? { team } : {}) },
    profileRetry: retry,
  };
}

export async function startProfile([, slug, ...args], env, readCatalog) {
  const usage = "Use start <slug> with --sha or --ref, and one prompt for an agent profile.";
  const { values, positionals } = profileOptions(args, {
    profiles: stringOption, repo: stringOption, sha: stringOption, ref: stringOption,
    model: stringOption, effort: stringOption, "producer-agent": stringOption, auth: stringOption,
    "operation-id": stringOption, revision: stringOption, "delivery-id": stringOption,
  }, usage);
  if (positionals.length > 1) {
    throw invalidArguments(usage);
  }
  const source = Object.fromEntries(["sha", "ref"].filter(key => values[key] !== undefined).map(key => [key, values[key]]));
  const overrides = Object.fromEntries(["repo", "model", "effort"].filter(key => values[key] !== undefined).map(key => [key, values[key]]));
  const input = { ...(Object.keys(source).length ? { source } : {}), ...(Object.keys(overrides).length ? { overrides } : {}),
    ...(positionals.length ? { prompt: positionals[0] } : {}),
    ...(values["producer-agent"] === undefined ? {} : { producerAgent: values["producer-agent"] }),
    ...(values.auth === undefined ? {} : { authMode: values.auth }) };
  return resolveProfileStart({ slug, revision: values.revision, operationId: values["operation-id"],
    deliveryId: values["delivery-id"], profiles: values.profiles }, input, env, readCatalog);
}

export async function resolveProfileStart({ slug, revision, operationId: rawId, deliveryId, profiles }, input, env, readCatalog) {
  if (!validProfileSlug(slug)) throw invalidArguments("Use start <slug> with the profile's required inputs.");
  checkCatalogSelection(readCatalog, profiles);
  if (!readCatalog && (revision !== undefined || deliveryId !== undefined)) {
    throw invalidArguments("--revision and --delivery-id require SANDBOX_RUNNER_TEAM=1.");
  }
  if (revision !== undefined && !validDigest(revision)) throw invalidArguments("Supply a valid profile revision.");
  if (deliveryId !== undefined && (typeof deliveryId !== "string" || deliveryId.length !== 36 || !uuid.test(deliveryId))) {
    throw invalidArguments("Supply a valid delivery ID.");
  }
  const id = rawId === undefined ? randomUUID() : operationId(rawId);
  const entry = readCatalog ? await teamProfile(readCatalog, slug) : undefined;
  if (entry && revision !== undefined && entry.revision !== revision) {
    throw new CliError("profile_revision_changed", "The requested revision is no longer current. Use profile get to inspect the new revision.",
      exit.requestFailure);
  }
  const body = entry?.profile ?? lookupProfile(await readProfiles(profiles, env), slug);
  const team = entry && { clientId: entry.clientId, revision: entry.revision,
    ...(deliveryId === undefined ? {} : { deliveryId: deliveryId.toLowerCase() }) };
  const issues = validateProfileInputs(body, input);
  if (issues.length) {
    throw new CliError("invalid_profile_inputs", profileInputErrorMessage, exit.usage, { issues, profile: slug });
  }
  return profileCommand({ ...input, kind: "profile", operationId: id, profile: { slug, body } }, { team });
}

function stateDirectory(env) {
  return join(absoluteHome(env.XDG_STATE_HOME, ".local", "state"), "sandbox-runner", "profile-requests");
}

function journalUnavailable() {
  return new CliError("profile_journal_unavailable", "Could not access the private profile request journal. Check the state directory permissions.", exit.configuration);
}

async function storedRequest(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw journalUnavailable();
  }
}

export async function retryProfile([, rawId, ...extra], env, origin, readCatalog) {
  if (extra.length) throw invalidArguments("Use retry <operation-id>.");
  const id = operationId(rawId);
  const saved = await storedRequest(join(stateDirectory(env), id + ".json"));
  if (!saved) throw new CliError("profile_request_not_found", "No profile submission was saved for this operation ID.", exit.configuration);
  if (saved.origin !== origin || saved.submission?.operationId !== id || Boolean(saved.team) !== Boolean(readCatalog) ||
      (readCatalog && saved.team.clientId !== (await teamProfiles(readCatalog)).clientId)) {
    throw new CliError("profile_request_mismatch", "The saved request belongs to a different Worker, client, or operation ID.", exit.configuration);
  }
  return profileCommand(saved.submission, { retry: true, team: saved.team });
}

export async function saveProfileRequest(command, origin, env) {
  const directory = stateDirectory(env);
  const path = join(directory, command.id + ".json");
  let temp;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await stat(directory)).mode & 0o077) throw journalUnavailable();
    temp = await mkdtemp(join(directory, ".request-"));
    const candidate = join(temp, "submission.json");
    await writeFile(candidate, JSON.stringify({ origin, ...command.profileJournal }) + "\n", { mode: 0o600, flush: true });
    await link(candidate, path);
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw journalUnavailable();
  } finally {
    if (temp !== undefined) await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
  const saved = await storedRequest(path);
  const savedCommand = saved?.origin === origin && saved.submission
    ? await profileCommand(saved.submission, { team: saved.team }) : undefined;
  if (!savedCommand || !checkedProfileReceipt(savedCommand.profileReceipt, command.profileReceipt)) {
    throw new CliError("operation_conflict", "This operation ID already has a saved request. Use retry with the same ID, or choose a new ID.", exit.requestFailure);
  }
}

function validDigest(value) {
  return typeof value === "string" && value.length === 64 && digest.test(value);
}

function validDeliveryId(value) {
  return typeof value === "string" && value.length === 36 && uuid.test(value) && value === value.toLowerCase();
}

export function checkedProfileReceipt(value, expected, review) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { slug, source, revision, requestDigest, producerSource, clientId, deliveryId } = value;
  const producer = producerSource === "declared";
  const team = source === "worker-catalog";
  if (!validProfileSlug(slug) || (!team && source !== "client-supplied") || !validDigest(revision) || !validDigest(requestDigest) ||
      (team ? !validProfileSlug(clientId) || (deliveryId !== undefined && !validDeliveryId(deliveryId)) :
        clientId !== undefined || deliveryId !== undefined) ||
      (producerSource !== undefined && !producer) || (review !== undefined && producer !== review) ||
      Object.keys(value).length !== 4 + Number(producer) + Number(team) + Number(deliveryId !== undefined) ||
      (expected && (slug !== expected.slug || source !== expected.source || revision !== expected.revision ||
        requestDigest !== expected.requestDigest || producerSource !== expected.producerSource ||
        clientId !== expected.clientId || deliveryId !== expected.deliveryId))) return;
  return { slug, source, revision, requestDigest, ...(producer ? { producerSource } : {}),
    ...(team ? { clientId } : {}), ...(deliveryId === undefined ? {} : { deliveryId }) };
}

export function profileFailure(error) {
  if (error instanceof ProfileError) {
    return new CliError(error.code, error.message, ["invalid_profile", "invalid_profile_config"].includes(error.code) ? exit.configuration : exit.usage,
      { issues: error.issues, profile: error.profile });
  }
}

export function checkedProfileInputIssues(value, profile) {
  if (!Array.isArray(value) || value.length === 0) return;
  const contract = profileInputContract(profile).properties;
  const seen = new Set();
  const issues = [];
  for (const item of value) {
    const { field, code, message, allowed } = item ?? {};
    if (!issueFields.has(field) || !issueCodes.has(code) || typeof message !== "string" || !message.trim() ||
        !message.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(message)) return;
    const key = `${field}:${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (allowed !== undefined) {
      const known = field.startsWith("overrides.") ? contract.overrides.properties[field.slice("overrides.".length)]?.enum : contract[field]?.enum;
      if (!known || !Array.isArray(allowed) || allowed.length !== known.length || allowed.some((value, index) => value !== known[index])) return;
    }
    issues.push({ field, code, message, ...(allowed === undefined ? {} : { allowed }) });
  }
  return issues;
}
