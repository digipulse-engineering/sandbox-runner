# Changelog

All notable changes to this project are listed here.

## Unreleased

First public release. Sandbox Runner runs Claude Code, Codex and OpenCode agents, review runs, test commands and Vitest suites in Cloudflare Containers, on your own Cloudflare account.

- A CLI and a stdio MCP server submit runs, follow them and fetch their results; a remote MCP endpoint behind Cloudflare Access serves web clients such as ChatGPT and Claude.
- The Worker holds the provider credentials and adds them on the allowed outbound routes; agents reach MCP connectors through per-run policies.
- Saved and team-shared run profiles, with a team catalog of clients, profiles and optional read-only clients. A Claude Code or Codex profile can set `authMode` to `strategy` to use the installation's authentication strategy, including its fallback; the Worker refuses such a run if no valid strategy is configured.
- People reach the remote MCP endpoint with their own Cloudflare Access sign-in from ChatGPT, claude.ai, Claude Code or Codex. `cloudflare access enable` accepts loopback redirects for native clients unless `--web-clients-only` is passed.
- An installation can publish its Worker on a custom domain recorded in `sandbox-runner.project.json`, next to its workers.dev address; `cloudflare access enable` then protects both.
- Codex runs can search the web from OpenAI's cached index with every auth mode. Codex subscription runs previously had web search turned off.
- Installations are created with `cloudflare setup`, configured in `sandbox-runner.project.json`, upgraded with `cloudflare upgrade` behind an admission guard, and protected with `cloudflare access enable`.
