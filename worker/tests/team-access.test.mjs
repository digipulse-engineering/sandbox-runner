import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedRunOwner, resolveTeamProfile, teamClient, teamProfile, tokenDigest } from "../team-access.ts";
import { parseTeamCatalog } from "../team-catalog.mjs";
import { sameProfileRequest } from "../contract.ts";

const profile = { kind: "agent", operation: "review", harness: "codex", authMode: "subscription",
  defaults: { repo: "example/repository" }, mcp: { connectors: ["github"] } };
const token = "a".repeat(64);
const tokenSha256 = await tokenDigest(token);
const team = { schemaVersion: 1, profiles: { reviewer: profile,
  executor: { ...profile, operation: "start", harness: "claude", authMode: "api-key", publish: true } },
  clients: { "lead-product": { tokenSha256, profiles: ["reviewer"] },
    "lead-engineering": { tokenSha256: await tokenDigest("b".repeat(64)), profiles: ["reviewer", "executor"] } } };

test("validates a catalog as one authorization snapshot", () => {
  const catalog = parseTeamCatalog(JSON.stringify(team));
  assert.equal(teamClient(catalog, tokenSha256).id, "lead-product");
  assert.equal(teamClient(catalog, "0".repeat(64)), undefined);
  assert.equal(parseTeamCatalog(JSON.stringify({ ...team, schemaVersion: 2 })), undefined);
  assert.equal(parseTeamCatalog(JSON.stringify({ ...team, profiles: { ...team.profiles,
    reviewer: { ...profile, authMode: undefined } } })), undefined);
  for (const grant of [
    { tokenSha256: tokenSha256 + "\n", profiles: ["reviewer"] },
    { tokenSha256, profiles: ["reviewer", "reviewer"] },
    { tokenSha256, profiles: ["missing"] },
    { tokenSha256: team.clients["lead-engineering"].tokenSha256, profiles: ["reviewer"] },
  ]) {
    assert.equal(parseTeamCatalog(JSON.stringify({ ...team, clients: { ...team.clients, "lead-product": grant } })), undefined);
  }
  assert.equal(parseTeamCatalog('{"schemaVersion":1,"profiles":{},"clients":{},"clients":{}}'), undefined);
});

test("binds team admission to the authorized revision, client and delivery", async () => {
  const catalog = parseTeamCatalog(JSON.stringify(team));
  const [product, engineering] = catalog.clients;
  const entry = await teamProfile(catalog, product, "reviewer");
  const executor = await teamProfile(catalog, engineering, "executor");
  const input = { kind: "team-profile", profile: entry.slug, revision: entry.revision, operationId: crypto.randomUUID(),
    source: { sha: "a".repeat(40) }, prompt: "Review", producerAgent: "claude", deliveryId: crypto.randomUUID() };
  const { request, receipt } = await resolveTeamProfile(input, catalog, product);
  assert.deepEqual(request.profile.body, profile);
  assert.equal(receipt.clientId, product.id);
  assert.equal(receipt.source, "worker-catalog");
  assert.equal(receipt.deliveryId, input.deliveryId);
  const other = (await resolveTeamProfile(input, catalog, engineering)).receipt;
  assert.equal(other.requestDigest, receipt.requestDigest);
  assert.equal(sameProfileRequest(receipt, other), false);
  assert.equal(sameProfileRequest(receipt, { ...receipt, deliveryId: crypto.randomUUID() }), false);
  assert.equal(allowedRunOwner(product.id, undefined), false);
  assert.equal(allowedRunOwner(product.id, engineering.id), false);
  assert.equal(allowedRunOwner(product.id, product.id), true);
  assert.equal(allowedRunOwner(undefined, product.id), true);
  await assert.rejects(resolveTeamProfile({ ...input, profile: executor.slug, revision: executor.revision }, catalog, product),
    { code: "profile_not_found", status: 404 });
  await assert.rejects(resolveTeamProfile({ ...input, revision: "0".repeat(64) }, catalog, product),
    { code: "profile_revision_changed", status: 409 });
  await assert.rejects(resolveTeamProfile({ ...input, authMode: "api-key" }, catalog, product), { code: "invalid_profile_inputs" });
  await assert.rejects(resolveTeamProfile({ ...input, clientId: engineering.id }, catalog, product), { code: "invalid_profile_inputs" });
});

test("reports input issues only after authorizing the team and exact profile revision", async () => {
  const catalog = parseTeamCatalog(JSON.stringify(team));
  const [product, engineering] = catalog.clients;
  const entry = await teamProfile(catalog, product, "reviewer");
  const executor = await teamProfile(catalog, engineering, "executor");
  const input = { kind: "team-profile", profile: entry.slug, revision: entry.revision, operationId: crypto.randomUUID(),
    source: { ref: "refs/heads/main" }, overrides: { effort: "unauthorized" } };
  const check = (code, status) => error => error.code === code && error.status === status && error.issues === undefined;
  await assert.rejects(resolveTeamProfile({ ...input, profile: executor.slug, revision: executor.revision }, catalog, product),
    check("profile_not_found", 404));
  await assert.rejects(resolveTeamProfile({ ...input, revision: "0".repeat(64) }, catalog, product),
    check("profile_revision_changed", 409));
  await assert.rejects(resolveTeamProfile(input, catalog, product), error => {
    assert.equal(error.code, "invalid_profile_inputs");
    assert.deepEqual(error.issues.map(({ field, code }) => [field, code]), [
      ["source", "exact_sha_required"], ["prompt", "required"], ["producerAgent", "required"],
      ["overrides.effort", "override_not_allowed"],
    ]);
    return true;
  });
});

test("a client can be marked read-only, and only with a boolean", () => {
  const readOnly = { ...team, clients: { ...team.clients, "lead-product": { tokenSha256, profiles: ["reviewer"], readOnly: true } } };
  assert.equal(teamClient(parseTeamCatalog(JSON.stringify(readOnly)), tokenSha256).readOnly, true);
  const explicit = { ...team, clients: { ...team.clients, "lead-product": { tokenSha256, profiles: ["reviewer"], readOnly: false } } };
  assert.equal(teamClient(parseTeamCatalog(JSON.stringify(explicit)), tokenSha256).readOnly, undefined);
  assert.equal(teamClient(parseTeamCatalog(JSON.stringify(team)), tokenSha256).readOnly, undefined);
  for (const value of ["true", 1, null]) {
    assert.equal(parseTeamCatalog(JSON.stringify({ ...team, clients: { ...team.clients,
      "lead-product": { tokenSha256, profiles: ["reviewer"], readOnly: value } } })), undefined);
  }
});

test("a read-only catalog uses its own key, and the plain key wins when an older version wrote it", async () => {
  const { catalogStorageKeys, storedCatalog, teamCatalogKey, teamCatalogReadOnlyKey } = await import("../team-access.ts");
  assert.deepEqual(catalogStorageKeys({ clients: [{ readOnly: true }, {}] }), { put: teamCatalogReadOnlyKey, delete: teamCatalogKey });
  assert.deepEqual(catalogStorageKeys({ clients: [{}] }), { put: teamCatalogKey, delete: teamCatalogReadOnlyKey });
  const storage = values => ({ get: async key => values[key] });
  assert.equal(await storedCatalog(storage({ [teamCatalogReadOnlyKey]: "read-only" })), "read-only");
  assert.equal(await storedCatalog(storage({ [teamCatalogKey]: "rolled-back", [teamCatalogReadOnlyKey]: "read-only" })), "rolled-back");
  assert.equal(await storedCatalog(storage({})), undefined);
});
