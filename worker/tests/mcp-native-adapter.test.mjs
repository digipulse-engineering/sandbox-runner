import assert from "node:assert/strict";
import test from "node:test";
import { takeMcpConnectorNames, withManagedMcp } from "../mcp-native-adapter.ts";

const connectorEnv = "SANDBOX_RUNNER_MCP_CONNECTORS_JSON";
const names = ["acme-staging", "github"];

test("consume managed connector names before starting a native agent", () => {
  const env = { [connectorEnv]: JSON.stringify(names), HOME: "/home/agent" };
  assert.deepEqual(takeMcpConnectorNames(env), names);
  assert.deepEqual(env, { HOME: "/home/agent" });
  assert.deepEqual(takeMcpConnectorNames(env), []);
  for (const input of ["invalid JSON", "null", "42", "[null]", '["GitHub"]', '["--github"]',
    '["x/mcp"]', '["github","github"]', '[{"name":"github","url":"https://untrusted.example/"}]']) {
    const bad = { [connectorEnv]: input };
    assert.throws(() => takeMcpConnectorNames(bad), /^Error: Invalid managed MCP connector configuration\.$/);
    assert.deepEqual(bad, {});
  }
});

test("configure only managed Claude MCP servers for a prompt on stdin", () => {
  const command = { argv: ["claude", "-p", "--model", "sonnet", "--resume", "session"], stdin: "--mcp-config=attacker" };
  assert.equal(withManagedMcp(command, "claude-code", []), command);
  const configured = withManagedMcp(command, "claude-code", names);
  assert.equal(configured.stdin, command.stdin);
  assert.deepEqual(configured.argv.slice(0, -5), command.argv);
  assert.deepEqual(configured.argv.slice(-5, -1), ["--setting-sources", "user", "--strict-mcp-config", "--mcp-config"]);
  assert.deepEqual(JSON.parse(configured.argv.at(-1)), { mcpServers: {
    "acme-staging": { type: "http", url: "http://mcp.harness.internal/acme-staging/mcp" },
    github: { type: "http", url: "http://mcp.harness.internal/github/mcp" },
  } });
});

test("configure Codex MCP from the CLI while preserving its execution policy and resume", () => {
  const command = { argv: ["codex", "exec", "resume", "thread", "--dangerously-bypass-approvals-and-sandbox", "-c",
    'model_reasoning_effort="high"', "-"], stdin: "prompt", env: { CODEX_HOME: "/home/agent/.codex" } };
  assert.equal(withManagedMcp(command, "codex", []), command);
  const configured = withManagedMcp(command, "codex", names);
  assert.equal(configured.stdin, command.stdin);
  assert.equal(configured.env, command.env);
  assert.deepEqual(configured.argv.slice(0, -7), command.argv.slice(0, -1));
  assert.deepEqual(configured.argv.slice(-7), ["--ignore-user-config", "--ignore-rules", "-c",
    'projects."/workspace".trust_level="untrusted"', "-c",
    'mcp_servers={acme-staging={url="http://mcp.harness.internal/acme-staging/mcp",required=true},github={url="http://mcp.harness.internal/github/mcp",required=true}}', "-"]);
});
