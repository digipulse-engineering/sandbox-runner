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

The CLI suite starts real child processes. If a timing test fails on a heavily loaded machine, run that file alone before reporting it.

## Change the code

- Keep a change focused on one problem and explain the reason in the commit message.
- Add or update tests for every behaviour change, including the refusal paths.
- Keep the Worker template generic: every installation builds the same `worker/cloudflare.config.ts`, and per-installation values belong in `sandbox-runner.project.json` (see "Installation settings" in the README).
- Never commit credentials, account identifiers or private hostnames. Tests use synthetic values and documentation addresses.
- Update the README when a command, option or default changes, and add an entry to `CHANGELOG.md`.

## Agents SDK pin

ContainerHarness comes from the Agents SDK commit pinned in `worker/prepare-sdk.sh`. `npm run check:sdk` reports upstream changes to the files the runner uses. See "Keep the Agents SDK pin current" in the README before you change the pin, and run `npm run check:sdk -- --ref <new pin>` on any bump: it refuses a commit that is not on the Agents SDK history.

## Releases

Maintainers follow `RELEASING.md`.

## Security issues

Do not open a public issue for a vulnerability. Follow `SECURITY.md`.
