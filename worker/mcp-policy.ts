import { context7Resource, isMcpOAuthBinding } from "./mcp-oauth-format.mjs";
import { isMcpConnectorName } from "./run-input-validation.mjs";
import { isRestrictedApiBinding, isRestrictedApiPolicy } from "./mcp-restricted-api.ts";

export { isMcpConnectorName };

export type McpAccessMode = "read-only" | "read-write";

type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
type RecordValue = Record<string, unknown>;

export type McpToolRule = {
  readonly tool: string;
  /** Exact, case-sensitive argument pins, including the action and resource. */
  readonly match: Readonly<Record<string, Json>>;
  /** Other arguments the agent may supply for this action. */
  readonly arguments: readonly string[];
};

export type McpConnector = {
  readonly url: string;
  readonly readAuth: string;
  readonly writeAuth: string;
  readonly read: readonly McpToolRule[];
  readonly write: readonly McpToolRule[];
};

export type McpRegistry = Readonly<Record<string, McpConnector>>;
export const mcpHost = "mcp.harness.internal";
export const mcpOrigin = "http://" + mcpHost;

const toolPattern = /^[a-zA-Z0-9_.-]+$/;
const inheritedKeys = new Set(["__proto__", "constructor", "prototype"]);
const githubMcpHost = "api.githubcopilot.com";
export const githubCiToolName = "get_commit_ci";
const githubCiTool = {
  name: githubCiToolName,
  description: "Read GitHub Actions and Checks status for the exact checked-out commit. Page defaults to 1. Results include GitHub links and omit logs.",
  inputSchema: {
    type: "object", properties: { owner: { type: "string" }, repo: { type: "string" },
      page: { type: "integer", minimum: 1 } }, required: ["owner", "repo"],
  },
};
export const context7Public = "context7-public";
const context7Url = "https://mcp.context7.com/mcp";
const context7Tools = new Map([
  ["resolve-library-id", ["libraryName", "query"]],
  ["query-docs", ["libraryId", "query", "language"]],
]);

export function isPublicContext7(connector: McpConnector): boolean {
  return connector.url === context7Url && connector.readAuth === context7Public && connector.writeAuth === context7Public &&
    context7ReadOnly(connector);
}

function context7ReadOnly(connector: McpConnector): boolean {
  return connector.write.length === 0 && connector.read.length > 0 && connector.read.every(rule => {
    const allowed = context7Tools.get(rule.tool);
    return allowed !== undefined && [...Object.keys(rule.match), ...rule.arguments].every(key => allowed.includes(key));
  });
}
// GitHub MCP tools covered by the App's Contents and Issues permissions.
const githubReadTools = new Set([
  "get_file_contents", "get_commit", "list_commits", "list_branches", "list_tags", "get_tag",
  "list_issues", "get_label", "list_label",
]);
const githubIssueReadMethods = new Set<Json>(["get", "get_comments", "get_sub_issues", "get_parent", "get_labels"]);

export function mcpConnectorUrl(name: string): string {
  if (!isMcpConnectorName(name)) throw new Error("Invalid MCP connector name");
  return mcpOrigin + "/" + name + "/mcp";
}

export function mcpConnectorName(request: Request): string | undefined {
  const url = new URL(request.url);
  const name = /^\/([^/]+)\/mcp$/.exec(url.pathname)?.[1];
  const host = request.headers.get("host");
  if (isMcpConnectorName(name) && request.url === mcpConnectorUrl(name) &&
      (host === null || host === mcpHost)) return name;
}

export function mcpObject(value: unknown): RecordValue | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as RecordValue;
}

function onlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function safeArgumentName(key: unknown): key is string {
  return typeof key === "string" && key.length !== 0 && !inheritedKeys.has(key) && !/[\u0000-\u001f\u007f]/u.test(key);
}

export function isMcpJsonLiteral(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isMcpJsonLiteral);
  const record = mcpObject(value);
  return record !== undefined && Object.entries(record).every(([key, entry]) => safeArgumentName(key) && isMcpJsonLiteral(entry));
}

function sameJson(left: Json, right: unknown): boolean {
  if (left === null || typeof left !== "object") return left === right;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  }
  const record = mcpObject(right);
  const entries = Object.entries(left);
  return record !== undefined && entries.length === Object.keys(record).length &&
    entries.every(([key, value]) => Object.hasOwn(record, key) && sameJson(value, record[key]));
}

function parseRules(value: unknown): McpToolRule[] | undefined {
  if (!Array.isArray(value)) return;
  const rules: McpToolRule[] = [];
  for (const entry of value) {
    const record = mcpObject(entry);
    if (!record || !onlyKeys(record, ["tool", "match", "arguments"])) return;
    const { tool, arguments: argumentNames } = record;
    const match = mcpObject(record.match);
    if (typeof tool !== "string" || !toolPattern.test(tool) || inheritedKeys.has(tool) || !match || !isMcpJsonLiteral(match) ||
        !Array.isArray(argumentNames) || !argumentNames.every(safeArgumentName) ||
        new Set(argumentNames).size !== argumentNames.length || argumentNames.some(key => Object.hasOwn(match, key))) return;
    rules.push({ tool, match: match as Record<string, Json>, arguments: argumentNames });
  }
  return rules;
}

