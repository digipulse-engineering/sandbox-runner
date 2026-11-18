#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
pin=1a450e71325c25ca1ec8b0013d756fe0c733b6f3
checkout=${1:-${SANDBOX_RUNNER_SDK_CHECKOUT:-}}
if ! command -v bun >/dev/null; then
  echo "Bun is required to bundle the pinned ContainerHarness runtime." >&2
  exit 1
fi
stage=$(mktemp -d "$PWD/.sdk-stage.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
if [ -z "$checkout" ]; then
  checkout="$stage/git"
  git init -q "$checkout"
  git -C "$checkout" fetch --quiet --depth=1 https://github.com/cloudflare/agents.git "$pin"
fi
mkdir "$stage/pinned-src"
git -C "$checkout" archive "$pin" packages/agents/src | tar -xf - --strip-components 3 -C "$stage/pinned-src"
# Keep the upstream daemon embedded for the SDK's managed image path.
bun build "$stage/pinned-src/harness/container/runtime/main.ts" --target=node --format=esm --minify --outfile="$stage/upstream-daemon.mjs"
node --input-type=module - "$stage" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const stage = process.argv[2];
const source = readFileSync(join(stage, "upstream-daemon.mjs"), "utf8");
const digest = createHash("sha256").update(source).digest("hex");
writeFileSync(join(stage, "pinned-src", "harness", "container", "daemon-source.generated.ts"),
  "export const DAEMON_SOURCE = " + JSON.stringify(source) + ";\n" +
  "export const DAEMON_VERSION = " + JSON.stringify(digest) + ";\n");
NODE
# Bundle the product daemon from the same archive before replacing local artifacts.
cp daemon.ts claude-terminal-diagnostics.ts checkout-daemon.ts codex-publication-terminal.ts \
  mcp-native-adapter.ts opencode-daemon.ts opencode-parser.ts opencode-settings.ts run-input-validation.mjs "$stage/"
bun build "$stage/daemon.ts" --target=node --format=esm --minify --outfile="$stage/daemon.mjs"
rm -rf pinned-src
mv "$stage/pinned-src" pinned-src
mv "$stage/daemon.mjs" daemon.mjs
