import assert from "node:assert/strict";
import test from "node:test";
import { beforeAgentDeadline, deadlineElapsed, deadlineReached, deadlineView, maxAgentTimeoutMs, resolveAgentDeadline,
  runDeadlineFetch, sameAgentDeadline } from "../agent-deadline.ts";
import { parseInput, parseProviderRunInput } from "../contract.ts";

const v4 = { operationId: "48f9fa4c-cc36-46bd-8b7d-f86f09ec79db", kind: "agent", agent: "claude", prompt: "fixture" };

test("v4 validates an explicit duration as a whole millisecond value supported by workerd", () => {
  for (const timeoutMs of [0, -1, 0.5, maxAgentTimeoutMs + 1, "1", null, undefined]) {
    assert.equal(parseProviderRunInput({ ...v4, timeoutMs }), undefined);
  }
  for (const timeoutMs of [1, maxAgentTimeoutMs]) {
    assert.equal(parseProviderRunInput({ ...v4, timeoutMs }).input.timeoutMs, timeoutMs);
  }
  assert.equal(parseProviderRunInput(v4).input.timeoutMs, undefined);
  assert.equal(parseInput({ ...v4, timeoutMs: 100 }, false).timeoutMs, undefined);
});

test("leaves an opaque body intact and fences the actual egress call at expiry", async t => {
  const start = 10_000;
  const deadlineAt = start + 5_000;
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const stream = new ReadableStream();
  const abort = new AbortController();
  let calls = 0;
  const fetcher = async (_target, init) => {
    calls += 1;
    assert.equal(init.body, stream);
    assert.equal(init.signal.aborted, false);
    abort.abort();
    assert.equal(init.signal.aborted, true);
    return new Response();
  };
  assert.equal(runDeadlineFetch(fetcher, undefined), fetcher);
  const forward = runDeadlineFetch(fetcher, deadlineAt);
  await forward("https://fixture.invalid", { method: "POST", body: stream, signal: abort.signal });
  t.mock.timers.setTime(deadlineAt);
  assert.throws(() => forward("https://fixture.invalid", { method: "POST", body: stream }), /deadline elapsed/);
  assert.equal(calls, 1);
});

test("resolves the optional default and cap once and closes authority at the exact deadline", () => {
  const now = 10_000;
  assert.equal(resolveAgentDeadline(undefined, undefined, now), undefined);
  const implicit = resolveAgentDeadline(undefined, "20", now);
  assert.deepEqual(implicit, { admittedAt: now, deadlineAt: now + 20, timeoutMs: undefined });
  assert.deepEqual(deadlineView(implicit), { deadlineAt: now + 20 });
  assert.equal(deadlineReached(implicit, now + 19), false);
  assert.equal(deadlineReached(implicit, now + 20), true);
  assert.equal(deadlineReached(undefined, now + 21), false);

  const explicit = resolveAgentDeadline(10, "20", now);
  assert.deepEqual(explicit, { admittedAt: now, deadlineAt: now + 10, timeoutMs: 10 });
  assert.deepEqual(resolveAgentDeadline(10, undefined, now), explicit);
  assert.equal(resolveAgentDeadline(21, "20", now), "run_timeout_exceeds_limit");
  for (const malformed of ["", "0", "1\n", " 1", "1.2", "1e3", String(maxAgentTimeoutMs + 1)]) {
    assert.equal(resolveAgentDeadline(1, malformed, now), "agent_deadline_invalid");
  }
  assert(sameAgentDeadline(explicit, JSON.parse(JSON.stringify(explicit))));
  assert(!sameAgentDeadline(implicit, explicit));
  assert(!sameAgentDeadline(explicit, { ...explicit, admittedAt: now - 1 }));
});

test("a late export or publication response cannot win the deadline race", async t => {
  const deadline = { admittedAt: 10_000, deadlineAt: 10_020 };
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: deadline.admittedAt });
  const external = Promise.withResolvers();
  const waiting = beforeAgentDeadline(() => external.promise, deadline);
  t.mock.timers.tick(20);
  assert.equal(await waiting, deadlineElapsed);
  external.resolve("late receipt");
  assert.equal(await beforeAgentDeadline(() => assert.fail("started after deadline"), deadline), deadlineElapsed);
});
