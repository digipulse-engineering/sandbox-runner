# Changelog

All notable changes to this project are listed here.

## Unreleased

First public release. Sandbox Runner runs Claude Code, Codex and OpenCode agents, review runs, test commands and Vitest suites in Cloudflare Containers, on your own Cloudflare account.

- A CLI and a stdio MCP server submit runs, follow them and fetch their results; a remote MCP endpoint behind Cloudflare Access serves web clients such as ChatGPT and Claude.
- The Worker holds the provider credentials and adds them on the allowed outbound routes; agents reach MCP connectors through per-run policies.
- Saved and team-shared run profiles, with a team catalog of clients, profiles and optional read-only clients.
- Installations are created with `cloudflare setup`, configured in `sandbox-runner.project.json`, upgraded with `cloudflare upgrade` behind an admission guard, and protected with `cloudflare access enable`.
