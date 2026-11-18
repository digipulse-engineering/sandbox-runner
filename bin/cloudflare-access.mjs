import { mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { accessClientIdVariable, accessClientSecretVariable } from "./access-service-token.mjs";
import { parseArgs, parseEnv } from "node:util";
import { cfCommand, signals } from "./auth.mjs";
import { CliError, exit, readTimeout } from "./cli-errors.mjs";
import { cloudflareProjectTarget, manifestName } from "./cloudflare-project.mjs";
import { accessEmailPattern } from "../worker/team-catalog.mjs";
import { validAccessSettings } from "../worker/access-config.mjs";

// A Cloudflare Access application with managed OAuth protects the Worker's workers.dev host. Access signs people in
// and issues MCP client tokens; the Worker maps the verified email to a team client. Machine clients (the CLI, the
// stdio MCP server, automation) present an Access service token, then their runner token as before.

const usage = "Use cloudflare access enable [DIRECTORY] --url https://WORKER.SUBDOMAIN.workers.dev --email ADDRESS " +
  "[--email ADDRESS ...] [--redirect-uri URI ...] [--web-clients-only] [--service-token-file FILE] [--service-token-ip CIDR ...] [--scope host|mcp] [--dry-run], " +
  "cloudflare access status [DIRECTORY] or cloudflare access disable [DIRECTORY].";
// "host" (the default) puts the whole workers.dev host behind Access, so unauthenticated traffic never reaches the
// Worker. "mcp" protects only /mcp and leaves the other routes to runner tokens alone; it exists for installations
// whose clients cannot present a service token yet.
const scopes = ["host", "mcp"];
// Web clients that call back to their own site. Native clients (Claude Code, Codex) use loopback redirects instead.
const defaultRedirects = ["https://chatgpt.com/*", "https://claude.ai/*"];
// Cloudflare recommends a short access token with a grant of one to two weeks for agents: the client refreshes
// silently and Access re-evaluates its policy on every refresh.
const grant = { access_token_lifetime: "15m", session_duration: "336h" };
const applicationId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

function configurationFailure(code, message) {
  return new CliError(code, message, exit.configuration);
}

function accessOptions(args) {
  try {
    const parsed = parseArgs({ args, tokens: true, allowPositionals: true, options: {
      url: { type: "string" }, email: { type: "string", multiple: true }, "redirect-uri": { type: "string", multiple: true },
      "dry-run": { type: "boolean" }, scope: { type: "string" }, "service-token-file": { type: "string" },
      "service-token-ip": { type: "string", multiple: true }, "web-clients-only": { type: "boolean" },
    } });
    const [action, directory = ".", ...extra] = parsed.positionals;
    const single = parsed.tokens.filter(token => token.kind === "option" && !["email", "redirect-uri", "service-token-ip"].includes(token.name))
      .map(token => token.name);
    if (!["enable", "status", "disable"].includes(action) || extra.length || directory === "" || new Set(single).size !== single.length) {
      throw new Error();
    }
    const { url, email, "redirect-uri": redirects, "dry-run": dryRun, scope, "service-token-file": tokenFile,
      "service-token-ip": ips, "web-clients-only": webOnly } = parsed.values;
    if (action !== "enable" && (url !== undefined || email !== undefined || redirects !== undefined || dryRun !== undefined ||
        parsed.values.scope !== undefined || tokenFile !== undefined || ips !== undefined || webOnly !== undefined)) throw new Error();
    if (action === "enable" && (url === undefined || email === undefined || (scope !== undefined && !scopes.includes(scope)) ||
        tokenFile === "")) throw new Error();
    return { action, directory, url, emails: email, redirects: redirects ?? defaultRedirects, dryRun: dryRun === true, scope,
      serviceTokenFile: tokenFile === undefined ? undefined : resolve(tokenFile), serviceTokenIps: ips, nativeClients: webOnly !== true };
  } catch {
    throw new CliError("usage_error", usage, exit.usage);
  }
}

/** The Worker's own workers.dev origin; the Access application covers only its /mcp path. */
function workerHostname(url, worker) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const parts = parsed?.hostname.split(".") ?? [];
  if (!parsed || parsed.protocol !== "https:" || parsed.port || parsed.origin !== url.replace(/\/$/, "") || parts.length !== 4 ||
      parts[0] !== worker.toLowerCase() || !label.test(parts[1]) || parts.slice(2).join(".") !== "workers.dev") {
    throw configurationFailure("cloudflare_access_url_invalid",
      `Pass --url with this Worker's workers.dev origin, https://${worker.toLowerCase()}.<subdomain>.workers.dev, as printed by deploy.`);
  }
  return parsed.hostname;
}

