# Security policy

Sandbox Runner holds provider credentials on a Cloudflare Worker and runs untrusted agent output in containers. Reports about credential exposure, sandbox escape, authorization bypass (runner tokens, team catalog, Cloudflare Access, the admission guard) or outbound policy bypass (MCP connectors, web requests) are especially welcome.

## Report a vulnerability

Report it privately through GitHub private vulnerability reporting: open https://github.com/digipulse-engineering/sandbox-runner/security/advisories/new, or use the "Report a vulnerability" button on the repository's Security tab. Do not open a public issue or pull request.

Include the affected version or commit, the configuration involved, the steps to reproduce and the impact you observed. Leave out real credentials: describe them instead.

We aim to acknowledge a report within a week and to agree on a disclosure date with you once a fix is ready.

## Supported versions

Fixes land on the latest release. Installations take them with `sandbox-runner cloudflare upgrade`.

## Operating an installation safely

- Keep the control token, the admission guard token and Access service token files private, and rotate them if they may have leaked.
- Protect the Worker's workers.dev host with Cloudflare Access (`cloudflare access enable`), and give machine clients a service token. Turn on strict service token authentication on your Zero Trust organization before binding a token to addresses.
- Give each client only the profiles it needs, and mark clients that only read with `"readOnly": true` in the team catalog.
