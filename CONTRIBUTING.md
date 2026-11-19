# Contributing

Thank you for helping improve Sandbox Runner.

## Set up

You need Node.js 24 or later, Bun (to rebuild the pinned ContainerHarness runtime), Go (for the container checkout helper) and Git. Docker is needed only to build and deploy container images.

```sh
npm ci
npm --prefix worker ci --ignore-scripts
(cd worker && bash prepare-sdk.sh)
```

## Test

Run every suite before you open a pull request, as CI does:

```sh
npm test
npm --prefix worker test
(cd worker/qualification/vitest && node --test registry.test.mjs witness.test.mjs)
(cd worker/checkout && go test ./...)
```

Some Go tests run on Linux only.

To run the Worker locally against simulated provider responses, put a synthetic control token in `worker/.dev.vars`, then run `SANDBOX_RUNNER_FIXTURES=1 npm run dev` from `worker`. Point the CLI at its loopback URL with that token. The prompt `J1 fixture quota` exercises HTTP 429. For Codex subscription, `J1 fixture SSE quota` exercises a quota failure inside HTTP 200.

The CLI suite starts real child processes. If a timing test fails on a heavily loaded machine, run that file alone before reporting it.

## Change the code

- Keep a change focused on one problem and explain the reason in the commit message.
- Add or update tests for every behaviour change, including the refusal paths.
- Keep the Worker template generic: every installation builds the same `worker/cloudflare.config.ts`, and per-installation values belong in `sandbox-runner.project.json` (see [Installation settings](docs/install.md#installation-settings)).
- Never commit credentials, account identifiers or private hostnames. Tests use synthetic values and documentation addresses.
- Update the README or the matching page in `docs/` when a command, option or default changes, and add an entry to `CHANGELOG.md`.

## Agents SDK pin

ContainerHarness comes from the Agents SDK commit pinned in `worker/prepare-sdk.sh`. `npm run check:sdk` reports upstream changes to the files the runner uses. See [Keep the Agents SDK pin current](docs/install.md#keep-the-agents-sdk-pin-current) before you change the pin, and run `npm run check:sdk -- --ref <new pin>` on any bump: it refuses a commit that is not on the Agents SDK history.

## Releases

Maintainers follow `RELEASING.md`.

## Security issues

Do not open a public issue for a vulnerability. Follow `SECURITY.md`.
