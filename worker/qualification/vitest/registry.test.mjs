import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadTarball, registryDenied, registryTarget } from "./registry.mjs";

const tarball = "https://registry.npmjs.org/vitest/-/vitest-5.1.0.tgz";

test("permits only lockfile tarball GET and HEAD with the fixed HTTPS authority", () => {
  for (const method of ["GET", "HEAD"]) assert.equal(registryTarget(new Request(tarball, { method })), tarball);
  for (const request of [
    new Request(tarball, { method: "POST", body: "synthetic" }),
    new Request(tarball, { headers: { host: "example.invalid" } }),
    new Request(tarball.replace("https:", "http:")),
    new Request(tarball.replace("registry.npmjs.org", "example.invalid")),
    new Request(tarball + "?extra=value"),
    new Request("https://registry.npmjs.org/vitest"),
    new Request(tarball.replace("5.1.0", "5.1.1")),
  ]) assert.equal(registryTarget(request), undefined);
});

test("builds an independent registry request and never returns upstream redirects or headers", async () => {
  const observed = [];
  const mockedRegistry = (url, options) => {
    observed.push({ url, options });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "set-cookie": "synthetic=discarded" } });
  };
  const success = await downloadTarball(tarball, "GET", mockedRegistry);
  assert.deepEqual(observed, [{ url: tarball, options: { method: "GET", redirect: "manual" } }]);
  assert.equal(success.headers.get("set-cookie"), null);
  assert.deepEqual(new Uint8Array(await success.arrayBuffer()), new Uint8Array([1, 2, 3]));
  const blocked = await downloadTarball(tarball, "GET", () => Response.redirect("https://example.invalid"));
  assert.equal(blocked.status, 502);
  assert.equal(blocked.headers.get("location"), null);
  assert.equal(registryDenied("sealed").headers.get("x-qualification-registry"), "sealed");
});
