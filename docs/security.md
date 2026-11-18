# Security model

This document states what Sandbox Runner protects, how, and what it leaves to you. It describes the code on `main`. To report a vulnerability, follow [SECURITY.md](../SECURITY.md).

It follows the four questions of the [Threat Modeling Manifesto](https://www.threatmodelingmanifesto.org/): what are we working on, what can go wrong, what do we do about it, and did we do a good enough job.

## What we are working on

Sandbox Runner runs coding agents (Claude Code, Codex, OpenCode), test commands and Vitest suites in Cloudflare Containers, on your own Cloudflare account. A Worker receives each request, starts one container for the run and stores the result in Durable Object storage.

The agent works with real credentials: a model provider key or subscription, a GitHub App and, optionally, MCP connectors. It also reads content nobody has reviewed: the repository, tool results and web pages. A prompt injection in that content can steer the agent, so the design treats everything inside the container as untrusted.

### Trust boundaries

| Zone | Trust | Holds |
| --- | --- | --- |
| Operator | Trusted | The control token, the admission guard token, the Cloudflare account |
| Team client | Limited | Its own token; only the profiles the operator granted |
| Worker and Durable Objects | Trusted | All provider credentials, policies, run results |
| Container | Untrusted | The checkout, the agent process, placeholders in place of credentials |
| Upstream services | External | Model providers, GitHub, MCP servers, the npm registry |

Requests cross three boundaries, and each has its own check:

1. **Caller to Worker.** A runner token, and Cloudflare Access when you enable it.
2. **Container to Worker.** The container has no internet access. It reaches only hosts that the Worker intercepts.
3. **Worker to upstream.** The Worker adds the credential, on a fixed route, after applying the run's policy.

## What you can expect

### Credentials stay on the Worker

- Provider credentials are Worker secrets. The container receives placeholders.
- On the model route, the Worker drops any credential header the container sent, sets the real one, and strips credential headers from the response.
- GitHub tokens are minted by the Worker for each use and are never sent to the container. A checkout token covers one repository with read access to contents. The Worker verifies the scope and expiry that GitHub returns.
- For MCP connectors, the container receives connector names only. OAuth grants and API keys stay on the Worker.

### The container has no general network access

Containers start with internet access disabled. The only destinations are hosts the Worker intercepts:

| Run | Reachable through the Worker |
| --- | --- |
| Agent run | One model provider endpoint; Git read of the run's own repository; the configured MCP connectors, read-write |
| Review | The same, with MCP connectors read-only |
| Vitest and test commands | Git read of the run's repository; npm tarballs listed in the lockfile, with integrity hashes, during the install phase only |

- The model route accepts one POST path per provider and does not follow redirects.
- The Git route accepts only the two fetch requests of the run's own repository. The repository must be on the installation's allowlist.
- For Vitest and test commands, the network closes before the tests run.
- All routes close when the run ends, is cancelled or passes its deadline.

### MCP connectors follow per-run rules

- The gateway forwards only `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`.
- A tool call must match a rule: exact values for the pinned arguments, and only the other argument names the rule allows. Tool discovery shows only the allowed tools.
- Review runs get the read rules only. A rule cannot be both read and write.
- A write is claimed once per request ID. Once a run has claimed a write, the Worker does not retry it through another authentication route.
- A reply that contains the connector's token verbatim is rejected. An encoded or split copy is not detected.

### Publication goes through the Worker

The container never holds a credential that can write to GitHub.

- The Worker exports the changed files after every agent process has exited. The export refuses symlinks, hard links, submodule changes, special files and unsafe names such as `.git`.
- The Worker checks the export's hashes and paths again, then creates the commit itself.
- It creates one branch, `sandbox-runner/<operation ID>`, only if that branch does not exist, and only after it has confirmed that the container is destroyed.
- Reviews and OpenCode runs cannot publish.

### Each run is isolated and cleaned up

- Each run, and each authentication attempt of a run, gets its own Durable Object and its own container.
- Results are stored outside the container.
- The container's filesystem is never saved or restored. The Worker refuses the agent runtime's workspace snapshots, so the checkout and the agent's files disappear with the container.
- At the end of a run, the Worker destroys the container and verifies that it is gone. It retries on failure and records `cleanup: "failed"` if it cannot confirm.
- Agent CLIs, test commands and the checkout run as an unprivileged user (uid 10001). The publication snapshot and export steps run as root, after every agent process has exited.

### Callers are authenticated and separated

- The control token and team tokens are compared as SHA-256 digests in constant time. The Worker stores only the digests of team tokens. A request with a missing or wrong runner token gets a 404.
- A team client can submit only the profiles the operator published for it, and can read, list and cancel only its own runs. A `readOnly` client cannot start or cancel anything.
- The admission guard token can only freeze and reopen admissions. It cannot submit runs, and the control token cannot operate the guard.
- The remote MCP endpoint (`/mcp`) exists only behind Cloudflare Access. The Worker checks the Access audience, maps the verified email to one team client, and never grants operator rights on this route. Browser requests are accepted only from the Worker's own origin and from `chatgpt.com`.

### The supply chain is pinned

- Base images are pinned by digest. OpenCode, pnpm and the Go modules are verified against hashes.
- The Agents SDK runtime is pinned to a commit, and deployment refuses another one.
- GitHub Actions are pinned by commit. Releases are staged on npm from CI with a provenance statement and need a maintainer's approval with two-factor authentication. See [RELEASING.md](../RELEASING.md).
- The public repository is configured to run CodeQL, secret scanning and Dependabot. These are repository settings, so a fork does not inherit them.

## What you cannot expect

These limits are part of the design or are not solved yet. Plan for them.

- **A prompt injection can still steer the agent.** The agent runs with its own permission prompts turned off, because nobody is there to answer them. The design limits what a steered agent can reach. It does not prevent the steering.
- **Data can leave through the allowed routes.** The agent can put repository content in a model request, in an MCP tool call that a rule allows, or in a published branch. The Worker does not inspect model request bodies, so it does not block tools that run on the provider's side, such as web search, except for the Codex subscription route.
- **A "read-only" review is not enforced inside the container for Claude Code and Codex.** They are instructed not to edit, and they cannot publish, but they can change files in their disposable checkout. Only OpenCode reviews deny editing and shell tools. MCP read-only rules are enforced for every review.
- **The control token is full authority.** Its holder can submit any run and use every write rule. Give team clients their own tokens and profiles.
- **Connector rules are yours to write.** The gateway enforces the pins you configure. A broad rule, or a mutating action listed under `read`, is honoured as written.
- **A connector write may be applied once even if the run then fails.** Check the upstream system before you submit the run again.
- **No spending limit is enforced.** Set limits with your model provider. No agent deadline applies unless you configure one.
- **Run output is stored as the agent produced it.** It can contain anything the agent read, and nothing redacts it. Treat it as untrusted data when you display it or pass it to another agent.
- **Run data is kept until you remove the installation.** Results, events and the run index stay in Durable Object storage. Nothing expires them.
- **Workers logs are off by default.** The only audit records are the stored runs and the log of refused team requests.
- **Claude Code and Codex are installed in the image by version, without an integrity hash.** Their dependencies are resolved when the image is built.
- **The container's supervising daemon runs as root** inside the container, as do the publication snapshot and export steps. The agent, the checkout and the test processes drop to the unprivileged user.
- **Isolation between containers is Cloudflare's.** Sandbox Runner relies on the isolation of Cloudflare Containers and adds none of its own.
- **Access protects only what you put behind it.** Without `cloudflare access enable`, the Worker's routes rely on runner tokens alone, and Worker-to-Worker service bindings bypass Access.
- **Checkout requires a private repository** on the allowlist. Public repositories are refused.
- **A run that was admitted keeps its policy** if you revoke the client or the profile afterwards. Cancel the run to stop it.

## Design principles applied

| Principle | Where |
| --- | --- |
| Least privilege | Checkout tokens scoped to one repository with read access to contents (the GitHub connector token adds issues access); one model path per provider; team clients limited to granted profiles |
| Deny by default | No internet in the container; unknown routes, tools and arguments are refused |
| Complete mediation | Every outbound request from the container passes through the Worker |
| Separation of duties | Separate tokens for control, admission guard and each team client; the agent proposes changes and the Worker publishes them |
| Fail closed | Ambiguous publication or cleanup is reconciled or recorded as failed; an unverified guard state cannot be reopened |
| Minimal trusted base | The container is disposable; state and secrets live on the Worker |

## Threats and what counters them

The [OWASP Top 10 for Agentic Applications](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) (2026) lists the main risks of agent systems. This table shows where Sandbox Runner stands on each.

| Risk | Position |
| --- | --- |
| ASI01 Agent Goal Hijack | Not prevented. Contained by the network, credential and connector limits above. |
| ASI02 Tool Misuse and Exploitation | MCP tool calls are pinned by rule; reviews are read-only; writes are claimed once. Rules are the operator's to scope. |
| ASI03 Identity and Privilege Abuse | Credentials never enter the container; tokens are short-lived and scoped; team clients are separated. |
| ASI04 Agentic Supply Chain Vulnerabilities | Pinned images, runtime and actions; verified downloads. Gap: the Claude Code and Codex installs. |
| ASI05 Unexpected Code Execution | Expected by design: the agent runs arbitrary code, in a disposable container with no general network access. |
| ASI06 Memory and Context Poisoning | Runs share no memory. Each starts from a commit in a new container. |
| ASI07 Insecure Inter-Agent Communication | Agents do not talk to each other. A review receives a commit, not the producer's output. |
| ASI08 Cascading Failures | A concurrency limit and the admission guard bound the number of runs. No spending limit. |
| ASI09 Human-Agent Trust Exploitation | Out of scope. Results are marked as untrusted for MCP clients; a person or another agent decides what to do with them. |
| ASI10 Rogue Agents | Runs end at their deadline or on cancellation, and all routes close. No deadline applies unless configured. |

### Common implementation weaknesses

- **Injection.** Agent and test commands are passed as argument lists, not shell strings. Paths in an export are validated twice.
- **Request forgery.** Upstream hosts are fixed in code or pinned in the connector configuration. Redirects are refused.
- **Secret disclosure.** Tokens are compared in constant time, failures return fixed codes instead of upstream text, and credential headers are stripped from responses.
- **Replay and duplicates.** Each run has a caller-generated operation ID. Publication and connector writes are claimed durably before they are attempted.

## Your responsibilities as operator

- Keep the control token, the guard token and Access service tokens private, and rotate them if they may have leaked.
- Put the Worker behind Cloudflare Access (`sandbox-runner cloudflare access enable`).
- Give each person or system its own team client, with only the profiles it needs.
- Write narrow connector rules: pin the action and the resource, and list every mutating action under `write`.
- Set spending limits with your providers and a deadline for agent runs.
- Limit the repository allowlist and the GitHub App installation to the repositories agents should read.
- Upgrade with `sandbox-runner cloudflare upgrade` to receive fixes.

## Did we do a good enough job?

- The Worker and CLI test suites in `worker/tests/` and `test/` cover these controls, including refusal paths. Not every sentence here maps to a named test.
- On the public repository, every change to `main` must pass the test suites, an image build and CodeQL.
- This document is reviewed against the code when the design changes. If you find a claim the code does not support, report it as a vulnerability.
