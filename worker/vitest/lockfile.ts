const registryOrigin = "https://registry.npmjs.org";
const strongIntegrity = /^sha512-[A-Za-z0-9+/]{86}==$/;
const packageVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

type NpmLockfile = {
  tarballs: string[];
  workspaces: string[];
  vitestVersion?: string;
};

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function segments(path: string): string[] | undefined {
  const parts = path.split("/");
  if (parts.every(part => part && part !== "." && part !== ".." && !/[\p{Cc}\\]/u.test(part))) return parts;
}

export function registryTarballUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() !== value) return;
  try {
    const url = new URL(value);
    if (url.origin === registryOrigin && !url.username && !url.password && !url.search && !url.hash &&
        url.pathname.endsWith(".tgz")) return url.href;
  } catch {
    // An unsupported source is refused before npm receives network access.
  }
}

export function parseNpmLockfile(text: string, requireVitest: boolean): NpmLockfile | undefined {
  let lockfile;
  try {
    lockfile = object(JSON.parse(text));
  } catch {
    return;
  }
  if (lockfile?.lockfileVersion !== 2 && lockfile?.lockfileVersion !== 3) return;
  const packages = object(lockfile.packages);
  if (!packages || !object(packages[""])) return;
  let vitestVersion;
  if (requireVitest) {
    const vitest = object(packages["node_modules/vitest"]);
    if (typeof vitest?.version !== "string" || vitest.version.trim() !== vitest.version || !packageVersion.test(vitest.version) ||
        !registryTarballUrl(vitest.resolved)) return;
    vitestVersion = vitest.version;
  }

  const tarballs = new Set<string>();
  const workspaces = new Set<string>();
  for (const [path, metadata] of Object.entries(packages)) {
    if (!path) continue;
    const pkg = object(metadata);
    const parts = segments(path);
    if (!pkg || !parts) return;
    if (pkg.link === true) {
      const target = pkg.resolved;
      if (typeof target !== "string" || target.includes(":") || !segments(target) || !Object.hasOwn(packages, target) ||
          target.split("/").includes("node_modules") || !parts.includes("node_modules")) return;
      workspaces.add(target);
    } else if (!parts.includes("node_modules")) {
      if (pkg.resolved !== undefined) return;
      workspaces.add(path);
    } else if (pkg.inBundle === true && pkg.resolved === undefined) {
      // The parent tarball's integrity covers bundled dependencies.
      continue;
    } else {
      const tarball = registryTarballUrl(pkg.resolved);
      if (!tarball || typeof pkg.integrity !== "string" || !pkg.integrity.split(/\s+/).some(value => strongIntegrity.test(value))) return;
      tarballs.add(tarball);
    }
  }
  return { tarballs: [...tarballs], workspaces: [...workspaces], ...(vitestVersion === undefined ? {} : { vitestVersion }) };
}
