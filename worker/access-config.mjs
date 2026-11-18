/**
 * Remote MCP settings: the Cloudflare Access application protecting /mcp and its team domain.
 * `sandbox-runner cloudflare access enable` records them in the project manifest, so every build of the
 * project (CLI deploy or a manual `cf deploy` during a version change) keeps the endpoint without extra
 * environment variables. Explicit environment variables take precedence, for builds outside a project.
 */
export const accessAudPattern = /^[a-f0-9]{64}$/;
export const accessTeamDomainPattern = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

/** @returns {{ aud: string; teamDomain: string } | undefined} */
export function validAccessSettings(value) {
  if (!value || typeof value !== "object") return;
  const { aud, teamDomain } = value;
  if (typeof aud === "string" && accessAudPattern.test(aud) && typeof teamDomain === "string" && accessTeamDomainPattern.test(teamDomain)) {
    return { aud, teamDomain };
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string | undefined} manifestText the project manifest, when the build runs inside a project
 * @returns {{ aud: string; teamDomain: string } | undefined}
 */
export function resolveAccessSettings(env, manifestText) {
  const aud = env.SANDBOX_RUNNER_ACCESS_AUD;
  const teamDomain = env.SANDBOX_RUNNER_ACCESS_TEAM_DOMAIN;
  if (aud !== undefined || teamDomain !== undefined) {
    const settings = validAccessSettings({ aud, teamDomain });
    if (!settings) {
      throw new Error("Set SANDBOX_RUNNER_ACCESS_AUD (64 hex) and SANDBOX_RUNNER_ACCESS_TEAM_DOMAIN (https://<team>.cloudflareaccess.com) together.");
    }
    return settings;
  }
  if (manifestText === undefined) return;
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error("The project manifest is not valid JSON.");
  }
  if (manifest?.access === undefined) return;
  const settings = validAccessSettings(manifest.access);
  if (!settings) throw new Error("The project manifest has invalid Access settings. Run cloudflare access enable again.");
  return settings;
}
