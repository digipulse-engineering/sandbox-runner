import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// CI tests the checkout helper with the go.mod toolchain, and the images build it with
// GOTOOLCHAIN=local. Dependabot updates the image tags but not the toolchain line.
test("the Go toolchain in go.mod is the one that builds the container images", () => {
  const toolchain = /^toolchain go(\d+\.\d+\.\d+)$/m.exec(read("worker/checkout/go.mod"))?.[1];
  assert.ok(toolchain, "worker/checkout/go.mod pins a toolchain");
  for (const dockerfile of ["worker/Dockerfile", "worker/vitest/Dockerfile"]) {
    const images = [...read(dockerfile).matchAll(/^FROM\b.*\bgolang:(\d+\.\d+\.\d+)-/gm)].map(match => match[1]);
    assert.ok(images.length > 0, `${dockerfile} builds with a golang image`);
    for (const image of images) assert.equal(image, toolchain, `${dockerfile} golang:${image} matches go${toolchain}`);
  }
});
