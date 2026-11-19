#!/usr/bin/env node
import { accessServiceHeaders } from "./access-service-token.mjs";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { authenticate } from "./auth.mjs";
import { authText, terminalAuthLocale } from "./auth-i18n.mjs";
import { authStrategies } from "./auth-strategies.mjs";
import { claudeOptionsError } from "./claude-options.mjs";
import { CliError, exit, readTimeout } from "./cli-errors.mjs";
import { cloudflareDeploy } from "./cloudflare-deploy.mjs";
import { cloudflareDestroy } from "./cloudflare-destroy.mjs";
import { cloudflareUpgrade } from "./cloudflare-upgrade.mjs";
import { cloudflareAccess } from "./cloudflare-access.mjs";
import { cloudflareDoctor } from "./cloudflare-doctor.mjs";
import { cloudflareInit } from "./cloudflare-init.mjs";
import { cloudflareLogin } from "./cloudflare-login.mjs";
import { cloudflareSetup } from "./cloudflare-setup.mjs";
import { checkedConnectorIssues, connectorIssueFailure, connectorIssueHint } from "./connector-issues.mjs";
import { matchesRepositoryReceipt, parseRepository, parseRepositoryRequest } from "./github-repository.mjs";
import { openCodeOptionsError } from "./opencode-settings.mjs";
import { checkedProfileInputIssues, checkedProfileReceipt, inspectProfiles, profileFailure, resolveProfileStart, retryProfile,
  saveProfileRequest, startProfile } from "./profile-commands.mjs";
import { createProfileFromTemplate } from "./profile-templates.mjs";
import { checkedEvents, parseAfter } from "./run-events.mjs";
import { checkedRunList, openCodeListHeader, parseListLimit, runListLimit, validListCursor } from "./run-list.mjs";
import { setupAgent, setupSandboxProvider } from "./setup.mjs";
import { manageTeam } from "./team-commands.mjs";
import { checkedVitestRun } from "./vitest-run.mjs";
import { isAgentEffort, isCodexModel } from "../worker/run-input-validation.mjs";
import { profileInputErrorMessage } from "../worker/run-profiles.mjs";

const agents = new Set(["claude", "codex"]);
const authModes = new Set(["subscription", "api-key"]);
const terminalStatuses = new Set(["succeeded", "capacity", "auth_required", "failed", "unanswered", "cancelled", "timed_out"]);
const statuses = new Set(["queued", "running", ...terminalStatuses]);
const cleanupStatuses = new Set(["pending", "destroyed", "failed"]);
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const sandboxProviderPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const runOptions = "[--auth subscription|api-key] [--operation-id UUID] [--sandbox-provider <name>] [--run-timeout-ms <milliseconds>] [--model ID] [--effort low|medium|high|xhigh|max] <prompt>";
const repositoryOptions = "--repo OWNER/REPO (--sha COMMIT_SHA | --ref FULL_REF)";
const connectorOptions = "[--mcp CONNECTOR ...] ";
const usage = [
  "sandbox-runner run --agent claude|codex " + runOptions,
  "sandbox-runner claude|codex start [" + repositoryOptions + " [--publish]] " + connectorOptions + runOptions,
  "sandbox-runner opencode start --model-provider openai|anthropic [" + repositoryOptions + "] [--model ID] [--effort high] [--operation-id UUID] [--sandbox-provider cloudflare] [--run-timeout-ms <milliseconds>] <prompt>",
  "sandbox-runner review --agent claude|codex --producer-agent claude|codex --repo OWNER/REPO --sha COMMIT_SHA " + connectorOptions + runOptions.replace("<prompt>", "<criteria>"),
  "sandbox-runner review --agent opencode --model-provider openai --model gpt-6.1-sol --effort xhigh --producer-agent claude|codex --repo OWNER/REPO --sha COMMIT_SHA " +
    connectorOptions + "[--operation-id UUID] [--run-timeout-ms <milliseconds>] <criteria>",
  "sandbox-runner vitest start " + repositoryOptions + " [--operation-id UUID] [--sandbox-provider <name>]",
  "sandbox-runner test " + repositoryOptions + " [--operation-id UUID] [--sandbox-provider <name>] -- <executable> [arguments...]",
  "sandbox-runner profile list [--usage executor|review|delivery-review|tier2-review|test] [--repo OWNER/REPO] [--profiles <file>]",
  "sandbox-runner profile validate [--profiles <file>]",
  "sandbox-runner profile get <slug> [--profiles <file>]",
  "sandbox-runner profile check <slug> (team mode)",
  "sandbox-runner profile template list|get [<template>]",
  "sandbox-runner profile create <template> --slug <slug> --repo OWNER/REPO [--harness <harness>] [--auth MODE] [--model-provider <name>] [--model ID] [--effort LEVEL] [--description <text>] [--publish] [--mcp CONNECTOR ...] [-- <executable> <args...>]",
  "sandbox-runner team catalog get",
  "sandbox-runner team catalog publish <file> [--revision SHA256]",
  "sandbox-runner team denials",
  "sandbox-runner start <slug> (--sha COMMIT_SHA | --ref FULL_REF) [--repo OWNER/REPO] [--model ID] [--effort LEVEL] [--auth MODE] [--producer-agent AGENT] [--operation-id UUID] [--profiles <file>] [--revision SHA256] [--delivery-id UUID] [-- <prompt>]",
  "sandbox-runner retry <operation-id>",
  "sandbox-runner status <id>",
  "sandbox-runner result <id>",
  "sandbox-runner wait <id> [--timeout-ms <milliseconds>]",
  "sandbox-runner cancel <id>",
  "sandbox-runner events <id> [--after <cursor>]",
  "sandbox-runner list [--cursor <cursor>] [--limit <count>]",
  "sandbox-runner skill",
  "sandbox-runner mcp",
  "sandbox-runner connector login NAME --mode read-only|read-write --scope SCOPES [--account <id>] [--worker <name>] [--profile <name>]",
  "sandbox-runner cloudflare init <directory> [--account <id>] [--worker <name>] [--profile <name>] [--max-concurrent-runs <count>]",
  "sandbox-runner cloudflare setup <directory> [--account <id>] [--worker <name>] [--profile <name>] [--max-concurrent-runs <count>] [--no-browser] [--dry-run] [--secrets-file <file>]",
  "sandbox-runner cloudflare login [<directory>] [--force] [--no-browser]",
  "sandbox-runner cloudflare deploy [<directory>] [--dry-run] [--secrets-file <file>]",
  "sandbox-runner cloudflare upgrade [<directory>] [--dry-run] (--guard-url <origin> --guard-token-file <file> [--upgrade-id <uuid>] | --without-guard)",
  "sandbox-runner cloudflare destroy [<directory>] --receipt <deploy.json> [--dry-run]",
  "sandbox-runner cloudflare doctor [--account <id>] [--worker <name>] [--profile <name>]",
  "sandbox-runner cloudflare access enable [directory] --url https://WORKER.SUBDOMAIN.workers.dev --email ADDRESS [--email ADDRESS] [--redirect-uri URI] [--web-clients-only] [--service-token-file FILE] [--service-token-ip CIDR] [--scope host|mcp] [--dry-run]",
  "sandbox-runner cloudflare access status|disable [directory]",
  "sandbox-runner cloudflare canary claude|codex [--repo OWNER/REPO --sha COMMIT_SHA] [--auth subscription|api-key] [--operation-id UUID] [--timeout-ms <milliseconds>]",
  "sandbox-runner cloudflare canary vitest --repo OWNER/REPO --sha COMMIT_SHA [--operation-id UUID] [--timeout-ms <milliseconds>]",
  "sandbox-runner auth claude|codex --mode subscription|api-key --account <id> --worker <name> [--profile <name>] [--stdin|--manual]",
  "sandbox-runner auth opencode --model-provider openai|anthropic --account <id> --worker <name> [--profile <name>] [--stdin]",
  "sandbox-runner claude|codex setup [--strategy " + [...authStrategies.keys()].join("|") + "] [--confirm-api-spend-cap] [--account <id>] [--worker <name>] [--profile <name>]",
  "sandbox-runner claude setup [--model <claude-model>] [--effort low|medium|high|xhigh|max] [--account <id>] [--worker <name>] [--profile <name>]",
  "sandbox-runner setup --default-sandbox-provider cloudflare [--account <id>] [--worker <name>] [--profile <name>]",
];

function usageError(message) {
  return new CliError("usage_error", message, exit.usage);
}

function configurationError(message) {
  return new CliError("configuration_error", message, exit.configuration);
}

function normalizeId(value) {
  if (value.length !== 36 || !uuidPattern.test(value)) throw usageError("A valid UUID is required.");
  return value.toLowerCase();
}

function effectiveAuthMode(agent, authMode) {
  return authMode ?? (agent === "claude" ? "subscription" : "api-key");
}

