import { mcpObject } from "./mcp-policy.ts";

export type McpRequestId = string | number;

export function mediaType(message: Request | Response): string | undefined {
  return message.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

type Consume = (text: string, done: boolean) => Record<string, unknown> | undefined;

async function readBody(
  message: Request | Response, maxBytes: number, consume: Consume,
): Promise<Record<string, unknown> | undefined> {
  const declared = Number(message.headers.get("content-length"));
  if (!message.body || declared > maxBytes || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    await message.body?.cancel().catch(() => undefined);
    return;
  }
  const reader = message.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return consume(decoder.decode(), true);
      bytes += next.value.byteLength;
      if (bytes > maxBytes) return;
      const result = consume(decoder.decode(next.value, { stream: true }), false);
      if (result) return result;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readMcpJson(message: Request | Response, maxBytes: number,
  acceptedMediaTypes: readonly string[] = ["application/json"],
): Promise<Record<string, unknown> | undefined> {
  if (!acceptedMediaTypes.includes(mediaType(message) ?? "")) {
    await message.body?.cancel().catch(() => undefined);
    return;
  }
  const pieces: string[] = [];
  return readBody(message, maxBytes, (text, done) => {
    pieces.push(text);
    if (!done) return;
    try {
      return mcpObject(JSON.parse(pieces.join("")));
    } catch {
      return;
    }
  });
}

function matchingResponse(response: Record<string, unknown> | undefined, id: McpRequestId): boolean {
  return response?.jsonrpc === "2.0" && response.id === id && !Object.hasOwn(response, "method") &&
    Object.hasOwn(response, "result") !== Object.hasOwn(response, "error");
}

function sseResponse(id: McpRequestId): Consume {
  let current = "";
  const data: string[] = [];
  return (chunk, done) => {
    current += chunk;
    const endings = /\r\n|\r|\n/g;
    let start = 0;
    for (const match of current.matchAll(endings)) {
      const end = match.index;
      // A CR at a chunk boundary may be the first half of a CRLF.
      if (!done && match[0] === "\r" && end + 1 === current.length) break;
      const line = current.slice(start, end);
      start = end + match[0].length;
      if (line === "" && data.length > 0) {
        try {
          const response = mcpObject(JSON.parse(data.join("\n")));
          if (matchingResponse(response, id)) return response;
        } catch {
          // A non-JSON SSE event cannot satisfy the pending JSON-RPC request.
        }
        data.length = 0;
      } else if (line === "data" || line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    current = current.slice(start);
  };
}

/** Supports a JSON result or a single correlated result on a POST SSE stream. */
export async function readMcpResponse(
  response: Response, id: McpRequestId, maxBytes: number,
): Promise<Record<string, unknown> | undefined> {
  if (mediaType(response) === "text/event-stream") return readBody(response, maxBytes, sseResponse(id));
  const value = await readMcpJson(response, maxBytes);
  if (matchingResponse(value, id)) return value;
}
