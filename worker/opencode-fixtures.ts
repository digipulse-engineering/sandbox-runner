import { openCodeProviders } from "./opencode-settings.ts";
import type { ModelProvider } from "./opencode-settings.ts";
import { stream as anthropicStream } from "./fixtures.ts";
import { openCodeReviewEffort, openCodeReviewModel } from "./run-input-validation.mjs";

const witness = "/workspace/opencode-witness.txt";
const marker = "OPENCODE_FIXTURE_COMPLETE";
const toolCall = "opencode_fixture_write";

export function openCodeFixtureFor(prompt: string) {
  switch (prompt) {
    case "OpenCode fixture write": return "write";
    case "OpenCode fixture network": return "network";
    case "OpenCode fixture checkout": return "checkout";
    case "OpenCode fixture missing key": return "missing";
    case "OpenCode fixture invalid key": return "auth";
    case "OpenCode fixture exhausted quota": return "quota";
    case "OpenCode fixture rate limit": return "rate";
    case "OpenCode fixture cancellation": return "cancel";
    default: return "success";
  }
}

export type OpenCodeFixture = ReturnType<typeof openCodeFixtureFor>;

function errorResponse(provider: ModelProvider, status: number, type: string, code: string) {
  return Response.json({
    ...(provider === "anthropic" ? { type: "error" } : {}),
    error: { message: "Synthetic provider response.", type, code },
  }, { status, headers: { "x-should-retry": "false" } });
}