function checkEmails(emails) {
  if (emails.length === 0 || new Set(emails).size !== emails.length || !emails.every(email => accessEmailPattern.test(email))) {
    throw configurationFailure("cloudflare_access_email_invalid",
      "Pass each member address once with --email, in lowercase. The same addresses go in the team catalog as accessEmail.");
  }
}

/** One address or range in CIDR notation, normalized so reruns compare equal; undefined when not a usable range. */
function cidr(value) {
  if (typeof value !== "string") return;
  const [address, prefix, ...rest] = value.split("/");
  const family = isIP(address ?? "");
  if (rest.length || !family || address.includes("%") || (prefix !== undefined && !/^[0-9]{1,3}$/.test(prefix))) return;
  const width = family === 4 ? 32 : 128;
  const bits = prefix === undefined ? width : Number(prefix);
  // /0 admits every address, which would silently remove the restriction.
  if (bits < 1 || bits > width) return;
  let value128;
  if (family === 4) {
    value128 = address.split(".").reduce((sum, part) => (sum << 8n) + BigInt(Number(part)), 0n);
  } else {
    const host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const [head, tail] = host.includes("::") ? host.split("::") : [host, undefined];
    const first = head ? head.split(":") : [];
    const last = tail ? tail.split(":") : [];
    const groups = tail === undefined ? first : [...first, ...Array(8 - first.length - last.length).fill("0"), ...last];
    if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return;
    value128 = groups.reduce((sum, group) => (sum << 16n) + BigInt(parseInt(group, 16)), 0n);
    // An IPv4-mapped address never matches an IPv4 client; pass the IPv4 address itself.
    if (value128 >> 32n === 0xffffn) return;
  }
  // The address must be the network address of its range, so one range has one spelling.
  if (value128 & ((1n << BigInt(width - bits)) - 1n)) return;
  const canonical = family === 4 ? address : new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return `${canonical}/${bits}`;
}

function checkIps(ips) {
  const normalized = Array.isArray(ips) ? ips.map(cidr) : [];
  if (normalized.length === 0 || normalized.some(value => value === undefined) || new Set(normalized).size !== normalized.length) {
    throw configurationFailure("cloudflare_access_ip_invalid",
      "Pass each client address or range once with --service-token-ip: an IPv4 or IPv6 address, or a CIDR range given by its " +
      "network address. /0 ranges and IPv4-mapped IPv6 addresses are refused.");
  }
  return normalized;
}

function recordedIps(ips) {
  try {
    return checkIps(ips).every((range, index) => range === ips[index]);
  } catch {
    return false;
  }
}

function checkRedirects(redirects) {
  const valid = uri => {
    const base = uri.endsWith("/*") ? uri.slice(0, -1) : uri;
    if (base.includes("*")) return false;
    try {
      const parsed = new URL(base);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash && !parsed.search && !parsed.port;
    } catch {
      return false;
    }
  };
  if (redirects.length === 0 || new Set(redirects).size !== redirects.length || !redirects.every(valid)) {
    throw configurationFailure("cloudflare_access_redirect_invalid",
      "Pass https redirect URIs with --redirect-uri, optionally ending in /* (for example https://chatgpt.com/*).");
  }
}

