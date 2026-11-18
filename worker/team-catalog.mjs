import { hasDuplicateJsonKeys } from "./profile-json.mjs";
import { parseProfileConfig, validProfileSlug } from "./run-profiles.mjs";

export const digest = /^[a-f0-9]{64}$/;

/** @returns {value is Record<string, any>} */
export function object(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Lowercase addresses only, so an Access identity matches exactly one client without case folding at request time.
export const accessEmailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** @returns {{ profiles: Record<string, Record<string, unknown>>; clients: { id: string; profiles: string[]; tokenSha256: string; accessEmail?: string; readOnly?: true }[] } | undefined} */
export function parseTeamCatalog(raw) {
  try {
    const value = JSON.parse(raw);
    if (hasDuplicateJsonKeys(raw) || !object(value) || !object(value.clients) ||
        Object.keys(value).some(key => !["schemaVersion", "profiles", "clients"].includes(key))) return;
    const { profiles } = parseProfileConfig({ schemaVersion: value.schemaVersion, profiles: value.profiles });
    if (Object.values(profiles).some(profile =>
      !object(profile) || (profile.kind === "agent" && profile.harness !== "opencode" && profile.authMode === undefined))) return;
    const clients = [];
    const hashes = new Set();
    const emails = new Set();
    for (const [id, client] of Object.entries(value.clients)) {
      if (!validProfileSlug(id) || !object(client) ||
          Object.keys(client).some(key => !["tokenSha256", "profiles", "accessEmail", "readOnly"].includes(key)) ||
          // A read-only client may read its profiles and runs but never start, retry or cancel one.
          (Object.hasOwn(client, "readOnly") && typeof client.readOnly !== "boolean") ||
          (Object.hasOwn(client, "accessEmail") && (typeof client.accessEmail !== "string" || client.accessEmail.length > 254 ||
            !accessEmailPattern.test(client.accessEmail) || emails.has(client.accessEmail))) ||
          typeof client.tokenSha256 !== "string" || client.tokenSha256.length !== 64 || !digest.test(client.tokenSha256) || hashes.has(client.tokenSha256) ||
          !Array.isArray(client.profiles) || new Set(client.profiles).size !== client.profiles.length ||
          !client.profiles.every(slug => validProfileSlug(slug) && Object.hasOwn(profiles, slug))) return;
      hashes.add(client.tokenSha256);
      if (Object.hasOwn(client, "accessEmail")) emails.add(client.accessEmail);
      clients.push({ id, profiles: client.profiles, tokenSha256: client.tokenSha256,
        ...(Object.hasOwn(client, "accessEmail") ? { accessEmail: client.accessEmail } : {}),
        ...(client.readOnly === true ? { readOnly: true } : {}) });
    }
    return { profiles, clients };
  } catch {
    return;
  }
}

