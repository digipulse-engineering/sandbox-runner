import { readMcpJson } from "./mcp-http.ts";
import { mcpObject } from "./mcp-policy.ts";
import type { McpConnector } from "./mcp-policy.ts";

export const paddleSandboxMcpUrl = "https://sandbox-api.paddle.com/";
export const paddleSandboxBinding = "SANDBOX_RUNNER_MCP_API_KEY_PADDLE_SANDBOX";

const priceId = /^pri_[a-z0-9]{26}$/;
const productId = /^pro_[a-z0-9]{26}$/;
const maxCatalogResponseBytes = 1024 * 1024;

type CatalogFields = Record<string, unknown>;

function product(data: CatalogFields): CatalogFields | undefined {
  if (typeof data.name !== "string") return;
  return { id: data.id, name: data.name, status: data.status };
}

function price(data: CatalogFields): CatalogFields | undefined {
  const unitPrice = mcpObject(data.unit_price);
  const cycle = mcpObject(data.billing_cycle);
  if (typeof data.product_id !== "string" || !productId.test(data.product_id) ||
      (data.name !== null && typeof data.name !== "string") ||
      typeof unitPrice?.amount !== "string" || !/^\d+$/.test(unitPrice.amount) ||
      typeof unitPrice.currency_code !== "string" || !/^[A-Z]{3}$/.test(unitPrice.currency_code)) return;
  if (data.billing_cycle !== null && (!cycle || typeof cycle.interval !== "string" ||
      !["day", "week", "month", "year"].includes(cycle.interval) ||
      typeof cycle.frequency !== "number" || !Number.isSafeInteger(cycle.frequency) || cycle.frequency < 1)) return;
  return {
    id: data.id, productId: data.product_id, name: data.name, status: data.status,
    unitPrice: { amount: unitPrice.amount, currencyCode: unitPrice.currency_code },
    billingCycle: cycle ? { interval: cycle.interval, frequency: cycle.frequency } : null,
  };
}

const catalogTools = new Map([
  ["paddle_get_price", { description: "Read a standard price from the Paddle sandbox catalog.",
    path: "prices", idPattern: priceId, project: price }],
  ["paddle_get_product", { description: "Read a standard product from the Paddle sandbox catalog.",
    path: "products", idPattern: productId, project: product }],
]);

export const paddleSandboxMcpTools = Array.from(catalogTools, ([name, tool]) => ({
  name, description: tool.description,
  inputSchema: { type: "object", required: ["id"], additionalProperties: false,
    properties: { id: { type: "string", pattern: tool.idPattern.source } } },
}));

export function isPaddleSandboxPolicy(connector: McpConnector): boolean {
  return connector.url === paddleSandboxMcpUrl && connector.readAuth === paddleSandboxBinding &&
    connector.writeAuth === paddleSandboxBinding && connector.write.length === 0 && connector.read.length > 0 &&
    connector.read.every(rule => {
      const tool = catalogTools.get(rule.tool);
      if (!tool) return false;
      const keys = Object.keys(rule.match);
      if (!keys.length) return rule.arguments.length === 1 && rule.arguments[0] === "id";
      return keys.length === 1 && rule.arguments.length === 0 && typeof rule.match.id === "string" &&
        tool.idPattern.test(rule.match.id);
    });
}

export function isPaddleSandboxKey(key: unknown): key is string {
  return typeof key === "string" && /^pdl_sdbx_apikey_[a-zA-Z0-9_-]+$/.test(key);
}

type PaddleCall = {
  name: string;
  args: Record<string, unknown>;
  token: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
};

export async function callPaddleSandboxTool({ name, args, token, signal, fetcher = fetch }: PaddleCall): Promise<Response> {
  const tool = catalogTools.get(name);
  const { id } = args;
  if (!tool || Object.keys(args).length !== 1 || typeof id !== "string" || !tool.idPattern.test(id)) {
    return new Response(null, { status: 400 });
  }
  if (!isPaddleSandboxKey(token)) return new Response(null, { status: 401 });
  try {
    const response = await fetcher(new URL(`${tool.path}/${id}`, paddleSandboxMcpUrl), {
      method: "GET", redirect: "manual", cache: "no-store", signal,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const retryAfter = response.headers.get("retry-after");
      return new Response(null, {
        status: [401, 403, 404, 429, 503].includes(response.status) ? response.status : 502,
        ...(retryAfter && [429, 503].includes(response.status) ? { headers: { "retry-after": retryAfter } } : {}),
      });
    }
    const data = mcpObject((await readMcpJson(response, maxCatalogResponseBytes))?.data);
    if (!data || data.id !== id || (data.type !== "standard" && data.type !== "custom") ||
        (data.status !== "active" && data.status !== "archived")) return new Response(null, { status: 502 });
    if (data.type === "custom") return new Response(null, { status: 404 });
    const result = tool.project(data);
    if (!result || JSON.stringify(result).includes(token)) return new Response(null, { status: 502 });
    return Response.json(result);
  } catch {
    return new Response(null, { status: 502 });
  }
}