function overlaps(left: McpToolRule, right: McpToolRule): boolean {
  // A single action must never be both read and write. Merely adding a
  // different optional argument cannot make a write into a read.
  return left.tool === right.tool && Object.entries(left.match).every(([key, value]) =>
    !Object.hasOwn(right.match, key) || sameJson(value, right.match[key]));
}

function upstreamUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() !== value) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) return url.href;
  } catch {
    return;
  }
}

function isRepositoryScoped(rule: McpToolRule): boolean {
  const { owner, repo } = rule.match;
  return typeof owner === "string" && /^[a-z0-9-]+$/i.test(owner) &&
    typeof repo === "string" && /^[a-z0-9_.-]+$/i.test(repo) && repo !== "." && repo !== "..";
}

function isProviderPolicy(connector: McpConnector): boolean {
  const { url, readAuth, writeAuth, read, write } = connector;
  const target = new URL(url);
  if (isRestrictedApiBinding(readAuth) || isRestrictedApiBinding(writeAuth)) return isRestrictedApiPolicy(connector);
  if (target.hostname === "mcp.context7.com" || readAuth === context7Public || writeAuth === context7Public) {
    return isPublicContext7(connector) || (url === context7Resource && isMcpOAuthBinding(readAuth) &&
      readAuth === writeAuth && context7ReadOnly(connector));
  }
  if (target.hostname === githubMcpHost) {
    return target.origin === `https://${githubMcpHost}` && readAuth === "github-app" && writeAuth === "github-app" &&
      [...read, ...write].every(isRepositoryScoped) &&
      read.every(rule => githubReadTools.has(rule.tool) || (rule.tool === "issue_read" && githubIssueReadMethods.has(rule.match.method)) ||
        (rule.tool === githubCiToolName && onlyKeys(rule.match, ["owner", "repo"]) && rule.arguments.every(key => key === "page"))) &&
      write.every(rule => rule.tool !== githubCiToolName &&
        (rule.tool !== "issue_write" || rule.match.method === "create" || rule.match.method === "update"));
  }
  if (readAuth === "github-app" || writeAuth === "github-app") return false;
  return true;
}

function isCredentialReference(value: unknown): value is string {
  return value === "github-app" || value === context7Public || isRestrictedApiBinding(value) || (typeof value === "string" && isMcpOAuthBinding(value));
}

export function parseMcpRegistry(value: string | undefined): McpRegistry | undefined {
  try {
    const record = mcpObject(value === undefined ? {} : JSON.parse(value));
    if (!record) return;
    const connectors: Record<string, McpConnector> = Object.create(null);
    for (const [name, entry] of Object.entries(record)) {
      const config = mcpObject(entry);
      if (!isMcpConnectorName(name) || !config || !onlyKeys(config, ["url", "readAuth", "writeAuth", "read", "write"])) return;
      const { readAuth, writeAuth } = config;
      const url = upstreamUrl(config.url);
      const read = parseRules(config.read);
      const write = parseRules(config.write);
      if (!url || !isCredentialReference(readAuth) || !isCredentialReference(writeAuth) || !read || !write ||
          read.length + write.length === 0 || read.some(rule => write.some(other => overlaps(rule, other)))) return;
      const connector = { url, readAuth, writeAuth, read, write };
      if (!isProviderPolicy(connector)) return;
      connectors[name] = connector;
    }
    return connectors;
  } catch {
    return;
  }
}

function intersectRules(admitted: readonly McpToolRule[], current: readonly McpToolRule[]): McpToolRule[] {
  const allowsPins = (rule: McpToolRule, pins: McpToolRule["match"]) => Object.entries(pins).every(([key, value]) =>
    Object.hasOwn(rule.match, key) ? sameJson(value, rule.match[key]) : rule.arguments.includes(key));
  const rules: McpToolRule[] = [];
  for (const previous of admitted) {
    for (const rule of current) {
      if (previous.tool !== rule.tool || !allowsPins(previous, rule.match) || !allowsPins(rule, previous.match)) continue;
      rules.push({ tool: rule.tool, match: { ...previous.match, ...rule.match },
        arguments: previous.arguments.filter(key => rule.arguments.includes(key)) });
    }
  }
  return rules;
}

