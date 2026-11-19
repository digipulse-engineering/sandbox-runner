# Run agents, reviews and tests

This page explains how to start agent runs, reviews and test suites on a deployed Worker, and how to read their results.

- [Run a prompt](#run-a-prompt)
- [Start OpenCode](#start-opencode)
- [Start in a private GitHub repository](#start-in-a-private-github-repository)
  - [Publish a run branch](#publish-a-run-branch)
- [Use MCP connectors in Claude Code and Codex](#use-mcp-connectors-in-claude-code-and-codex)
- [Run a Vitest suite](#run-a-vitest-suite)
- [Run a test command](#run-a-test-command)
- [Review a commit](#review-a-commit)
  - [Publish and review from a shell](#publish-and-review-from-a-shell)

## Run a prompt

1. Set `SANDBOX_RUNNER_URL` to the deployed Worker URL in your shell.
2. Set `SANDBOX_RUNNER_TOKEN` to the control token.
3. Run with the configured strategy. To select one mode for this run, pass `--auth`.

```sh
sandbox-runner run --agent claude 'Respond with the word READY.'
sandbox-runner run --agent codex --auth subscription 'Respond with the word READY.'
sandbox-runner status <run-id>
sandbox-runner result <run-id>
sandbox-runner wait <run-id>
```

Each run command prints one JSON object. Each submission returns a run ID. New runs include `authMode`.

### Authentication mode

| You supply | Result |
| --- | --- |
| `--auth` | The explicit mode takes precedence. The run uses a single attempt. It requires a Worker with `POST /v2/runs`. |
| A configured strategy, no `--auth` | The run keeps its chosen strategy. |
| No strategy and no `--auth` | Claude Code uses `subscription`. Codex uses `api-key`. |

A strategy run records each attempt ID, mode, status and cleanup state under `attempts`. For a two-mode strategy:

- The second attempt starts after the first returns `provider_quota_exhausted` and its container is destroyed.
- The second attempt uses the original prompt in a fresh container.
- The result includes `fallbackReason` and the mode that produced the final result.

OpenAI can block Codex API-key access when the API organization is enrolled in an API credits promotion. The run then fails with `provider_codex_api_credit_promo_restricted`.

The quota-based strategy stays on its current attempt for this restriction. To continue, do one of these for a new run:

- Use a key from an eligible API organization.
- Explicitly select subscription authentication.

### Reconcile an uncertain submission

1. Repeat the original command with the original ID as `--operation-id`.
2. Keep the same agent, prompt and options, including any explicit auth mode or sandbox provider.
3. Retrieve the terminal result after cleanup.

A missing selected credential returns `auth_required`. Recognized quota failures return `capacity`.

### Set a run deadline

`claude start`, `codex start`, `run`, and `review` accept `--run-timeout-ms <milliseconds>`. This option selects the v4 agent API. The v1–v3 submission paths keep their existing behavior.

| `SANDBOX_RUNNER_AGENT_TIMEOUT_MS` in the [installation settings](install.md#installation-settings) | `--run-timeout-ms` | Deadline of a new v4 agent run |
| --- | --- | --- |
| Set | Not passed | The setting gives the default duration. |
| Set | Passed | The override applies. The setting caps it. |
| Not set | Passed | The run uses its own deadline. |
| Not set | Not passed | The Worker adds no deadline. |

A deadline applies from the first durable admission through startup, checkout and every authentication attempt.

- Submissions with a deadline include `deadlineAt` in epoch milliseconds. Replaying the same operation keeps that value.
- At the deadline, the Worker reports `timed_out` with reason `run_timed_out`, closes new outbound work and destroys the sandbox.
- `status`, `list` and `events` can show the timeout while cleanup is pending.
- `result` and `wait` exit `5` after confirmed cleanup. They report cleanup failure if destruction could not be confirmed.
- A strategy's attempt history keeps the outcome of each attempt.
- A provider request timeout still reports `provider_timeout`.

### Wait for a run

`wait` reads the result until the run reaches a terminal state and cleanup settles. It retries interrupted reads. It uses the same output and exit codes as `result`.

- Pass `--timeout-ms` to limit the time spent waiting.
- After a timeout or interruption, pass the same run ID to `wait` to continue.

### Cancel a run

```sh
sandbox-runner cancel <run-id>
```

Use this command on a provider-aware run. The response acknowledges the request. Use `wait` on the same ID to confirm the final outcome and cleanup.

- A completed run keeps its existing result.
- A strategy stops scheduling fallback when cancellation is requested.

### Read run events

```sh
sandbox-runner events <run-id>
sandbox-runner events <run-id> --after <cursor>
```

The first command reads the lifecycle events of a Cloudflare agent or Vitest run. The JSON response includes the run ID, the available events and `nextCursor`. Save `nextCursor` and pass it to `--after` to resume after that event.

- You can repeat a read after an interruption.
- An empty response keeps the same cursor.

| Run | Recorded history |
| --- | --- |
| All runs | Admission, observed state changes, cancellation and cleanup |
| Agent strategy runs | Also attempts and fallback |
| Vitest runs | Also the checkout, lockfile, install and test phases |
| Runs created before event tracking began | Start with a `snapshot` of their durable state |

Use `result` to retrieve the run output.

### List runs

```sh
sandbox-runner list
sandbox-runner list --cursor <cursor>
```

The first command reads the logical runs admitted by this Worker. The JSON includes `runs` and `nextCursor`. Pass the cursor to `--cursor` to continue with older runs.

- The default page has up to 24 entries. `--limit` can request a smaller page.
- A `null` cursor marks the last page.
- New admissions appear on a fresh list. They keep the position of an existing cursor.

Each entry includes the run ID, agent or test suite, provider, current status and cleanup. A strategy appears under its logical run ID.

Earlier runs stay available through their IDs. Use `result` for the run output and `events` for its history.

### Read failure reasons

The `result` command prints guidance for known failure reasons on stderr. It keeps its JSON on stdout.

| Provider response | Reported as |
| --- | --- |
| Generic HTTP 429 | `capacity` with reason `provider_capacity`, exit code 4 |
| HTTP 529 | `provider_overloaded`, with the same exit code, 4 |
| HTTP 401 | `auth_required` |
| HTTP 403 | A permission failure |

These confirmed quota signals report `provider_quota_exhausted`:

- Claude Code API-key requests with an upstream HTTP 429 and the structured Anthropic spend-cap code.
- Codex API-key requests with the pinned adapter's result for `insufficient_quota`.

Subscription failures and other provider responses keep their existing diagnostics when the agent omits a confirmed quota signal.

## Start OpenCode

OpenCode 2.2.7 is bundled in the Cloudflare agent image.

1. On a new installation, record `"SANDBOX_RUNNER_OPENCODE": "1"` in the project's [settings](install.md#installation-settings). Do this before `cloudflare deploy` or `cloudflare setup`.
2. Run `cloudflare doctor`. It shows the active capability and whether each dedicated provider binding is present.
3. Configure the API key for each provider you intend to use.

Builds from the repository checkout read `SANDBOX_RUNNER_OPENCODE=1` from the environment instead of the settings.

```sh
sandbox-runner auth opencode --model-provider openai --account <id> --worker <name> --profile default
sandbox-runner auth opencode --model-provider anthropic --account <id> --worker <name> --profile default
```

Auth uses masked input. It verifies the active Worker, then publishes through `cf`. It updates `SANDBOX_RUNNER_OPENCODE_OPENAI_API_KEY` or `SANDBOX_RUNNER_OPENCODE_ANTHROPIC_API_KEY`.

- Each run uses only its chosen provider's dedicated key.
- The key stays in the Worker.
- The selected provider bills the API usage.

```sh
sandbox-runner opencode start --model-provider openai 'Respond with the word READY.'
sandbox-runner opencode start --model-provider anthropic --effort high 'Respond with the word READY.'
```

| `--model-provider` | Route | Model | Effort |
| --- | --- | --- | --- |
| `openai` | Chat Completions | `gpt-4.1-mini` | |
| `anthropic` | Messages | `claude-sonnet-5-5` | Accepts `--effort high` |

Omit `--model` to use the selected provider's model.

| Topic | OpenCode behavior |
| --- | --- |
| Input | Accepts a prompt. Uses the v4 submission route. |
| Private GitHub workspace | Pass `--repo OWNER/REPO` and `--sha COMMIT_SHA` together. Read-only checkout with the selected provider's API key. |
| Unavailable features | Publication and subscription auth |
| Operations | The same `status`, `wait`, `result`, `cancel`, `events` and `list` |
| Reported fields | Submission, status and result include the model provider and effective model, plus effort when supplied. |
| Limits | Counts toward the installation's active-run limit. Accepts `--run-timeout-ms` for the run deadline. |
| Reconcile | Reuse the same operation ID, prompt and options. This includes the presence or absence of model, effort and deadline overrides. |
| `list` | The current CLI opts into OpenCode entries. Earlier CLIs can still list their supported runs against the new Worker and use their existing cursors. |

> **Warning:** Before you enable OpenCode on an existing installation, prepare a version you can roll back to that understands the OpenCode index filter. A version from before the filter can return OpenCode entries to earlier CLIs after the first OpenCode admission. The first-install command `cloudflare deploy` rejects existing installations.

## Start in a private GitHub repository

1. Use a GitHub App installed on the private repositories you intend to use.
2. On the Worker, configure `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_INSTALLATION_ID` and `GITHUB_APP_PRIVATE_KEY` as secrets for that GitHub App.
3. Set `SANDBOX_RUNNER_GITHUB_ALLOWLIST` to a JSON object. Map each `owner/repo` to its numeric GitHub repository ID.

```sh
sandbox-runner claude start --repo owner/repo --sha 0123456789abcdef0123456789abcdef01234567 'Review the changed tests.'
```

The Worker requests a short-lived installation token for the selected repository. The token has read access to contents and metadata. The container receives the repository slug and commit SHA without the installation token.

| Command | Repository input |
| --- | --- |
| `claude start`, `codex start`, `opencode start`, `vitest start`, `test` | `--repo` with a full commit SHA in `--sha`, or a full Git reference in `--ref`, such as `refs/heads/team/release` or `refs/tags/v2.0` |
| `review` | `--repo` with `--sha` |
| MCP repository inputs | A full SHA |

Use the allowlist's exact repository spelling. OpenCode uses the Worker's inline provider configuration, with project configuration discovery disabled.

### Start from a branch or tag

- For a new operation with `--ref`, the Worker resolves the branch or tag through the selected GitHub App before it admits the run.
- The first confirmed admission pins the commit.
- The agent starts in `/workspace` after checkout verifies the pinned SHA.
- Submission, status and result include `repository.slug` and `repository.sha`.
- When you retry, keep the original reference and operation ID, even if the branch has moved. Switching to `--sha` under that same operation ID conflicts with the original request.
- While the reference resolves, `result` reports `run_in_progress`.
- Before admission, a cancellation request returns `admission_in_progress`. Retry the cancellation once status confirms admission.
- `SANDBOX_RUNNER_API_TIMEOUT_MS` bounds reference resolution. This time comes before the run's own deadline starts.

### Checkout behavior

- If the remote does not advertise direct SHA fetch, checkout tries commits reachable from the same repository's advertised branch heads.
- Checkout fails if it cannot retrieve and verify the requested SHA within the configured deadline.
- `SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS` has a 10-minute default. Raise it in the [installation settings](install.md#installation-settings) for repositories that need more.
- Checkout skips submodule initialization, Git hooks and filters.
- Each authentication strategy attempt gets its own checkout at the same SHA.

### Publish a run branch

Pass `--publish` on `claude start` or `codex start`. This authorizes the Worker to create the branch `sandbox-runner/<run-id>` in the selected repository.

```sh
sandbox-runner claude start --repo owner/repo --sha 0123456789abcdef0123456789abcdef01234567 --publish 'Fix the failing tests.'
sandbox-runner wait <run-id>
```

- The GitHub App needs **Contents: write** permission on that repository.
- The container uses its usual read-only Git route.
- The Worker obtains the write grant for publication. It limits the grant to the selected repository.
- To set a smaller transfer budget, configure `SANDBOX_RUNNER_GITHUB_PUBLICATION_MAX_BYTES` in the [installation settings](install.md#installation-settings).

**What the Worker publishes**

- Regular tracked edits and deletions.
- Regular untracked files that the workspace's `.gitignore` rules allow.

The Worker verifies the candidate tree. It creates a commit with the supplied base SHA as its sole parent. It creates the run branch once and verifies its target.

| Field or value | Meaning |
| --- | --- |
| `publication.status` | Publication progress |
| `publication.branch`, `commitSha`, `treeSha` | Identify a verified publication |
| `no_changes` | The workspace was clean |
| `uncertain` | The branch remains ambiguous after the recovery window |
| `github_publication_run_timed_out` | The deadline expired before the reference creation claim; publication closed |

**Failures and retries**

- The agent's output stays available if publication fails.
- `wait` waits for publication and cleanup.
- A cancellation before the reference creation claim closes publication.
- After a claimed reference request, the Worker checks the branch with a read-scoped token and a fresh deadline.
- After `uncertain`, use `status` or `wait` with the same run ID to request another readback.
- Keep `--publish` unchanged when you retry the same operation ID.

**Run deadline**

- While publication is pending, `status`, `list` and `events` show the root as running.
- The deadline covers workspace export, Git object creation and the reference creation claim.
- A ref request may already have reached GitHub. In that case, readback can continue after the deadline.
- A verified branch and SHA appear in the timed-out result. `wait` exits `5` after cleanup and readback settle.

**Codex publication**

Codex publication requires Linux child subreaper and pidfd support. The supervisor verifies that all its descendants have exited before the Worker can export the workspace. The checkout timeout also bounds that drain.

In the tested local AMD64 emulation on an ARM64 Docker host, `pidfd_open` returned `ENOSYS`. The publication run stopped before it launched Codex.

## Use MCP connectors in Claude Code and Codex

Pass `--mcp` once for each configured connector.

```sh
sandbox-runner claude start --repo owner/repo --sha "$commit" \
  --mcp github --mcp tracker 'Update issue 7 with the result.'
sandbox-runner review --agent codex --producer-agent claude --repo owner/repo --sha "$commit" \
  --mcp github --mcp tracker 'Read issue 7 and verify the result.'
```

| Command | Connector access |
| --- | --- |
| `claude start`, `codex start` | Read-write |
| `review` | Read-only, regardless of the selected model or authentication mode |

The run receipt reports the assigned mode and connector names in `connectorAccess`.

These roles apply to connector calls from a run. Anyone who holds the installation control token can submit executor runs. Trust these people to use the configured write rules.

- The sandbox receives the selected connector names and talks to the internal gateway.
- The gateway applies its rules both to discovery and to each tool call.
- Model credentials and connector credentials stay on the Worker.

### Configure connectors

Set `SANDBOX_RUNNER_MCP_CONNECTORS` to a JSON object in the [installation settings](install.md#installation-settings).

| Connector field | Value |
| --- | --- |
| `url` | The HTTPS URL of the server |
| `readAuth`, `writeAuth` | Credential references |
| `read`, `write` | Arrays of rules |

| Rule field | Value |
| --- | --- |
| `tool` | The tool name |
| `match` | Exact argument values |
| `arguments` | An array of other argument names the agent may supply |

Rules for safe connectors:

- Read-write combines both rule arrays.
- Pin any argument that selects the action or resource.
- Read-only runs receive the `read` rules. Put every action that changes data in `write` only.
- A write may be attempted once per request ID. If it may have reached the connector, check its outcome upstream before you submit another run.
- After the Worker claims a write, it suppresses model-auth fallback. It reports `connectorFallbackBlocked` when a later quota failure would otherwise have switched authentication routes.

### Connector examples

| Connector | `url` | Credential reference (both modes) | `read` | `write` |
| --- | --- | --- | --- | --- |
| GitHub | `https://api.githubcopilot.com/mcp/` | `"github-app"` | Rules that pin `owner` and `repo` | An explicit write rule for Issues writes |
| Context7, public documentation | `https://mcp.context7.com/mcp` | `context7-public` | Only `resolve-library-id` and `query-docs` | Empty |
| Context7, browser authorization | `https://mcp.context7.com/mcp/oauth` | `SANDBOX_RUNNER_MCP_CREDENTIAL_CONTEXT7` | Same read-only rules | Empty |
| Paddle Sandbox (dedicated profile) | `https://sandbox-api.paddle.com/` | `SANDBOX_RUNNER_MCP_API_KEY_PADDLE_SANDBOX` | `paddle_get_price` and `paddle_get_product`, with `id` pinned | Empty |
| PostHog test project (dedicated profile) | The exact query API URL of your isolated test project | `SANDBOX_RUNNER_MCP_API_KEY_POSTHOG` | `posthog_count_events` | Empty |
| Another OAuth server, such as `tracker` | The server's exact MCP URL, for example `https://mcp.example.com/mcp` | A `SANDBOX_RUNNER_MCP_CREDENTIAL_…` secret reference for each OAuth grant | Rules that pin the action and the resource | Rules that pin the action and the resource |

**GitHub**

Rules pin `owner` and `repo` to the exact spelling in the checkout allowlist. This rule reads one issue:

```json
{"tool":"issue_read","match":{"method":"get","owner":"owner","repo":"repo","issue_number":7},"arguments":[]}
```

- An Issues write needs an explicit write rule and GitHub App **Issues: write**.
- The Worker mints repository-scoped installation tokens with **Contents: read**, plus **Issues: read** or **Issues: write** according to the run mode.
- The GitHub App must have access to the remote MCP service.

**GitHub Actions and Checks**

To inspect GitHub Actions and Checks for the run's immutable checkout SHA, add this read rule to the GitHub connector:

```json
{"tool":"get_commit_ci","match":{"owner":"owner","repo":"repo"},"arguments":["page"]}
```

- The tool returns workflow and check names, statuses, conclusions and GitHub links.
- It takes no branch, SHA, workflow or run ID from the agent. It exposes no log or artifact content.
- Grant **Actions: read** and **Checks: read** to the existing GitHub App. Approve the updated permissions on its installation.
- The Worker mints a separate installation token for this capability. The token is scoped to the selected repository and the two read permissions.

**Context7**

- For public documentation, the relay sends no credentials to Context7. Keep documentation queries generic because they leave the sandbox.
- For browser authorization, run this command against the configured Worker. The gateway pins the issuer and uses the renewable grant.

```sh
sandbox-runner connector login context7 --mode read-only --scope 'profile email offline_access'
```

**Paddle Sandbox**

- Provision a sandbox API key with `price.read` and `product.read` only.
- Pin `id` to the catalog item under test.
- The gateway returns selected standard catalog fields.

**PostHog test project**

- Set `url` to the exact query API URL, for example `https://eu.posthog.com/api/projects/123/query/`.
- Provision a personal API key limited to that project and `query:read`.
- In `read`, allow `posthog_count_events`. Pin `event` and `testRunProperty`. Allow the `testRunId` and `minutes` arguments.
- Instrument the test run to send its UUID in the configured property.
- The tool returns a fresh count for that tag over 15, 30 or 60 minutes.

**Dedicated API keys**

- Publish these dedicated keys as Cloudflare Worker secrets through `cf`, with masked input or stdin.
- Each binding is installation-wide.
- Deploy provider configuration only for environments that the corresponding key is authorized to read.
- After you rotate the key, resubmit any affected run that the credential change interrupted.

**Another OAuth server**

Pin the arguments that select the action and the resource in each rule. This read rule lists the items of one project:

```json
{"tool":"list_items","match":{"project":"01234567-89ab-4cde-8f01-23456789abcd"},"arguments":[]}
```

Repeat the login for each distinct credential reference. Select an identity with access to the pinned resource.

### Log in to an OAuth connector

```sh
sandbox-runner connector login tracker --mode read-only --scope 'items.read items.write' \
  --account "$cloudflare_account" --worker "$worker"
```

The command opens the provider's authorization page in your browser. It publishes the grant through `cf` and checks the active Worker version.

- The OAuth scopes and the provider identity still apply upstream.
- The Worker's read-only rules apply even when the grant can write.
- The stored OAuth grant is bound to its exact resource URL. When you change a connector's URL, update it in the Worker configuration. Deploy the configuration before you run `connector login` again.

`connector login` supports servers that follow the MCP authorization specification on a single origin. The server must meet these requirements:

- It publishes protected resource metadata (RFC 9728). Its `resource` is exactly the connector URL.
- That metadata names one authorization server on the same origin.
- The authorization server metadata (RFC 8414) offers dynamic client registration.
- It offers PKCE with `S256`.
- It offers the `authorization_code` and `refresh_token` grants.
- It offers the `none` token endpoint authentication method.

Otherwise the login stops with `connector_oauth_discovery_failed`.

### Recover from connector issues

The Worker renews grants on demand. It can confirm that a grant needs reconnecting before it can admit a run. Then the CLI JSON response and the Sandbox Runner MCP tool result include:

- `admission: "rejected"`
- the `operationId`
- a `connectorIssue` with the connector name and mode
- a `recovery` action

After recovery, use the same inputs and operation ID.

- A named profile can use `sandbox-runner retry <operation-id>` or `sandbox_runner_retry_profile` to submit the saved request.
- For an uncertain submission, first reconcile with the same ID.

**Reconnect from an interactive terminal**

In an interactive terminal, the CLI can offer to reconnect and retry once.

1. Set `CLOUDFLARE_ACCOUNT_ID` and `SANDBOX_RUNNER_WORKER` for the same HTTPS Runner URL.
2. The CLI verifies the active version and the Worker's enabled canonical `workers.dev` address through `cf`.
3. The CLI asks for consent. It reuses the OAuth scopes from the previous grant.

Scripted CLI calls and MCP return the action for the operator to complete. For custom domains, other routes, or unverifiable targets or scopes, run `connector login` against the intended Cloudflare Worker. Use the affected connector, mode and previously approved scopes.

**Issues on an existing run**

Read `connectorIssues` in `status`, `wait` or `result`, and `connector_issue` in `events`. A rate limit may include `retryAfterSeconds`.

| Issue | Action |
| --- | --- |
| `mcp_connector_access_denied` | Check permissions. |
| `mcp_connector_tool_unavailable` | Check the tool catalog. |
| `mcp_connector_write_unconfirmed` | Verify the outcome at the connector before you attempt the write again. |
| `mcp_connector_credential_changed` | The selected binding of an in-progress run now carries a different grant. |

New runs pin the OAuth grant generation at admission. An operator's browser reconnection creates a new grant for future runs. While a write to an MCP origin is unresolved, the run fences further writes to aliases of that origin.

## Run a Vitest suite

Use the same GitHub App, repository allowlist, Worker URL and control token.

**Repository requirements**

- The repository must commit `package.json`.
- It commits an npm v2 or v3 `package-lock.json` that installs Vitest.
- The lockfile may reference public `registry.npmjs.org` tarballs with SHA-512 integrity, and workspaces within the checkout.
- Test dependencies must install with lifecycle scripts disabled.

```sh
sandbox-runner vitest start --repo owner/repo --sha 0123456789abcdef0123456789abcdef01234567
sandbox-runner wait <run-id>
```

The dedicated Container runs these steps:

1. It verifies the requested commit and lockfile.
2. It runs `npm ci --ignore-scripts`.
3. It closes and drains the Git and npm routes.
4. It starts `vitest run` as a non-root user.

Vitest uses the repository's configuration, without agent credentials. To change the deadline that covers checkout, installation and tests, set `SANDBOX_RUNNER_VITEST_TIMEOUT_MS` in the [installation settings](install.md#installation-settings).

Use `status`, `result` and `cancel` with the run ID. The JSON reports the phase, requested repository and verified SHA, lockfile hash, runtime versions, image digest, duration and cleanup. A completed command also reports its exit code and bounded stdout and stderr.

| `wait` and `result` exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Vitest exit `1`, or cancellation |
| `5` | Timeout |
| `6` | Runtime, install or cleanup failure |

To reconcile an interrupted submission, repeat `vitest start` with these values:

- the same repository
- the original SHA or reference
- the same provider option
- the same `--operation-id`

## Run a test command

```sh
sandbox-runner test --repo owner/repo --sha 0123456789abcdef0123456789abcdef01234567 -- npm test
sandbox-runner wait <run-id>
```

Put the executable and each argument after `--`. The Worker runs these steps:

1. It verifies the exact Git checkout.
2. It installs the committed dependency lockfile with lifecycle scripts disabled.
3. It closes both network routes.
4. It runs the argument vector directly in `/workspace`.

The test command runs as a non-root user. Its `PATH` includes the project's `node_modules/.bin`. Its stdin is closed.

### Supported lockfiles

| Lockfile | Requirements |
| --- | --- |
| npm `package-lock.json` | Can have zero dependencies. Does not require Vitest. |
| Root `pnpm-lock.yaml` | Lockfile version 9. `package.json` pins an exact pnpm 10 version. No `package-lock.json` is present. |

For a pnpm lockfile:

- The sandbox uses its integrity-pinned pnpm 10 runner. It does not download a project-specified package manager.
- It accepts public npm registry packages locked with SHA-512, and links to other workspaces inside the checkout.
- The registry phase receives only the verified lockfile.
- The container closes and drains registry egress. Then it installs the workspace from that store with `--offline --frozen-lockfile --ignore-scripts`.
- The command starts after offline installation.
- The result includes `versions.pnpmVersion`.

The `vitest` suite continues to use the npm lockfile contract.

### Shallow checkout

A named `command` profile may set `"checkout": "shallow"` for commands that only need the source tree at one commit.

- Supply an exact `--sha`.
- The checkout fetches that commit at depth 1 through the same read-only Git route.
- Other profiles and raw test commands keep their default checkout behavior.

### Results and retries

Use `--operation-id` to retry a submission with the same repository, SHA, provider and ordered arguments. `status`, `wait`, `result`, `cancel` and `events` use the run ID.

- Status and result JSON identify the suite as `command`.
- The event history records phases and cleanup, without arguments or output.
- A started command reports its native `exitCode` or termination `signal`, and bounded stdout and stderr.
- The existing `SANDBOX_RUNNER_VITEST_TIMEOUT_MS` deployment setting controls the deadline for both suites.

| `wait` and `result` exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Nonzero child exit, signal or cancellation |
| `5` | Run deadline |
| `6` | Setup, launch or cleanup failure |

For example, a child exit `125` is recorded as `exitCode: 125`. An executable that the sandbox cannot launch has a diagnostic and no child exit code.

## Review a commit

```sh
sandbox-runner review --agent codex --producer-agent claude --repo owner/repo --sha COMMIT_SHA 'Check the candidate against the acceptance criteria.'
sandbox-runner wait RUN_ID
```

- Review uses a fresh container.
- It verifies the full commit SHA.
- It gives the agent GitHub read access for that repository.
- It accepts the usual agent authentication and runtime options.
- The producer and reviewer must use different agents. Supply the producer's agent alongside the candidate SHA.

### Review with OpenCode

```sh
sandbox-runner review --agent opencode --model-provider openai --model gpt-6.1-sol --effort xhigh \
  --producer-agent claude --repo owner/repo --sha COMMIT_SHA --mcp github --mcp tracker \
  'Check the candidate against the acceptance criteria.'
```

- OpenCode review uses its dedicated OpenAI API key and the public Responses API.
- It uses the qualified model and effort in the command above.
- Each named MCP connector is restricted to its Worker-configured read policy.
- OpenCode reviews can read and search the checkout.
- They cannot use shell, editing, subagent or web tools.

### Review result

A completed review has a `review` object.

| Field | Value |
| --- | --- |
| `producerAgent` | The producer's agent |
| `verdict` | `PASS`, `FAIL` or `ESCALATE` |
| `findings` | An array of findings |

- A valid verdict gives a successful run, including a verdict of `FAIL`.
- Unstructured or incomplete output gives `review_verdict_invalid`.
- The result stays available after cleanup.

### Publish and review from a shell

Set these variables before you run the block:

| Variable | Value |
| --- | --- |
| `TASK_KEY` | A unique, stable task identifier for this Worker |
| `REPO` | `owner/repo` |
| `BASE_SHA` | The full starting commit SHA |
| `MISSION` | The producer prompt |
| `CRITERIA` | The review prompt |

The shell derives a separate operation ID for each run. Use the same Worker, task key and inputs when you resume.

```sh
set -eu
: "${TASK_KEY:?Set TASK_KEY}" "${REPO:?Set REPO}" "${BASE_SHA:?Set BASE_SHA}"
: "${MISSION:?Set MISSION}" "${CRITERIA:?Set CRITERIA}"

operation_id() {
  node --input-type=module -e '
    import { createHash } from "node:crypto";
    const [task, role] = process.argv.slice(1);
    const bytes = createHash("sha256")
      .update(JSON.stringify(["sandbox-runner", task, role])).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 128;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString("hex");
    console.log([hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
      hex.slice(16, 20), hex.slice(20)].join("-"));
  ' -- "$TASK_KEY" "$1"
}

producer_id=$(operation_id producer)
reviewer_id=$(operation_id reviewer)
sandbox-runner claude start --operation-id "$producer_id" --repo "$REPO" \
  --sha "$BASE_SHA" --publish -- "$MISSION" > /dev/null
publication=$(sandbox-runner wait "$producer_id")
published_sha=$(printf '%s\n' "$publication" | node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const [id, repo, base] = process.argv.slice(1);
  const run = JSON.parse(readFileSync(0, "utf8"));
  const published = run.publication;
  if (run.id !== id || run.agent !== "claude" || run.status !== "succeeded" ||
      run.cleanup !== "destroyed" || run.repository?.slug !== repo ||
      run.repository.sha !== base.toLowerCase() || published?.status !== "published" ||
      published.branch !== "sandbox-runner/" + id || typeof published.commitSha !== "string" ||
      published.commitSha.length !== 40 || !/^[0-9a-f]{40}$/u.test(published.commitSha) ||
      published.commitSha === run.repository.sha) {
    throw new Error("The publication receipt did not identify the expected run branch and commit.");
  }
  console.log(published.commitSha);
' -- "$producer_id" "$REPO" "$BASE_SHA")
sandbox-runner review --agent codex --producer-agent claude --operation-id "$reviewer_id" \
  --repo "$REPO" --sha "$published_sha" -- "$CRITERIA" > /dev/null
sandbox-runner wait "$reviewer_id"
```

- To resume an interrupted submission or wait, run the same shell block again.
- If the producer reports no changes, the shell stops before it submits the review.
- If the receipt cannot be verified, the shell stops before it submits the review.
- Read `review.verdict` from the final JSON to decide whether the change passed review.
