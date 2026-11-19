# Install and operate an installation

This page tells how to deploy, configure, upgrade, check and remove a Sandbox Runner installation on your Cloudflare account.

- [Set up the Worker](#set-up-the-worker)
- [Upgrade an installation](#upgrade-an-installation)
- [Run several installations](#run-several-installations)
- [Installation settings](#installation-settings)
- [Deploy from the repository checkout](#deploy-from-the-repository-checkout)
- [Keep the Agents SDK pin current](#keep-the-agents-sdk-pin-current)
- [Check a Cloudflare installation](#check-a-cloudflare-installation)
- [Remove a Cloudflare installation](#remove-a-cloudflare-installation)

An installation is one Worker with its own Container applications, Durable Objects, secrets, team catalog and admission guard.

## Set up the Worker

You need Node.js 24 or later, Bun, Git and Docker to build the project.

### Option A: one command

```sh
sandbox-runner cloudflare setup my-sandbox-runner --account <id> --worker my-sandbox-runner --profile default --dry-run
sandbox-runner cloudflare setup my-sandbox-runner --secrets-file /path/to/sandbox-runner.secrets.env
```

`cloudflare setup` does these steps:

1. It initializes a Cloudflare project.
2. It installs the locked dependencies of the project.
3. It verifies your Cloudflare account.
4. It builds both Container applications.

Setup behavior:

- Setup reuses an initialized project that matches the installed CLI template.
- It then reads the account, Worker and profile from the manifest.
- It keeps the project if preparation, sign-in or deployment must be retried.
- The first deployment needs a [secrets file](#create-the-secrets-file).
- Connect the agent credentials after deployment.

### Option B: one step at a time

Use these commands to prepare and deploy a project that you customized and reviewed.

```sh
sandbox-runner cloudflare init my-sandbox-runner --account <id> --worker my-sandbox-runner --profile default
cd my-sandbox-runner
npm ci
sandbox-runner cloudflare login
sandbox-runner cloudflare deploy --dry-run
```

| Command | What it does |
| --- | --- |
| `cloudflare init` | Writes only local project files. Records the account, Worker, optional profile and ContainerHarness pin in `sandbox-runner.project.json`. |
| `npm ci` | Installs the locked Worker dependencies that the project includes. |
| `cloudflare login` | Uses the Cloudflare profile recorded in the project and verifies access to its account. |
| `cloudflare deploy --dry-run` | Runs the [deploy checks](#what-deploy-checks) without the real upload. |

The project also includes an unmodified copy of the Worker configuration. That configuration reads the installation's settings from the manifest (see [Installation settings](#installation-settings)).

`cloudflare login` details:

- It reuses a working profile.
- It starts the `cf` browser sign-in when needed. See [Cloudflare CLI sign-in](https://developers.cloudflare.com/cf/get-started/#sign-in).
- Pass `--force` to sign in again.
- Pass `--no-browser` to approve the link from another device.
- Run it from the generated project directory, or pass the directory as an argument.

### Create the secrets file

The first deployment needs a private dotenv file with two tokens:

| Variable | Value |
| --- | --- |
| `SANDBOX_RUNNER_TOKEN` | The control token. |
| `SANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN` | The [admission guard](#freeze-admissions-before-changing-worker-versions) token. |

```sh
umask 077
{ printf 'SANDBOX_RUNNER_TOKEN=%s\n' "$(openssl rand -hex 32)"
  printf 'SANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN=guard-%s\n' "$(openssl rand -hex 32)"; } > /path/to/sandbox-runner.secrets.env
sandbox-runner cloudflare deploy --secrets-file /path/to/sandbox-runner.secrets.env
```

1. Create the file with the commands above.
2. Keep both tokens in your operator secret store.
3. Pass the file path as `--secrets-file`.
4. After deployment, connect agent credentials with `sandbox-runner auth` or agent setup.

> **Warning:** The guard must exist before the first run. It tracks every admission from then on, so `cloudflare upgrade` can freeze and drain runs. You cannot add it to an installation that already ran.

### What deploy checks

1. `cloudflare deploy` checks the project's account and ContainerHarness pin.
2. It builds the initialized Worker in an isolated directory.
3. It validates the prebuilt output with `cf deploy --dry-run`.
4. The real upload requires free names for the Worker and its Container applications.

- Cloudflare applies uploads as upserts. Coordinate first deployments to the same names across operators.
- If the CLI returns `uncertain: true`, run `cloudflare doctor`. Then check the account's Container applications before you retry or change resources.

## Upgrade an installation

Install the new CLI release. Then upgrade each installation from its project directory.

```sh
sandbox-runner cloudflare upgrade my-sandbox-runner --dry-run --guard-url https://my-sandbox-runner.SUBDOMAIN.workers.dev --guard-token-file /path/to/guard.json
sandbox-runner cloudflare upgrade my-sandbox-runner --guard-url https://my-sandbox-runner.SUBDOMAIN.workers.dev --guard-token-file /path/to/guard.json
```

### Options

| Option | Use |
| --- | --- |
| `--guard-url` | The origin where the guard accepts a bearer token. Use the workers.dev host, or a loopback bridge. When Access protects the host, put the [Access service token](profiles.md#connect-an-mcp-client-with-your-identity) in the environment. |
| `--guard-token-file` | A file with the guard token. The token is alone, or is `SANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN` in a JSON or dotenv file. |
| `--dry-run` | Reports the files to replace. When the project already matches, it also builds and checks the deployment. It changes nothing. |
| `--upgrade-id <uuid>` | Continues after exit code `4` when the guard is drained. It also adopts a closure that you made yourself. |
| `--without-guard` | For an installation created before guards were required. See [Upgrade without a guard](#upgrade-without-a-guard). |

### What upgrade does

1. It reads the installation and its guard.
2. It replaces the project's template files with the files of this release.
3. It keeps `sandbox-runner.project.json`.
4. It runs `npm ci`.
5. It follows the [version-change procedure](#freeze-admissions-before-changing-worker-versions):
   1. It checks that one version serves all traffic. It records that version as the rollback target, with the installation's Container applications and Durable Object namespaces.
   2. It closes the admission guard. If runs are still draining, it stops with exit code `4` and the closure's `upgradeId`. Run it again with `--upgrade-id <uuid>` when the guard is drained.
   3. It deploys the build. The Worker keeps its secrets.
   4. It checks that the new version serves all traffic with the same Container applications and namespaces. It also checks that the guard reports the same drained closure from the new version.

The manifest records the template only after `npm ci` succeeds. If upgrade fails, run it again: it repeats the installation.

### Refusals and errors

- Upgrade switches versions of an unchanged topology only.
- It refuses a release or manifest that adds or renames a Durable Object or Container application (`cloudflare_upgrade_topology_changed`).
- It detects this after it replaces the template files. The project keeps those files.
- Such a release needs its own migration.
- Any error after the guard closed names the closure that keeps admissions frozen.

### After upgrade

The receipt lists the previous and new versions. Under `guard.reopen`, it gives the request that reopens admissions.

1. If the receipt reports `uncertain: true`, check the Worker before you reopen. Its message names the previous version.
2. Check the new version.
3. Send the `guard.reopen` request. Upgrade never reopens admissions.
4. Run a [canary](#inspect-and-test-the-installation). Upgrade verifies the deployment, not a run. The canary exercises the Worker, the container runtime and the agent together.

### Upgrade without a guard

An installation created before guards were required has no guard. Pass `--without-guard`.

- Nothing freezes admissions.
- Upgrade switches only when no container instance is active, assigned, starting or being scheduled.
- Otherwise it returns `cloudflare_upgrade_runs_active`.

> **Warning:** A run admitted between that check and the switch can still be interrupted.

## Run several installations

To keep two teams, projects or environments apart, create one installation for each. Each installation is a separate project directory with its own Worker name.

```sh
sandbox-runner cloudflare init runner-team-a --account <id> --worker runner-team-a
sandbox-runner cloudflare init runner-team-b --account <id> --worker runner-team-b
```

- Installations share nothing at run time.
- A failed deployment, a closed admission guard or a leaked credential stays within its installation.
- Profiles, clients and runs belong to one installation. Profile names do not need to be unique across installations.
- Every project contains the same Worker template. Only `sandbox-runner.project.json` differs.
- Projects initialized by earlier releases carry a rewritten `cloudflare.config.ts`. `cloudflare upgrade` replaces it with the shared template.

| Situation | Use |
| --- | --- |
| The same people may run any profile of the installation. | One installation for several projects. |
| The credentials, repositories or people must stay apart. | Separate installations. |

## Installation settings

Record what makes an installation different in its `sandbox-runner.project.json`. Every build of the project reads this file: `cloudflare deploy`, `cloudflare upgrade` or a manual `cf deploy` from the project directory. A new release then replaces only the template files.

```json
{
  "schemaVersion": 1,
  "worker": "runner-team-a",
  "maxConcurrentRuns": 4,
  "settings": {
    "SANDBOX_RUNNER_OPENCODE": "1",
    "SANDBOX_RUNNER_MCP_CONNECTORS": {
      "github": { "url": "https://api.githubcopilot.com/mcp/", "readAuth": "github-app", "writeAuth": "github-app",
        "read": [{ "tool": "issue_read", "match": { "method": "get", "owner": "owner", "repo": "repo", "issue_number": 7 }, "arguments": [] }],
        "write": [] }
    }
  }
}
```

### Manifest entries

| Entry | Written by | Effect |
| --- | --- | --- |
| Account, Worker, profile, limit (`maxConcurrentRuns`) | `init` | Identify the installation and its run limit. |
| `access` | `cloudflare access enable` | Adds the Access block. |
| `domain` | You | Publishes the Worker on a custom domain. See below. |
| `containers.agent.name` | You | Keeps an existing agent Container application whose name differs from the Worker name. |
| `settings` | You | Sets the Worker's plain-text options. See [Worker settings](#worker-settings). |

`domain`:

- Use a domain such as `sandbox-runner.example.com`, on a zone of the installation's Cloudflare account.
- Deploying creates the domain and its DNS record. The workers.dev address stays enabled.
- Run `cloudflare access enable` again after you add the domain. The Access application then protects both addresses.
- The MCP URL becomes `https://<domain>/mcp`.
- Clients connected to the workers.dev address keep working. Reconnect them to the new URL when convenient.

`containers.agent.name`:

- Do not change it on a deployed installation. `cloudflare destroy` checks the receipt against it.

### Worker settings

| Setting | Default | Notes |
| --- | --- | --- |
| `SANDBOX_RUNNER_OPENCODE` | | |
| `SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS` | 10 minutes | Bounds the container's Git fetch. No request waits on it. |
| `SANDBOX_RUNNER_API_TIMEOUT_MS` | 25 seconds | Bounds each Worker operation against GitHub or an MCP connector. See [Deadlines](#deadlines). |
| `SANDBOX_RUNNER_GITHUB_PUBLICATION_MAX_BYTES` | | |
| `SANDBOX_RUNNER_VITEST_TIMEOUT_MS` | 15 minutes | At most six hours. |
| `SANDBOX_RUNNER_AGENT_TIMEOUT_MS` | | |
| `SANDBOX_RUNNER_MCP_CONNECTORS` | | JSON option. Write it as JSON or as text. |
| `SANDBOX_RUNNER_GITHUB_ALLOWLIST` | | JSON option. Write it as JSON or as text. It is usually a Worker secret. Record it here only if the installation has no secret of that name. |

### Validation

- The CLI and the build reject an unknown entry, an out-of-range timeout or malformed JSON.
- The Worker validates the other values when it admits a run.
- A project build reads these settings from its manifest only. Values exported for another installation never reach it.
- Builds from the repository checkout, without a manifest, read them from the environment, except the allowlist.
- `cloudflare deploy`, `cloudflare setup` and `cloudflare upgrade` refuse to run while one of these settings, other than the allowlist, is exported. They do not ignore it.
- Secrets stay on the Worker. They never belong in the manifest.
- Every installation keeps SSH and log collection off for both Container applications. The containers handle run credentials and output.

### Deadlines

These deadlines are failure containment, not targets. Work that finishes earlier is not affected. Set them from durations observed on your repositories.

The API deadline bounds these operations:

- Resolving the commit.
- Checking connectors.
- Preparing or reconciling a run branch's publication as a whole.

Some of these operations run while a start, status or result request waits.

- Keep the API deadline under the CLI's request timeout (`SANDBOX_RUNNER_TIMEOUT_MS`, 30 seconds by default).
- A start that resolves a commit and checks OAuth connectors can wait for the resolution plus up to 30 seconds.
- Very large publications may need a higher value. Those requests then wait longer.

### Container images

- Each build also builds both container images from the template's Dockerfiles. The images always match the Worker and its daemon.
- The Dockerfiles pin their base images by digest, and their tools by version and checksum.
- Cloudflare tags each build by its content. It reuses an unchanged image and does not push it again.
- The machine that deploys needs Docker.

## Deploy from the repository checkout

The repository checkout also contains the Worker source. Install Node.js 24 or later, Bun, Git and Docker.

1. Optional: the installation fetches ContainerHarness at commit `1a450e71325c25ca1ec8b0013d756fe0c733b6f3`. To build from an existing Agents SDK checkout that contains this commit, set `SANDBOX_RUNNER_SDK_CHECKOUT` to its path before you run `npm ci`.
2. From the checkout, build and check the Worker:

   ```sh
   cd worker
   npm ci
   npx --no-install cf auth whoami
   npx --no-install cf deploy --dry-run
   ```

3. Create a secrets file outside the checkout, readable only by you. Put `SANDBOX_RUNNER_TOKEN` and `SANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN` in it, as for `cloudflare deploy`.
4. Deploy the Worker with that file:

   ```sh
   npx --no-install cf deploy --secrets-file /path/to/sandbox-runner.secrets.env
   ```

## Keep the Agents SDK pin current

ContainerHarness comes from the sources of the [Agents SDK](https://github.com/cloudflare/agents), not from an npm release. The pinned commit is in `worker/prepare-sdk.sh`. Maintainers check this pin before each release.

```sh
npm run check:sdk
npm run check:sdk -- --ref agents@0.33.0
```

How the check works:

- It needs `worker/pinned-src`. `npm ci` in `worker/` prepares it.
- It follows the imports of the Worker and the container daemon into the pinned source. This finds the SDK files that they use.
- It asks GitHub which files changed between the pin and the ref (`main` by default).
- It prints the changed files that the runner uses, other changes under `harness/`, and the commits in between.
- Set `GH_TOKEN` to raise GitHub's rate limit.

| Exit code | Meaning |
| --- | --- |
| `0` | No used file changed. |
| `1` | At least one used file changed, or GitHub truncated the comparison. |
| `2` | The check could not run. |

When a used file changed:

1. Read those commits.
2. To take them, set the new commit in `worker/prepare-sdk.sh` and in [Deploy from the repository checkout](#deploy-from-the-repository-checkout).
3. Run `npm ci` in `worker/` to rebuild ContainerHarness and the daemon.
4. Run the tests and the local smoke runs.
5. Release.
6. Each installation takes the release with `cloudflare upgrade`, and a canary when admissions reopen.

## Check a Cloudflare installation

### Limit concurrent runs on a new installation

Pass `--max-concurrent-runs <count>` to `cloudflare init` or `cloudflare setup` when you create a new installation. Use a positive integer.

- The project manifest records the value.
- The first deployment verifies that the Worker, Container applications and associated Durable Object namespaces are new.
- The deployment receipt reports the chosen limit.

How slots work:

- Each admitted operation ID occupies one slot, from reservation to confirmed sandbox destruction.
- An authentication strategy shares its slot across attempts.
- Reviews and test runs use the same limit.
- An unfinished publication or a failed cleanup keeps the slot.
- The Worker reconciles released slots from the durable run state. A new submission can still see `installation_capacity` for a short time after cleanup.

| Result | CLI exit code | What to do |
| --- | --- | --- |
| `installation_capacity` | `4` | The installation is full. |
| `admission_unconfirmed` | `6` | The admission is uncertain. Repeat the same input and operation ID to reconcile. |

Existing runs stay readable and replayable at capacity.

Installations created without a limit stay unconfigured. The first-deployment option applies to new installations only. To enable a limit on an existing installation, you need an attested drain of its earlier runs.

### Freeze admissions before changing Worker versions

`cloudflare deploy` installs the `SANDBOX_RUNNER_ADMISSION_CONTROL_TOKEN` secret with the first version, from the secrets file. `cloudflare upgrade` drives the protocol below. The table documents it for operators and other tooling.

The guard token:

- Its format is `guard-` followed by 64 lowercase hexadecimal digits.
- Store it separately from the run and team credentials.
- The operator API uses it as the `Authorization: Bearer` credential.
- Run and team credentials cannot use the operator API.
- The guard token cannot submit runs.
- Use the installation's authenticated ingress.

| HTTP request | Effect |
| --- | --- |
| `GET /v4/admissions/guard` | Read the persisted closure, responding Worker version, pending count and page of unsettled admissions. |
| `GET /v4/admissions/guard?after=GENERATION` | Continue the pending page using the preceding `nextCursor`. |
| `POST /v4/admissions/guard` with `{"action":"close","upgradeId":"UUID"}` | Start or reread the same closure and record its generation. |
| `GET /v4/admissions/guard/UUID` | Read the tracked operation's client, generation and reconciliation state. |
| `POST /v4/admissions/guard` with `{"action":"open","upgradeId":"UUID","generation":"N"}` | Reopen the same closure or abort its drain. A stale or conflicting operation returns HTTP 409. |

While the guard is closed:

- Fresh submissions receive `installation_maintenance`.
- Matching requests can still replay their recorded run.
- They can still use status, result, list, events and cancel.

Drain rules:

- A pending UUID is fenced before a run exists, or reconciled to terminal cleanup and its exact client row in the index.
- A cleanup failure or a client index mismatch blocks drainage.
- The recorded reply for a fenced UUID is different from a 404 for an unknown UUID.
- Track unresolved admissions from CLI journals. Use the same operation IDs for reconciliation.

Limits of the guard:

- The guard adds no concurrency ceiling.
- Existing installations with untracked history may still admit runs while the guard is open.
- Closing stops fresh submissions. `legacy_unverified` means that the Worker cannot prove their drainage.
- No override certifies these historical operations.

Procedure for a version change:

1. Assign one operator or deployment process to serialize close, drain, version switch and reopen.
2. Close the guard.
3. Require `drained` for the exact closure ID and generation.
4. Before the switch, verify the serving Worker version and the unchanged `RunIndex` namespace with `cf`.
5. Switch the version.
6. Confirm 100% traffic on the intended version.
7. Read back the same closure, generation and namespace.
8. Reopen the guard.

> **Warning:** Both versions in a rollback must enforce this protocol. If an older version does not have it, keep an independent ingress freeze through the version change. Restore a guard-compatible deployment before you reopen those admissions.

### Inspect and test the installation

#### Doctor

```sh
sandbox-runner cloudflare doctor --account <id> --worker <name> --profile default
```

Doctor uses the same target flags and environment variables as `auth`. It makes read-only Cloudflare API calls. It reads:

- The selected account.
- The Worker version that serves all traffic.
- The Sandbox Runner binding metadata.
- The link from the `Run` Durable Object to its Container application.

Its JSON reports each known provider credential binding as `present`, `missing` or `invalid`.

| Result | Meaning |
| --- | --- |
| `ready` | The Cloudflare checks passed and at least one provider credential binding is present. |
| Exit code `3` | Setup is incomplete, or a check is not verified. |
| Exit code `5` | The diagnostic took longer than `SANDBOX_RUNNER_TIMEOUT_MS`. |

Doctor does not check credential validity or container startup. These need a canary run.

#### Canary

The canary runs against the deployed gateway selected by `SANDBOX_RUNNER_URL` and `SANDBOX_RUNNER_TOKEN`.

```sh
sandbox-runner cloudflare canary claude --auth subscription --timeout-ms 120000
sandbox-runner cloudflare canary codex --auth api-key --timeout-ms 120000
sandbox-runner cloudflare canary vitest --repo OWNER/REPO --sha COMMIT_SHA --timeout-ms 120000
```

| Option | Use |
| --- | --- |
| `--auth` | Choose a mode to test its credential directly. Omit it to exercise the configured strategy. |
| `--repo` and `--sha` | Supply them together to exercise a private checkout. The Vitest canary requires both. |
| `--operation-id` | Keep the ID before submission. Repeat the same command with this ID and options to recover an uncertain submission. |

- Claude Code and Codex canaries require the agent to return a value derived from the run ID.
- The Vitest canary expects the suite at that commit to pass.
- All three canaries wait for verified container cleanup.
- The JSON receipt reports the run ID, outcome and cleanup. Vitest also reports its verified commit and image digest.
- To continue waiting after the CLI stops, use `wait` with the same ID. Or repeat the canary to verify its success condition.

## Remove a Cloudflare installation

1. Save the JSON receipt from a successful `cloudflare setup` or `cloudflare deploy` command.
2. Go to the initialized project directory.
3. Preview the removal with the receipt.
4. Confirm the removal with the same receipt.

```sh
sandbox-runner cloudflare destroy --receipt /path/to/deploy.json --dry-run
sandbox-runner cloudflare destroy --receipt /path/to/deploy.json
```

What destroy verifies:

- It uses the project account and Cloudflare profile.
- It verifies the receipt's version in the Worker's history and the single active version.
- It verifies the exact Container application and Durable Object namespace identities.
- `--dry-run` only reads Cloudflare metadata. It reports which verified resources are present.

The receipt's version only has to be in the history, because credential rotations and settings changes can activate a new version of the same installation.

What the real command does:

1. It deletes the Worker by its Cloudflare ID. This removes its versions and run history.
2. It removes any of its attested Container applications still present afterward.
3. It confirms that the Worker, those applications and their namespaces are absent.

- Coordinate changes to the installation with other operators during removal.
- If a response is lost, the CLI checks the inventory before it continues.
- If it returns `uncertain: true`, inspect with `--dry-run` and the same receipt before you resume.

The JSON reports `images: "retained"`. The receipt identifies the installation, but registry tags may have other consumers. Review those tags separately if you want to remove them.
