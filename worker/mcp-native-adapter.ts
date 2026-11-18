import type { CliCommand } from "./pinned-src/harness/container/runtime/cli-adapter";

const connectorName = /^[a-z][a-z0-9-]*$/;
const connectorEnv = "SANDBOX_RUNNER_MCP_CONNECTORS_JSON";

export function takeMcpConnectorNames(env: Record<string, string | undefined>): string[] {
  const raw = env[connectorEnv];
  delete env[connectorEnv];
  if (raw === undefined) return [];
  let names: unknown;
  try {
    names = JSON.parse(raw);
  } catch {
    throw new Error("Invalid managed MCP connector configuration.");
  }
  if (!Array.isArray(names) || !names.every(name => typeof name === "string" && connectorName.test(name)) ||
      new Set(names).size !== names.length) {
    throw new Error("Invalid managed MCP connector configuration.");
  }
  return names;
}

function connectorUrl(name: string): string {
  return `http://mcp.harness.internal/${name}/mcp`;
}

export function withManagedMcp(command: CliCommand, agent: "claude-code" | "codex", names: string[]): CliCommand {
  if (!names.length) return command;
  if (agent === "claude-code") {
    const mcpServers = Object.fromEntries(names.map(name => [name, { type: "http", url: connectorUrl(name) }]));
    return { ...command, argv: [...command.argv, "--setting-sources", "user", "--strict-mcp-config",
      "--mcp-config", JSON.stringify({ mcpServers })] };
  }

  // Codex loads repository config for trusted projects. The checkout remains
  // writable through the preset's container-scoped execution policy.
  const overrides = ["--ignore-user-config", "--ignore-rules", "-c", 'projects."/workspace".trust_level="untrusted"',
    "-c", `mcp_servers={${names.map(name => `${name}={url="${connectorUrl(name)}",required=true}`).join(",")}}`];
  // The preset's final positional argument is the stdin prompt marker.
  return { ...command, argv: [...command.argv.slice(0, -1), ...overrides, ...command.argv.slice(-1)] };
}