function parseTimeoutMs(rawTimeout) {
  if (rawTimeout === undefined) return;
  const timeout = Number(rawTimeout);
  // Node timers support positive signed 32-bit millisecond delays.
  if (!/^\d+$/.test(rawTimeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw usageError("--timeout-ms must be between 1 and 2147483647.");
  }
  return timeout;
}

function parseAgentTimeoutMs(value) {
  if (value === undefined) return;
  const timeoutMs = Number(value);
  // Same bound as the Worker's workerd timers. This is not the local wait timer.
  if (value.trim() !== value || !/^\d+$/.test(value) || timeoutMs < 1 || timeoutMs > 3_153_600_000_000) {
    throw usageError("--run-timeout-ms must be a positive integer within the Worker's timer range.");
  }
  return timeoutMs;
}

function parseWait(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, tokens: true, options: { "timeout-ms": { type: "string" } } });
  } catch {
    throw usageError("Wait requires a run ID and accepts an optional --timeout-ms.");
  }
  if (parsed.positionals.length !== 1 || parsed.tokens.filter(token => token.kind === "option").length > 1) {
    throw usageError("Wait requires a run ID and accepts --timeout-ms once.");
  }
  return { name: "result", id: normalizeId(parsed.positionals[0]), wait: true, timeout: parseTimeoutMs(parsed.values["timeout-ms"]) };
}

function requestedRepository(repo, sha, ref) {
  if (sha !== undefined && ref !== undefined) return;
  return parseRepositoryRequest(ref === undefined ? { slug: repo, sha } : { slug: repo, ref });
}

function connectorNames(value) {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length ||
      !value.every(name => typeof name === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name) &&
        name.trim() === name && name !== "constructor" && name !== "prototype")) return;
  return [...value].sort();
}

function checkedConnectorAccess(value, review) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) return;
  const mode = review ? "read-only" : "read-write";
  const connectors = connectorNames(value.connectors);
  if (value.mode === mode && connectors) return { mode, connectors };
}

function parseTestStart(args, suite) {
  const label = suite === "vitest" ? "Vitest" : "test";
  const separator = args.indexOf("--");
  const argv = suite === "command" ? args.slice(separator + 1) : undefined;
  if (argv && (separator < 0 || !argv[0] || argv.some(arg => !arg.isWellFormed() || arg.includes("\0")))) {
    throw usageError("Supply an executable and its arguments after --.");
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv ? args.slice(0, separator) : args, tokens: true, options: {
      repo: { type: "string" }, sha: { type: "string" }, ref: { type: "string" },
      "operation-id": { type: "string" }, "sandbox-provider": { type: "string" },
    } });
  } catch {
    throw usageError(suite === "vitest" ? "Use sandbox-runner vitest start --repo OWNER/REPO --sha COMMIT_SHA."
      : "Use sandbox-runner test --repo OWNER/REPO --sha COMMIT_SHA -- <executable> [arguments...].");
  }
  const optionNames = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
  if (new Set(optionNames).size !== optionNames.length) throw usageError(`Each ${label} option can be supplied once.`);
  const { repo, sha, ref, "operation-id": suppliedId, "sandbox-provider": sandboxProvider } = parsed.values;
  const repository = requestedRepository(repo, sha, ref);
  if (!repository) throw usageError("Supply --repo and either --sha or a full --ref in refs/heads/ or refs/tags/.");
  if (sandboxProvider !== undefined && (!sandboxProviderPattern.test(sandboxProvider) || sandboxProvider.trim() !== sandboxProvider)) {
    throw usageError("--sandbox-provider must be a lowercase provider name.");
  }
  if (suppliedId !== undefined && suppliedId.length !== 36) throw usageError("A valid UUID is required.");
  return { name: "run", version: "v4", kind: "test", suite, repository, sandboxProvider, argv,
    id: suppliedId === undefined ? randomUUID() : normalizeId(suppliedId) };
}

function parseEvents(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, tokens: true, options: { after: { type: "string" } } });
  } catch {
    throw usageError("Events requires a run ID and accepts an optional --after cursor.");
  }
  if (parsed.positionals.length !== 1 || parsed.tokens.filter(token => token.kind === "option").length > 1) {
    throw usageError("Events requires a run ID and accepts --after once.");
  }
  const after = parsed.values.after === undefined ? 0 : parseAfter(parsed.values.after);
  if (after === undefined) throw usageError("--after must be a nonnegative integer cursor.");
  return { name: "events", id: normalizeId(parsed.positionals[0]), version: "v4", after };
}

function parseList(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, tokens: true, options: { cursor: { type: "string" }, limit: { type: "string" } } });
    const names = parsed.tokens.map(token => token.name);
    if (names.some(name => name === undefined) || new Set(names).size !== names.length) throw new Error();
  } catch {
    throw usageError("List accepts --cursor and --limit once each.");
  }
  const { cursor, limit: rawLimit } = parsed.values;
  if (cursor !== undefined && !validListCursor(cursor)) throw usageError("Use a cursor returned by sandbox-runner list.");
  const limit = rawLimit === undefined ? undefined : parseListLimit(rawLimit);
  if (rawLimit !== undefined && limit === undefined) throw usageError(`--limit must be between 1 and ${runListLimit}.`);
  return { name: "list", cursor, limit };
}

function parseOpenCodeStart(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args, allowPositionals: true, tokens: true,
      options: {
        "model-provider": { type: "string" }, model: { type: "string" }, effort: { type: "string" },
        "operation-id": { type: "string" }, "sandbox-provider": { type: "string" }, "run-timeout-ms": { type: "string" },
        repo: { type: "string" }, sha: { type: "string" }, ref: { type: "string" },
      },
    });
  } catch {
    throw usageError("Invalid OpenCode start arguments. Use sandbox-runner --help for usage.");
  }
  const names = parsed.tokens.filter(token => token.kind === "option").map(token => token.name);
  if (new Set(names).size !== names.length) throw usageError("Each OpenCode option can be supplied once.");
  const [prompt] = parsed.positionals;
  if (parsed.positionals.length !== 1 || !prompt.trim() || !prompt.isWellFormed() || prompt.includes("\0")) {
    throw usageError("OpenCode start requires one nonempty prompt argument.");
  }
  const { "model-provider": modelProvider, model, effort, "operation-id": id, "sandbox-provider": sandboxProvider,
    repo, sha, ref } = parsed.values;
  const error = openCodeOptionsError({ modelProvider, model, effort });
  if (error) throw usageError(error);
  if (sandboxProvider !== undefined && sandboxProvider !== "cloudflare") {
    throw usageError("OpenCode start supports the Cloudflare sandbox provider.");
  }
  const repository = requestedRepository(repo, sha, ref);
  if ((repo !== undefined || sha !== undefined || ref !== undefined) && !repository) {
    throw usageError("Supply --repo OWNER/REPO with either --sha COMMIT_SHA or --ref FULL_REF.");
  }
  return {
    name: "run", version: "v4", agent: "opencode", authMode: "api-key", explicitAuth: true,
    prompt, modelProvider, overrides: { model, effort }, sandboxProvider, repository,
    timeoutMs: parseAgentTimeoutMs(parsed.values["run-timeout-ms"]),
    id: id === undefined ? randomUUID() : normalizeId(id),
  };
}

function runSettingsError(agent, { model, effort }) {
  if (agent !== "codex") return claudeOptionsError(agent, { model, effort });
  if (model !== undefined && !isCodexModel(model)) return "--model must be an OpenAI model ID up to 5,000 bytes.";
  if (effort !== undefined && !isAgentEffort(effort)) return "--effort must be low, medium, high, xhigh, or max.";
}

