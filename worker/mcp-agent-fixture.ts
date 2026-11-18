import { stream } from "./fixtures.ts";
import { object } from "./github-auth.ts";

export type McpModelFixtureCall = {
  connector: string;
  tool: string;
  args: Record<string, unknown>;
  expect: string;
  denied?: true;
};

const failed = "MCP fixture tool or result mismatch.";
const claudeId = (index: number) => `toolu_mcp_fixture_${index}`;
const codexId = (index: number) => `call_mcp_fixture_${index}`;
const list = (value: unknown) => Array.isArray(value) ? value : [];

function claudeStream(model: string, index: number, step: { name: string; args: Record<string, unknown> } | { text: string }) {
  const use = "name" in step;
  return stream([
    { type: "message_start", message: {
      id: `msg_mcp_fixture_${index}`, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
    } },
    { type: "content_block_start", index: 0, content_block: use
      ? { type: "tool_use", id: claudeId(index), name: step.name, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: use
      ? { type: "input_json_delta", partial_json: JSON.stringify(step.args) } : { type: "text_delta", text: step.text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: use ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ], "req_mcp_fixture_claude");
}

function codexStream(model: string, index: number, step: { namespace: string; name: string; args: Record<string, unknown> } | { text: string }) {
  const use = "name" in step;
  const item = use ? {
    type: "function_call", id: `fc_mcp_fixture_${index}`, call_id: codexId(index), namespace: step.namespace,
    name: step.name, status: "completed", arguments: JSON.stringify(step.args),
  } : {
    type: "message", id: `msg_mcp_fixture_${index}`, role: "assistant", status: "completed",
    content: [{ type: "output_text", text: step.text, annotations: [] }],
  };
  const response = { id: `resp_mcp_fixture_${index}`, object: "response", created_at: 0, model,
    status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  return stream([
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", response_id: response.id, output_index: 0,
      item: { ...item, status: "in_progress", ...(use ? { arguments: "" } : { content: [] }) } },
    { type: "response.output_item.done", response_id: response.id, output_index: 0, item },
    { type: "response.completed", response },
  ].map((event, sequence_number) => ({ ...event, sequence_number })), "req_mcp_fixture_codex");
}

/** Drive the pinned native clients through real MCP calls against a synthetic upstream. */
export async function mcpAgentFixture(
  body: BodyInit | null | undefined,
  agent: "claude" | "codex",
  calls: readonly McpModelFixtureCall[],
  finalText: string,
): Promise<Response> {
  const payload = object(await new Response(body).json().catch(() => undefined));
  const model = typeof payload?.model === "string" ? payload.model : "fixture";
  const tools = list(payload?.tools).map(object);
  if (agent === "claude") {
    const blocks = list(payload?.messages).flatMap(message => list(object(message)?.content)).map(object);
    for (const [index, call] of calls.entries()) {
      const result = blocks.find(block => block?.type === "tool_result" && block.tool_use_id === claudeId(index));
      if (result) {
        if (!JSON.stringify(result.content ?? "").includes(call.expect) || (result.is_error === true) !== (call.denied === true)) {
          return claudeStream(model, index, { text: failed });
        }
      } else {
        const name = `mcp__${call.connector}__${call.tool}`;
        return claudeStream(model, index, tools.some(tool => tool?.name === name) ? { name, args: call.args } : { text: failed });
      }
    }
    return claudeStream(model, calls.length, { text: finalText });
  }

  const input = list(payload?.input).map(object);
  for (const [index, call] of calls.entries()) {
    const result = input.find(item => item?.type === "function_call_output" && item.call_id === codexId(index));
    if (result) {
      if (!JSON.stringify(result.output ?? "").includes(call.expect)) return codexStream(model, index, { text: failed });
    } else {
      const namespace = `mcp__${call.connector.replaceAll("-", "_")}`;
      const available = tools.find(tool => tool?.type === "namespace" && tool.name === namespace);
      return codexStream(model, index, list(available?.tools).some(tool => object(tool)?.name === call.tool)
        ? { namespace, name: call.tool, args: call.args } : { text: failed });
    }
  }
  return codexStream(model, calls.length, { text: finalText });
}
