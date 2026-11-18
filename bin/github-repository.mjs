function validGitReference(ref) {
  return typeof ref === "string" && ref.isWellFormed() && /^(?:refs\/heads|refs\/tags)\//u.test(ref) &&
    !/[\u0000-\u0020\u007f~^:?*\[\\]/u.test(ref) && !ref.includes("..") && !ref.includes("@{") && !ref.endsWith(".") &&
    ref.split("/").every(part => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function parseRepositoryRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) return;
  const { slug, sha, ref } = value;
  if (typeof slug !== "string" || slug.trim() !== slug) return;
  const [owner, name, extra] = slug.split("/");
  if (extra !== undefined || owner.trim() !== owner || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(owner) ||
      !name || !/^[a-z0-9._-]+$/i.test(name) || name === "." || name === ".." || /\.git$/i.test(name)) return;
  if (Object.hasOwn(value, "ref")) return validGitReference(ref) ? { slug, ref } : undefined;
  if (typeof sha === "string" && sha.length === 40 && /^[a-f0-9]{40}$/i.test(sha)) return { slug, sha: sha.toLowerCase() };
}

export function parseRepository(value) {
  const source = parseRepositoryRequest(value);
  return source && "sha" in source ? source : undefined;
}

export function matchesRepositoryReceipt(repository, requested) {
  return repository?.slug === requested.slug && ("ref" in requested || repository.sha === requested.sha);
}
