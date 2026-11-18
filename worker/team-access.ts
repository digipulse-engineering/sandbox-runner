import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { ProfileError, profileReceipt, profileRevision, validProfileSlug } from "./run-profiles.mjs";
import { accessEmailPattern, object, digest } from "./team-catalog.mjs";
import { operationId } from "./run-input-validation.mjs";
import type { RunProfileReceipt } from "./contract.ts";

export type TeamClient = { id: string; profiles: string[]; tokenSha256: string; accessEmail?: string; readOnly?: true };
export type TeamGrant = { client: Pick<TeamClient, "id" | "profiles" | "readOnly">; catalog: Pick<TeamCatalog, "profiles"> };
export type TeamCatalog = {
  profiles: Record<string, Record<string, unknown>>;
  clients: TeamClient[];
};
const encoder = new TextEncoder();
export const teamCatalogKey = "team-catalog";
// A catalog with a read-only client lives under its own key. Worker versions from before read-only clients read only
// the first key, so after a rollback they find no catalog and refuse every team client instead of letting a
// read-only one write.
export const teamCatalogReadOnlyKey = "team-catalog-read-only";

type CatalogStorage = { get<T>(key: string): Promise<T | undefined> };

/**
 * The stored catalog. Current versions keep exactly one of the two keys. Both exist only after an older version
 * published during a rollback: it wrote the plain key, which is then the newer catalog.
 */
export async function storedCatalog<T>(storage: CatalogStorage): Promise<T | undefined> {
  return await storage.get<T>(teamCatalogKey) ?? await storage.get<T>(teamCatalogReadOnlyKey);
}

/** Where to store a catalog, and which key to clear so only one remains. */
export function catalogStorageKeys(catalog: Pick<TeamCatalog, "clients">): { put: string; delete: string } {
  return catalog.clients.some(client => client.readOnly === true)
    ? { put: teamCatalogReadOnlyKey, delete: teamCatalogKey } : { put: teamCatalogKey, delete: teamCatalogReadOnlyKey };
}

export async function tokenDigest(token: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", encoder.encode(token))).toString("hex");
}

export function sameTokenDigest(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function teamClient(catalog: TeamCatalog, actual: string) {
  if (actual.length !== 64 || !digest.test(actual)) return;
  let client: TeamClient | undefined;
  for (const candidate of catalog.clients) {
    if (sameTokenDigest(actual, candidate.tokenSha256)) client = candidate;
  }
  return client;
}

/** The client an Access-authenticated person acts as. Addresses are stored lowercase. */
export function teamClientByEmail(catalog: TeamCatalog, email: string) {
  // Fold ASCII only: Unicode lowercasing maps characters such as U+212A KELVIN SIGN onto ASCII letters.
  const address = email.replace(/[A-Z]/gu, char => char.toLowerCase());
  if (!accessEmailPattern.test(address)) return;
  return catalog.clients.find(client => client.accessEmail === address);
}

export function allowedRunOwner(clientId: string | undefined, ownerId: string | undefined): boolean {
  return clientId === undefined || clientId === ownerId;
}

export async function teamProfile(catalog: Pick<TeamCatalog, "profiles">, client: Pick<TeamClient, "profiles">, slug: string) {
  if (!client.profiles.includes(slug)) return;
  const profile = catalog.profiles[slug];
  return { slug, profile, revision: await profileRevision(profile) };
}

export class TeamRequestError extends ProfileError {
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(code, message);
    this.status = status;
  }
}

export async function resolveTeamProfile(value: unknown, catalog: Pick<TeamCatalog, "profiles">, client: Pick<TeamClient, "id" | "profiles">) {
  if (!object(value) || value.kind !== "team-profile" || typeof value.profile !== "string" ||
      !validProfileSlug(value.profile) || typeof value.revision !== "string" || value.revision.length !== 64 || !digest.test(value.revision) ||
      (Object.hasOwn(value, "deliveryId") && (typeof value.deliveryId !== "string" ||
        value.deliveryId.length !== 36 || operationId(value.deliveryId) !== value.deliveryId))) {
    throw new TeamRequestError("invalid_profile_request", "Supply a catalog profile, its revision and an optional delivery UUID.", 400);
  }
  const entry = await teamProfile(catalog, client, value.profile);
  if (!entry) throw new TeamRequestError("profile_not_found", "The requested profile is unavailable.", 404);
  if (value.revision !== entry.revision) {
    throw new TeamRequestError("profile_revision_changed", "The published profile revision has changed.", 409);
  }
  const { revision, deliveryId, ...fields } = value;
  const request = { ...fields, kind: "profile", profile: { slug: entry.slug, body: entry.profile } };
  const receipt: RunProfileReceipt = { ...await profileReceipt(request), source: "worker-catalog", clientId: client.id,
    ...(typeof deliveryId === "string" ? { deliveryId } : {}) };
  return { request, receipt };
}
