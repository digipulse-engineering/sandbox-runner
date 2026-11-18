import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceEgress, fetchLockedTarball, leaseEgress, npmEgressTarget, releaseEgress, withEgressLease } from "../vitest/egress.ts";

test("admits npm only after checkout leases drain and prevents new leases after seal", () => {
  const checkout = leaseEgress({ phase: "checkout", leases: [] }, "checkout", "git-1");
  assert.equal(leaseEgress(checkout, "install", "npm-1"), undefined);
  const draining = advanceEgress(checkout, "draining_checkout");
  assert.equal(leaseEgress(draining, "checkout", "git-2"), undefined);
  assert.equal(advanceEgress(draining, "install"), undefined);
  const install = advanceEgress(releaseEgress(draining, "git-1"), "install");
  const download = leaseEgress(install, "install", "npm-1");
  const closed = advanceEgress(download, "closed");
  assert.deepEqual(closed.leases, ["npm-1"]);
  assert.equal(leaseEgress(closed, "install", "npm-2"), undefined);
  assert.deepEqual(releaseEgress(releaseEgress(closed, "npm-1"), "npm-1"), { phase: "closed", leases: [] });
  assert.equal(advanceEgress(closed, "install"), undefined);
});

test("releases after consuming or cancelling response body and when the forward fails", async () => {
  let released = 0;
  let cancelled = false;
  const release = async () => { released++; };
  const response = await withEgressLease(async () => new Response("package"), release);
  assert.equal(released, 0);
  assert.equal(await response.text(), "package");
  assert.equal(released, 1);
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const abandoned = await withEgressLease(async () => new Response(stream), release);
  await abandoned.body.cancel();
  assert.equal(cancelled, true);
  assert.equal(released, 2);
  await assert.rejects(withEgressLease(async () => { throw new Error("upstream failed"); }, release), /upstream failed/);
  assert.equal(released, 3);
});

test("constructs npm requests on the fixed authority without forwarding secrets or redirects", async () => {
  const tarball = "https://registry.npmjs.org/vitest/-/vitest-5.1.0.tgz";
  assert.equal(npmEgressTarget(new Request(tarball, { method: "HEAD" })), tarball);
  for (const request of [new Request(tarball + "?anything=1"), new Request(tarball.replace("https:", "http:")),
    new Request(tarball, { headers: { host: "example.invalid" } }), new Request(tarball, { method: "POST", body: "data" }),
    new Request(tarball.replace("registry.npmjs.org", "example.invalid"))]) assert.equal(npmEgressTarget(request), undefined);
  const response = await fetchLockedTarball(tarball, "GET", async (url, options) => {
    assert.equal(url, tarball);
    assert.deepEqual(options, { method: "GET", redirect: "manual" });
    return Response.redirect("https://example.invalid/");
  });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("location"), null);
});
