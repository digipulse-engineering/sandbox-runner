import assert from "node:assert/strict";
import test from "node:test";
import { withCodexPublicationTerminal } from "../codex-publication-terminal.ts";

const done = { status: "done", text: "fixture reply" };
const quota = { status: "unanswered", reason: "Quota exceeded. Check your plan and billing details." };
const event = { type: "usage", inputTokens: 1 };
const fallback = { status: "unanswered", reason: "pinned end fallback" };
const parser = () => withCodexPublicationTerminal({
  line: value => ({ events: [event], outcome: value === "done" ? done : quota }),
  end: () => fallback,
});

test("releases Codex publication success only after normal supervisor exit", () => {
  for (const code of [0, 17, null]) {
    const wrapped = parser();
    assert.deepEqual(wrapped.line("done"), { events: [event] });
    const outcome = wrapped.end({ code, stderr: "" });
    assert.deepEqual(outcome, code === 0 ? done : {
      status: "unanswered", reason: "github_publication_supervisor_unverified",
    });
  }
});

test("preserves the pinned last terminal provider error and no-frame fallback", () => {
  const wrapped = parser();
  wrapped.line("done");
  wrapped.line("quota");
  assert.deepEqual(wrapped.end({ code: 1, stderr: "fixture noise" }), quota);
  assert.deepEqual(parser().end({ code: 1, stderr: "" }), fallback);
  const recovered = parser();
  recovered.line("quota");
  recovered.line("done");
  assert.deepEqual(recovered.end({ code: 0, stderr: "" }), done);
});
