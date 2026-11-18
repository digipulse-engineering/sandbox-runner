import { CliError, exit } from "./cli-errors.mjs";

/**
 * Cloudflare Access service token for clients of an installation whose whole host Access protects.
 * The variable names are the ones Wrangler reads for the same purpose.
 */
export const accessClientIdVariable = "CLOUDFLARE_ACCESS_CLIENT_ID";
export const accessClientSecretVariable = "CLOUDFLARE_ACCESS_CLIENT_SECRET";

const value = /^[A-Za-z0-9._-]{1,256}$/;

/** Headers that present the service token to Access, or none when the variables are unset. */
export function accessServiceHeaders(env = process.env) {
  const id = env[accessClientIdVariable];
  const secret = env[accessClientSecretVariable];
  if (id === undefined && secret === undefined) return {};
  if (typeof id !== "string" || typeof secret !== "string" || !value.test(id) || !value.test(secret)) {
    throw new CliError("configuration_error",
      `Set ${accessClientIdVariable} and ${accessClientSecretVariable} together, to the client ID and secret of an Access service token.`,
      exit.configuration);
  }
  return { "cf-access-client-id": id, "cf-access-client-secret": secret };
}
