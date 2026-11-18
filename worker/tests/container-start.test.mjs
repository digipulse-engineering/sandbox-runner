import assert from "node:assert/strict";
import test from "node:test";
import { guardedContainerStart } from "../container-start.ts";

test("fences a Harness start that resumes after teardown", async () => {
  const calls = [];
  class NativeContainer {
    #image = "fixture";
    get images() { return { base: this.#image }; }
    start(options) { calls.push(options.image === this.#image); }
    inspect() { return this.#image; }
  }
  let tearingDown = false;
  const container = guardedContainerStart(new NativeContainer(), () => !tearingDown);
  container.start({ image: container.images.base });
  assert.equal(container.inspect(), "fixture");
  const delayedStart = Promise.resolve().then(() => container.start({ image: "fixture" }));
  tearingDown = true;
  await assert.rejects(delayedStart, /teardown/);
  assert.deepEqual(calls, [true]);
});

test("awaits HTTPS setup for every start and after adopting a running container", async () => {
  const calls = [];
  class NativeContainer {
    start() { calls.push("start"); }
    async setInactivityTimeout() { calls.push("timeout"); }
  }
  const native = new NativeContainer();
  const gate = Promise.withResolvers();
  const container = guardedContainerStart(native, () => true, async () => {
    await gate.promise;
    calls.push("https");
  });
  container.start();
  const configure = container.setInactivityTimeout(1_000);
  assert.deepEqual(calls, ["start", "timeout"]);
  gate.resolve();
  await configure;
  container.start();
  await container.setInactivityTimeout(1_000);
  const adopted = guardedContainerStart(native, () => true, async () => { calls.push("https"); });
  await adopted.setInactivityTimeout(1_000);
  assert.deepEqual(calls, ["start", "timeout", "https", "start", "timeout", "https", "timeout", "https"]);
});

test("does not install Git authority after a delayed inactivity update crosses the deadline", async () => {
  const setup = Promise.withResolvers();
  let open = true;
  const container = guardedContainerStart({ setInactivityTimeout: () => setup.promise }, () => open,
    async () => assert.fail("installed after deadline"));
  const configure = container.setInactivityTimeout(1_000);
  open = false;
  setup.resolve();
  await assert.rejects(configure, /teardown/);
});
