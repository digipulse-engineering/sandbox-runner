import type { PresetAgent, AuthMode } from "./contract";

export type Fixture = "success" | "capacity" | "auth" | "permission" | "overloaded" | "timeout" |
  "sse_capacity" | "sse_failure" | "claude_sse_capacity" | "claude_sse_overloaded" | "strategy_quota" | "strategy_deadline" |
  "cancellation" | "review_verdict";

const fixtureVerdict = JSON.stringify({ verdict: "PASS", findings: ["Synthetic checkout fixture reviewed."] });

export function fixtureFor(prompt: string): Fixture {
  if (prompt === "J1 fixture quota") return "capacity";
  if (prompt === "J1 fixture auth") return "auth";
  if (prompt === "J1 fixture permission") return "permission";
  if (prompt === "J1 fixture overloaded") return "overloaded";
  if (prompt === "J1 fixture provider timeout") return "timeout";
  if (prompt === "J1 fixture SSE quota") return "sse_capacity";
  if (prompt === "J1 fixture SSE failure") return "sse_failure";
  if (prompt === "J1 fixture Claude SSE quota") return "claude_sse_capacity";
  if (prompt === "J1 fixture Claude SSE overloaded") return "claude_sse_overloaded";
  if (prompt === "J1 fixture strategy quota") return "strategy_quota";
  if (prompt === "J1 fixture strategy deadline") return "strategy_deadline";
  if (prompt === "J1 fixture cancellation") return "cancellation";
  if (prompt === "J2 fixture review verdict") return "review_verdict";
  return "success";
}

export function stream<T extends { type: string }>(events: T[], requestId: string, hold = false): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      }
      if (!hold) controller.close();
    },
    async pull(controller) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      if (!cancelled) controller.enqueue(encoder.encode(": waiting for cancellation\n\n"));
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream", "request-id": requestId } });
}

function claude(errorType?: "rate_limit_error" | "overloaded_error", hold = false, text = "Claude fixture complete."): Response {
  const start = { type: "message_start", message: {
    id: "msg_fixture_claude", type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
  } };
  if (hold) return stream([start], "req_fixture_cancellation", true);
  if (errorType) {
    return stream([
      start,
      { type: "error", error: { type: errorType, message: "Fixture request failed." } },
    ], "req_fixture_claude");
  }
  return stream([
    start,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ], "req_fixture_claude");
}

function codex(authMode: AuthMode, fixture: Fixture): Response {
  const item = {
    id: "msg_fixture_codex", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: fixture === "review_verdict" ? fixtureVerdict : "Codex fixture complete.", annotations: [] }],
  };
  const response = {
    id: "resp_fixture_codex", object: "response", created_at: 0,
    model: authMode === "subscription" ? "gpt-6.1-sol" : "gpt-5.1",
    status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const created = { ...response, status: "in_progress", output: [] };
  const start = { type: "response.created", response: created };
  if (fixture === "cancellation") return stream([{ ...start, sequence_number: 0 }], "req_fixture_cancellation", true);
  const quotaCode = authMode === "subscription" ? "subscription_sharing_usage_limit_exceeded" : "insufficient_quota";
  const errorCode = fixture === "sse_capacity" ? quotaCode : "server_error";
  const events = fixture !== "success" && fixture !== "review_verdict" ? [
    start,
    { type: "response.failed", response: { ...created, status: "failed", error: {
      type: errorCode, code: errorCode, message: "Fixture request failed.",
    } } },
  ] : [
    start,
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return stream(events.map((event, sequence_number) => ({ ...event, sequence_number })), "req_fixture_codex");
}

const fixtureErrors = {
  capacity: { status: 429, type: "rate_limit_error" },
  auth: { status: 401, type: "authentication_error" },
  permission: { status: 403, type: "permission_error" },
  overloaded: { status: 529, type: "overloaded_error" },
  timeout: { status: 408, type: "api_error" },
};

export function fixtureResponse(agent: PresetAgent, authMode: AuthMode, fixture: Fixture): Response {
  if (fixture === "strategy_deadline") fixture = authMode === "api-key" ? "strategy_quota" : "cancellation";
  if (fixture === "cancellation") {
    // Begin a provider-valid response and keep it open until teardown.
    return agent === "claude" ? claude(undefined, true) : codex(authMode, fixture);
  }
  if (fixture === "strategy_quota") {
    if (agent === "claude" && authMode === "api-key") {
      return Response.json({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "Fixture API spend limit reached.",
          details: { error_code: "enforced_spend_limit_reached" },
        },
      }, { status: 429, headers: { "retry-after": "0", "x-should-retry": "false" } });
    }
    fixture = authMode === "api-key" ? "sse_capacity" : "success";
  }
  if (fixture === "claude_sse_capacity") return claude("rate_limit_error");
  if (fixture === "claude_sse_overloaded") return claude("overloaded_error");
  if (fixture === "review_verdict" && agent === "claude") return claude(undefined, false, fixtureVerdict);
  if (fixture !== "success" && fixture !== "sse_capacity" && fixture !== "sse_failure" && fixture !== "review_verdict") {
    const { status, type } = fixtureErrors[fixture];
    return Response.json({ type: "error", error: { type, message: "Fixture request failed." } }, {
      status, headers: { "retry-after": "0", "x-should-retry": "false" },
    });
  }
  if (agent === "claude") return claude();
  const response = codex(authMode, fixture);
  if (authMode === "subscription") response.headers.delete("content-type");
  return response;
}
