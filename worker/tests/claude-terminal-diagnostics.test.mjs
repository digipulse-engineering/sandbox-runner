import assert from "node:assert/strict";
import test from "node:test";
import { claudeSpendLimitReason, withClaudeTerminalDiagnostics } from "../claude-terminal-diagnostics.ts";

const failure = { status: "unanswered", reason: "The CLI's ordinary failure detail." };
const events = [{ type: "usage", inputTokens: 1 }];
const state = { sessionId: "fixture-session" };
const update = { events, state, outcome: failure };

function parserWith(outcomeUpdate = update, exitOutcome = failure) {
  return withClaudeTerminalDiagnostics({
    line: () => outcomeUpdate,
    end: () => exitOutcome,
  });
}

const terminal = {
  type: "result",
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  api_error_status: 429,
};

test("projects the validated terminal API status and retains the pinned parser's updates", () => {
  for (const status of [400, 401, 429, 529, 599]) {
    const parsed = parserWith().line(JSON.stringify({ ...terminal, api_error_status: status }));
    assert.deepEqual(parsed, {
      events, state, outcome: { status: "unanswered", reason: "claude_provider_http_" + status },
    });
    assert.equal(parsed.events, events);
    assert.equal(parsed.state, state);
  }
});

test("ignores nonterminal, successful and malformed diagnostics", () => {
  for (const message of [
    { ...terminal, type: "assistant", error: "rate_limit" },
    { ...terminal, is_error: false },
    { ...terminal, terminal_reason: "completed" },
    { ...terminal, api_error_status: "429" },
    { ...terminal, api_error_status: 429.5 },
    { ...terminal, api_error_status: 399 },
    { ...terminal, api_error_status: 600 },
    null,
  ]) {
    assert.equal(parserWith().line(JSON.stringify(message)), update);
  }
  assert.equal(parserWith().line("{malformed"), update);
  const successful = { events, state, outcome: { status: "done", text: "OK" } };
  assert.equal(parserWith(successful).line(JSON.stringify(terminal)), successful);
  assert.equal(parserWith({ events, state }).line(JSON.stringify(terminal)).outcome, undefined);
});

test("keeps free text out of the reserved reason namespace", () => {
  for (const reason of ["claude_provider_http_429", claudeSpendLimitReason]) {
    const spoofed = { status: "unanswered", reason };
    const parser = parserWith({ ...update, outcome: spoofed }, spoofed);
    const blocked = { status: "unanswered", reason: "claude_unclassified_failure" };
    assert.deepEqual(parser.line(JSON.stringify({ type: "result", is_error: true })).outcome, blocked);
    assert.deepEqual(parser.end({ code: 1, stderr: "" }), blocked);
  }
  assert.equal(parserWith().end({ code: 1, stderr: "" }), failure);
});

test("recognizes only the exact spend-cap code on the structured 429 terminal event", () => {
  for (const [fields, reason] of [
    [{ api_error_code: "enforced_spend_limit_reached" }, claudeSpendLimitReason],
    [{ api_error_code: "rate_limit_error" }, "claude_provider_http_429"],
    [{ api_error_code: "enforced_spend_limit_reached", api_error_status: 400 }, "claude_provider_http_400"],
  ]) {
    const parsed = parserWith().line(JSON.stringify({ ...terminal, ...fields }));
    assert.deepEqual(parsed.outcome, { status: "unanswered", reason });
  }
});
