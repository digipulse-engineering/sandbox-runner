import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const endpoint = process.env.SANDBOX_RUNNER_TEST_URL ?? "http://127.0.0.1:8911";
const checks = [
  ["delta", null],
  ["symlink", "github_publication_unsafe_workspace"],
  ["hardlink", "github_publication_unsafe_workspace"],
  ["mount", "github_publication_unsafe_workspace"],
  ["alias", "github_publication_unsafe_workspace"],
  ["budget", "github_publication_limit_exceeded"],
  ["busy", "github_publication_workspace_busy"],
];
for (const [mode, reason] of checks) {
  const id = randomUUID();
  const response = await fetch(endpoint + "/" + mode + "/" + id, { method: "POST", redirect: "error" });
  assert.equal(response.status, 200);
  const result = await response.json();
  console.log(JSON.stringify({ id, mode, ...result }));
  assert.equal(result.phase, "export");
  assert.equal(result.destroyed, true);
  if (reason) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, reason);
    assert.equal(result.changes, undefined);
  } else {
    assert.equal(result.status, "exported");
    assert.equal(result.baseTreeMatched, true);
    assert.equal(result.treeMatched, true);
    assert.deepEqual(result.changes.map(({ kind, path, mode, contentVerified }) => ({ kind, path, mode, contentVerified })), [
      { kind: "put", path: "change.txt", mode: "100755", contentVerified: true },
      { kind: "delete", path: "delete.txt", mode: undefined, contentVerified: undefined },
      { kind: "put", path: "new.txt", mode: "100644", contentVerified: true },
    ]);
  }
}