/** cf prints list results after a result_info line; single objects are plain JSON. */
function parseCf(stdout) {
  const text = String(stdout);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/^[[{]/m);
    if (start < 0) throw new Error("cf returned no JSON");
    return JSON.parse(text.slice(start));
  }
}

const serviceTokenId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const memberPolicyName = worker => `Sandbox Runner MCP members (${worker})`;
const clientPolicyName = worker => `Sandbox Runner clients (${worker})`;
const serviceTokenName = worker => `Sandbox Runner clients (${worker})`;

const tokenPageSize = 50;

/** Every Access service token of the account, across pages. */
async function allServiceTokens(read) {
  const tokens = [];
  for (let page = 1; ; page++) {
    const listed = await read("zero-trust", "access", "service-tokens", "list", "--page", String(page), "--per-page", String(tokenPageSize));
    if (!Array.isArray(listed)) throw new Error("unexpected service token listing");
    tokens.push(...listed);
    if (listed.length < tokenPageSize) return tokens;
  }
}

function applicationBody(worker, domain, emails, redirects, tokenId, ips, nativeClients = true) {
  return {
    type: "self_hosted",
    name: `Sandbox Runner MCP (${worker})`,
    domain,
    session_duration: "24h",
    app_launcher_visible: false,
    policies: [
      { name: memberPolicyName(worker), decision: "allow", include: emails.map(email => ({ email: { email } })) },
      // Service Auth: the request carries the token's client ID and secret instead of a person's sign-in. With addresses,
      // one policy per range requires the token and that source, so a leaked token is useless from anywhere else.
      ...(tokenId === undefined ? [] : ips === undefined ? [{ name: clientPolicyName(worker), decision: "non_identity",
        include: [{ service_token: { token_id: tokenId } }] }]
        : ips.map(range => ({ name: `${clientPolicyName(worker)} from ${range}`, decision: "non_identity",
          include: [{ service_token: { token_id: tokenId } }], require: [{ ip: { ip: range } }] }))),
    ],
    oauth_configuration: {
      enabled: true,
      // Native clients such as Claude Code and Codex register a loopback redirect on a port chosen at sign-in
      // (RFC 8252, section 7.3). The member policy still decides who can sign in.
      dynamic_client_registration: { enabled: true, allowed_uris: redirects,
        allow_any_on_localhost: nativeClients, allow_any_on_loopback: nativeClients },
      grant,
    },
  };
}

const readOnlyFields = ["id", "uid", "aud", "created_at", "updated_at", "policies"];

function mergedBody(existing, body, worker) {
  // Cloudflare derives domain, self_hosted_domains and destinations from one another. When the scope changes, keeping
  // the old lists would send both the old and the new path.
  const moved = existing.domain !== body.domain;
  const kept = Object.fromEntries(Object.entries(existing).filter(([key]) => !readOnlyFields.includes(key) &&
    !(moved && (key === "destinations" || key === "self_hosted_domains"))));
  // Every policy this command names for the worker is replaced, including client policies for ranges no longer passed.
  const ours = policy => body.policies.some(owned => owned.name === policy?.name) ||
    (typeof policy?.name === "string" && (policy.name === clientPolicyName(worker) ||
      (policy.name.startsWith(`${clientPolicyName(worker)} from `) && cidr(policy.name.slice(`${clientPolicyName(worker)} from `.length)) !== undefined)));
  const otherPolicies = (existing.policies ?? []).filter(policy => !ours(policy) && typeof policy?.id === "string")
    .map(policy => ({ id: policy.id, ...(policy.precedence === undefined ? {} : { precedence: policy.precedence }) }));
  return { ...kept, ...body, policies: [...body.policies, ...otherPolicies],
    oauth_configuration: { ...existing.oauth_configuration, ...body.oauth_configuration } };
}

