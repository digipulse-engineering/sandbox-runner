# Route governed reviews from an orchestrator

This page explains how an operator broker routes governed reviews to Sandbox Runner.

- [How the broker works](#how-the-broker-works)
- [Review policy](#review-policy)
- [Prepare the inputs](#prepare-the-inputs)
- [Advance a review](#advance-a-review)
- [Transport and recovery](#transport-and-recovery)
- [Run the broker from another language](#run-the-broker-from-another-language)

## How the broker works

The installed package includes two operator-side modules:

- `bin/review-routing.mjs`
- `bin/review-broker.mjs`

Agents submit a contract reference to a trusted broker. The broker does these tasks:

- It authenticates the caller.
- It verifies admission.
- It assembles the sealed packet.
- It owns the private journal.

Give the broker its own team token. Grant it only the qualified review profiles it needs.

Existing `start`, `review` and profile commands retain their current API.

## Review policy

The router implements one fixed review policy.

| Review | What it does |
| --- | --- |
| Delivery review | Checks a candidate against its contract. |
| Tier-2 review | Adds an adversarial review for risky changes. |

A Tier-2 review is decided at one of two authority levels:

- `lead`
- `ceo`, for the final approver

If this policy fits your process, use the modules as they are. If not, use them as a reference for your own broker.

## Prepare the inputs

### Policy

Use a separate version-1 policy and catalog for each installation.

A policy pins these fields:

- `installation`
- `clientId`
- `repository`
- the ordered arrays `routes.delivery`, `routes.tier2Lead` and `routes.tier2Ceo`

Each route entry pins `slug`, `revision`, `reviewerSubject`, `model` and `effort`.

| Route array | Authority | Profiles, in order |
| --- | --- | --- |
| `routes.delivery` | — | 1. An OpenCode API key profile<br>2. A Codex subscription profile |
| `routes.tier2Lead` | `lead` | One Codex subscription profile |
| `routes.tier2Ceo` | `ceo` | Two Claude subscription profiles with different models:<br>1. A primary<br>2. A fallback |

Tier-2 routes pin the effort `xhigh`. Tier-2 uses the packet as its evidence source.

### Route qualification records

Supply the records from the broker's verified evidence store. Each record has these fields:

- `installation`
- `slug`
- `revision`
- `status`
- `evidence`

| `status` | When to use it |
| --- | --- |
| `qualified` | Only for routes whose exact profile is qualified. |
| `unavailable` | For a confirmed limitation. |

The `ceo` authority may move to its second route. This applies only when the first route is confirmed unavailable before submission.

### Admitted packet

Supply the broker-admitted packet with these fields:

| Field | Content |
| --- | --- |
| `contractId` | Contract identifier |
| `contractRevision` | Contract revision |
| `planRevision` | Plan revision |
| `contract` | |
| `plan` | |
| `sealedDiff` | Sealed diff |
| `target` | |
| `producer` | Producer record: `subject`, `harness`, `model` and `evidenceDigest` |
| `acceptance` | Array of acceptance references |
| `tests` | Array of test evidence references |

Resolve the producer record from trusted receipts or independently verified execution evidence.

Each item in `acceptance` and `tests` is a uniquely identified immutable reference with these fields:

- `id`
- `reference`
- `digest`, a SHA-256 digest
- `summary`, a self-contained summary

Test evidence also includes `sha` and `outcome`.

Keep producer reasoning out of the packet.

### Risk decision

| Field | Required for |
| --- | --- |
| `stage` | All reviews |
| `requiresTier2` | All reviews |
| `authority` | Tier-2 |
| `trigger` | Tier-2 |
| `surfaces` | Tier-2 |
| `includeDelivery` | Tier-2 |

### Verdict rules

- A combined verdict requires evidence for both axes on the same SHA.
- A Discovery packet without a candidate SHA needs a separate runtime contract for its review.
- Preserve that Discovery verdict separately from candidate delivery.

## Advance a review

Call `advanceReview(input, options)` from `bin/review-broker.mjs`. Hold the broker's contract lock during the call.

### `input`

| Field | Content |
| --- | --- |
| `policy` | The installation policy |
| `admission` | The current admission |
| `source` | The source |
| `qualifications` | The route qualification records |
| `allowSubmission` | Whether the step may submit; `false` for a read-only step |
| `previous: { attempt }` | On resume only: the attempt from the journal |

### `options`

| Option | Content |
| --- | --- |
| `origin` | The exact approved HTTPS origin |
| `token` | The installation's team bearer |
| `persist(attempt)` | Callback that commits each attempt |
| `authorizeSubmission(operationId)` | Callback that checks admission before each POST |

### `persist(attempt)`

1. Commit the attempt atomically before the callback resolves.
2. Save the entire record, including the exact `body` string.
3. Retain earlier attempts for audit.

| Stage | Meaning |
| --- | --- |
| `uncertain` | Committed before a first POST. |
| `admitted` | Records the authenticated proof that the operation exists. |
| `settled` | Adds the verified terminal receipt of the operation. |
| `blocked` | Records an operation ID conflict or a confirmed connector rejection. |

A connector rejection returns three items to the operator:

- the connector
- the access mode
- the recovery action

Reconnecting a connector leaves the attempt blocked. To replay the same UUID after operator verification, the broker needs a separate recovery action.

### `authorizeSubmission(operationId)`

The callback checks the admission again, under the same lock, before each POST.

- Return `{ allowed: true }` only while the current policy and admission authorize the exact journaled request.
- Include `expiresAt` as Unix epoch milliseconds when the admission has an expiry.

### Read-only steps and revocation

- Pass `allowSubmission: false` for a read-only step. This includes recovery after revocation.
- Omit `admission` when there is no current matching admission. The broker can still record the terminal receipt of the old run.
- The broker controls when a contract is finished. It saves the disposition in the journal.

## Transport and recovery

The transport follows these rules:

- It reads the Worker catalog with the broker bearer.
- It refuses redirects.
- On resume, it reads status and result for the same operation ID. It uses the saved profile pin, even if the catalog changes.

If the Worker has no record of an uncertain attempt, a replay requires all of these:

- the same bytes and UUID
- current qualification
- a fresh admission check

After submission, only one route change is possible: the delivery fallback. It requires all of these:

- confirmed quota exhaustion
- verified cleanup
- equivalent scope

Automatic fallback with MCP still needs its own qualification.

Poll `reconcile` results through the broker.

Treat an I/O or journal error as uncertain. Restart from the last committed record.

## Run the broker from another language

An operator broker in another language can launch the stdio module as a child process:

```sh
node <installed-package>/bin/review-broker-stdio.mjs
```

1. Connect the child with private pipes.
2. Put `SANDBOX_RUNNER_URL` and `SANDBOX_RUNNER_TOKEN` in the child environment.
3. Keep the lock and the credentials under the broker's service identity.

Each child advances one step. It uses newline-delimited JSON.

| Step | Message | Your action |
| --- | --- | --- |
| 1 | — | Send `{ "type": "advance", "input": { ... } }`. |
| 2 | `{ "type": "persist", "attempt": { ... } }` | Commit the attempt. Reply with `{ "type": "persisted", "operationId": "…", "stage": "…" }`. The values must match `attempt.journal.operationId` and `attempt.stage`. |
| 3 | `{ "type": "authorize", "operationId": "…" }` | Do a fresh admission check. Reply with `{ "type": "authorization", "operationId": "…", "allowed": true }`. On refusal, send `allowed: false`. Add `expiresAt` if the admission has an expiry. |
| 4 | `{ "type": "result", "decision": { ... } }` | The step ends. |

The child sends step 2 once for each attempt to persist.

Recover from the committed journal in these cases:

- The child sends `{ "type": "error", "code": "review_broker_step_unconfirmed" }`.
- The child fails.

Keep stdin open until the result. EOF cancels pending operations.
