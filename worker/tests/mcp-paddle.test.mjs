import assert from "node:assert/strict";
import test from "node:test";
import {
  callPaddleSandboxTool, isPaddleSandboxKey, isPaddleSandboxPolicy,
  paddleSandboxBinding, paddleSandboxMcpTools, paddleSandboxMcpUrl,
} from "../mcp-paddle.ts";

const priceId = "pri_01gsz8z1q1n00f12qt82y31smh";
const productId = "pro_01gsz97mq9pa4fkyy0wqenepkz";
const token = "pdl_sdbx_apikey_fixture";
const price = { id: priceId, product_id: productId, name: null, status: "active", type: "standard",
  billing_cycle: { interval: "month", frequency: 1, unexpected: "omit" },
  unit_price: { amount: "3900", currency_code: "EUR", unexpected: "omit" }, custom_data: { private: "omit" } };
const product = { id: productId, name: "Pro", status: "active", type: "standard", description: "omit" };

test("allows only explicit price and product reads with the Paddle sandbox credential", () => {
  const read = [
    { tool: "paddle_get_price", match: {}, arguments: ["id"] },
    { tool: "paddle_get_product", match: { id: productId }, arguments: [] },
  ];
  const connector = { url: paddleSandboxMcpUrl, readAuth: paddleSandboxBinding, writeAuth: paddleSandboxBinding, read, write: [] };
  assert.equal(isPaddleSandboxPolicy(connector), true);
  assert.deepEqual(paddleSandboxMcpTools.map(tool => tool.name), read.map(rule => rule.tool));
  assert.equal(isPaddleSandboxKey(token), true);
  assert.equal(isPaddleSandboxKey("pdl_live_apikey_fixture"), false);
  assert.equal(isPaddleSandboxKey(`${token}\n`), false);
  for (const invalid of [
    { url: "https://api.paddle.com/" },
    { writeAuth: "SANDBOX_RUNNER_MCP_CREDENTIAL_ALTERNATE" },
    { write: read },
    { read: [{ ...read[0], tool: "execute" }] },
    { read: [{ ...read[0], arguments: ["id", "include"] }] },
    { read: [{ ...read[1], match: { id: priceId } }] },
  ]) assert.equal(isPaddleSandboxPolicy({ ...connector, ...invalid }), false);
});

test("requests exact catalog records and projects only fields used in a billing review", async () => {
  const signal = new AbortController().signal;
  const results = [
    ["paddle_get_price", "prices", price, { id: priceId, productId, name: null, status: "active",
      unitPrice: { amount: "3900", currencyCode: "EUR" }, billingCycle: { interval: "month", frequency: 1 } }],
    ["paddle_get_product", "products", product, { id: productId, name: "Pro", status: "active" }],
  ];
  for (const [name, path, data, expected] of results) {
    const response = await callPaddleSandboxTool({ name, args: { id: data.id }, token, signal,
      fetcher: async (url, options) => {
        assert.equal(url.href, `https://sandbox-api.paddle.com/${path}/${data.id}`);
        assert.deepEqual(options, { method: "GET", redirect: "manual", cache: "no-store", signal,
          headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
        return Response.json({ data });
      } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  }
});

test("rejects arbitrary operations, URLs, expansions, and live keys before a provider request", async () => {
  const fetcher = () => assert.fail("Forbidden request reached Paddle");
  for (const [name, args] of [
    ["execute", {}],
    ["paddle_get_price", { id: "../customers" }],
    ["paddle_get_price", { id: productId }],
    ["paddle_get_price", { id: priceId, include: "customer" }],
    ["paddle_get_price", { id: priceId, url: "https://api.paddle.com/" }],
  ]) {
    const response = await callPaddleSandboxTool({ name, args, token, fetcher });
    assert.equal(response.status, 400);
  }
  const response = await callPaddleSandboxTool({ name: "paddle_get_price", args: { id: priceId },
    token: "pdl_live_apikey_fixture", fetcher });
  assert.equal(response.status, 401);
});

test("preserves actionable statuses without exposing redirects, provider errors, or non-catalog records", async () => {
  const rateLimit = new Response("secret diagnostics", { status: 429, headers: { "retry-after": "60" } });
  const cases = [
    [new Response("secret diagnostics", { status: 401 }), 401],
    [new Response("secret diagnostics", { status: 403 }), 403],
    [rateLimit, 429],
    [Response.redirect("https://api.paddle.com/", 302), 502],
    [Response.json({ data: { ...price, type: "custom" } }), 404],
    [Response.json({ data: { ...price, id: productId } }), 502],
    [Response.json({ data: { ...price, name: token } }), 502],
  ];
  for (const [provider, status] of cases) {
    const response = await callPaddleSandboxTool({ name: "paddle_get_price", args: { id: priceId }, token,
      fetcher: async () => provider });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("retry-after"), status === 429 ? "60" : null);
    assert.equal(response.headers.get("location"), null);
    assert.equal(await response.text(), "");
  }
});
