const claudeAliases = new Set(["sonnet", "sonnet[1m]", "opus", "opus[1m]", "opusplan", "opusplan[1m]", "haiku", "fable"]);
// Workers limit each binding value to 5 KB. Model syntax admits only ASCII.
// https://developers.cloudflare.com/workers/platform/limits/#environment-variables
const modelMaxBytes = 5_000;
const ownerPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const repositoryPattern = /^[a-z0-9._-]+$/i;
const connectorPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const reservedConnectorNames = new Set(["__proto__", "constructor", "prototype"]);

export const openCodeReviewModel = "gpt-6.1-sol";
export const openCodeReviewEffort = "xhigh";
export const openCodeModels = Object.freeze({ openai: "gpt-4.1-mini", anthropic: "claude-sonnet-5-5" });

/** @param {unknown} value */
export function operationId(value) {
  return typeof value === "string" && value.length === 36 && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : undefined;
}

/** @param {unknown} value @returns {value is string} */
export function isClaudeModel(value) {
  return typeof value === "string" && value.length <= modelMaxBytes && value.trim() === value &&
    (claudeAliases.has(value) || /^claude-[a-z0-9]+(?:-[a-z0-9]+)*(?:\[1m\])?$/.test(value));
}

/** @param {unknown} value @returns {value is string} */
export function isCodexModel(value) {
  return typeof value === "string" && value.length <= modelMaxBytes && value.trim() === value &&
    /^(?:gpt-[0-9]|o[0-9])[a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value);
}

/** @param {unknown} value @returns {value is "low" | "medium" | "high" | "xhigh" | "max"} */
export function isAgentEffort(value) {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

/** @param {unknown} owner @param {unknown} name */
export function validRepository(owner, name) {
  return typeof owner === "string" && typeof name === "string" &&
    owner.trim() === owner && name.trim() === name &&
    ownerPattern.test(owner) && repositoryPattern.test(name) &&
    name !== "." && name !== ".." && !name.toLowerCase().endsWith(".git");
}

/** @param {unknown} slug @returns {slug is string} */
export function validRepositorySlug(slug) {
  if (typeof slug !== "string") return false;
  const [owner, name, extra] = slug.split("/");
  return extra === undefined && validRepository(owner, name);
}

const refEnd = String.raw`(?![\s\S])`;
const refComponent = String.raw`(?!\.)(?![^/]*\.lock(?:/|${refEnd}))[^/\u0000-\u0020\u007f~^:?*\[\\]+`;
// The same pattern is published in the profile's JSON Schema. Explicit end-of-input
// assertions avoid treating an otherwise allowed Unicode line separator as an anchor.
export const gitReferencePattern = String.raw`^refs/(?:heads|tags)/(?![\s\S]*(?:\.\.|@\{|\.${refEnd}))${refComponent}(?:/${refComponent})*${refEnd}`;
const gitReferenceRegex = new RegExp(gitReferencePattern, "u");

/** @param {unknown} ref @returns {ref is string} */
export function validGitReference(ref) {
  return typeof ref === "string" && ref.isWellFormed() && gitReferenceRegex.test(ref);
}

/** @param {unknown} value @returns {{slug: string, sha: string} | {slug: string, ref: string} | undefined} */
export function parseRepositoryRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) return;
  const { slug, ref, sha } = /** @type {Record<string, unknown>} */ (value);
  if (!validRepositorySlug(slug)) return;
  if (Object.hasOwn(value, "ref")) return validGitReference(ref) ? { slug, ref } : undefined;
  if (typeof sha === "string" && /^[a-f0-9]{40}$/iu.test(sha) && sha.length === 40) return { slug, sha: sha.toLowerCase() };
}

/** @param {unknown} value @returns {value is string} */
export function isMcpConnectorName(value) {
  return typeof value === "string" && connectorPattern.test(value) && !reservedConnectorNames.has(value);
}

/** @param {unknown} value @returns {string[] | undefined} */
export function parseConnectorNames(value) {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length ||
      !value.every(isMcpConnectorName)) return;
  return [...value].sort();
}

/** @param {unknown} value @returns {value is keyof typeof openCodeModels} */
export function isModelProvider(value) {
  return value === "openai" || value === "anthropic";
}

/**
 * @param {unknown} modelProvider
 * @param {unknown} model
 * @param {unknown} effort
 * @param {boolean} [review]
 * @returns {{modelProvider: keyof typeof openCodeModels, model: string, effort?: "high" | "xhigh"} | undefined}
 */
export function resolveOpenCodeSettings(modelProvider, model, effort, review = false) {
  if (review) {
    if (modelProvider === "openai" && model === openCodeReviewModel && effort === openCodeReviewEffort) {
      return { modelProvider, model, effort };
    }
    return;
  }
  if (!isModelProvider(modelProvider)) return;
  const expected = openCodeModels[modelProvider];
  if (model !== undefined && model !== expected) return;
  if (effort !== undefined && (modelProvider !== "anthropic" || effort !== "high")) return;
  return { modelProvider, model: expected, ...(effort === "high" ? { effort } : {}) };
}
