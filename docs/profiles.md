# Profiles, teams and MCP clients

This page explains how to save run configurations as profiles, share them with a team, and connect MCP clients to the runner.

- [Save a run configuration](#save-a-run-configuration)
  - [Create a profile from a template](#create-a-profile-from-a-template)
  - [Profile file format](#profile-file-format)
- [Share profiles with a team](#share-profiles-with-a-team)
- [Install the Sandbox Runner skill](#install-the-sandbox-runner-skill)
  - [Choose an interface](#choose-an-interface)
  - [Connect a local MCP server with a token](#connect-a-local-mcp-server-with-a-token)
  - [Connect an MCP client with your identity](#connect-an-mcp-client-with-your-identity)

## Save a run configuration

A profile is a named, reusable run configuration. You can write it from a template or by hand.

### Create a profile from a template

With an agent that has the [skill](#install-the-sandbox-runner-skill), paste:

```text
Use Sandbox Runner to create a profile for <goal> on <owner/repo> from the closest template.
Show me the draft and its input contract. Do not publish it until I agree.
```

To do it by hand:

```sh
sandbox-runner profile template list
sandbox-runner profile template get executor
sandbox-runner profile create executor --slug executor --repo owner/repo --harness claude --auth subscription
sandbox-runner profile create test-command --slug workspace-checks --repo owner/repo -- pnpm run check
```

1. Run `profile template list` to list the bundled Cloudflare templates.
2. Run `profile template get <template>` to see the creation inputs that the route requires.
3. Run `profile create` to print a draft.
4. Use the draft's `config` object as a standalone profile file. Or merge the named entry into an existing file or team catalog.
5. Verify the draft (see the checklist below).
6. Qualify the actual route on the target installation before you give the profile to clients.

The templates cover execution, delivery review, Vitest and fixed commands.

`tier2-review` is an operator template:

- It requires an exact model.
- It recommends submission through the [review broker](review-broker.md#route-governed-reviews-from-an-orchestrator).
- Authorize the correct broker identity in the team catalog.
- Configure the review policy separately.

**What the draft contains.** The generated profile revision, the input contract and `qualification: "unverified"`.

**What to verify.**

| Profile | Verify |
| --- | --- |
| All | Repository access and installation access |
| Agent | The model and the credential route |
| Test | The lockfile and the command |

For team profiles, `profile check <slug>` checks the Worker configuration for the profile's declared scope. It does not call a model, validate a live provider grant or run a test.

**Billing mode.** Each template fixes one billing mode per agent profile.

| Template | Billing mode |
| --- | --- |
| Claude, Codex | The author must choose a key or a subscription. |
| OpenCode | Key. Requires a model provider. |
| Tier-2 | Subscription, an explicit model and `xhigh`. |

Enable managed connectors and Git publication explicitly when the selected route supports them. The Worker continues to enforce repository, connector and publication policies.

### Profile file format

**File location.**

| Source | Location | Scope |
| --- | --- | --- |
| Default | `~/.config/sandbox-runner/profiles.json` or `$XDG_CONFIG_HOME/sandbox-runner/profiles.json` | CLI and its stdio MCP server |
| `SANDBOX_RUNNER_PROFILES` | An absolute path to another file | CLI and its stdio MCP server |
| `--profiles` | A path | One CLI command |

**Example file.**

```json
{
  "schemaVersion": 1,
  "profiles": {
    "review-claude": {
      "kind": "agent",
      "harness": "claude",
      "operation": "review",
      "authMode": "api-key",
      "sandboxProvider": "cloudflare",
      "defaults": { "repo": "owner/repo", "model": "claude-sonnet-5-5", "effort": "medium" },
      "allowedOverrides": { "effort": ["medium", "high"] },
      "mcp": { "connectors": ["github", "tracker"] }
    },
    "unit-tests": {
      "kind": "test",
      "runner": "vitest",
      "sandboxProvider": "cloudflare",
      "defaults": { "repo": "owner/repo" },
      "allowedOverrides": { "repo": ["owner/repo", "owner/another-repo"] }
    }
  }
}
```

**Validate and use it.**

```bash
sandbox-runner profile validate
sandbox-runner profile get review-claude
sandbox-runner start review-claude --sha "$commit" --producer-agent codex --effort high -- 'Check the candidate against the acceptance criteria.'
sandbox-runner start unit-tests --ref refs/heads/main
```

#### Profile rules

Profiles use the same repository allowlist, authentication strategies, sandbox provider and connector policies as direct runs.

- Match the repository spelling in the Worker's allowlist.
- Give each profile a repository default or an explicit list of eligible repositories.
- The Worker accepts an override only when its value is in the profile's list.
- A listed field without a profile default requires an explicit value.
- Supply a full SHA or a full ref on each run.
- A review requires a full SHA. It records the producer as the caller declares it.
- Profiles reject fields that the selected runner does not support.

#### The `usage` field

The optional `usage` field describes the profile.

| Value | Notes |
| --- | --- |
| `executor`, `delivery-review`, `tier2-review`, `test` | Must agree with the profile's runner and operation. |
| `review` (in discovery only) | Shown for an older review without an explicit usage. The stored profile and its revision stay valid. |

- `usage` helps clients select a profile.
- The team catalog and the broker policy govern authorization.
- To assign a more specific usage, publish the new revision. Then update any policy pin that refers to it.

#### Discover profiles and their inputs

| Command | Result |
| --- | --- |
| `profile list --usage delivery-review --repo owner/repo` | Filters the profiles visible to the current client. |
| `profile get <slug>` | The complete definition, its revision and `inputContract`. |

`inputContract` is a JSON Schema for the run inputs. It describes the source, the task or criteria, the producer harness and the permitted overrides.

- Pass transport fields, such as the operation UUID and the profile revision, separately.
- The Worker checks the profile grant and revision before it reports invalid inputs.
- A rejected input returns `invalid_profile_inputs` and an `issues` array.
- Each issue has `field`, `code`, `message` and, where applicable, the allowed values.
- The Worker creates no run for invalid inputs. Fix the listed fields before you resubmit.

#### Models and runner settings

| Runner | Settings |
| --- | --- |
| Claude | Accepts explicit model IDs and effort settings. An omitted setting without an override list inherits the Worker's configured default, if present. Otherwise Claude Code chooses its own default. |
| Codex | Accepts explicit OpenAI GPT and o-series model IDs, such as `gpt-6.1-sol` and `gpt-6-astra`. Reasoning effort is `low`, `medium`, `high`, `xhigh` or `max`, where the selected model and account allow it. |
| OpenCode | Requires `modelProvider`. A `start` profile uses the provider's qualified start settings. |
| OpenCode `review` | Uses `modelProvider: "openai"` with `defaults.model: "gpt-6.1-sol"` and `defaults.effort: "xhigh"`. It can select managed connectors in `mcp.connectors` for read-only access. |
| Test | Selects `vitest` or `command`. A `command` profile has a fixed `argv`. |

For Codex:

- Use `--model` and `--effort` on Codex runs, or save the settings in a named profile.
- Codex overrides use `POST /v4/runs`.
- Without a model override, API-key runs use `gpt-5.1`.
- Without a model override, subscription runs use `gpt-6.1-sol`.

Publication is an opt-in field on Claude and Codex `start` profiles.

#### Pin a credential mode

Set the optional `authMode` of an agent profile to `api-key` or `subscription`. It selects one credential mode for all submissions of the profile. OpenCode supports `api-key`.

| Profile | Caller selection |
| --- | --- |
| Pins a mode | A different CLI `--auth` or MCP `authMode` is rejected. |
| No pin | Accepts an explicit caller selection. Otherwise uses the Worker's authentication strategy. |

#### Permissions and provenance

- Named profiles are reusable configurations for callers with the operator token.
- The Worker enforces read-only MCP on reviews.
- The Worker enforces read-write MCP within configured grants on agent starts.
- A change to connector policies can narrow access for an admitted profile run.
- If callers must have different permissions, limit who receives the operator token.
- The profile receipt identifies a client-supplied definition. It marks review provenance as declared.

#### Replay a submission

Use a caller-generated `--operation-id` for automation.

| Item | Behaviour |
| --- | --- |
| Journal | The CLI saves the submitted profile and inputs, including the prompt, in a private journal. |
| Journal path | `$XDG_STATE_HOME/sandbox-runner/profile-requests` (default `~/.local/state/sandbox-runner/profile-requests`) |
| Worker origin | Saved without its token. |
| `sandbox-runner retry <operation-id>` | Replays the saved request, even after you edit or delete the profile file. |
| Identical submission | The Worker returns the original run. |
| Different submission, same ID | The Worker rejects it. |
| Run receipt | Includes the profile slug, revision and request digest. |

Use `status` or `wait` after the Worker admits the run. Remove local journal files when you no longer need to replay them.

## Share profiles with a team

A Worker operator can publish a catalog. The catalog has an allowlist of profiles for each client.

- Give each orchestrator, CI job or teammate its own client ID and token.
- Reserve the installation control token for trusted operators.
- The catalog uses the same profile bodies as local profiles.
- Claude and Codex profiles in the catalog must pin an authentication mode.
- OpenCode uses its API-key route.
- Grant a profile backed by a personal subscription only to clients authorized to consume that subscription.

```json
{
  "schemaVersion": 1,
  "profiles": {
    "executor": {
      "kind": "agent",
      "harness": "claude",
      "operation": "start",
      "authMode": "api-key",
      "defaults": { "repo": "example/project", "model": "claude-sonnet-5-5", "effort": "high" }
    },
    "reviewer": {
      "kind": "agent",
      "harness": "codex",
      "operation": "review",
      "authMode": "subscription",
      "defaults": { "repo": "example/project" }
    },
    "unit-tests": {
      "kind": "test",
      "runner": "vitest",
      "defaults": { "repo": "example/project" }
    }
  },
  "clients": {
    "lead-engineering": {
      "tokenSha256": "<SHA-256 of the engineering client token>",
      "profiles": ["executor", "reviewer", "unit-tests"]
    },
    "lead-product": {
      "tokenSha256": "<SHA-256 of the product client token>",
      "profiles": ["reviewer"]
    }
  }
}
```

### Read-only clients

Add `"readOnly": true` to a client that may only read.

A read-only client can:

- list its profiles;
- check their readiness;
- read its runs' status, events and results.

The Worker answers `403 client_read_only` to start, retry and cancel.

Use it for dashboards, brokers that collect results, or a web connector that should only look.

> **Warning: rollbacks.**
> - A catalog with a read-only client is stored where older Worker versions (from before this option) do not look.
> - If you roll back to such a version, the Worker refuses every team client. A read-only client does not gain writes.
> - A catalog published while rolled back cannot mark clients read-only. It stays in force after you roll forward.
> - After you roll forward, publish the read-only catalog again.

### Create client tokens

1. Generate a separate token for each client with `openssl rand -hex 32`.
2. Hash the exact 64-character string, without a trailing newline.
3. Put the lowercase hex digest in the catalog.
4. Deliver the original token through your secret manager.

Keep client IDs stable across rotation. Use a new ID and token for each unrelated principal.

### Publish the catalog

Before you publish:

- Put the operator token in `SANDBOX_RUNNER_TOKEN`.
- Make sure that the team-capable Worker version serves all traffic.

```sh
sandbox-runner team catalog publish team-catalog.json
sandbox-runner team catalog get
sandbox-runner team catalog publish team-catalog.json --revision "$catalog_revision"
sandbox-runner team denials
```

- To edit an existing catalog, use the revision that `team catalog get` returns.
- After a concurrent update, read the catalog again before you publish.

| Change | Action |
| --- | --- |
| Revoke a client | Remove its grant and publish the change. |
| Rotate a client token | Replace the digest on the same client ID. |

Requests authenticated before the change may finish. Admitted runs keep their policy. The operator can cancel active runs if necessary.

### Configure a team client

Set these variables for each client. Set the same variables in the stdio MCP server environment.

| Variable | Value |
| --- | --- |
| `SANDBOX_RUNNER_URL` | The Worker URL |
| `SANDBOX_RUNNER_TEAM` | `1` |
| `SANDBOX_RUNNER_TOKEN` | The client's token |

```sh
sandbox-runner profile list
sandbox-runner profile get unit-tests
sandbox-runner start unit-tests --sha "$commit_sha" --delivery-id "$delivery_uuid"
sandbox-runner list
```

**What the Worker does with team submissions.**

- It accepts team submissions by slug and exact profile revision.
- It applies the published overrides and connector policy.
- It attaches the authenticated client ID to each run receipt.
- If a human delegates to an orchestrator, the receipt identifies the orchestrator.

**Who sees which runs.**

- Clients can list, read, cancel and replay their own runs.
- The operator can inspect runs across clients.
- A delivery UUID links receipts for audit. It grants no access to the runs of other clients.

**Denial report.** It aggregates counts and timestamps by client and reason. It omits prompts, outputs and tokens.

**Lost submission response.** The profile revision can change after a response is lost.

1. Check the existing operation ID with `status` or `result`.
2. To submit against the new revision, start a new operation.

Private installations can continue to use local profiles with the operator token.

## Install the Sandbox Runner skill

```sh
mkdir -p "$agent_skills_dir/sandbox-runner"
sandbox-runner skill > "$agent_skills_dir/sandbox-runner/SKILL.md"
```

1. Set `agent_skills_dir` to a skill directory that your client loads.
2. Run the commands above to export the bundled guide from the installed CLI. The export needs no gateway or Cloudflare credentials.

The [skill](../skills/sandbox-runner/SKILL.md) covers:

- Authoring and publishing profiles.
- Discovering authorized profiles with the CLI or MCP.
- Running a review at a pinned profile revision and commit.
- Using `AGENTS.md`, `CLAUDE.md` and native repository skills for ephemeral agents.

Limits:

- To attach a skill bundle to a profile, the runner needs support beyond the current schema.
- Configure the client's gateway and token separately.
- Team grants determine which profiles the client can discover and run.

### Choose an interface

| Who | Interface | Authenticates with |
| --- | --- | --- |
| People, from ChatGPT, claude.ai, Claude Code or Codex | The remote MCP endpoint, `/mcp` | Their own sign-in through Cloudflare Access |
| Scripts, CI and other services | The CLI or the local MCP server | A runner token, plus an Access service token |
| The operator | The CLI | The control token and the Cloudflare account |

- People work through [published profiles](#share-profiles-with-a-team) on the remote endpoint.
- A profile fixes what a run may do. The person supplies the prompt and the commit.
- Sign-in is per person and you can revoke it in Access. No secret is copied to their machine.
- Use the CLI to set up and operate an installation, and for unattended runs.
- A script does not sign in, so it uses tokens.
- The CLI and the local MCP server can also start runs outside profiles, with the control token.

### Connect a local MCP server with a token

1. Register the installed `sandbox-runner` executable with the single argument `mcp`.
2. Use the stdio transport.
3. Set `SANDBOX_RUNNER_URL` and `SANDBOX_RUNNER_TOKEN` in the MCP server process environment. Use the host's private configuration.
4. Call `sandbox_runner_capabilities` first.

The tools use that gateway and its run permissions.

**Tools.**

| Task | Tool | Notes |
| --- | --- | --- |
| Read the supported routes | `sandbox_runner_capabilities` | Describes the connector's supported routes. |
| Start an agent run | `sandbox_runner_start` | |
| Review an exact commit | `sandbox_runner_review` | Uses a different agent from the declared producer. |
| Run a remote test | `sandbox_runner_vitest_start` or `sandbox_runner_test` | `sandbox_runner_test` takes an `argv` array. The executable and its arguments run inside the remote test container. |
| Inspect saved configurations | `sandbox_runner_profile_list`, `sandbox_runner_profile_get` | Discovery exposes the same input contract and profile revision as the CLI. |
| Start from a profile | `sandbox_runner_start_profile` | Takes the slug, a caller-generated `operationId`, a source and the applicable inputs. Invalid starts return the same structured `issues` as the CLI. |
| Replay a profile submission | `sandbox_runner_retry_profile` | Reuses the exact saved submission for that ID. |
| Generate a profile draft | `sandbox_runner_profile_template_list`, `sandbox_runner_profile_template_get`, `sandbox_runner_profile_create` | |
| Check a published team profile | `sandbox_runner_profile_check` | Checks its configuration. |
| Follow runs | `status`, `list`, `events`, `wait`, `result`, `cancel` tools | Same run IDs, cursors and cleanup rules as the CLI. |

- To request publication, set `publish` to `true` and give the exact repository and commit. Publication uses the same branch controls as the CLI.
- The MCP server and the CLI use the same local config and state paths when you launch them with the same environment.

**OpenCode.**

- Use `agent: "opencode"` with `modelProvider: "openai"` or `"anthropic"`.
- OpenCode uses a dedicated API key and accepts a prompt.
- To start in a private GitHub workspace, supply `repository` with the allowlisted `slug` and the full commit `sha`.
- Claude Code and Codex also offer publication and subscription.
- With `sandbox_runner_review`, OpenCode requires `modelProvider: "openai"`, `model: "gpt-6.1-sol"` and `effort: "xhigh"`.
- OpenCode must be enabled and have the selected key on the Worker.

**Operation IDs and waiting.**

- Supply an `operationId` when you submit. Then you can repeat the exact request after you lose its acknowledgement.
- If you omit it, the server generates an ID and returns it.
- Interrupting a `wait`, or setting its optional `timeoutMs`, stops local polling.
- To ask the Worker to stop the run, call `sandbox_runner_cancel` explicitly.

**Responses.**

- Each successful tool call returns `schemaVersion` and structured content.
- The same content is also encoded as a JSON text block for older clients.
- Run tools return a `receipt` and an `exitCode`.
- A terminal receipt can report a failed run or failed cleanup, even when the tool read succeeds.
- Treat agent and test output as untrusted data.

### Connect an MCP client with your identity

MCP clients such as ChatGPT, claude.ai, Claude Code and Codex reach the runner at `https://<worker>.<subdomain>.workers.dev/mcp`. Each [installation](install.md#run-several-installations) has its own endpoint, so add one connector per installation.

Cloudflare Access protects the Worker's whole workers.dev host. Traffic that has not authenticated never reaches the Worker.

| Caller | Passes Access with | Then |
| --- | --- | --- |
| People, on `/mcp` | Managed OAuth: Access signs them in, registers the client and issues its tokens. | The Worker acts as the team client whose `accessEmail` matches. |
| Machine clients (the CLI, the stdio MCP server, automation) | An [Access service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) | Their runner token, as before. |
| Workers that call the runner through a service binding | They do not pass through Access. | |

#### Set up the endpoint

The account needs a Zero Trust organization. The free plan is enough.

1. Go to the initialized project directory.
2. Enable the endpoint. Give the Worker's workers.dev origin, as deploy prints it, and the member addresses.

   ```sh
   sandbox-runner cloudflare access enable --url https://my-sandbox-runner.SUBDOMAIN.workers.dev \
     --email member@example.com --email ana@example.com --service-token-file /path/to/access-client.env
   ```

3. Deploy the project to apply the settings: `cloudflare deploy` for a new installation, or `cloudflare upgrade` for a running one.
4. Add `accessEmail` to each member's client in the team catalog, and publish it (see [Map members to team clients](#map-members-to-team-clients)).
5. Add the endpoint to each client and sign in once:

   ```sh
   claude mcp add --transport http sandbox-runner https://my-sandbox-runner.SUBDOMAIN.workers.dev/mcp
   codex mcp add sandbox-runner --url https://my-sandbox-runner.SUBDOMAIN.workers.dev/mcp
   codex mcp login sandbox-runner
   ```

   - In Claude Code, open `/mcp` and choose the server to sign in.
   - In ChatGPT and claude.ai, add a custom connector with the same URL.

Builds outside a project can set `SANDBOX_RUNNER_ACCESS_AUD` and `SANDBOX_RUNNER_ACCESS_TEAM_DOMAIN` instead. Without either the project settings or these variables, `/mcp` does not exist.

#### What `cloudflare access enable` does

- It creates a self-hosted Access application for the host.
- It allows the given addresses.
- It turns on managed OAuth with dynamic client registration.
- It records the application's audience and team domain in `sandbox-runner.project.json`. Every build of the project then includes `/mcp`.
- A rerun updates the same application.
- It refuses a host or path that another Access application already protects.

| Command | Result |
| --- | --- |
| `cloudflare access status` | Reads the application back, with the service token's expiry. |
| `cloudflare access disable` | Deletes the application and its service token. |

#### Options

| Option | Effect |
| --- | --- |
| `--url` | The Worker's workers.dev origin, as deploy prints it. |
| `--email` | A member address. Repeat it for each member. |
| `--dry-run` | Shows the application first. |
| `--service-token-file` | Creates an Access service token for the installation's machine clients. See [Service token for machine clients](#service-token-for-machine-clients). |
| `--scope mcp` | Protects `/mcp` alone and leaves the other routes to runner tokens. Keep it only for clients that cannot present a service token yet. |
| `--service-token-ip` | Accepts the service token only from the given sources. See [Service token for machine clients](#service-token-for-machine-clients). |
| `--redirect-uri` | Lists other web client redirects instead of the defaults. Repeat it for each redirect. |
| `--web-clients-only` | Refuses loopback redirects. |

A rerun with another `--scope` changes the recorded application in place. The application keeps its audience and the OAuth clients registered with it.

#### Dynamic client registration

| Client type | Accepted redirect |
| --- | --- |
| Web clients | `https://chatgpt.com/*` and `https://claude.ai/*`. Repeat `--redirect-uri` to list others instead. |
| Native clients, such as Claude Code and Codex | A loopback address (`http://localhost` or `http://127.0.0.1`, any port), as [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252#section-7.3) requires. Pass `--web-clients-only` to refuse them. |

Registration does not grant access. The person must still sign in with an allowed address.

#### Service token for machine clients

`--service-token-file` does three things:

1. It creates an Access service token for the installation's machine clients.
2. It writes the client ID and secret to that new file. Only you can read the file. The secret is shown once.
3. It admits the token with a Service Auth policy.

Give the machine clients these variables:

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_ACCESS_CLIENT_ID` | The client ID from the file |
| `CLOUDFLARE_ACCESS_CLIENT_SECRET` | The secret from the file |
| `SANDBOX_RUNNER_URL` | The Worker URL |
| `SANDBOX_RUNNER_TOKEN` | The runner token |

Wrangler reads the same names.

- Omit `--service-token-file` when no client uses the workers.dev host. For example, clients reach the runner through a facade Worker.
- Service tokens expire after a year by default. Rotate a token before then with `cf zero-trust access service-tokens rotate`.

**Restrict the token by address** with `--service-token-ip`:

- Add the option once per address or CIDR range. Use IPv4 or IPv6, given by its network address.
- The restriction applies to every machine client of the installation, because they share the token.
- It requires [strict service token authentication](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/#strict-service-token-authentication) on the Zero Trust organization.
- Without strict authentication, Access answers with a session cookie that works from any address. The command then refuses.
- Reruns keep the recorded addresses. If you pass the option again, it replaces them.

#### Map members to team clients

Add `accessEmail` to each member's client in the team catalog, in lowercase. Then publish the catalog.

```json
"clients": {
  "member": { "tokenSha256": "<SHA-256 of the client token>", "profiles": ["executor"], "accessEmail": "member@example.com" }
}
```

- Each address may appear on one client only.
- Keep the application on identity providers that verify email addresses, because the email selects the team client.
- Catalogs that use `accessEmail` require this CLI version or later for `team catalog get`.

#### What members can do

A member acts through MCP exactly as with their token: the same profiles and the same runs. Removing `accessEmail` or the client from the catalog ends web access on the next request.

The endpoint offers these tools:

- `sandbox_runner_profile_list`
- `sandbox_runner_profile_get`
- `sandbox_runner_profile_check`
- `sandbox_runner_start_profile`
- `sandbox_runner_list`
- `sandbox_runner_status`
- `sandbox_runner_events`
- `sandbox_runner_result`
- `sandbox_runner_cancel`

The endpoint has no direct start, wait or retry tool.

- Poll `sandbox_runner_status` until the run is settled.
- Starts require a caller-generated `operationId` and the profile `revision`.
- To recover an uncertain start, repeat both.