export function narrowMcpConnector(admitted: McpConnector, current: McpConnector | undefined, mode: McpAccessMode): McpConnector | undefined {
  const credential = mode === "read-only" ? "readAuth" : "writeAuth";
  if (!current || current.url !== admitted.url || current[credential] !== admitted[credential]) return;
  const read = intersectRules(admitted.read, current.read);
  const write = mode === "read-write" ? intersectRules(admitted.write, current.write) : [];
  if (read.length || write.length) return { ...admitted, read, write };
}

function matches(rule: McpToolRule, tool: string, args: RecordValue): boolean {
  if (rule.tool !== tool) return false;
  return Object.entries(rule.match).every(([key, value]) => Object.hasOwn(args, key) && sameJson(value, args[key])) &&
    Object.keys(args).every(key => Object.hasOwn(rule.match, key) || rule.arguments.includes(key));
}

export function mcpToolAccess(
  connector: McpConnector, mode: McpAccessMode, name: string, args: RecordValue,
): "read" | "write" | undefined {
  if (connector.read.some(rule => matches(rule, name, args))) return "read";
  if (mode === "read-write" && connector.write.some(rule => matches(rule, name, args))) return "write";
}

function toolInputSchema(upstream: RecordValue, rules: McpToolRule[]): RecordValue | undefined {
  const upstreamProps = mcpObject(upstream.properties) ?? {};
  const required = Array.isArray(upstream.required) && upstream.required.every(safeArgumentName) ? upstream.required : [];
  const visibleRules = rules.filter(rule => required.every(name => Object.hasOwn(rule.match, name) || rule.arguments.includes(name)));
  if (!visibleRules.length) return;
  const names = new Set(visibleRules.flatMap(rule => [...Object.keys(rule.match), ...rule.arguments]));
  const properties: RecordValue = Object.create(null);
  const pinnedInAll: string[] = [];
  // Claude Code 2.1.289 omits tools with a root anyOf. Advertise the flat
  // union here and leave the exact action/argument pairing to mcpToolAccess.
  for (const name of names) {
    const base = Object.hasOwn(upstreamProps, name) ? mcpObject(upstreamProps[name]) ?? {} : {};
    if (!visibleRules.every(rule => Object.hasOwn(rule.match, name))) {
      properties[name] = base;
      continue;
    }
    pinnedInAll.push(name);
    const choices: Json[] = [];
    for (const rule of visibleRules) {
      const value = rule.match[name];
      if (!choices.some(choice => sameJson(choice, value))) choices.push(value);
    }
    if (choices.every(value => value === null || typeof value !== "object")) {
      properties[name] = { ...base, enum: choices };
      continue;
    }
    // Advertise composite pins without a composite enum for Responses
    // compatibility. matches() still enforces the exact JSON pin.
    const [choice] = choices;
    const exact = choices.length === 1 ? `Use exactly this JSON value: ${JSON.stringify(choice)}.`
      : `Use exactly one of these JSON values: ${choices.map(value => JSON.stringify(value)).join(", ")}.`;
    const description = [base.description, exact]
      .filter(value => typeof value === "string" && value.length > 0).join(" ");
    const { enum: _enum, ...schema } = base;
    const scalarArray = choices.length === 1 && Array.isArray(choice) && choice.length > 0 &&
      choice.every(value => value !== null && typeof value !== "object" && typeof value === typeof choice[0]);
    properties[name] = scalarArray ? { ...schema, type: "array", description,
      items: { type: typeof choice[0], ...mcpObject(base.items), enum: [...new Set(choice)] } } : { ...schema, description };
  }
  return { type: "object", properties, required: [...new Set([...required, ...pinnedInAll])], additionalProperties: false,
    ...(mcpObject(upstream.$defs) ? { $defs: upstream.$defs } : {}) };
}

export function projectMcpTools(value: RecordValue, connector: McpConnector, mode: McpAccessMode,
  includeGithubCiTool = false,
): RecordValue | undefined {
  if (!Array.isArray(value.tools) || (value.nextCursor !== undefined && typeof value.nextCursor !== "string")) return;
  const rules = mode === "read-write" ? [...connector.read, ...connector.write] : connector.read;
  const tools: RecordValue[] = [];
  const candidates = includeGithubCiTool && connector.readAuth === "github-app" ? [githubCiTool, ...value.tools] : value.tools;
  for (const item of candidates) {
    const tool = mcpObject(item);
    if (!tool || typeof tool.name !== "string") return;
    if (connector.readAuth === "github-app" && tool.name === githubCiToolName && tool !== githubCiTool) continue;
    const allowed = rules.filter(rule => rule.tool === tool.name);
    if (!allowed.length) continue;
    const original = mcpObject(tool.inputSchema);
    const inputSchema = original?.type === "object" ? toolInputSchema(original, allowed) : undefined;
    if (!inputSchema) continue;
    tools.push({ name: tool.name, inputSchema,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(typeof tool.title === "string" ? { title: tool.title } : {}),
      ...(mcpObject(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
    });
  }
  return { tools, ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }) };
}