function openAIResponse(model: string, input: { path: string; content: string }, wantsTool: boolean, hold: boolean) {
  const chunk = (delta: object, finish_reason: string | null) => ({
    id: "chatcmpl_opencode_fixture", object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta, finish_reason }],
  });
  const data = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n";
  if (hold) {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(data(chunk({ role: "assistant" }, null))));
      },
    }), { headers: { "content-type": "text/event-stream" } });
  }
  const chunks = wantsTool ? [
    chunk({ role: "assistant", tool_calls: [{
      index: 0, id: toolCall, type: "function",
      function: { name: "write", arguments: JSON.stringify(input) },
    }] }, null),
    chunk({}, "tool_calls"),
  ] : [chunk({ role: "assistant", content: marker }, null), chunk({}, "stop")];
  return new Response(chunks.map(data).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function anthropicResponse(model: string, input: { path: string; content: string }, wantsTool: boolean, hold: boolean) {
  const start = { type: "message_start", message: {
    id: "msg_opencode_fixture", type: "message", role: "assistant", model, content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
  } };
  if (hold) return anthropicStream([start], "req_opencode_fixture", true);
  return anthropicStream([
    start,
    { type: "content_block_start", index: 0, content_block: wantsTool
      ? { type: "tool_use", id: toolCall, name: "write", input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: wantsTool
      ? { type: "input_json_delta", partial_json: JSON.stringify(input) } : { type: "text_delta", text: marker } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: wantsTool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ], "req_opencode_fixture");
}

// This is the fixture upstream, downstream of the same opaque relay used in real mode.
export async function openCodeFixtureResponse(provider: ModelProvider, effort: "high" | "xhigh" | undefined,
  fixture: OpenCodeFixture, operationId: string, body: BodyInit | null | undefined): Promise<Response> {
  if (fixture === "auth") return errorResponse(provider, 401, "authentication_error", "invalid_api_key");
  if (fixture === "quota" || fixture === "rate") {
    return errorResponse(provider, 429, provider === "openai" ? "api_error" : "rate_limit_error",
      fixture === "quota" && provider === "openai" ? "insufficient_quota" : "rate_limit_exceeded");
  }
  const request = await new Response(body).json().catch(() => null) as {
    model?: unknown; stream?: unknown; thinking?: { type?: unknown }; output_config?: { effort?: unknown };
    tools?: { name?: unknown; function?: { name?: unknown } }[];
    reasoning?: { effort?: unknown }; input?: unknown;
    messages?: { role?: unknown; tool_call_id?: unknown; content?: { type?: unknown; tool_use_id?: unknown; is_error?: unknown }[] }[];
  } | null;
  if (effort === openCodeReviewEffort) {
    if (provider !== "openai" || request?.model !== openCodeReviewModel || request.stream !== true ||
        request.reasoning?.effort !== openCodeReviewEffort || !Array.isArray(request.input)) {
      return errorResponse(provider, 400, "invalid_request_error", "fixture_wire_mismatch");
    }
    const blocked = new Set(["edit", "write", "patch", "shell", "subagent", "webfetch", "websearch", "execute", "skill"]);
    if (!Array.isArray(request.tools) || request.tools.some(tool => typeof tool?.name === "string" && blocked.has(tool.name))) {
      return errorResponse(provider, 400, "invalid_request_error", "fixture_review_tools_unrestricted");
    }
    const text = JSON.stringify({ verdict: "PASS", findings: ["OpenCode Responses review fixture passed."] });
    const part = { type: "output_text", text, annotations: [] };
    const item = { id: "msg_opencode_review", type: "message", role: "assistant", status: "completed", content: [part] };
    const response = { id: "resp_opencode_review", object: "response", created_at: 1, model: openCodeReviewModel,
      status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    return anthropicStream([
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: "" } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
      { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text },
      { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ].map((event, sequence_number) => ({ ...event, sequence_number })), "req_opencode_review");
  }
  const { model } = openCodeProviders[provider];
  if (request?.model !== model || request.stream !== true || !Array.isArray(request.messages) ||
      (provider === "anthropic" && (request.thinking?.type !== "adaptive" || request.output_config?.effort !== effort))) {
    return errorResponse(provider, 400, "invalid_request_error", "fixture_wire_mismatch");
  }
  const input = { path: witness, content: operationId + "\n" };
  let wantsTool = false;
  if (fixture === "write" || fixture === "network" || fixture === "checkout") {
    if (!Array.isArray(request.tools) || !request.tools.some(tool => (tool?.name ?? tool?.function?.name) === "write")) {
      return errorResponse(provider, 400, "invalid_request_error", "fixture_tool_unavailable");
    }
    wantsTool = provider === "openai"
      ? !request.messages.some(message => message?.role === "tool" && message.tool_call_id === toolCall)
      : !request.messages.some(message => message?.role === "user" && Array.isArray(message.content) &&
        message.content.some(item => item?.type === "tool_result" && item.tool_use_id === toolCall && item.is_error !== true));
  }
  return provider === "openai" ? openAIResponse(model, input, wantsTool, fixture === "cancel")
    : anthropicResponse(model, input, wantsTool, fixture === "cancel");
}

const verifyWitness = `
import { open, lstat, constants } from "node:fs/promises";
const [path, operationId, sha] = process.argv.slice(1);
const expected = Buffer.from(operationId + "\\n");
// Bound the native exec if the filesystem stops responding.
setTimeout(() => process.exit(1), 15_000).unref();
process.setgroups([]);
process.setgid(10001);
process.setuid(10001);
async function matches(path, contents) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== contents.length || stat.uid !== 10001 || stat.gid !== 10001) return false;
    const { buffer, bytesRead } = await file.read(Buffer.alloc(contents.length + 1), 0, contents.length + 1, 0);
    return bytesRead === contents.length && buffer.subarray(0, bytesRead).equals(contents);
  } finally {
    await file.close();
  }
}
async function absent(path) {
  return lstat(path).then(() => false, error => error?.code === "ENOENT");
}
if (!await matches(path, expected)) process.exit(1);
if (sha !== undefined) {
  if (!await matches("/workspace/.git/HEAD", Buffer.from(sha + "\\n")) ||
      !await matches("/workspace/witness.txt", Buffer.from("sandbox-runner fixture base\\n"))) process.exit(1);
  for (const source of ["opencode.json", ".opencode/opencode.json", ".opencode/plugins/witness.ts", ".githooks/post-checkout",
    ".gitmodules", ".gitattributes"]) {
    if (!(await lstat("/workspace/" + source)).isFile()) process.exit(1);
  }
  for (const marker of ["opencode-plugin-must-not-execute", "hook-must-not-execute", ".git/modules/sub", "sub/.git"]) {
    if (!await absent("/workspace/" + marker)) process.exit(1);
  }
}
`;

export async function verifyOpenCodeWitness(container: Container | undefined, operationId: string, checkoutSha?: string): Promise<boolean> {
  if (!container?.running) return false;
  try {
    const process = await container.exec(
      ["/usr/local/bin/node", "--input-type=module", "--eval", verifyWitness, "--", witness, operationId,
        ...(checkoutSha === undefined ? [] : [checkoutSha])],
      { stdout: "ignore", stderr: "ignore" },
    );
    return (await process.output()).exitCode === 0;
  } catch {
    return false;
  }
}
