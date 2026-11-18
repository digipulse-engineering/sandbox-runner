import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPin, importClosure, importSpecifiers, pinnedCommit, resolveImport } from "../worker/check-sdk-pin.mjs";

const pin = "f".repeat(40);

test("the pin comes from the prepare script's pin line", () => {
  assert.equal(pinnedCommit(`#!/bin/sh\npin=${pin}\n`), pin);
  assert.throws(() => pinnedCommit("pin=main\n"), /no pin/);
});

test("imports include multi-line, type-only, dynamic and side-effect forms, and only relative ones", () => {
  const source = `import {\n  a,\n  b\n} from "../../lifecycle";\nimport type { T } from "./types";\n` +
    `export { x } from './x.js';\nconst m = await import("./runtime/main");\nimport "./side-effect";\nimport z from "zod";\n`;
  assert.deepEqual(importSpecifiers(source), ["../../lifecycle", "./types", "./x.js", "./runtime/main", "./side-effect"]);
});

test("specifiers resolve like the bundler: extension, .js to .ts, and index files", () => {
  const files = new Set(["lifecycle/index.ts", "harness/container/types.ts", "harness/container/x.ts"]);
  assert.equal(resolveImport("harness/container/harness.ts", "../../lifecycle", files), "lifecycle/index.ts");
  assert.equal(resolveImport("harness/container/harness.ts", "./types", files), "harness/container/types.ts");
  assert.equal(resolveImport("harness/container/harness.ts", "./x.js", files), "harness/container/x.ts");
  assert.equal(resolveImport("harness/container/harness.ts", "./missing", files), undefined);
});

test("the closure follows imports across directories and leaves out generated files", async () => {
  const sources = {
    "harness/container/harness.ts": `import { a } from "../../lifecycle";\nimport { D } from "./daemon-source.generated";`,
    "harness/container/daemon-source.generated.ts": "export const D = 1;",
    "lifecycle/index.ts": `export * from "./job-queue";`,
    "lifecycle/job-queue.ts": "export const q = 1;",
    "harness/opencode/agent.ts": `import { a } from "../../lifecycle";`,
  };
  const files = new Set(Object.keys(sources));
  const used = await importClosure(["harness/container/harness.ts"], files, path => sources[path]);
  assert.deepEqual([...used].sort(), ["harness/container/harness.ts", "lifecycle/index.ts", "lifecycle/job-queue.ts"]);
});

function comparison({ files, status = "ahead", aheadBy = files.length, commits = aheadBy }) {
  return async url => {
    assert.match(url, new RegExp(`/repos/cloudflare/agents/compare/${pin}\\.\\.\\.main$`));
    return { ok: true, json: async () => ({ status, ahead_by: aheadBy,
      commits: Array.from({ length: commits }, (_, index) => ({ sha: String(index).repeat(40).slice(0, 40),
        commit: { committer: { date: "2026-11-16T00:00:00Z" }, message: `change ${index}\n\nbody` } })),
      files: files.map(filename => ({ filename, status: "modified", additions: 1, deletions: 1 })) }) };
  };
}

test("a changed file outside the closure keeps the pin current; a changed used file does not", async () => {
  const used = new Set(["harness/container/harness.ts", "lifecycle/job-queue.ts"]);
  const quiet = await checkPin({ pin, ref: "main", used,
    fetchImpl: comparison({ files: ["packages/agents/src/harness/pi/tests/wire.ts", "docs/readme.md"] }) });
  assert.equal(quiet.upToDate, true);
  assert.deepEqual(quiet.otherHarnessChanges, ["harness/pi/tests/wire.ts"]);
  const changed = await checkPin({ pin, ref: "main", used,
    fetchImpl: comparison({ files: ["packages/agents/src/lifecycle/job-queue.ts"] }) });
  assert.equal(changed.upToDate, false);
  assert.deepEqual(changed.usedChanges.map(change => change.file), ["lifecycle/job-queue.ts"]);
  assert.equal(changed.commits[0].title, "change 0");
});

test("a truncated comparison or a pin off the ref cannot report the pin as current", async () => {
  const used = new Set(["lifecycle/job-queue.ts"]);
  const truncated = await checkPin({ pin, ref: "main", used, fetchImpl: comparison({ files: [], aheadBy: 400, commits: 250 }) });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.upToDate, false);
  await assert.rejects(checkPin({ pin, ref: "main", used, fetchImpl: comparison({ files: [], status: "diverged" }) }), /not an ancestor/);
});