function protects(application, domain) {
  const domains = [application?.domain, ...(application?.self_hosted_domains ?? []),
    ...(application?.destinations ?? []).map(destination => destination?.uri)];
  return domains.some(value => typeof value === "string" && value.toLowerCase() === domain);
}

async function readManifest(directory) {
  const path = join(directory, manifestName);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  return { path, manifest };
}

// Replace the manifest atomically so an interrupted write never leaves it truncated.
async function writeManifest(path, manifest) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function cloudflareAccess(args, env) {
  const options = accessOptions(args);
  const target = await cloudflareProjectTarget(options.directory, env);
  const { path, manifest } = await readManifest(target.directory);
  const recorded = manifest.access;
  if (recorded !== undefined && (!validAccessSettings(recorded) || !applicationId.test(recorded.appId ?? "") ||
      (recorded.scope !== undefined && !scopes.includes(recorded.scope)) ||
      (recorded.serviceTokenId !== undefined && !serviceTokenId.test(recorded.serviceTokenId)) ||
      (recorded.serviceTokenIps !== undefined && !recordedIps(recorded.serviceTokenIps)))) {
    throw configurationFailure("cloudflare_access_manifest_invalid", "The project manifest has invalid Access settings. Restore it or remove its access block.");
  }
  // A rerun keeps the recorded scope; a new application protects the whole host.
  if (options.action === "enable") options.scope ??= recorded?.scope ?? (recorded === undefined ? "host" : "mcp");
  let domain;
  let hostname;
  if (options.action === "enable") {
    hostname = workerHostname(options.url, target.worker);
    domain = options.scope === "host" ? hostname : hostname + "/mcp";
    checkEmails(options.emails);
    checkRedirects(options.redirects);
    if (options.serviceTokenIps !== undefined) options.serviceTokenIps = checkIps(options.serviceTokenIps);
    if (options.serviceTokenFile !== undefined && options.scope !== "host") {
      throw configurationFailure("cloudflare_access_service_token_scope",
        "A service token is for clients of a Worker that Access protects entirely: pass it with --scope host.");
    }
  }

  const timeout = readTimeout(env);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new CliError("interrupted", "The Cloudflare Access command was interrupted.", exit.requestFailure));
  const scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-cloudflare-access-"));
  for (const name of signals) process.on(name, interrupt);
  try {
    const cf = cfCommand(target, scratch, env, { signal: controller.signal, timeout,
      onTimeout: () => new CliError("timeout", "The Cloudflare command timed out.", exit.timeout) });
    const read = async (...commandArgs) => parseCf(await cf(...commandArgs));
    const checked = async (step, code, message) => {
      try {
        controller.signal.throwIfAborted();
        return await step();
      } catch (error) {
        controller.signal.throwIfAborted();
        if (error instanceof CliError) throw error;
        throw configurationFailure(code, message);
      }
    };
    await checked(async () => {
      const account = await read("accounts", "get");
      if (account?.id?.toLowerCase() !== target.account) throw new Error();
    }, "cloudflare_account_unverified", "Could not verify the project's Cloudflare account. Run cloudflare login first.");
    const applications = await checked(() => read("zero-trust", "access", "applications", "list"), "cloudflare_access_list_failed",
      "Could not list Access applications. Nothing was changed.");
    const listed = Array.isArray(applications) ? applications : [];
    const generatedName = `Sandbox Runner MCP (${target.worker})`;
    const existing = recorded === undefined ? undefined : listed.find(application => application?.id === recorded.appId);

    if (options.action === "status") {
      // Missing only when the listing succeeds without it; a failed read is unknown, not missing.
      const token = recorded?.serviceTokenId === undefined ? undefined
        : await allServiceTokens(read).then(
          tokens => tokens.find(candidate => candidate?.id === recorded.serviceTokenId) ?? null, () => "unknown");
      return { status: recorded === undefined ? "disabled" : existing ? "enabled" : "application_missing",
        ...(recorded === undefined ? {} : { appId: recorded.appId, aud: recorded.aud, teamDomain: recorded.teamDomain, mcpUrl: recorded.mcpUrl,
          scope: recorded.scope ?? "mcp" }),
        ...(existing ? { oauth: existing.oauth_configuration?.enabled === true, domain: existing.domain } : {}),
        ...(recorded?.serviceTokenIps === undefined ? {} : { serviceTokenIps: recorded.serviceTokenIps,
          // The binding holds only while the organization keeps strict service token authentication on.
          addressBindingEffective: await read("zero-trust", "organization", "get").then(
            organization => organization?.strict_service_token_auth === true, () => "unknown") }),
        ...(token === undefined ? {} : { serviceToken: token === "unknown" ? { id: recorded.serviceTokenId, status: "unknown" }
          : token ? { id: recorded.serviceTokenId, expiresAt: token.expires_at ?? null }
          : { id: recorded.serviceTokenId, status: "missing" } }) };
    }

    if (options.action === "disable") {
      if (recorded === undefined) return { status: "disabled", changed: false };
      if (existing) {
        // Delete only the application this project created: same audience, protecting this Worker's /mcp.
        let host;
        try {
          host = new URL(recorded.mcpUrl).hostname;
        } catch {
          host = "";
        }
        const recordedDomain = recorded.scope === "host" ? host : host + "/mcp";
        if (existing.aud !== recorded.aud || host.split(".")[0] !== target.worker.toLowerCase() || !protects(existing, recordedDomain)) {
          throw configurationFailure("cloudflare_access_conflict",
            `The recorded Access application ${recorded.appId} does not match this project. Nothing was deleted.`);
        }
        await checked(() => cf("zero-trust", "access", "applications", "delete", recorded.appId, "--force"),
          "cloudflare_access_delete_failed", "Could not delete the Access application. Check it in Zero Trust before retrying.");
      }
      if (recorded.serviceTokenId !== undefined) {
        // The token served only this application's clients. One already gone counts as deleted.
        const tokens = await checked(() => allServiceTokens(read), "cloudflare_access_list_failed",
          "Could not list Access service tokens. The application is deleted; rerun disable to finish.");
        if (tokens.some(token => token?.id === recorded.serviceTokenId)) {
          await checked(() => cf("zero-trust", "access", "service-tokens", "delete", recorded.serviceTokenId, "--force"),
            "cloudflare_access_delete_failed", `Could not delete the service token ${recorded.serviceTokenId}. Rerun disable to retry.`);
        }
      }
      const { access: _removed, ...rest } = manifest;
      await writeManifest(path, rest);
      return { status: "disabled", changed: true, appId: recorded.appId,
        next: "Run cloudflare upgrade to remove the /mcp settings from the Worker. Until then /mcp answers 404." };
    }

    const organization = await checked(() => read("zero-trust", "organization", "get"), "cloudflare_access_organization_missing",
      "This account has no Zero Trust organization. Create one in the Cloudflare dashboard (Zero Trust, free plan) and retry.");
    const teamDomain = `https://${organization?.auth_domain ?? ""}`;
    if ((options.serviceTokenIps ?? recorded?.serviceTokenIps) !== undefined && organization?.strict_service_token_auth !== true) {
      // Without strict service token authentication, Access answers a token request with a session cookie that works from
      // any address, so binding the token to addresses would not hold.
      throw configurationFailure("cloudflare_access_strict_service_tokens_off",
        "--service-token-ip needs strict service token authentication on the Zero Trust organization (Access settings). " +
        "Enable it, then rerun.");
    }
    if (!validAccessSettings({ aud: "0".repeat(64), teamDomain })) {
      throw configurationFailure("cloudflare_access_organization_missing", "Could not read the Zero Trust team domain.");
    }
    // A create whose result was lost leaves an application this command named; adopt it rather than duplicate it.
    const current = existing ?? (recorded === undefined
      ? listed.find(application => application?.name === generatedName && protects(application, domain)) : undefined);
    const taken = listed.find(application => protects(application, domain) && application.id !== current?.id);
    if (taken) {
      throw configurationFailure("cloudflare_access_conflict",
        `The Access application ${taken.id} already protects ${domain}. Remove it or record it before enabling.`);
    }
    // The recorded application may change scope in place: it keeps its ID, audience and OAuth clients. An application
    // adopted by name must already protect the requested domain.
    if (current && current !== existing && !protects(current, domain)) {
      throw configurationFailure("cloudflare_access_conflict",
        `The Access application ${current.id} protects another path. Run cloudflare access disable first.`);
    }
    // The service token for machine clients: the recorded one, or a new one written once to --service-token-file.
    let tokenId = recorded?.serviceTokenId;
    if (tokenId !== undefined && options.scope !== "host") {
      throw configurationFailure("cloudflare_access_service_token_scope",
        "This installation has a service token for its clients; keep --scope host, or run cloudflare access disable first.");
    }
    // Without a record, a token of this project's name is adopted only when --service-token-file already holds its
    // credentials: that is the state a run leaves when it created the token but could not save the application.
    let createToken = false;
    if (tokenId === undefined && options.serviceTokenFile !== undefined) {
      const tokens = await checked(() => allServiceTokens(read), "cloudflare_access_list_failed",
        "Could not list Access service tokens. Nothing was changed.");
      const named = tokens.find(token => token?.name === serviceTokenName(target.worker));
      const saved = await readFile(options.serviceTokenFile, "utf8").then(text => parseEnv(text), () => undefined);
      if (named && saved?.[accessClientIdVariable] !== undefined && saved[accessClientIdVariable] === named.client_id) {
        tokenId = named.id;
      } else if (named) {
        throw configurationFailure("cloudflare_access_conflict",
          `A service token named "${serviceTokenName(target.worker)}" already exists (${named.id}) and --service-token-file does not hold it. ` +
          "Delete it in Zero Trust, or pass the file written when it was created.");
      } else if (saved !== undefined) {
        throw configurationFailure("cloudflare_access_service_token_file_exists",
          "The --service-token-file already exists. Choose a new path: the command writes the new token's secret there once.");
      } else {
        createToken = true;
      }
    }
    // Addresses passed now replace the recorded ones; without the option a rerun keeps them.
    const ips = options.serviceTokenIps ?? recorded?.serviceTokenIps;
    if (ips !== undefined && tokenId === undefined && !createToken) {
      throw configurationFailure("cloudflare_access_service_token_missing",
        "--service-token-ip restricts the installation's service token: pass --service-token-file to create one.");
    }
    const planned = applicationBody(target.worker, domain, options.emails, options.redirects,
      createToken ? "00000000-0000-0000-0000-000000000000" : tokenId, ips, options.nativeClients);
    const mcpUrl = `https://${hostname}/mcp`;
    if (options.dryRun) {
      return { status: "dry_run", action: current ? "update" : "create", ...(current ? { appId: current.id } : {}), teamDomain, mcpUrl,
        scope: options.scope, ...(createToken ? { serviceToken: "create" } : tokenId ? { serviceToken: tokenId } : {}),
        ...(ips === undefined ? {} : { serviceTokenIps: ips }), application: current ? mergedBody(current, planned, target.worker) : planned };
    }
    if (createToken) {
      // Claim the file before creating the token, so a path that cannot be written never leaves an unreachable token.
      let file;
      try {
        file = await open(options.serviceTokenFile, "wx", 0o600);
      } catch {
        throw configurationFailure("cloudflare_access_service_token_file_exists",
          "Could not create the --service-token-file. Choose a new path in an existing directory.");
      }
      let created;
      try {
        controller.signal.throwIfAborted();
        created = await read("zero-trust", "access", "service-tokens", "create", "--body", JSON.stringify({ name: serviceTokenName(target.worker) }));
      } catch {
        await file.close();
        await rm(options.serviceTokenFile, { force: true });
        throw new CliError("cloudflare_access_unconfirmed",
          `The service token could not be confirmed. Check for "${serviceTokenName(target.worker)}" in Zero Trust and delete it before retrying.`,
          exit.requestFailure, { uncertain: true });
      }
      if (!serviceTokenId.test(created?.id ?? "") || typeof created.client_id !== "string" || typeof created.client_secret !== "string") {
        await file.close();
        await rm(options.serviceTokenFile, { force: true });
        throw new CliError("cloudflare_access_unconfirmed", "Cloudflare answered without the service token. Check Zero Trust before retrying.",
          exit.requestFailure, { uncertain: true });
      }
      try {
        await file.writeFile(`${accessClientIdVariable}=${created.client_id}\n${accessClientSecretVariable}=${created.client_secret}\n`);
      } catch {
        await file.close().catch(() => {});
        await rm(options.serviceTokenFile, { force: true });
        throw new CliError("cloudflare_access_service_token_unwritten",
          `The service token ${created.id} was created but its secret could not be written. Delete it in Zero Trust and retry.`,
          exit.configuration, { uncertain: true });
      }
      await file.close();
      tokenId = created.id;
    }
    const fresh = applicationBody(target.worker, domain, options.emails, options.redirects, tokenId, ips, options.nativeClients);
    const body = current ? mergedBody(current, fresh, target.worker) : fresh;
    let saved;
    try {
      controller.signal.throwIfAborted();
      saved = current ? await read("zero-trust", "access", "applications", "update", current.id, "--body", JSON.stringify(body))
        : await read("zero-trust", "access", "applications", "create", "--body", JSON.stringify(body));
    } catch {
      // The write may have landed. Rerunning enable adopts an application created under this name.
      throw new CliError("cloudflare_access_unconfirmed", "The Access application write could not be confirmed. Rerun enable to reconcile it.",
        exit.requestFailure, { uncertain: true });
    }
    const settings = validAccessSettings({ aud: saved?.aud, teamDomain });
    if (!settings || !applicationId.test(saved?.id ?? "") || saved?.oauth_configuration?.enabled !== true) {
      throw new CliError("cloudflare_access_unconfirmed",
        "Cloudflare answered without the expected application. Check Zero Trust before retrying.", exit.requestFailure, { uncertain: true });
    }
    const access = { appId: saved.id, aud: settings.aud, teamDomain, mcpUrl, scope: options.scope,
      ...(tokenId === undefined ? {} : { serviceTokenId: tokenId }), ...(ips === undefined ? {} : { serviceTokenIps: ips }) };
    try {
      await writeManifest(path, { ...manifest, access });
    } catch {
      throw new CliError("cloudflare_access_manifest_unwritten",
        "The Access application was saved but the project manifest could not be updated. Rerun enable to record it.",
        exit.configuration, { uncertain: true, ...access });
    }
    return {
      status: "enabled", action: current ? "updated" : "created", appId: saved.id, aud: settings.aud, teamDomain, mcpUrl,
      scope: options.scope, ...(tokenId === undefined ? {} : { serviceTokenId: tokenId }), ...(ips === undefined ? {} : { serviceTokenIps: ips }),
      next: [
        ...(createToken ? [`Give machine clients the variables in ${options.serviceTokenFile}; keep that file private.`] : []),
        ...(options.scope === "host" && tokenId === undefined ? ["Access now blocks every client without a sign-in. If the CLI, " +
          "the stdio MCP server or automation call this workers.dev host, rerun with --service-token-file."] : []),
        "Add each member's lowercase address as accessEmail on their client in the team catalog and publish it.",
        "Deploy the project: a first deployment with cloudflare deploy, or cloudflare upgrade for a running installation.",
        `Then add ${mcpUrl} as an OAuth MCP connector in the client.`,
      ],
    };
  } finally {
    try {
      await rm(scratch, { recursive: true, force: true });
    } finally {
      for (const name of signals) process.removeListener(name, interrupt);
    }
  }
}
