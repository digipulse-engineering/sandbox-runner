import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProviderRunInput } from "../contract.ts";
import { admitGithubCheckout } from "../github-checkout.ts";
import { parseTestSubmission, sameTestSubmission } from "../vitest/admission.ts";

const id = "c3982431-3622-428d-a21f-c6f4c9ea20f9";
const repository = { slug: "fixture/vitest", sha: "a".repeat(40) };
const input = { kind: "test", suite: "vitest", operationId: id, repository };

test("binds test replays to the admitted profile request", () => {
  const raw = parseTestSubmission(input);
  const profile = { slug: "unit-tests", revision: "a".repeat(64), source: "client-supplied", requestDigest: "b".repeat(64) };
  const admitted = { ...raw, profile };
  assert(sameTestSubmission(admitted, { ...raw, profile: { ...profile } }));
  assert(!sameTestSubmission(admitted, { ...raw, profile: { ...profile, requestDigest: "c".repeat(64) } }));
  assert(!sameTestSubmission(admitted, raw));
  assert(!sameTestSubmission(raw, admitted));
  assert.equal(parseTestSubmission({ ...input, profile }), undefined);
});

test("uses the same canonical Git source and distinguishes test and agent admission", () => {
  const testRun = parseTestSubmission({ ...input, operationId: id.toUpperCase(), repository: { ...repository, sha: repository.sha.toUpperCase() } });
  assert.deepEqual(testRun, { operationId: id, repository });
  assert.equal(parseProviderRunInput(input), undefined);
  assert.equal(parseTestSubmission({ kind: "agent", agent: "claude", operationId: id, prompt: "fixture", repository }), undefined);
  assert(sameTestSubmission(testRun, parseTestSubmission(input)));
  assert(!sameTestSubmission(testRun, parseTestSubmission({ ...input, sandboxProvider: "cloudflare" })));
  assert(!sameTestSubmission(testRun, parseTestSubmission({ ...input, repository: { ...repository, sha: "b".repeat(40) } })));
});

test("admits only the fixed suite with a full SHA and a provider name", () => {
  for (const value of [{ ...input, suite: "test" }, { ...input, authMode: "api-key" }, { ...input, command: ["sh"] },
    { ...input, operationId: id + "\n" }, { ...input, repository: { ...repository, sha: "HEAD" } },
    { ...input, sandboxProvider: "https://example.invalid" }, { ...input, sandboxProvider: "cloudflare\n" }]) {
    assert.equal(parseTestSubmission(value), undefined);
  }
  assert.equal(parseTestSubmission({ ...input, sandboxProvider: "future-provider" }).sandboxProvider, "future-provider");
});

test("admits the configured GitHub source in real mode without fixture or model credentials", () => {
  const source = { slug: "owner/repo", sha: repository.sha };
  const submission = parseTestSubmission({ ...input, repository: source });
  const env = { SANDBOX_RUNNER_MODE: "real", SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS: "25000",
    SANDBOX_RUNNER_GITHUB_ALLOWLIST: '{"owner/repo":301}', GITHUB_APP_CLIENT_ID: "placeholder-app",
    GITHUB_APP_INSTALLATION_ID: "placeholder-installation", GITHUB_APP_PRIVATE_KEY: "placeholder-not-a-private-key" };
  assert.deepEqual(admitGithubCheckout(submission.repository, env), { owner: "owner", name: "repo", repositoryId: 301 });
  assert.equal(admitGithubCheckout(repository, { ...env, SANDBOX_RUNNER_GITHUB_FIXTURES: "1" }), "github_repository_not_allowed");
});

test("freezes the exact ordered command argv and does not reuse a Vitest operation ID", () => {
  const argv = ["node", "--kill-after=1s", "", "a b", "$(touch outside)", "é\n🚀"];
  const submitted = { ...input, suite: "command", argv };
  const command = parseTestSubmission(submitted);
  assert.deepEqual(command, { operationId: id, repository, suite: "command", argv });
  assert.notEqual(command.argv, argv);
  assert(sameTestSubmission(command, parseTestSubmission({ ...submitted, argv: [...argv] })));
  assert(!sameTestSubmission(command, parseTestSubmission({ ...submitted, argv: [...argv].reverse() })));
  assert(!sameTestSubmission(command, parseTestSubmission(input)));
  assert(!sameTestSubmission(parseTestSubmission(input), command));
  for (const invalid of [undefined, [], [""], "sh", ["sh", 1], ["sh", "bad\0arg"], ["sh", "\uD800"]]) {
    assert.equal(parseTestSubmission({ ...submitted, argv: invalid }), undefined);
  }
  assert.equal(parseTestSubmission({ ...input, argv: ["sh"] }), undefined);
});

test("validates shallow checkout only on exact command-profile resolutions and binds it to the replay", () => {
  const shallow = { ...input, suite: "command", argv: ["pnpm", "test"], checkout: "shallow" };
  const command = parseTestSubmission(shallow, true);
  assert.equal(command.checkout, "shallow");
  assert(sameTestSubmission(command, parseTestSubmission(shallow, true)));
  assert.equal(parseTestSubmission(shallow), undefined);
  assert.equal(parseTestSubmission({ ...shallow, suite: "vitest" }, true), undefined);
  assert.equal(parseTestSubmission({ ...shallow, repository: { slug: repository.slug, ref: "refs/heads/main" } }, true), undefined);
  const { checkout: _checkout, ...full } = shallow;
  assert(!sameTestSubmission(command, parseTestSubmission(full)));
});
