import assert from "node:assert/strict";
import test from "node:test";
import { createProfileFromTemplate, getProfileTemplate, listProfileTemplates } from "../bin/profile-templates.mjs";
import { parseProfileConfig, profileRevision } from "../worker/run-profiles.mjs";

const target = { slug: "candidate", repo: "example/project" };

test("discover the portable Cloudflare templates and their conditional creation inputs", () => {
  assert.deepEqual(listProfileTemplates().templates.map(item => item.id),
    ["executor", "delivery-review", "vitest", "test-command", "tier2-review"]);
  const { template } = getProfileTemplate("delivery-review");
  assert.equal(template.sandboxProvider, "cloudflare");
  assert.deepEqual(template.requiredInputs, ["slug", "repo", "harness"]);
  assert.deepEqual(template.routes.claude.requiredInputs, ["authMode"]);
  assert.deepEqual(template.routes.opencode.requiredInputs, ["modelProvider"]);
  assert.deepEqual(template.routes.opencode.defaultsByModelProvider, { openai: { model: "gpt-6.1-sol", effort: "xhigh" } });
  assert.deepEqual(getProfileTemplate("test-command").template.requiredInputs, ["slug", "repo", "argv"]);
  assert.throws(() => getProfileTemplate("constructor"), { code: "profile_template_not_found" });
});

test("generate standalone deterministic profiles across harness and authentication choices", async () => {
  for (const id of ["executor", "delivery-review"]) {
    for (const harness of ["claude", "codex"]) {
      for (const authMode of ["api-key", "subscription"]) {
        const input = { ...target, harness, authMode };
        const result = await createProfileFromTemplate(id, input);
        assert.deepEqual(result, await createProfileFromTemplate(id, input));
        assert.equal(result.profile.authMode, authMode);
        assert.equal(result.profile.defaults.repo, target.repo);
        assert.equal(result.profile.defaults.effort, "high");
        assert.equal(result.profile.publish, undefined);
        assert.equal(result.profile.mcp, undefined);
        assert.equal(result.qualification, "unverified");
        assert.equal(result.revision, await profileRevision(result.profile));
        assert.deepEqual(parseProfileConfig(result.config).profiles[target.slug], result.profile);
        assert.equal(result.inputContract.type, "object");
      }
    }
  }
  const input = { ...target, harness: "opencode", modelProvider: "anthropic", effort: "high" };
  const executor = await createProfileFromTemplate("executor", input);
  assert.equal(executor.profile.authMode, "api-key");
  assert.equal(executor.profile.defaults.model, "claude-sonnet-5-5");
  const review = await createProfileFromTemplate("delivery-review", { ...input, modelProvider: "openai", effort: "xhigh" });
  assert.equal(review.profile.defaults.model, "gpt-6.1-sol");
  assert.equal(review.profile.defaults.effort, "xhigh");
  const published = await createProfileFromTemplate("executor", {
    ...target, harness: "claude", authMode: "subscription", publish: true, connectors: ["github", "context7"],
  });
  assert.equal(published.profile.publish, true);
  assert.deepEqual(published.profile.mcp.connectors, ["context7", "github"]);
});

test("Vitest and fixed-command templates have no agent fields and preserve argument boundaries", async () => {
  const vitest = await createProfileFromTemplate("vitest", target);
  const command = await createProfileFromTemplate("test-command", { ...target, argv: ["pnpm", "exec", "test tool", "--dry-run", ""] });
  assert.equal(vitest.profile.runner, "vitest");
  assert.equal(vitest.profile.authMode, undefined);
  assert.deepEqual(command.profile.argv, ["pnpm", "exec", "test tool", "--dry-run", ""]);
  assert.equal(command.profile.operation, undefined);
  assert.equal(command.inputContract.properties.prompt, undefined);
});

test("Tier-2 requires a named route and refuses API keys, tools, publication and effort weakening", async () => {
  const input = { ...target, harness: "codex", model: "gpt-6-astra" };
  const { template } = getProfileTemplate("tier2-review");
  assert.equal(template.recommendedLaunch, "broker");
  assert(template.requirements.includes("review-independence"));
  const result = await createProfileFromTemplate("tier2-review", input);
  assert.equal(result.profile.usage, "tier2-review");
  assert.equal(result.profile.defaults.effort, "xhigh");
  assert.equal(result.profile.authMode, "subscription");
  await assert.rejects(createProfileFromTemplate("tier2-review", {
    ...input, authMode: "api-key", effort: "low", publish: true, connectors: ["github"],
  }), error => {
    assert.equal(error.code, "invalid_profile_template_inputs");
    assert.deepEqual(error.issues.map(issue => issue.field), ["authMode", "effort", "publish", "connectors"]);
    return true;
  });
  await assert.rejects(createProfileFromTemplate("tier2-review", { ...target, harness: "claude" }),
    error => error.issues.some(issue => issue.field === "model" && issue.code === "required"));
});

test("report independent creation errors without copying malformed input into diagnostics", async () => {
  await assert.rejects(createProfileFromTemplate("executor", {
    slug: "Rejected-value", harness: "codex", modelProvider: "anthropic", model: "wrong-model", effort: false,
    "private-marker": "test-secret-value",
  }), error => {
    assert.equal(error.code, "invalid_profile_template_inputs");
    assert.deepEqual(error.issues.map(issue => issue.field), ["$", "slug", "repo", "authMode", "modelProvider", "model", "effort"]);
    assert.doesNotMatch(JSON.stringify(error.issues), /private-marker|test-secret-value|Rejected-value|wrong-model/);
    return true;
  });
});
