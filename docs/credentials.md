# Connect credentials and choose defaults

This page shows how to connect agent credentials to the Worker and how to save default settings on it.

- [Connect or reconnect a provider](#connect-or-reconnect-a-provider)
- [Choose an authentication strategy](#choose-an-authentication-strategy)
- [Configure Claude Code defaults](#configure-claude-code-defaults)
- [Choose a sandbox provider](#choose-a-sandbox-provider)

## Connect or reconnect a provider

### Before you start

1. Install the CLI from the checkout root with `npm install -g .`.
2. Put `cf` on your PATH, or set `SANDBOX_RUNNER_CF_BIN` to the absolute path of the `cf` executable.
3. Choose the Cloudflare account ID, the deployed Worker name and the agent's authentication mode.

### Connect a credential

```sh
export CLOUDFLARE_ACCOUNT_ID='<cloudflare-account-id>'
export SANDBOX_RUNNER_WORKER='sandbox-runner-j1'
sandbox-runner auth claude --mode subscription --profile default
sandbox-runner auth codex --mode subscription --profile default
```

Set the target with environment variables or options:

| Target | Environment variable | Option |
| --- | --- | --- |
| Cloudflare account | `CLOUDFLARE_ACCOUNT_ID` | `--account` |
| Worker | `SANDBOX_RUNNER_WORKER` | `--worker` |
| Cloudflare profile | `SANDBOX_RUNNER_CF_PROFILE` | `--profile` |

The `auth` command does these steps in order:

1. It verifies the target's active Sandbox Runner version before it asks for authorization.
2. It updates the selected secret with `cf`.
3. It verifies the new active version and binding.

### Authentication modes

| Agent | `--mode` | Worker secret |
| --- | --- | --- |
| Claude Code | `subscription` | `CLAUDE_CODE_OAUTH_TOKEN` |
| Claude Code | `api-key` | `ANTHROPIC_API_KEY` |
| Codex | `subscription` | `OPENAI_SUBSCRIPTION_OAUTH_TOKEN` |
| Codex | `api-key` | `OPENAI_API_KEY` |

### Claude Code subscription

On macOS, `sandbox-runner auth` runs the local `claude setup-token` command.

1. Approve access in the browser.
2. If Claude gives you a browser authorization code, enter it in the terminal and press Enter.

Sandbox Runner captures the resulting token in memory. It publishes the token through `cf`. See [Claude Code authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token).

| Variable | Purpose | Default |
| --- | --- | --- |
| `SANDBOX_RUNNER_CLAUDE_BIN` | Selects a specific local Claude executable. | — |
| `SANDBOX_RUNNER_CLAUDE_SETUP_TIMEOUT_MS` | Sets the browser flow timeout, in milliseconds. | Ten minutes |

#### Enter the token manually

If automatic capture is unavailable, the command offers masked input. Use `--manual` to start with that prompt.

1. Run `claude setup-token` in a private terminal.
2. Paste the token at the masked prompt.
3. Press Enter, then Ctrl-D.

The CLI reads the entire paste. It removes line breaks and spaces that the terminal inserted. It then checks the Claude OAuth format.

### Codex subscription

1. In the browser on the same machine, confirm Sign in with ChatGPT.
2. Select the ChatGPT account and workspace whose plan you want to use.

The CLI saves registration metadata locally. It publishes the access token to the Worker. When the grant expires or is revoked, run the command again to reconnect.

### API keys and unattended updates

- Choose `--mode api-key` to use a key that the provider bills.
- For an unattended Claude subscription or API key update, use `--stdin`. Read the input from a protected file or your secret manager.
- The interactive masked prompt uses a POSIX terminal.

```sh
sandbox-runner auth codex --mode api-key --profile default --stdin < /path/to/protected-key-file
```

### Message language

Interactive messages for `auth` and `connector login` support English and French.

| Surface | Language source |
| --- | --- |
| Terminal | `SANDBOX_RUNNER_LANG`. Otherwise, the first nonempty setting among `LC_ALL`, `LC_MESSAGES` and `LANG`. |
| Local OAuth callback | `SANDBOX_RUNNER_LANG`. When it is unset, the browser's `Accept-Language` preferences. |

- Set `SANDBOX_RUNNER_LANG=fr` to choose French explicitly.
- Regional variants such as `fr-BE` use the French catalog.
- English is the fallback.
- The structured JSON and MCP contracts stay stable across languages.

## Choose an authentication strategy

Before you run setup, update the CLI. Then deploy a Worker from a release that supports authentication strategies.

```sh
sandbox-runner claude setup --profile default
sandbox-runner codex setup --profile default
```

Setup uses the same account, Worker and Cloudflare profile options as `auth`.

- Setup connects any missing credentials.
- Setup saves one strategy per agent on the target Worker.
- Each credential update becomes active when setup publishes it.
- The previous strategy or default mode applies until setup publishes the new choice.
- A run uses the strategy when it has no explicit mode: a CLI or local MCP run without `--auth`, or a profile whose `authMode` is `strategy` (see [Choose a credential mode](profiles.md#choose-a-credential-mode)).

| Strategy | First attempt | Second attempt after confirmed quota exhaustion |
| --- | --- | --- |
| `api-key-only` | API key | — |
| `api-key-first-then-subscription` | API key | Subscription |
| `subscription-only` | Subscription | — |
| `subscription-first-then-api-key` | Subscription | API key |

### Spending limits

For each strategy that uses an API key, configure a spending limit with the provider. Confirm the limit during setup. The provider enforces the limit, and setup records your confirmation.

### Billing

Treat API-key runs as potentially billable. The provider determines which credits apply.

- Anthropic's coverage table excludes Claude Code.
- Anthropic's help center describes some self-run `claude -p` requests as Agent SDK usage.
- The billing classification of the hosted Sandbox Runner canary remains unverified.
- OpenAI's subscription API-credit benefit excludes Codex usage through API keys.

Sources: [Anthropic coverage](https://platform.claude.com/docs/fr/about-claude/api-credits-for-subscribers#what-the-credits-cover) · [Anthropic FAQ](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans) · [OpenAI API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits#what-the-credits-cover)

### Configure a strategy from a script

1. Connect the required credentials first.
2. Pass `--strategy` explicitly.
3. For a strategy that uses a key, enable the provider limit. Then pass `--confirm-api-spend-cap`.

```sh
sandbox-runner claude setup --strategy api-key-first-then-subscription --confirm-api-spend-cap
sandbox-runner codex setup --strategy subscription-only
```

## Configure Claude Code defaults

Update the CLI. Then deploy a Worker that supports Claude defaults. Use the same Cloudflare account, Worker and profile options as `auth`.

```sh
sandbox-runner claude setup --model claude-sonnet-5-5 --effort medium
sandbox-runner run --agent claude --effort high 'Review the tests in this repository.'
```

The first command saves one or both values on the Worker. The second command overrides the effort for one run.

| Option | Worker default | Per-run override | Values |
| --- | --- | --- | --- |
| `--model` | Saved by `claude setup` | Overrides the Worker default on a new run | — |
| `--effort` | Saved by `claude setup` | Overrides the Worker default on a new run | `low`, `medium`, `high`, `xhigh`, `max` |

### Setup rules

- Run settings setup separately from auth strategy setup.
- Settings setup updates only the fields you supply. It uses your existing credentials.
- Cloudflare requires the latest Worker version to be fully deployed before it accepts this update.
- With no value configured for a field, Sandbox Runner uses its existing behavior.
- Claude Code applies the capabilities and effort limits of the selected model and account.

### Settings on a run

- Sandbox Runner keeps the selected settings with the run. This includes authentication fallback and retries with the same operation ID.
- `status` and `result` include `model` and `effort` when the Worker or the caller selected them.
- For a strategy run, `model` and `effort` also appear on each attempt.
- On the legacy submission API, per-run overrides use `POST /v3/runs`.

## Choose a sandbox provider

The sandbox provider runs the container. Cloudflare is the available provider.

### Save the default on the gateway

1. Deploy a Worker that supports provider-aware runs.
2. Run setup with the same Cloudflare account, Worker and profile options as `auth`.

```sh
sandbox-runner setup --default-sandbox-provider cloudflare --profile default
```

Setup updates `SANDBOX_RUNNER_DEFAULT_SANDBOX_PROVIDER` through `cf`. It then verifies the active Worker version. Cloudflare requires its latest Worker version to serve all traffic before the update.

### Choose the provider for a run

Use `claude start` or `codex start` to submit through `POST /v4/runs`.

```sh
sandbox-runner claude start --effort high 'Review the tests in this repository.'
sandbox-runner codex start --sandbox-provider cloudflare 'Respond with the word READY.'
```

| `--sandbox-provider` | Provider for the run |
| --- | --- |
| Omitted | The gateway's default. This is Cloudflare until you configure it. |
| Passed | The provider that you pass. |

- An unavailable provider is rejected before the Worker reserves a run.
- The gateway saves the resolved provider with the run.
- Its ID, `kind` and `sandboxProvider` appear in the submission, status and result JSON.

### Submission routes for `run --agent`

| Condition | Route |
| --- | --- |
| You pass `--sandbox-provider`. | `POST /v4/runs` |
| You supply a Codex model or effort override. | `POST /v4/runs` |
| No other v4 option applies. | The existing `/v1`, `/v2` or `/v3` route |

Use the same `status` and `result` commands for either form.