function parseCommand([name, ...args]) {
  if (name === "list") return parseList(args);
  if (name === "wait") return parseWait(args);
  if (name === "vitest" && args[0] === "start") return parseTestStart(args.slice(1), "vitest");
  if (name === "test") return parseTestStart(args, "command");
  if (name === "events") return parseEvents(args);
  if (name === "opencode" && args[0] === "start") return parseOpenCodeStart(args.slice(1));
  const startAgent = agents.has(name) && args[0] === "start" ? name : undefined;
  const reviewing = name === "review";
  if (name === "run" || startAgent || reviewing) {
    let parsed;
    try {
      parsed = parseArgs({
        args: startAgent ? args.slice(1) : args,
        options: {
          ...(startAgent ? {} : { agent: { type: "string" } }),
          ...(startAgent || reviewing ? { repo: { type: "string" }, sha: { type: "string" }, mcp: { type: "string", multiple: true } } : {}),
          ...(startAgent ? { publish: { type: "boolean" }, ref: { type: "string" } } : {}),
          ...(reviewing ? { "producer-agent": { type: "string" }, "model-provider": { type: "string" } } : {}),
          auth: { type: "string" }, "operation-id": { type: "string" }, "sandbox-provider": { type: "string" },
          model: { type: "string" }, effort: { type: "string" }, "run-timeout-ms": { type: "string" },
        },
        allowPositionals: true,
        tokens: true,
      });
    } catch {
      throw usageError("Invalid run arguments. Use sandbox-runner --help for usage.");
    }
    const optionNames = parsed.tokens.filter(token => token.kind === "option" && token.name !== "mcp").map(token => token.name);
    if (new Set(optionNames).size !== optionNames.length) {
      throw usageError("Each run option can be supplied once.");
    }
    const { auth, "operation-id": suppliedId, "sandbox-provider": sandboxProvider, model, effort, repo, sha, ref, publish, mcp,
      "producer-agent": reviewProducer, "model-provider": modelProvider, "run-timeout-ms": rawAgentTimeout } = parsed.values;
    const connectors = connectorNames(mcp);
    if (mcp !== undefined && !connectors) throw usageError("Pass each MCP connector once by its configured lowercase name.");
    const agent = startAgent ?? parsed.values.agent;
    const [prompt] = parsed.positionals;
    const openCodeReview = reviewing && agent === "opencode";
    if ((!agents.has(agent) && !openCodeReview) || parsed.positionals.length !== 1 || !prompt.trim()) {
      throw usageError(startAgent ? "Start requires one nonempty prompt argument."
        : reviewing ? "Review requires --agent claude|codex|opencode and one nonempty criteria argument."
        : "Run requires --agent claude|codex and one nonempty prompt argument.");
    }
    if (openCodeReview ? auth !== undefined && auth !== "api-key" : modelProvider !== undefined) {
      throw usageError("Only OpenCode review accepts --model-provider and uses API-key authentication.");
    }
    if (auth !== undefined && !authModes.has(auth)) {
      throw usageError("--auth must be subscription or api-key.");
    }
    if (sandboxProvider !== undefined && (!sandboxProviderPattern.test(sandboxProvider) || sandboxProvider.trim() !== sandboxProvider)) {
      throw usageError("--sandbox-provider must be a lowercase provider name.");
    }
    const settingsError = openCodeReview ? openCodeOptionsError({ modelProvider, model, effort }, true)
      : runSettingsError(agent, { model, effort });
    if (settingsError) throw usageError(settingsError);
    const repository = requestedRepository(repo, sha, ref);
    if ((reviewing || repo !== undefined || sha !== undefined || ref !== undefined) && !repository) {
      throw usageError(reviewing ? "Supply --repo OWNER/REPO and --sha with the full 40-character commit SHA together."
        : "Supply --repo and either --sha or a full --ref in refs/heads/ or refs/tags/.");
    }
    if (reviewing && (!agents.has(reviewProducer) || reviewProducer === agent)) {
      throw usageError("Review requires --producer-agent and a different --agent.");
    }
    if (publish && !repository) throw usageError("--publish requires --repo with --sha or --ref.");
    const overrides = model !== undefined || effort !== undefined ? { model, effort } : undefined;
    const timeoutMs = parseAgentTimeoutMs(rawAgentTimeout);
    const legacyVersion = overrides ? "v3" : auth !== undefined ? "v2" : "v1";
    const needsV4 = startAgent || reviewing || sandboxProvider !== undefined || timeoutMs !== undefined || (agent === "codex" && overrides);
    const version = needsV4 ? "v4" : legacyVersion;
    return {
      name: "run", version, agent, authMode: effectiveAuthMode(agent, auth), explicitAuth: openCodeReview || auth !== undefined,
      prompt, overrides, sandboxProvider, repository, reviewProducer, publish, timeoutMs, connectors, modelProvider,
      id: suppliedId === undefined ? randomUUID() : normalizeId(suppliedId),
    };
  }
  if ((name === "status" || name === "result") && args.length === 1) {
    return { name, id: normalizeId(args[0]) };
  }
  if (name === "cancel" && args.length === 1) return { name, id: normalizeId(args[0]), version: "v4" };
  throw usageError("Use sandbox-runner --help for usage.");
}

function parseCanary([target, ...args]) {
  const isVitest = target === "vitest";
  if (!isVitest && !agents.has(target)) throw usageError("Choose claude, codex or vitest for the Cloudflare canary.");
  let parsed;
  try {
    parsed = parseArgs({ args, tokens: true, options: {
      repo: { type: "string" }, sha: { type: "string" }, "operation-id": { type: "string" },
      "timeout-ms": { type: "string" }, ...(isVitest ? {} : { auth: { type: "string" } }),
    } });
    const names = parsed.tokens.map(token => token.name);
    if (names.some(name => name === undefined) || new Set(names).size !== names.length) throw new Error();
  } catch {
    throw usageError("Invalid Cloudflare canary options. Use sandbox-runner --help for usage.");
  }
  const { "operation-id": operationId, "timeout-ms": rawTimeout, ...startOptions } = parsed.values;
  const id = operationId === undefined ? randomUUID() : normalizeId(operationId);
  const expectedAnswer = isVitest ? undefined : `SANDBOX_RUNNER_CANARY_${id}`;
  const start = [target, "start", "--sandbox-provider=cloudflare", `--operation-id=${id}`,
    ...Object.entries(startOptions).map(([name, value]) => `--${name}=${value}`)];
  if (!isVitest) start.push(`Reply with exactly ${expectedAnswer} and nothing else. Do not use tools.`);
  return { ...parseCommand(start), expectedAnswer, timeout: parseTimeoutMs(rawTimeout) };
}

function readConfiguration(env) {
  const configuredUrl = env.SANDBOX_RUNNER_URL ?? "";
  let url;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw configurationError("SANDBOX_RUNNER_URL must be an absolute Worker URL.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (
    !/^https?:\/\/[^/\s@?#\\]+\/?$/iu.test(configuredUrl) ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw configurationError("SANDBOX_RUNNER_URL must be an HTTPS origin or an HTTP loopback origin.");
  }

  const token = env.SANDBOX_RUNNER_TOKEN ?? "";
  if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) {
    throw configurationError("SANDBOX_RUNNER_TOKEN must contain a Bearer token.");
  }

  // Fail on a half-set Access service token before any request.
  accessServiceHeaders(env);
  return { url, token, timeout: readTimeout(env) };
}

