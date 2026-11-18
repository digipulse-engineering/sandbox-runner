#!/bin/sh
# pnpm uses this marker to skip project-managed version switching, even for --version and --help.
COREPACK_ROOT=/opt/sandbox-runner-vitest exec /usr/local/bin/node /opt/sandbox-runner-vitest/tools/pnpm/bin/pnpm.cjs \
  --config.manage-package-manager-versions=false --config.package-manager-strict-version=false "$@"
