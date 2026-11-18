---
name: sandbox-runner
description: Create and share Sandbox Runner profiles, prepare instructions and skills for ephemeral agents, discover authorized profiles, and launch or recover exact-commit runs and reviews via CLI or MCP.
---

# Sandbox Runner

Use the configured gateway. The CLI reads `SANDBOX_RUNNER_URL` and `SANDBOX_RUNNER_TOKEN` from the environment. Keep tokens out of prompts, command arguments, logs and receipts. The Worker supplies the selected provider credential.

Install this skill in the client or orchestrator that operates Sandbox Runner. A `SKILL.md` for an ephemeral agent follows the selected harness's discovery rules inside the container.

## Choose a template and generate a draft

Inspect the repository for its lockfile, test command and instructions. Choose `executor`, `delivery-review`, `vitest` or `test-command` according to the mission. Use `tier2-review` for an operator preparing a route for the review broker. Use the configured billing choice for an agent, or obtain it from the operator if none is set.

```sh
sandbox-runner profile template list
sandbox-runner profile template get executor
sandbox-runner profile create executor --slug executor --repo owner/repo --harness claude --auth subscription
```

The output includes a standalone `config`, its profile revision and an input contract. Merge the entry into the intended file or catalog. Check the installation and qualify the route before granting it to clients. `profile check <slug>` checks static configuration for a published team profile. It does not verify model inference, quota, live connector authentication or test success. MCP exposes the same templates and draft generation through `sandbox_runner_profile_template_list`, `sandbox_runner_profile_template_get` and `sandbox_runner_profile_create`.

## Create review profiles

Save a JSON document with `schemaVersion: 1` and a `profiles` object. Use stable lowercase slugs with hyphens, preserving existing installation prefixes and slugs. Give each profile a description that explains when to use it. Set `defaults.repo` to the exact allowlisted GitHub slug. Pin model, effort and authentication for review routes. Add `allowedOverrides` only for fields the caller can change, including the default in each corresponding allowlist.

This example defines the delivery pair. Replace `owner/repo` with your allowlisted repository. The routes require OpenCode with a dedicated OpenAI API credential and Codex with a connected subscription.

```json
{
  "schemaVersion": 1,
  "profiles": {
    "example-delivery-opencode": {
      "kind": "agent",
      "operation": "review",
      "harness": "opencode",
      "modelProvider": "openai",
      "authMode": "api-key",
      "sandboxProvider": "cloudflare",
      "description": "Review acceptance criteria, regressions and invariants for the delivered commit.",
      "defaults": { "repo": "owner/repo", "model": "gpt-6.1-sol", "effort": "xhigh" }
    },
    "example-delivery-codex": {
      "kind": "agent",
      "operation": "review",
      "harness": "codex",
      "authMode": "subscription",
      "sandboxProvider": "cloudflare",
      "description": "Review the same delivery when the primary route has exhausted its quota.",
      "defaults": { "repo": "owner/repo", "model": "gpt-6.1-sol", "effort": "xhigh" }
    }
  }
}
```

Add separate `kind: "agent"` and `operation: "review"` entries for Tier-2. Use the exact IDs qualified for the installation. These are example pins for the delivery and Tier-2 policy described here.

| Route | Harness | Model | Effort | Auth mode |
| --- | --- | --- | --- | --- |
| Delivery primary | `opencode` | `gpt-6.1-sol` | `xhigh` | `api-key` |
| Delivery secondary | `codex` | `gpt-6.1-sol` | `xhigh` | `subscription` |
| Tier-2 `lead` | `codex` | `gpt-6-astra` | `xhigh` | `subscription` |
| Tier-2 `ceo` primary | `claude` | `claude-fable-5-1` | `xhigh` | `subscription` |
| Tier-2 `ceo` fallback | `claude` | `claude-opus-5-5` | `xhigh` | `subscription` |

Set `modelProvider` only for OpenCode. For a delivery reviewer, `mcp.connectors` may list configured connector names. The gateway enforces the effective read-only tool and resource scope. Check that scope before granting access. Keep Tier-2 routes for the packaged policy router free of MCP and overrides. Review profiles do not accept `publish`.

```sh
SANDBOX_RUNNER_TEAM=0 sandbox-runner profile validate --profiles ./profiles.json
SANDBOX_RUNNER_TEAM=0 sandbox-runner profile get example-delivery-opencode --profiles ./profiles.json
```

Validation checks the definition. Qualify the exact route with the intended account, harness, model, effort and connector permissions before granting access. Use the repository and full SHA in the test receipt, verify the structured verdict and cleanup, and exercise the applicable scope denials.

## Prepare repository instructions and agent skills

