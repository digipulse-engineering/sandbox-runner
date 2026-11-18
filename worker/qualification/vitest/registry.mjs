import lock from "./project/package-lock.json" with { type: "json" };

export const registryHost = "registry.npmjs.org";
const registryOrigin = "https://" + registryHost;
const tarballs = new Set(Object.entries(lock.packages).filter(([name]) => name).map(([, pkg]) => {
  const url = new URL(pkg.resolved);
  if (url.origin !== registryOrigin || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith(".tgz") || !pkg.integrity?.startsWith("sha512-")) {
    throw new Error("Invalid registry entry in the qualification lockfile");
  }
  return url.href;
}));

export function registryTarget(request) {
  const host = request.headers.get("host");
  if ((request.method !== "GET" && request.method !== "HEAD") || request.body !== null ||
      (host !== null && host !== registryHost) || !tarballs.has(request.url)) return;
  return request.url;
}

export function registryDenied(reason) {
  return new Response(null, { status: 403, headers: { "x-qualification-registry": reason } });
}

export async function downloadTarball(target, method, fetchPackage = fetch) {
  try {
    const upstream = await fetchPackage(target, { method, redirect: "manual" });
    if (upstream.status !== 200) {
      await upstream.body?.cancel();
      return new Response(null, { status: 502 });
    }
    return new Response(upstream.body, { headers: { "content-type": "application/octet-stream" } });
  } catch {
    return new Response(null, { status: 502 });
  }
}
