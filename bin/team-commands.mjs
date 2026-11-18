import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { validProfileSlug } from "../worker/run-profiles.mjs";
import { parseTeamCatalog } from "../worker/team-catalog.mjs";
import { CliError, exit } from "./cli-errors.mjs";

const usage = "Use team catalog get, team catalog publish <file> [--revision SHA256], or team denials.";
const validRevision = value => typeof value === "string" && value.length === 64 && /^[0-9a-f]+$/u.test(value);
const catalogPath = "/v4/team/catalog";
const denialsPath = "/v4/team/denials";

function invalidResponse(publish) {
  return new CliError("invalid_response", "The Worker returned an invalid team administration response.", exit.requestFailure,
    { uncertain: publish });
}

function workerFailure(status, publish) {
  const details = { httpStatus: status };
  if (status === 412) {
    return new CliError("team_catalog_revision_changed", "The team catalog changed. Read it again and reconcile before publishing.",
      exit.requestFailure, details);
  }
  if (status === 428) {
    return new CliError("team_catalog_precondition_required", "The Worker rejected the catalog publication precondition.",
      exit.configuration, details);
  }
  if (status === 400 || status === 415) {
    return new CliError("invalid_team_catalog", "The Worker rejected the team catalog.", exit.configuration, details);
  }
  if ([401, 403, 404].includes(status)) {
    return new CliError("not_found", "Check the Worker URL, operator token and support for team administration.", exit.configuration, details);
  }
  return new CliError("team_request_failed", "The Worker could not confirm the team administration request.", exit.requestFailure,
    { ...details, uncertain: publish });
}

function checkedDenials(data) {
  if (!Array.isArray(data?.denials)) return;
  const denials = [];
  for (const item of data.denials) {
    if (!item) return;
    const { clientId, reason, count, lastAt } = item;
    if (!validProfileSlug(clientId) || typeof reason !== "string" || !/^[a-z][a-z_]*$/u.test(reason) ||
        !Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(lastAt) || lastAt <= 0) return;
    denials.push({ clientId, reason, count, lastAt });
  }
  return { denials };
}

async function publication(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, tokens: true, options: { revision: { type: "string" } } });
  } catch {
    throw new CliError("usage_error", usage, exit.usage);
  }
  const { values: { revision }, positionals, tokens } = parsed;
  if (positionals.length !== 1 || tokens.filter(token => token.kind === "option").length > 1 ||
      (revision !== undefined && !validRevision(revision))) {
    throw new CliError("usage_error", usage, exit.usage);
  }
  let body;
  try {
    body = await readFile(positionals[0], { encoding: "utf8" });
  } catch {
    throw new CliError("team_catalog_file_unavailable", "Could not read the team catalog file.", exit.configuration);
  }
  if (!parseTeamCatalog(body)) {
    throw new CliError("invalid_team_catalog", "The file must contain a valid team catalog with hashed client tokens.", exit.configuration);
  }
  return { method: "PUT", body, catalogRevision: revision ?? null };
}

export async function manageTeam(args, request) {
  const [noun, verb, ...rest] = args;
  const publish = noun === "catalog" && verb === "publish";
  const get = noun === "catalog" && verb === "get" && rest.length === 0;
  const denials = noun === "denials" && args.length === 1;
  if (!publish && !get && !denials) throw new CliError("usage_error", usage, exit.usage);
  const options = publish ? await publication(rest) : { method: "GET" };
  const { status, body } = await request(denials ? denialsPath : catalogPath, options);
  if (status !== 200) throw workerFailure(status, publish);
  if (denials) {
    const result = checkedDenials(body);
    if (result) return result;
  } else if (publish && validRevision(body?.revision)) {
    return { revision: body.revision };
  } else if (get && body?.revision === null && body.config === null) {
    return { revision: null, config: null };
  } else if (get && validRevision(body?.revision) && parseTeamCatalog(JSON.stringify(body.config))) {
    return { revision: body.revision, config: body.config };
  }
  throw invalidResponse(publish);
}