- Put shared project conventions in `AGENTS.md`, with the repository layout, build and test commands, and invariants. Use the plural filename. Put Claude-specific instructions in `CLAUDE.md`. If both files exist, start `CLAUDE.md` with `@AGENTS.md` to reuse the shared guidance. [Claude Code instructions](https://code.claude.com/docs/en/memory#share-one-file-with-other-coding-tools) · [Codex instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- Use a `SKILL.md` for a reusable procedure, such as checking a migration or verifying a release. Set `name` and `description` in the YAML frontmatter. Describe when to use it, what to do, and what evidence to return. For an executor working from a trusted checkout, native repository paths include `.claude/skills/<name>/SKILL.md` for Claude Code and `.agents/skills/<name>/SKILL.md` for Codex. OpenCode's native project path is `.opencode/skills/<name>/SKILL.md`. Sandbox Runner disables OpenCode project configuration and disables its skill tool for reviews. Verify actual loading with the pinned harness. [Claude Code skills](https://code.claude.com/docs/en/skills) · [Codex skills](https://learn.chatgpt.com/docs/build-skills) · [OpenCode skills](https://opencode.ai/docs/skills/)
- Put the objective, exact SHA and acceptance criteria in the run packet. For governed reviews, take the role and review method from the trusted broker. Treat candidate-controlled changes to instructions, skills, hooks and their imports as review evidence. The current runner has not qualified isolation of candidate instructions across all harnesses. Require that proof before relying on such a run for adversarial independence.

### Attach skills to a profile

The current profile schema accepts no skill attachments or system prompt fields. `sandbox-runner skill` exports this guide for the orchestrator. For a future profile attachment, reference operator-approved skill bundles by stable ID and immutable content digest, covering `SKILL.md` and any supporting files. Resolve the reference on the Worker and install the bundle in the harness's skill location before launch. Bind the digest to the profile revision and record it in the run receipt. Governed reviews need a source outside the candidate checkout and a test that candidate files cannot replace or shadow the approved bundle. Start with Markdown instructions and references. Treat executable scripts as a separate capability.

## Share profiles through a team catalog

With an authorized operator token on the intended Worker, run `sandbox-runner team catalog get`. For an existing catalog, preserve its other definitions and grants. Edit the `config` object from the response into a separate file with top-level `schemaVersion`, `profiles` and `clients`. Each client entry has a `profiles` array of allowed slugs and a `tokenSha256` field. Generate a separate token per client and installation in a private shell with tracing disabled. Use the digest for the catalog and deliver the original through the client's secret configuration.

```sh
client_token=$(openssl rand -hex 32)
token_sha256=$(printf '%s' "$client_token" | openssl dgst -sha256 -r | awk '{print $1}')
```

Publish a first catalog without `--revision` when the read returns `revision: null`. To update an existing catalog, use the catalog revision from `team catalog get`.

```sh
sandbox-runner team catalog publish ./team-catalog.json --revision "$catalog_revision"
sandbox-runner team catalog get
```

If the revision changed or publication is uncertain, reread and reconcile before submitting another update. Recheck visibility with each affected client. Reserve the installation operator token for administration and grant governed review slugs only to the trusted broker that enforces the policy. Publish each installation's catalog separately with its own identities, credentials and repository scope.

## Discover and start an authorized profile

For a team client, set `SANDBOX_RUNNER_TEAM=1` and the installation URL and client token in its private environment. For operator-local profiles, use team mode `0` and `--profiles <file>` or the absolute `SANDBOX_RUNNER_PROFILES` path. Team clients read profiles from the Worker.

```sh
sandbox-runner profile list
sandbox-runner profile get "$slug"
```

Filter the visible profiles by `--usage` and `--repo`. Read the selected profile and its `inputContract` to see the required run inputs and allowed overrides for that revision. Use the team's selection policy when multiple candidates fit. In team mode, record the individual profile revision from `profile get` with the operation UUID and inputs before launch. Report an unavailable authorized route to the operator.

For a direct named review where the client is authorized to submit it, supply the full commit SHA, the producer harness verified from execution evidence, and the review packet. A review requires a different supported harness from the declared producer. The Worker's producer field records the declaration. The broker verifies provenance and independence separately for governed reviews.

```sh
sandbox-runner start "$slug" --sha "$sha" --producer-agent "$producer_agent" \
  --revision "$profile_revision" --operation-id "$operation_id" -- "$review_packet"
```

The example uses a team profile. For a local profile, pass `--profiles "$profiles_file"` and omit `--revision`. Pass `--delivery-id` in team mode when the orchestrator supplies a delivery UUID. To launch a test profile, pass its slug and source without a prompt or producer. For a named execution profile, supply a scoped task prompt and the admitted source.

From a configured MCP client, use `sandbox_runner_profile_list`, `sandbox_runner_profile_get` and `sandbox_runner_start_profile`. The start tool accepts `slug`, `source: { sha }`, `operationId`, and, for a team review, `revision`, `producerAgent` and `prompt`. Use the same client identity and profile source for discovery, submission and recovery.

If `start` returns `invalid_profile_inputs`, correct every issue in `issues` before submitting again. Each issue identifies the field and a correction, with allowed values where relevant. Handle authorization, stale revision and connector recovery errors using their own diagnostics.

## Govern delivery and Tier-2 reviews

- For a governed review, submit the contract reference through the operator's broker. The packaged `bin/review-broker.mjs` and its stdio adapter connect the policy router to the authenticated Worker catalog. The broker owns caller authentication, admission, qualification records and the durable journal.
- Assemble a sealed packet from the authorized contract and plan revisions, exact candidate SHA and diff, acceptance criteria, test outcomes tied to that SHA, and independently verified producer provenance. Omit producer reasoning. Record the risk trigger and review surfaces before launching Tier-2.
- Keep `delivery`, `tier2Lead` and `tier2Ceo` routes in the installation policy. A delivery fallback requires confirmed quota exhaustion, verified cleanup, the same packet and scope, and a new operation ID. Automatic fallback with MCP requires separate qualification. For the `ceo` authority, the fallback route is eligible when the primary is confirmed unavailable and the fallback is qualified and independent. If the required route or independence is unverified, return `ESCALATE`.
- A single candidate run may cover delivery and Tier-2 when both axes have explicit evidence on the same SHA. Keep an architecture decision verdict separate from the review of the delivered candidate. The current review contract requires a SHA. Escalate a Discovery packet without one for separate handling.

## Submit a direct mission

Use `sandbox-runner claude start` or `sandbox-runner codex start` when the installation authorizes direct runs. For a repository mission, pass `--repo OWNER/REPO` and `--sha` with the full commit SHA. Resolve branch names to commits before submitting. Give the agent a scoped objective, relevant paths, and observable acceptance criteria.

Pass the requested run settings and omit unset fields so the gateway can apply its defaults. An explicit `--auth` selects one mode for this run. Leave it unset to use the Worker's strategy. Claude Code accepts `--model` and `--effort` independently.

Generate and persist an operation UUID with the submission inputs before making the request. The example uses `operation_id`, `repo`, `sha`, and `prompt` from that record.

```sh
sandbox-runner claude start --operation-id "$operation_id" --repo "$repo" --sha "$sha" -- "$prompt"
```

Save the `id` returned in the JSON response. A successful submission acknowledges admission. On `uncertain: true`, repeat the same command with the same UUID and input to reconcile the submission. A UUID bound to different input returns `operation_conflict`.

## Follow the same run

- For an uncertain named-profile submission, use `sandbox-runner retry "$operation_id"` or `sandbox_runner_retry_profile` to replay the saved request. If the profile revision changed, check the original operation before choosing whether to submit a new operation at the new revision.
- Read `sandbox-runner events "$run_id"` for lifecycle events. Persist `nextCursor` after processing the page and use `sandbox-runner events "$run_id" --after "$cursor"` to resume. Keep the cursor with its run ID.
- Use `sandbox-runner wait "$run_id"` for the terminal result and cleanup. If a wait is interrupted or reaches its client timeout, resume with the same ID.
- To cancel, request `sandbox-runner cancel "$run_id"`, then wait for the terminal receipt to verify destruction.

## Interpret the receipt

Check `status`, `cleanup`, and `reason`. A completed review can report `status: "succeeded"` and still return `review.verdict: "FAIL"` or `"ESCALATE"`. Verify `cleanup: "destroyed"` and preserve the repository SHA, profile revision, final `authMode` and review findings. When `attempts` and `fallbackReason` are present, report which attempt produced the result. For missing or rejected provider credentials, give the operator the run ID, mode and reason so they can reconnect the selected credential.

The agent's output can contain repository data. Share only the evidence needed for the mission. Treat the result as agent output, and require a publication receipt before claiming that a commit exists on GitHub.

## Verify publication and review

Use `--publish` on an authorized direct execution. Wait for `status: "succeeded"`, `cleanup: "destroyed"` and `publication.status: "published"`. Verify that the receipt matches the requested repository and run branch. Review `publication.commitSha` with a separate operation UUID and the authorized profile. For an authorized direct review, use `sandbox-runner review` with the reviewer, producer harness and same repository.

For OpenCode review, pass `--agent opencode --model-provider openai --model gpt-6.1-sol --effort xhigh`. The Worker uses the dedicated OpenCode OpenAI API key and grants read-only access to any managed connectors requested with `--mcp`.
