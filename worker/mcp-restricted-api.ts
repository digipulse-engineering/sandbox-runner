import { readMcpJson } from "./mcp-http.ts";
import { callPaddleSandboxTool, isPaddleSandboxKey, isPaddleSandboxPolicy, paddleSandboxBinding,
  paddleSandboxMcpTools } from "./mcp-paddle.ts";
import { callPosthogTool, isPosthogKey, isPosthogPolicy, posthogBinding, posthogMcpTools } from "./mcp-posthog.ts";
import { mcpObject } from "./mcp-policy.ts";
import type { McpConnector } from "./mcp-policy.ts";

export function isRestrictedApiBinding(binding: unknown): binding is string {
  return binding === posthogBinding || binding === paddleSandboxBinding;
}

export function isRestrictedApiPolicy(connector: McpConnector): boolean {
  return isPosthogPolicy(connector) || isPaddleSandboxPolicy(connector);
}

export function restrictedApiKey(binding: string, value: unknown): string | undefined {
  if (binding === posthogBinding && isPosthogKey(value) || binding === paddleSandboxBinding && isPaddleSandboxKey(value)) return value;
}

// Implements a small stateless upstream for the existing relay. It never sends MCP envelopes to an API provider.
export function restrictedApiFetcher(connector: McpConnector, fetcher: typeof fetch): typeof fetch {
  const posthog = connector.readAuth === posthogBinding;
  return async (input, init) => {
    if (input !== connector.url || init?.method !== "POST") return new Response(null, { status: 405 });
    const request = new Request(input, init);
    const call = await readMcpJson(request, 64 * 1024);
    if (!call) return new Response(null, { status: 400 });
    const { id, method } = call;
    const params = mcpObject(call.params);
    const result = (value: Record<string, unknown>) => Response.json({ jsonrpc: "2.0", id, result: value });
    switch (method) {
      case "initialize":
        return result({ protocolVersion: params?.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: posthog ? "sandbox-runner-posthog" : "sandbox-runner-paddle-sandbox", version: "1" } });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "ping":
        return result({});
      case "tools/list":
        return result({ tools: posthog ? posthogMcpTools : paddleSandboxMcpTools });
      case "tools/call": {
        const name = params?.name;
        const args = mcpObject(params?.arguments);
        const token = request.headers.get("authorization")?.slice("Bearer ".length);
        if (typeof name !== "string" || !args || !token) return new Response(null, { status: 400 });
        const operation = { url: connector.url, name, args, token, signal: request.signal, fetcher };
        const response = await (posthog ? callPosthogTool(operation) : callPaddleSandboxTool(operation));
        if (response.status === 400 || response.status === 404) return result({ isError: true,
          content: [{ type: "text", text: response.status === 404 ? "Sandbox catalog item not found." : "Invalid tool arguments." }] });
        if (!response.ok) return response;
        const output = await readMcpJson(response, 128 * 1024);
        if (!output) return new Response(null, { status: 502 });
        return result({ content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output });
      }
      default:
        return new Response(null, { status: 405 });
    }
  };
}
