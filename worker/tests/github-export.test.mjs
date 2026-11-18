import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { exportGithubWorkspace, parseWorkspaceExport, safePublicationPath } from "../github-export.ts";

const baseSha = "a".repeat(40);
const baseTreeSha = "b".repeat(40);
const treeSha = "c".repeat(40);
const header = { version: 1, baseSha, baseTreeSha };
const put = {
  kind: "put", path: "example.txt", mode: "100644",
  data: Buffer.from("example\n").toString("base64"),
  blobSha: createHash("sha1").update("blob 8\0example\n").digest("hex"),
};
const remove = { kind: "delete", path: "former.txt" };

function encode(changes = [put, remove], summary = { treeSha, changes: changes.length }) {
  const lines = [header, ...changes, summary].map(record => JSON.stringify(record) + "\n").join("");
  return Buffer.from(lines + JSON.stringify({ sha256: createHash("sha256").update(lines).digest("hex") }) + "\n");
}

const fails = error => error.code === "github_publication_export_failed";

test("validates the complete native receipt and checks each Git blob SHA", () => {
  const result = parseWorkspaceExport(encode(), baseSha);
  assert.equal(result.baseTreeSha, baseTreeSha);
  assert.equal(result.treeSha, treeSha);
  assert.deepEqual(result.changes, [{ kind: "put", path: put.path, mode: put.mode,
    blobSha: put.blobSha, bytes: Buffer.from("example\n") }, remove]);
  assert.deepEqual(parseWorkspaceExport(encode([], { treeSha: baseTreeSha, changes: 0 }), baseSha).changes, []);
  assert.throws(() => parseWorkspaceExport(encode([{ ...put, blobSha: baseSha }]), baseSha), fails);
  assert.throws(() => parseWorkspaceExport(encode([{ ...put, data: put.data + "\n" }]), baseSha), fails);
});

test("rejects a missing, partial or mismatched receipt with no candidate", () => {
  const complete = encode();
  const payload = complete.subarray(0, complete.lastIndexOf(10, complete.length - 2) + 1);
  for (const invalid of [
    payload, complete.subarray(0, -1), complete.subarray(0, -8), Buffer.concat([complete, Buffer.from("\n")]),
    Buffer.from(complete.toString().replace("former.txt", "changed.txt")),
    encode([put, put]), encode([put], { treeSha, changes: 2 }), encode([put], { treeSha: baseTreeSha, changes: 1 }),
  ]) assert.throws(() => parseWorkspaceExport(invalid, baseSha), fails);
  assert.throws(() => parseWorkspaceExport(complete, treeSha), fails);
});

test("fails closed on path aliases, unsafe modes and non-UTF8 output", () => {
  for (const path of ["../../x", "/absolute", "a//b", "a/.git/config", "a/.ｇｉｔ /config", "a/git~1/x",
    "a/\\b", "a/C:other", "a/\u202ex", "a/\ud800"]) {
    assert.throws(() => parseWorkspaceExport(encode([{ ...put, path }]), baseSha), fails);
  }
  assert.throws(() => parseWorkspaceExport(encode([{ ...put, mode: "120000" }]), baseSha), fails);
  assert.throws(() => parseWorkspaceExport(Buffer.from([255, 10, 255, 10]), baseSha), fails);
});

function stream(bytes) {
  return new ReadableStream({
    start(controller) {
      const middle = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.subarray(0, middle));
      controller.enqueue(bytes.subarray(middle));
      controller.close();
    },
  });
}

test("native capture enforces stdout size, exit status and bounded diagnostics", async () => {
  const signal = AbortSignal.timeout(60_000);
  const permit = async () => true;
  const complete = encode();
  let kills = 0;
  function container(output, error = Buffer.alloc(0), exitCode = 0, maxBytes = complete.length) {
    return {
      exec(argv, options) {
        assert.deepEqual(argv, ["/usr/local/bin/sandbox-runner-checkout", "export", "--sha", baseSha,
          "--max-bytes", String(maxBytes)]);
        assert.equal(options.cwd, "/workspace");
        assert.equal(options.env.PATH, "/nonexistent");
        return {
          stdout: stream(output), stderr: stream(error), exitCode: Promise.resolve(exitCode),
          kill() { kills += 1; },
        };
      },
    };
  }

  const result = await exportGithubWorkspace(container(complete), baseSha, complete.length, signal, permit);
  assert.equal(result.treeSha, treeSha);
  await assert.rejects(exportGithubWorkspace(container(complete, Buffer.alloc(0), 0, complete.length - 1),
    baseSha, complete.length - 1, signal, permit), error => error.code === "github_publication_limit_exceeded");
  await assert.rejects(exportGithubWorkspace(container(complete, Buffer.alloc(0), 1), baseSha, complete.length, signal, permit), fails);
  await assert.rejects(exportGithubWorkspace(container(Buffer.alloc(0), Buffer.from("github_publication_workspace_busy\n"), 1),
    baseSha, complete.length, signal, permit), error => error.code === "github_publication_workspace_busy");
  await assert.rejects(exportGithubWorkspace(container(complete, Buffer.alloc(256), 1),
    baseSha, complete.length, signal, permit), fails);
  assert.equal(kills, 2);
});

test("never opens native exec after publication authority closes", async () => {
  await assert.rejects(exportGithubWorkspace({ exec() { assert.fail("unauthorized native capture"); } },
    baseSha, encode().length, AbortSignal.timeout(60_000), async () => false),
  error => error.code === "github_publication_authority_closed");
});

test("publication paths treat trailing dots and spaces as Windows and Git hosts do, in linear time", () => {
  // The previous implementation trimmed with /[. ]+$/u. Keep its decisions.
  const previous = path => typeof path === "string" && path.isWellFormed() && path.split("/").every(part => {
    const alias = part.normalize("NFKC").toLowerCase().replace(/[. ]+$/u, "");
    return !!alias && alias !== ".git" && !/^git~[0-9]+$/u.test(alias) &&
      !/[\\:\p{Cc}\p{Cf}]/u.test(part) && !/[/\\:\p{Cc}\p{Cf}]/u.test(alias);
  });
  for (const path of ["src/a.ts", ".git", ".git.", ".git . .", ".GIT ", "dir/.Git./x", "git~1", "git~1. .", "GIT~12 ",
    "a. . .x", "...", " . ", "", "a/", "a//b", "trailing. ", "name.\u3000", "ﾟ.git", "a\u200b.", "a:b", "c\\d"]) {
    assert.equal(safePublicationPath(path), previous(path), JSON.stringify(path));
  }
  assert.equal(safePublicationPath(".git" + ". ".repeat(4)), false);
  const started = performance.now();
  assert.equal(safePublicationPath("a" + ". ".repeat(200_000) + "x"), true);
  assert.ok(performance.now() - started < 1_000, "a long run of dots and spaces is checked in linear time");
});