function requestWorker(url, { method, token, body, signal, readForbidden, list, catalogRevision }) {
  const secure = url.protocol === "https:";
  const request = secure ? requestHttps : requestHttp;
  const headers = { accept: "application/json", authorization: "Bearer " + token, ...accessServiceHeaders() };
  if (list) headers[openCodeListHeader] = "1";
  if (catalogRevision === null) headers["if-none-match"] = "*";
  else if (catalogRevision !== undefined) headers["if-match"] = `"${catalogRevision}"`;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
  }
  const options = { method, headers, signal, agent: false };
  if (secure) options.rejectUnauthorized = true;
  if (!secure && url.hostname === "localhost") {
    options.hostname = "127.0.0.1";
    headers.host = url.host;
  }
  return new Promise((resolve, reject) => {
    const outgoing = request(url, options, async incoming => {
      try {
        const status = incoming.statusCode;
        let text = "";
        if ([200, 202, 400, 404, 409, 429, 503].includes(status) || (status === 403 && readForbidden)) {
          incoming.setEncoding("utf8");
          for await (const chunk of incoming) text += chunk;
        } else {
          incoming.destroy();
        }
        resolve({ status, text });
      } catch (error) {
        reject(error);
      }
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function decodeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function requestTeam(path, options, config) {
  const signal = AbortSignal.timeout(config.timeout);
  const mutation = options.method === "PUT";
  let response;
  try {
    response = await requestWorker(new URL(path, config.url), { ...options, token: config.token, signal });
  } catch {
    if (signal.aborted) {
      throw new CliError("timeout", "The team administration request timed out.", exit.timeout, { uncertain: mutation });
    }
    throw new CliError("network_error", "The team administration request did not complete.", exit.requestFailure, { uncertain: mutation });
  }
  const body = decodeJson(response.text);
  if (containsControlToken(body, config.token)) {
    throw new CliError("invalid_response", "The Worker returned an invalid team administration response.", exit.requestFailure,
      { uncertain: mutation });
  }
  return { status: response.status, body };
}

function teamCatalog(config, deadline) {
  const mode = process.env.SANDBOX_RUNNER_TEAM;
  if (mode === undefined || mode === "0") return;
  if (mode !== "1") throw configurationError("SANDBOX_RUNNER_TEAM must be 1 to use the Worker catalog or 0 to use local profiles.");
  const target = config ?? readConfiguration(process.env);
  return async (slug, { readinessRevision } = {}) => {
    const path = slug === undefined ? "/v4/profiles" : "/v4/profiles/" + encodeURIComponent(slug) +
      (readinessRevision === undefined ? "" : "/readiness");
    const url = new URL(path, target.url);
    if (readinessRevision !== undefined) url.searchParams.set("revision", readinessRevision);
    const timeout = AbortSignal.timeout(target.timeout);
    const signal = deadline ? AbortSignal.any([deadline, timeout]) : timeout;
    let response;
    try {
      response = await requestWorker(url, { method: "GET", token: target.token, signal, readForbidden: true });
    } catch {
      if (signal.aborted) throw new CliError("timeout", "Reading the team profile catalog timed out.", exit.timeout);
      throw new CliError("network_error", "Could not contact the team profile catalog.", exit.requestFailure);
    }
    const body = decodeJson(response.text);
    if (response.status === 200 && !containsControlToken(body, target.token)) return body;
    const failure = teamProfileError(response.status, body);
    if (failure) throw failure;
    if (readinessRevision !== undefined && response.status === 404) {
      throw new CliError("profile_check_unavailable", "The Worker does not expose readiness for this profile.", exit.configuration,
        { httpStatus: response.status });
    }
    if ([401, 403, 404].includes(response.status)) {
      throw new CliError("not_found", "Check the Worker URL, team client token and team profile catalog.", exit.configuration,
        { httpStatus: response.status });
    }
    throw new CliError("invalid_response", "The Worker did not return a team profile catalog.", exit.requestFailure,
      { httpStatus: response.status });
  };
}

function teamProfileError(httpStatus, body) {
  const details = { httpStatus };
  if (httpStatus === 404 && body?.error === "profile_not_found") {
    return new CliError(body.error, "The profile is unavailable to this team client.", exit.configuration, details);
  }
  if (httpStatus === 409 && body?.error === "profile_revision_changed") {
    return new CliError(body.error, "The team profile revision changed. Check status for this operation ID before starting another run.",
      exit.requestFailure, details);
  }
  if (httpStatus === 403 && body?.error === "profile_required") {
    return new CliError(body.error, "This team client must start an authorized profile with SANDBOX_RUNNER_TEAM=1.",
      exit.configuration, details);
  }
  if (httpStatus === 503 && body?.error === "team_configuration_invalid") {
    return new CliError(body.error, "Ask the Worker operator to check the team catalog and client configuration.", exit.configuration, details);
  }
}

function checkedStrategy(body) {
  const modes = authStrategies.get(body.strategy);
  if (!modes || !Array.isArray(body.attempts) || body.attempts.length < 1 || body.attempts.length > modes.length) return;
  const attempts = [];
  const ids = new Set([body.id.toLowerCase()]);
  for (const [index, attempt] of body.attempts.entries()) {
    if (!attempt || typeof attempt.operationId !== "string" || !uuidPattern.test(attempt.operationId) ||
        ids.has(attempt.operationId.toLowerCase()) || attempt.authMode !== modes[index] ||
        attempt.model !== body.model || attempt.effort !== body.effort ||
        !statuses.has(attempt.status) || !cleanupStatuses.has(attempt.cleanup) ||
        (attempt.reason !== undefined && typeof attempt.reason !== "string")) return;
    const { operationId, authMode, status, cleanup, reason, model, effort } = attempt;
    ids.add(operationId.toLowerCase());
    attempts.push({ operationId, authMode, status, cleanup, reason, model, effort });
  }
  const { strategy, fallbackReason } = body;
  const active = attempts.at(-1);
  const cancelledBeforeDeadline = body.deadlineAt !== undefined && body.cancellationRequested === true && body.status === "cancelled" &&
    body.reason === "run_cancelled" && active.status === "timed_out" && active.reason === "run_timed_out";
  const publishing = body.deadlineAt !== undefined && body.publication?.status === "pending" &&
    body.status === "running" && body.reason === undefined && active.status === "succeeded";
  if (body.authMode !== active.authMode || body.cleanup !== active.cleanup ||
      (body.status === "timed_out" ? body.cleanup !== "pending" && !terminalStatuses.has(active.status)
        : !cancelledBeforeDeadline && !publishing && (body.status !== active.status || body.reason !== active.reason))) return;
  if (attempts.length === 1) {
    if (fallbackReason !== undefined) return;
  } else {
    const first = attempts[0];
    if (fallbackReason !== "provider_quota_exhausted" || first.reason !== fallbackReason ||
        first.status !== "capacity" || first.cleanup !== "destroyed") return;
  }
  return { strategy, attempts, fallbackReason };
}

function checkedPublication(value, run, repository) {
  if (!value || typeof value !== "object" || !repository) return;
  const { status, branch, commitSha, treeSha, reason } = value;
  if (status === "pending" || status === "cancelled") return { status };
  if (status === "failed" && typeof reason === "string" && /^github_[a-z0-9_]+$/u.test(reason)) return { status, reason };
  if (status === "no_changes" && run.status === "succeeded") return { status };
  if ((run.status !== "succeeded" && !(run.status === "timed_out" && run.reason === "run_timed_out" && run.deadlineAt !== undefined)) ||
      run.cleanup !== "destroyed") return;
  if (branch !== "sandbox-runner/" + run.id) return;
  if (status === "uncertain" || status === "conflict") return { status, branch };
  const oid = value => typeof value === "string" && value.length === 40 && /^[0-9a-f]{40}$/u.test(value);
  if (status === "published" && oid(commitSha) && oid(treeSha) && commitSha !== repository.sha) {
    return { status, branch, commitSha, treeSha };
  }
}

function checkedRun(body, command) {
  const profile = checkedProfileReceipt(body?.profile, command.profileReceipt, body?.review !== undefined);
  if ((body?.profile !== undefined || command.profileReceipt) && !profile) return;
  if (body?.kind === "test") {
    if ((command.name === "run" && command.kind !== "test") || body.connectorIssues !== undefined) return;
    const run = checkedVitestRun(body, command);
    return run && (profile ? { ...run, profile } : run);
  }
  if (command.kind === "test") return;
  const openCode = body?.agent === "opencode";
  if (openCode ? typeof body.model !== "string" || openCodeOptionsError(body, body.review !== undefined) ||
      body.kind !== "agent" || body.sandboxProvider !== "cloudflare" || body.authMode !== "api-key" ||
      body.publication !== undefined ||
      body.strategy !== undefined || body.attempts !== undefined || body.fallbackReason !== undefined ||
      (command.modelProvider !== undefined && (body.modelProvider !== command.modelProvider || body.effort !== command.overrides.effort))
    : !agents.has(body?.agent) || body.modelProvider !== undefined || runSettingsError(body.agent, body)) return;
  if (
    body?.id !== command.id ||
    (command.name === "run" && command.agent !== body.agent) ||
    (body.authMode !== undefined && !authModes.has(body.authMode)) ||
    (command.explicitAuth && body.authMode === undefined) ||
    !statuses.has(body.status) ||
    !cleanupStatuses.has(body.cleanup) ||
    (command.name === "result" && (!terminalStatuses.has(body.status) || body.cleanup === "pending")) ||
    (body.output !== undefined && typeof body.output !== "string") ||
    (body.reason !== undefined && typeof body.reason !== "string") ||
    (command.overrides?.model !== undefined && body.model !== command.overrides.model) ||
    (command.overrides?.effort !== undefined && body.effort !== command.overrides.effort)
  ) return undefined;

  const hasStrategy = body.strategy !== undefined || body.attempts !== undefined || body.fallbackReason !== undefined;
  const strategy = hasStrategy ? checkedStrategy(body) : undefined;
  if ((hasStrategy && (!strategy || command.explicitAuth)) || (command.authStrategy && !strategy) ||
      (command.name === "run" && !strategy && command.authMode !== effectiveAuthMode(body.agent, body.authMode))) return;
  const hasProviderContract = body.kind !== undefined || body.sandboxProvider !== undefined;
  if (command.version === "v4" || hasProviderContract) {
    if (body.kind !== "agent" || body.sandboxProvider !== "cloudflare" ||
        (command.sandboxProvider !== undefined && body.sandboxProvider !== command.sandboxProvider)) return;
  }
  const { deadlineAt } = body;
  if ((deadlineAt !== undefined && (!hasProviderContract || !Number.isSafeInteger(deadlineAt) || deadlineAt <= 0)) ||
      (command.timeoutMs !== undefined && deadlineAt === undefined) ||
      (body.status === "timed_out" && (deadlineAt === undefined || body.reason !== "run_timed_out" || body.output !== undefined))) return;
  const repository = parseRepository(body.repository);
  if ((body.repository !== undefined && (!repository || !hasProviderContract)) ||
      (openCode && command.name === "run" && !!repository !== !!command.repository) ||
      (command.repository && !matchesRepositoryReceipt(repository, command.repository))) return;
  const review = body.review === undefined ? undefined : checkedReview(body.review, body.agent, body.status);
  if ((body.review !== undefined && (!review || !repository || body.output !== undefined)) ||
      (command.name === "run" && review?.producerAgent !== command.reviewProducer)) return;
  const connectorAccess = checkedConnectorAccess(body.connectorAccess, review);
  if ((body.connectorAccess !== undefined && (!connectorAccess || (openCode && !review) || !hasProviderContract)) ||
      (command.name === "run" && JSON.stringify(connectorAccess?.connectors) !== JSON.stringify(command.connectors))) return;
  const connectorIssues = body.connectorIssues === undefined ? undefined : checkedConnectorIssues(body.connectorIssues, connectorAccess);
  if (body.connectorIssues !== undefined && !connectorIssues) return;
  const { connectorFallbackBlocked } = body;
  if (connectorFallbackBlocked !== undefined && (connectorFallbackBlocked !== true || connectorAccess?.mode !== "read-write" ||
      body.reason !== "provider_quota_exhausted" || strategy?.attempts.length !== 1 || body.cleanup !== "destroyed")) return;
  const publication = checkedPublication(body.publication, body, repository);
  if ((body.publication !== undefined && !publication) || (review && publication) ||
      (command.name === "run" && !!command.publish !== !!publication) ||
      (command.name === "result" && publication?.status === "pending")) return;
  if (body.cancellationRequested !== undefined &&
      (body.cancellationRequested !== true || !strategy || !hasProviderContract)) return;
  const { id, agent, authMode, status, cleanup, output, reason, model, effort } = body;
  const provider = hasProviderContract ? { kind: body.kind, sandboxProvider: body.sandboxProvider } : undefined;
  const cancellation = body.cancellationRequested ? { cancellationRequested: true } : undefined;
  return { id, agent, authMode, status, cleanup, output, reason, model, effort, ...strategy, ...provider, ...cancellation,
    ...(profile ? { profile } : {}),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(openCode ? { modelProvider: body.modelProvider } : {}),
    ...(review === undefined ? {} : { review }),
    ...(connectorAccess === undefined ? {} : { connectorAccess }),
    ...(connectorIssues === undefined ? {} : { connectorIssues }),
    ...(connectorFallbackBlocked === undefined ? {} : { connectorFallbackBlocked }),
    ...(repository ? { repository } : {}), ...(publication ? { publication } : {}) };
}

function checkedReview(value, agent, status) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { producerAgent, verdict, findings } = value;
  if (!agents.has(producerAgent) || producerAgent === agent) return;
  if (status !== "succeeded") {
    if (verdict === undefined && findings === undefined) return { producerAgent };
    return;
  }
  if ((verdict !== "PASS" && verdict !== "FAIL" && verdict !== "ESCALATE") || !Array.isArray(findings) ||
      (verdict !== "PASS" && findings.length === 0) ||
      !findings.every(finding => typeof finding === "string" && finding.trim() && finding.isWellFormed())) return;
  return { producerAgent, verdict, findings };
}

function workerError(command, httpStatus, body) {
  const details = { httpStatus };
  const mutation = command.name === "run" || command.name === "cancel";
  const teamFailure = teamProfileError(httpStatus, body);
  if (teamFailure) return teamFailure;
  const connectorFailure = connectorIssueFailure(command, httpStatus, body);
  if (connectorFailure) return connectorFailure;
  if (command.profileSubmission && httpStatus === 400 && body?.error === "invalid_profile_inputs") {
    const issues = checkedProfileInputIssues(body.issues, command.profileJournal.submission.profile.body);
    if (!issues) {
      return new CliError("invalid_response", "The Worker returned an invalid profile input diagnostic.", exit.requestFailure,
        { ...details, uncertain: true });
    }
    return new CliError(body.error, profileInputErrorMessage, exit.usage, { ...details, issues, profile: command.profileReceipt.slug });
  }
  if (command.profileSubmission && httpStatus === 400 &&
      ["invalid_profile_config", "invalid_profile", "invalid_profile_request", "override_not_allowed"].includes(body?.error)) {
    return new CliError(body.error, "The Worker rejected the profile or its run inputs.", exit.usage, details);
  }
  if (command.connectors && httpStatus === 403 && body?.error === "mcp_connector_not_allowed") {
    return new CliError(body.error, "The selected MCP connector is unavailable for this run.", exit.configuration, details);
  }
  if (command.connectors && httpStatus === 503 && ["mcp_connector_configuration_invalid", "mcp_connector_auth_required"].includes(body?.error)) {
    return new CliError(body.error, "Check the Worker's MCP connector settings and credentials.", exit.configuration, details);
  }
  if (command.name === "run" && command.repository && "ref" in command.repository && body?.operationId === command.id) {
    if (httpStatus === 404 && body.error === "github_reference_not_found") {
      return new CliError(body.error, "GitHub did not return a commit for the reference. Check the branch or tag and the GitHub App access.", exit.configuration, details);
    }
    if (httpStatus === 503 && body.error === "github_reference_unavailable") {
      return new CliError(body.error, "The Worker could not resolve the GitHub reference. Retry the same input and operation ID.", exit.requestFailure, details);
    }
  }
  if (httpStatus === 409 && (command.name === "cancel" || command.name === "status") &&
      body?.error === "admission_in_progress" && body.operationId === command.id) {
    const message = command.name === "cancel" ? "The reference is still resolving. Retry cancellation after admission."
      : "The reference is still resolving. Check status after admission.";
    return new CliError(body.error, message, exit.requestFailure, details);
  }
  if (httpStatus === 403 && command.repository && body?.error === "github_repository_not_allowed") {
    return new CliError("github_repository_not_allowed", "The repository is outside this Worker's GitHub allowlist.", exit.configuration, details);
  }
  if (httpStatus >= 300 && httpStatus < 400) {
    return new CliError("redirect_rejected", "The Worker returned a redirect.", exit.requestFailure, {
      ...details, uncertain: mutation,
    });
  }
  if (httpStatus === 401 || httpStatus === 403 || (httpStatus === 404 && body?.error === "not_found")) {
    if (command.name === "list") {
      return new CliError("not_found", "Check the Worker URL, control token and support for run listing.", exit.configuration, details);
    }
    if (command.name === "events") {
      return new CliError("not_found", "Check the Worker URL, control token and support for run events.", exit.configuration, details);
    }
    if (command.name === "cancel") {
      return new CliError("not_found", "Check the Worker URL, control token and support for run cancellation.", exit.configuration, details);
    }
    if (command.version === "v4") {
      return new CliError("not_found", "Check the Worker URL, control token and support for provider-aware runs.", exit.configuration, details);
    }
    if (command.overrides) {
      return new CliError("not_found", "Check the Worker URL, control token and support for Claude run overrides.", exit.configuration, details);
    }
    if (command.explicitAuth) {
      return new CliError("not_found", "Check the Worker URL, control token and support for explicit auth.", exit.configuration, details);
    }
    return new CliError("not_found", "The Worker did not accept the URL or control token.", exit.configuration, details);
  }
  if (httpStatus === 400 && body?.error === "invalid_request") {
    return new CliError("invalid_request", "The Worker did not accept the run input.", exit.usage, details);
  }
  if (httpStatus === 400 && command.name === "run" && command.timeoutMs !== undefined && body?.error === "run_timeout_exceeds_limit") {
    return new CliError("run_timeout_exceeds_limit", "The requested run timeout exceeds the Worker's configured limit.", exit.usage, details);
  }
  if (httpStatus === 400 && command.name === "events" && body?.error === "invalid_cursor") {
    return new CliError("invalid_cursor", "The cursor is outside this run's event history. Use a cursor returned for this run.", exit.usage, details);
  }
  if (command.name === "list") {
    if (httpStatus === 400 && ["invalid_cursor", "invalid_limit", "invalid_query"].includes(body?.error)) {
      return new CliError(body.error, "The Worker rejected the pagination options.", exit.usage, details);
    }
    if (httpStatus === 405) {
      return new CliError("run_list_unsupported", "Deploy a Worker that supports listing runs.", exit.configuration, details);
    }
    if (httpStatus === 503 && body?.error === "run_list_unavailable") {
      return new CliError("run_list_unavailable", "The Worker could not complete the list. Retry the same cursor.", exit.requestFailure, details);
    }
  }
  if (httpStatus === 503 && command.name === "run" && body?.error === "run_index_unavailable") {
    return new CliError("run_index_unavailable", "The Worker could not confirm indexing. Retry the same input with the same operation ID.",
      exit.requestFailure, { ...details, uncertain: true });
  }
  const admissionResponse = command.name === "run" && body?.operationId === command.id;
  if (admissionResponse && httpStatus === 429 && body?.error === "installation_capacity") {
    return new CliError("installation_capacity", "The installation has reached its concurrent run limit. Retry with the same operation ID.",
      exit.capacity, details);
  }
  if (admissionResponse && httpStatus === 503) {
    if (body?.error === "installation_maintenance") {
      return new CliError("installation_maintenance", "The installation has paused new admissions. Retry after the operator reopens it.",
        exit.requestFailure, details);
    }
    if (body?.error === "admission_unconfirmed") {
      return new CliError("admission_unconfirmed", "The Worker could not confirm admission. Retry the same input with the same operation ID.",
        exit.requestFailure, { ...details, uncertain: true });
    }
    if (body?.error === "legacy_unverified") {
      return new CliError("legacy_unverified", "The installation has earlier admissions. Verify that they are drained before enabling its limit.",
        exit.configuration, details);
    }
    if (body?.error === "installation_admission_invalid") {
      return new CliError("installation_admission_invalid", "The deployment's concurrency limit differs from the installation policy.",
        exit.configuration, details);
    }
  }
  if (httpStatus === 404 && body?.error === "run_not_found") {
    return new CliError("run_not_found", "The Worker could not find this run.", exit.requestFailure, details);
  }
  if (httpStatus === 409 && command.name === "run" && body?.error === "operation_conflict") {
    return new CliError("operation_conflict", "This operation ID is already bound to different run input.", exit.requestFailure, details);
  }
  if (httpStatus === 409 && command.name === "result" && body?.error === "run_in_progress") {
    return new CliError("run_in_progress", "The result is still pending.", exit.requestFailure, details);
  }
  if (httpStatus === 409 && command.name === "cancel" && body?.error === "cancel_unsupported") {
    return new CliError("cancel_unsupported", "Cancellation requires a provider-aware run. Use sandbox-runner claude start or codex start.", exit.configuration, details);
  }
  if (httpStatus === 503 && command.name === "run" && command.agent && !command.explicitAuth && body?.error === "auth_strategy_invalid") {
    return new CliError("auth_strategy_invalid", `The Worker auth strategy is invalid. Run sandbox-runner ${command.agent} setup for this Worker.`, exit.configuration, details);
  }
  if (httpStatus === 503 && command.name === "run" && command.agent === "claude" && body?.error === "claude_defaults_invalid") {
    return new CliError("claude_defaults_invalid", "The Worker Claude defaults are invalid. Use sandbox-runner claude setup to update them.", exit.configuration, details);
  }
  if (httpStatus === 503 && command.agent === "opencode" && body?.error === "opencode_disabled") {
    return new CliError("opencode_disabled", "OpenCode is disabled on this Worker. Check SANDBOX_RUNNER_OPENCODE.", exit.configuration, details);
  }
  if (httpStatus === 503 && command.version === "v4") {
    if (command.kind !== "test" && body?.error === "agent_deadline_invalid") {
      return new CliError("agent_deadline_invalid", "Check the Worker's SANDBOX_RUNNER_AGENT_TIMEOUT_MS setting.", exit.configuration, details);
    }
    if (command.kind === "test" && body?.error === "vitest_not_configured") {
      return new CliError("vitest_not_configured", "Check the Worker's native Vitest configuration.", exit.configuration, details);
    }
    if (body?.error === "sandbox_provider_unavailable") {
      return new CliError("sandbox_provider_unavailable", "The selected sandbox provider is unavailable on this Worker.", exit.configuration, details);
    }
    if (body?.error === "sandbox_provider_default_invalid") {
      return new CliError("sandbox_provider_default_invalid", "The Worker default sandbox provider is invalid. Use sandbox-runner setup --default-sandbox-provider cloudflare.", exit.configuration, details);
    }
    if (body?.error === "github_allowlist_invalid" || body?.error === "github_checkout_not_configured") {
      return new CliError(body.error, "Check the Worker GitHub App and repository allowlist configuration.", exit.configuration, details);
    }
    if (body?.error === "github_publication_configuration_invalid") {
      return new CliError(body.error, "Check the GitHub publication transfer budget on the Worker.", exit.configuration, details);
    }
  }
  return new CliError("request_failed", "The Worker rejected the request.", exit.requestFailure, {
    ...details, uncertain: mutation,
  });
}

async function execute(command, config, deadline) {
  const submitting = command.name === "run";
  const cancelling = command.name === "cancel";
  const readingEvents = command.name === "events";
  const listing = command.name === "list";
  const mutation = submitting || cancelling;
  const path = submitting ? `/${command.version}/runs`
    : listing ? "/v4/runs"
    : cancelling ? `/v4/runs/${command.id}/cancel`
    : readingEvents ? `/v4/runs/${command.id}/events` : "/v1/runs/" + command.id;
  const url = new URL(path + (command.name === "result" ? "/result" : ""), config.url);
  if (readingEvents && command.after !== 0) url.searchParams.set("after", command.after);
  if (listing && command.cursor !== undefined) url.searchParams.set("cursor", command.cursor);
  if (listing && command.limit !== undefined) url.searchParams.set("limit", String(command.limit));
  const submission = command.profileSubmission ?? (command.kind === "test" ? {
    kind: "test", suite: command.suite, operationId: command.id, repository: command.repository, sandboxProvider: command.sandboxProvider,
    ...(command.argv === undefined ? {} : { argv: command.argv }),
  } : {
    agent: command.agent, prompt: command.prompt, operationId: command.id,
    ...(command.version === "v4" ? { kind: "agent", sandboxProvider: command.sandboxProvider, timeoutMs: command.timeoutMs } : {}),
    ...(command.repository ? { repository: command.repository } : {}),
    ...(command.reviewProducer ? { reviewProducer: command.reviewProducer } : {}),
    ...(command.publish ? { publish: true } : {}),
    ...(command.explicitAuth ? { authMode: command.authMode } : {}),
    ...(command.modelProvider === undefined ? {} : { modelProvider: command.modelProvider }),
    ...(command.connectors === undefined ? {} : { connectors: command.connectors }),
    ...command.overrides,
  });
  const body = submitting ? JSON.stringify(submission) : undefined;

  const requestTimeout = AbortSignal.timeout(config.timeout);
  const signal = deadline ? AbortSignal.any([deadline, requestTimeout]) : requestTimeout;
  let response;
  try {
    response = await requestWorker(url, {
      method: mutation ? "POST" : "GET", token: config.token, body, signal,
      list: listing,
      readForbidden: submitting,
    });
  } catch {
    if (signal.aborted) {
      throw new CliError("timeout", "The request timed out.", exit.timeout, { uncertain: mutation });
    }
    throw new CliError("network_error", "The request did not complete.", exit.requestFailure, { uncertain: mutation });
  }
  const payload = decodeJson(response.text);
  const expectedStatus = mutation ? 202 : 200;
  if (payload?.error === "invalid_profile_inputs" && containsControlToken(payload.issues, config.token)) {
    throw new CliError("invalid_response", "The Worker returned an invalid profile input diagnostic.", exit.requestFailure,
      { httpStatus: response.status, uncertain: mutation });
  }
  if (response.status !== expectedStatus) throw workerError(command, response.status, payload);

  if (listing) {
    const page = checkedRunList(payload, command);
    if (!page) throw new CliError("invalid_response", "The Worker returned an invalid run list.", exit.requestFailure, { httpStatus: response.status });
    return page;
  }

  if (readingEvents) {
    const page = checkedEvents(payload, command.id, command.after);
    if (page) return page;
    throw new CliError("invalid_response", "The Worker returned an invalid event history.", exit.requestFailure, {
      httpStatus: response.status,
    });
  }

  const run = checkedRun(payload, command);
  if (!run || (cancelling && !terminalStatuses.has(run.status) && !run.cancellationRequested)) {
    throw new CliError("invalid_response", "The Worker returned an invalid run response.", exit.requestFailure, {
      httpStatus: response.status, uncertain: mutation,
    });
  }
  return run;
}

async function waitForResult(command, config, signal) {
  const timeout = command.timeout === undefined ? undefined : AbortSignal.timeout(command.timeout);
  const deadline = signal && timeout ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
  for (;;) {
    try {
      return await execute(command, config, deadline);
    } catch (error) {
      if (deadline?.aborted) break;
      const retry = error instanceof CliError && (
        ["run_in_progress", "network_error", "timeout"].includes(error.code) ||
        [502, 503, 504].includes(error.httpStatus)
      );
      if (!retry) throw error;
    }
    try {
      await sleep(1_000, undefined, { signal: deadline });
    } catch (error) {
      if (!deadline?.aborted) throw error;
      break;
    }
  }
  throw new CliError("wait_timeout", "Stopped waiting for this run. Use sandbox-runner wait with the same run ID to continue.", exit.timeout);
}

async function runCanary(command, config) {
  if (process.stderr.isTTY) process.stderr.write(`\nWaiting for Cloudflare canary ${command.id}\n\n`);
  await execute(command, config);
  const result = { ...command, name: "result" };
  const run = await waitForResult(result, config);
  if (run.agent !== command.agent || run.kind !== (command.kind ?? "agent") ||
      (command.explicitAuth && run.authMode !== command.authMode)) {
    throw new CliError("invalid_response", "The result does not match the canary target.", exit.requestFailure);
  }
  const { id, kind, suite, agent, sandboxProvider, status: runStatus, cleanup, repository,
    authMode, fallbackReason, checkoutSha, lockSha256, imageDigest, exitCode: processExitCode, versions } = run;
  const runtimeExit = resultExitCode(result, run);
  const proved = kind === "test" ? checkoutSha === repository.sha && imageDigest !== undefined && processExitCode === 0
    : run.output?.trim() === command.expectedAnswer;
  const reason = runtimeExit === exit.success && !proved ? "canary_result_unverified" : run.reason;
  const passed = runtimeExit === exit.success && proved;
  let hint = resultHint(result, run);
  if (reason === "canary_result_unverified") hint = "The run finished without the expected canary proof.";
  if (reason === "test_install_failed" && cleanup === "destroyed") {
    hint = `npm ci failed. Read the installation output with sandbox-runner result ${id}.`;
  }
  return {
    output: { status: passed ? "passed" : "failed", id, kind, suite, agent, sandboxProvider, runStatus, cleanup, reason,
      repository, authMode, fallbackReason, checkoutSha, lockSha256, imageDigest, processExitCode, versions },
    exitCode: passed ? exit.success : runtimeExit || exit.runFailure,
    hint,
  };
}

function resultExitCode(command, run) {
  if (command.name !== "result") return exit.success;
  if (run.kind === "test" && run.cleanup === "failed") return exit.requestFailure;
  if (run.cleanup === "failed") return exit.runFailure;
  if (run.status === "succeeded") {
    return !run.publication || run.publication.status === "published" || run.publication.status === "no_changes"
      ? exit.success : exit.runFailure;
  }
  if (run.kind === "test") {
    if (run.status === "cancelled" || (run.reason === "test_failed" && run.exitCode === 1) ||
        (run.suite === "command" && (run.reason === "test_command_failed" || run.reason === "test_command_signaled"))) return exit.runFailure;
    return run.reason === "test_timed_out" ? exit.timeout : exit.requestFailure;
  }
  if (run.status === "capacity") return exit.capacity;
  if (run.status === "auth_required") return exit.configuration;
  if (run.status === "timed_out") return exit.timeout;
  return exit.runFailure;
}

const resultHints = new Map([
  ["run_timed_out", "The run reached its configured deadline. Submit a new operation ID to start another run."],
  ["provider_auth_required", "The provider rejected authentication. Check the credential configured for this agent and auth mode."],
  ["provider_credential_missing", "Configure the Worker credential for this agent and auth mode."],
  ["provider_permission_denied", "The provider denied access. Check account, project, and model permissions."],
  ["provider_billing_required", "The provider reported a billing restriction. Check billing or available credit."],
  ["provider_capacity", "The provider returned a usage or rate limit. Check the account limits and retry when capacity is available."],
  ["provider_quota_exhausted", "The provider reported insufficient quota. Check the project budget, billing, or available credit."],
  ["provider_overloaded", "The provider is overloaded. Wait for it to recover before retrying."],
  ["provider_timeout", "The provider request timed out. Check provider availability before retrying."],
  ["provider_unavailable", "The provider returned a server error. Check its availability before retrying."],
  ["provider_transport_failed", "The Worker could not complete the provider connection. Check provider availability and network access."],
  ["provider_redirect_denied", "The provider returned a redirect. Check the configured provider endpoint."],
  ["provider_request_rejected", "The provider rejected the request. Check the model, request parameters, and account limits."],
  ["provider_codex_api_credit_promo_restricted", "OpenAI blocked Codex API-key access for this organization because of its API credits promotion. Configure a key from an eligible API organization or explicitly select subscription authentication."],
  ["provider_request_too_large", "The provider rejected the request size. Reduce the prompt or its context."],
  ["provider_resource_unavailable", "The provider could not find the requested resource. Check the model or endpoint."],
  ["container_lost", "The container stopped before returning a result. Submit a new run to try again."],
  ["container_unavailable", "The container could not be started. Check the Cloudflare Containers configuration and status."],
  ["github_checkout_failed", "The private repository could not be checked out at the requested SHA. Check the GitHub App installation, repository access, and commit availability."],
  ["review_verdict_invalid", "The agent did not return a structured review verdict."],
  ["opencode_mcp_startup_failed", "OpenCode could not connect every selected MCP server before the review. Check connector availability and credentials."],
  ["checkout_failed", "The test checkout did not reach the requested Git SHA."],
  ["test_lockfile_unverified", "The committed npm lockfile or required suite dependency could not be verified."],
  ["test_install_failed", "npm ci failed. Check the installation output in this receipt."],
  ["test_runtime_failed", "The native test runtime could not complete."],
  ["test_runtime_lost", "The native test run was interrupted before its result was saved."],
  ["test_command_failed", "The test command returned a nonzero exit code. Check the command output in this receipt."],
  ["test_command_signaled", "A signal terminated the test command. Check the signal and command output in this receipt."],
  ["test_command_not_found", "The executable was not found in the checkout or its command PATH."],
  ["test_command_permission_denied", "The sandbox user could not execute the selected file."],
  ["test_command_invalid_executable", "The file could not be executed directly. Use an executable binary or a script with a valid interpreter line."],
  ["test_command_arguments_too_large", "The operating system rejected the command arguments as too large."],
  ["test_command_start_failed", "The sandbox could not start the selected executable."],
  ["test_timed_out", "The test run reached its configured deadline."],
  ["aborted", "The operation was interrupted. Submit a new run if you still need a result."],
  ["harness_operation_not_found", "ContainerHarness could not find the operation. Submit a new run if you still need a result."],
  ["turn_unanswered", "The agent did not return a result."],
  ["run_failed", "The run failed without a specific provider diagnostic."],
  ["run_cancelled", "The run was cancelled."],
]);

function resultHint(command, run) {
  if (command.name !== "result") return;
  if (run.cleanup === "failed") return "Container cleanup failed. Check the run in Cloudflare Containers.";
  if (run.connectorFallbackBlocked) return "Provider quota ran out after an MCP write was claimed. Check its outcome before starting another run.";
  if (run.status === "timed_out" && run.publication?.status === "uncertain") {
    return "The run reached its deadline. Use status or wait with the same run ID to recheck the branch.";
  }
  if (run.status === "succeeded" && run.publication) {
    switch (run.publication.status) {
      case "cancelled": return "Publication was cancelled.";
      case "failed": return "The agent completed. Publication failed before a branch was verified.";
      case "conflict": return "The run branch already points to a different commit.";
      case "uncertain": return "The run branch could not be verified. Use status or wait with the same run ID to check it again.";
    }
  }
  const hint = resultHints.get(run.reason);
  if (run.reason === "provider_auth_required" || run.reason === "provider_credential_missing") {
    if (run.agent === "opencode") {
      return hint + ` Use sandbox-runner auth opencode --model-provider ${run.modelProvider} --account <id> --worker <name>.`;
    }
    const mode = effectiveAuthMode(run.agent, run.authMode);
    return hint + ` Use sandbox-runner auth ${run.agent} --mode ${mode} --account <id> --worker <name>.`;
  }
  return hint;
}

async function runCommand(command, config, signal) {
  if (command.profileSubmission && !command.profileRetry) await saveProfileRequest(command, config.url.origin, process.env);
  const run = command.wait ? await waitForResult(command, config, signal) : await execute(command, config, signal);
  const issues = command.name === "result" ? run.connectorIssues ?? [] : [];
  const uncertainWrite = issues.find(issue => issue.code === "mcp_connector_write_unconfirmed");
  const hint = resultHint(command, run);
  const hints = [uncertainWrite ? connectorIssueHint(uncertainWrite, process.env) : hint && authText(terminalAuthLocale(process.env), hint),
    ...issues.filter(issue => issue !== uncertainWrite).map(issue => connectorIssueHint(issue, process.env))].filter(Boolean);
  return { output: run, exitCode: resultExitCode(command, run), hint: hints.join("\n\n") };
}

async function runWithConnectorRecovery(command, config) {
  try {
    return await runCommand(command, config);
  } catch (error) {
    if (command.profileReceipt?.source === "worker-catalog" ||
        !(error instanceof CliError) || error.admission !== "rejected" || !error.reconnectScope ||
        !error.workerVersionId || config.url.protocol !== "https:" ||
        !process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY ||
        !process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.SANDBOX_RUNNER_WORKER ||
        containsControlToken([error.connectorIssue, error.reconnectScope, error.workerVersionId], config.token)) throw error;
    const { connectorLogin } = await import("./connector-login.mjs");
    const { connector, mode } = error.connectorIssue;
    const locale = terminalAuthLocale(process.env);
    let reconnected;
    try {
      reconnected = await connectorLogin([connector, "--mode", mode, "--scope", error.reconnectScope],
        process.env, { CliError, exit, timeout: config.timeout,
          recovery: { versionId: error.workerVersionId, origin: config.url.origin } });
    } catch (reconnectError) {
      const failure = checkedFailure(reconnectError);
      process.stderr.write(authText(locale, failure.message) + "\n");
      if (failure.uncertain) {
        throw new CliError(error.code, failure.message, failure.exitCode, {
          httpStatus: error.httpStatus, admission: error.admission, connectorIssue: error.connectorIssue,
          recovery: { action: "check_configuration", retry: "same_operation_id" },
        });
      }
      throw error;
    }
    if (!reconnected) throw error;
    process.stderr.write(authText(locale, "Connector credential configured. Active Worker version verified.") + "\n");
  }
  return runCommand(command, config);
}

function commandFailure(failure, command) {
  const message = command?.profileSubmission && failure.uncertain
    ? `${failure.message} Use sandbox-runner retry ${command.id} to resend the saved request.` : failure.message;
  return {
    output: {
      error: failure.code,
      message,
      operationId: command?.id,
      httpStatus: failure.httpStatus,
      uncertain: failure.uncertain || undefined,
      admission: failure.admission,
      connectorIssue: failure.connectorIssue,
      recovery: failure.recovery,
      profile: failure.profile,
      issues: failure.issues,
    },
    exitCode: failure.exitCode,
  };
}

function checkedFailure(error) {
  return error instanceof CliError ? error
    : profileFailure(error) ?? new CliError("internal_error", "The CLI could not complete the command.", exit.requestFailure);
}

async function resolveCommand(args, config, signal) {
  if (args[0] === "start") return startProfile(args, process.env, teamCatalog(config, signal));
  if (args[0] === "retry") {
    const target = config ?? readConfiguration(process.env);
    return retryProfile(args, process.env, target.url.origin, teamCatalog(target, signal));
  }
  return parseCommand(args);
}

function containsControlToken(value, token) {
  if (typeof value === "string") return value.includes(token);
  return value !== null && typeof value === "object" && Object.values(value).some(field => containsControlToken(field, token));
}

async function mcpMain(args) {
  if (args.length !== 0) {
    process.stderr.write("Use sandbox-runner mcp without arguments.\n");
    return exit.usage;
  }
  try {
    if (Number(process.versions.node.split(".")[0]) < 24) throw configurationError("Sandbox Runner requires Node.js 24 or later.");
    const config = readConfiguration(process.env);
    const { serveRunnerMcp } = await import("./mcp.mjs");
    serveRunnerMcp(async (argumentsForCommand, signal) => {
      let command;
      let result;
      try {
        signal.throwIfAborted();
        if (argumentsForCommand.type === "profile-create") {
          result = { output: await createProfileFromTemplate(argumentsForCommand.template, argumentsForCommand.input), exitCode: exit.success };
        } else if (argumentsForCommand[0] === "profile") {
          result = { output: await inspectProfiles(argumentsForCommand, process.env, () => teamCatalog(config, signal)), exitCode: exit.success };
        } else {
          command = argumentsForCommand.type === "profile-start"
            ? await resolveProfileStart(argumentsForCommand.envelope, argumentsForCommand.input, process.env, teamCatalog(config, signal))
            : await resolveCommand(argumentsForCommand, config, signal);
          signal.throwIfAborted();
          result = await runCommand(command, config, signal);
        }
      } catch (error) {
        if (signal.aborted) {
          const uncertain = command?.name === "run" || command?.name === "cancel";
          result = commandFailure(new CliError("interrupted", "The MCP request was interrupted.", exit.requestFailure, { uncertain }), command);
        } else {
          result = commandFailure(checkedFailure(error), command);
        }
      }
      if (!containsControlToken(result.output, config.token)) return result;
      const safeCommand = command?.id?.includes(config.token) ? undefined : command;
      const uncertain = command?.name === "run" || command?.name === "cancel";
      return commandFailure(new CliError("invalid_response", "The Worker returned an invalid MCP response.", exit.requestFailure,
        { uncertain }), safeCommand);
    });
    return exit.success;
  } catch {
    process.stderr.write("Could not start Sandbox Runner MCP. Check Node.js, the installation, and the configured Runner URL and control token.\n");
    return exit.configuration;
  }
}

async function main(args) {
  let command;
  const connectorAuth = args[0] === "connector" && args[1] === "login";
  const authorizing = args[0] === "auth" || connectorAuth;
  const authLocale = authorizing ? terminalAuthLocale(process.env) : "en";
  const settingUp = args[0] === "setup" || (agents.has(args[0]) && args[1] === "setup");
  try {
    if (Number(process.versions.node.split(".")[0]) < 24) {
      throw configurationError("Sandbox Runner requires Node.js 24 or later.");
    }
    if (args.length === 1 && args[0] === "--help") {
      return { output: { usage }, exitCode: exit.success };
    }
    if (args[0] === "skill") {
      if (args.length !== 1) throw usageError("Skill does not accept arguments.");
      return {
        markdown: await readFile(new URL("../skills/sandbox-runner/SKILL.md", import.meta.url), "utf8"),
        exitCode: exit.success,
      };
    }
    if (args[0] === "profile") return { output: await inspectProfiles(args, process.env, () => teamCatalog()), exitCode: exit.success };
    if (args[0] === "team") {
      const output = await manageTeam(args.slice(1), (path, options) => requestTeam(path, options, readConfiguration(process.env)));
      return { output, exitCode: exit.success };
    }
    if (args[0] === "cloudflare" && args[1] === "init") {
      return { output: await cloudflareInit(args.slice(2), process.env), exitCode: exit.success };
    }
    if (args[0] === "cloudflare" && args[1] === "setup") {
      return { output: await cloudflareSetup(args.slice(2), process.env), exitCode: exit.success };
    }
    if (args[0] === "cloudflare" && args[1] === "login") {
      return { output: await cloudflareLogin(args.slice(2), process.env), exitCode: exit.success };
    }
    if (args[0] === "cloudflare" && args[1] === "deploy") {
      return { output: await cloudflareDeploy(args.slice(2), process.env), exitCode: exit.success };
    }
    if (args[0] === "cloudflare" && args[1] === "upgrade") {
      return await cloudflareUpgrade(args.slice(2), process.env);
    }
    if (args[0] === "cloudflare" && args[1] === "destroy") {
      return { output: await cloudflareDestroy(args.slice(2), process.env), exitCode: exit.success };
    }
    if (args[0] === "cloudflare" && args[1] === "access") {
      return { output: await cloudflareAccess(args.slice(2), process.env), exitCode: exit.success };
    }
    if (args[0] === "cloudflare" && args[1] === "doctor") {
      return await cloudflareDoctor(args.slice(2), process.env);
    }
    if (args[0] === "cloudflare" && args[1] === "canary") {
      command = parseCanary(args.slice(2));
      return await runCanary(command, readConfiguration(process.env));
    }
    if (args[0] === "auth") {
      const output = await authenticate(args.slice(1), process.env, { CliError, exit, timeout: readTimeout(process.env) });
      if (process.stdin.isTTY && process.stderr.isTTY) {
        process.stderr.write("\n" + authText(authLocale, "Credential configured. Active Worker version verified.") + "\n\n");
      }
      return { output, exitCode: exit.success };
    }
    if (connectorAuth) {
      const { connectorLogin } = await import("./connector-login.mjs");
      const output = await connectorLogin(args.slice(2), process.env, { CliError, exit, timeout: readTimeout(process.env) });
      if (process.stdin.isTTY && process.stderr.isTTY) {
        process.stderr.write("\n" + authText(authLocale, "Connector credential configured. Active Worker version verified.") + "\n\n");
      }
      return { output, exitCode: exit.success };
    }
    if (settingUp) {
      const timeout = readTimeout(process.env);
      const output = args[0] === "setup"
        ? await setupSandboxProvider(args.slice(1), process.env, timeout)
        : await setupAgent(args[0], args.slice(2), process.env, timeout);
      if (process.stdin.isTTY && process.stderr.isTTY) {
        let update = "Auth strategy";
        if (output.model !== undefined || output.effort !== undefined) update = "Claude defaults";
        if (output.sandboxProvider !== undefined) update = "Default sandbox provider";
        process.stderr.write(`\n${update} configured. Active Worker version verified.\n\n`);
      }
      return { output, exitCode: exit.success };
    }
    command = await resolveCommand(args);
    return await runWithConnectorRecovery(command, readConfiguration(process.env));
  } catch (error) {
    const failure = checkedFailure(error);
    if ((authorizing || settingUp) && process.stdin.isTTY && process.stderr.isTTY) {
      process.stderr.write("\n" + authText(authLocale, failure.message) + "\n\n");
    }
    const result = commandFailure(failure, command);
    if (failure.connectorIssue && process.stderr.isTTY) {
      result.hint = connectorIssueHint(failure.connectorIssue, process.env, failure.recovery?.action);
    } else if (failure.issues?.length && process.stderr.isTTY) {
      result.hint = [failure.message, ...failure.issues.map(issue => `  ${issue.field} — ${issue.message}`)].join("\n");
    }
    return result;
  }
}

const args = process.argv.slice(2);
if (args[0] === "mcp") {
  process.exitCode = await mcpMain(args.slice(1));
} else {
  const result = await main(args);
  process.stdout.write(result.markdown ?? JSON.stringify(result.output) + "\n");
  if (result.hint) process.stderr.write(result.hint + "\n");
  process.exitCode = result.exitCode;
}
