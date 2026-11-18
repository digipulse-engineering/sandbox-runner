import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { exportGithubWorkspace, GithubWorkspaceError, maxPublicationWireBytes } from "./github-export";

const node = "/usr/local/bin/node";
const checkout = "/usr/local/bin/sandbox-runner-checkout";
const fixture = ["delta", "symlink", "hardlink", "mount", "alias", "budget", "busy"] as const;
type Fixture = typeof fixture[number];
const baseFiles = { ".gitignore": "ignored.txt\n", "change.txt": "before\n", "delete.txt": "delete\n", "keep.txt": "keep\n" };
const drop = "process.setgroups([]); process.setgid(10001); process.setuid(10001);";
const gitObjects = `
function gitObject(type, bytes) {
  const content = Buffer.concat([Buffer.from(type + " " + bytes.length + "\\0"), bytes]);
  return { content, sha: createHash("sha1").update(content).digest("hex") };
}
function tree(entries) {
  return gitObject("tree", Buffer.concat(Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .flatMap(([name, entry]) => [Buffer.from(entry.mode + " " + name + "\\0"), Buffer.from(entry.sha, "hex")])));
}
`;

const seed = `
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
${drop}
${gitObjects}
function writeObject(type, bytes) {
  const { content, sha } = gitObject(type, bytes);
  mkdirSync(".git/objects/" + sha.slice(0, 2), { recursive: true });
  writeFileSync(".git/objects/" + sha.slice(0, 2) + "/" + sha.slice(2), deflateSync(content));
  return sha;
}
const entries = {};
for (const [name, data] of Object.entries(${JSON.stringify(baseFiles)})) {
  writeFileSync(name, data);
  entries[name] = { mode: "100644", sha: writeObject("blob", Buffer.from(data)) };
}
const encoded = tree(entries).content;
const baseTreeSha = writeObject("tree", encoded.subarray(encoded.indexOf(0) + 1));
const identity = "Fixture <fixture@example.invalid> 1 +0000";
const sha = writeObject("commit", Buffer.from("tree " + baseTreeSha + "\\nauthor " + identity +
  "\\ncommitter " + identity + "\\n\\nfixture\\n"));
mkdirSync(".git/refs/heads", { recursive: true });
writeFileSync(".git/refs/heads/main", sha + "\\n");
writeFileSync(".git/HEAD", "ref: refs/heads/main\\n");
writeFileSync(".git/config", "[core]\\nrepositoryformatversion=0\\n");
console.log(JSON.stringify({ sha, baseTreeSha }));
`;

const mutate = `
import { accessSync, chmodSync, linkSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
${drop}
try { accessSync("/run/sandbox-runner/github-publication.json"); process.exit(2); }
catch (error) { if (error.code !== "EACCES") process.exit(3); }
const mode = process.argv[1];
rmSync(".git", { recursive: true });
symlinkSync("/home/agent", ".git");
writeFileSync("change.txt", "after\\n");
chmodSync("change.txt", 0o755);
rmSync("delete.txt");
writeFileSync("new.txt", "new\\n");
writeFileSync("ignored.txt", "ignored synthetic data\\n");
if (mode === "symlink" || mode === "hardlink") {
  const outside = "/home/agent/outside.txt";
  writeFileSync(outside, "outside synthetic data\\n");
  if (mode === "symlink") symlinkSync(outside, "untrusted");
  else linkSync(outside, "untrusted");
}
if (mode === "alias") {
  mkdirSync(".ｇｉｔ");
  writeFileSync(".ｇｉｔ/config", "synthetic alias");
}
if (mode === "mount") {
  mkdirSync("/home/agent/outside-directory");
  writeFileSync("/home/agent/outside-directory/outside.txt", "outside synthetic data\\n");
  mkdirSync("untrusted");
}
if (mode === "busy") {
  const child = spawn("/usr/local/bin/node", ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  child.unref();
}
`;

class FixtureError extends Error {
  readonly diagnostic: Record<string, unknown>;

  constructor(diagnostic: Record<string, unknown>) {
    super("fixture_command_failed");
    this.diagnostic = diagnostic;
  }
}

async function command(container: Container, argv: string[], deadlineMs: number) {
  let process;
  try {
    process = await container.exec(argv, {
      cwd: "/workspace", env: { PATH: "/nonexistent" }, signal: AbortSignal.timeout(deadlineMs),
    });
  } catch (error) {
    throw new FixtureError({ operation: "exec", errorType: error instanceof TypeError ? "type" : "native" });
  }
  let output;
  try {
    output = await process.output();
  } catch {
    throw new FixtureError({ operation: "output" });
  }
  if (output.exitCode !== 0 || output.stderr.byteLength !== 0) {
    const stderr = new TextDecoder().decode(output.stderr);
    const marker = /\b(EACCES|EPERM|ENOENT|SyntaxError|ReferenceError|TypeError)\b/u.exec(stderr)?.[1];
    throw new FixtureError({ operation: "exit", exitCode: output.exitCode, stderrBytes: output.stderr.byteLength, marker });
  }
  return new TextDecoder().decode(output.stdout);
}

function expectedTreeSha() {
  const files = { ".gitignore": baseFiles[".gitignore"], "change.txt": "after\n", "keep.txt": "keep\n", "new.txt": "new\n" };
  const bytes = Buffer.concat(Object.entries(files).flatMap(([name, data]) => {
    const content = Buffer.from(data);
    const sha = createHash("sha1").update("blob " + content.length + "\0").update(content).digest();
    return [Buffer.from((name === "change.txt" ? "100755 " : "100644 ") + name + "\0"), sha];
  }));
  return createHash("sha1").update("tree " + bytes.length + "\0").update(bytes).digest("hex");
}

export class ExportRun extends DurableObject<Env> {
  async run(mode: Fixture) {
    const container = this.ctx.container;
    if (!container) throw new Error("fixture_container_missing");
    const deadlineMs = Number(this.env.COMMAND_TIMEOUT_MS);
    container.start({
      image: container.images.base,
      enableInternet: false,
      env: { CF_HARNESS_TOKEN: crypto.randomUUID(), CF_HARNESS_RUNTIME_ID: crypto.randomUUID() },
    });
    let phase = "start";
    let result: Record<string, unknown>;
    try {
      await container.setInactivityTimeout(deadlineMs * 3);
      phase = "seed";
      const base = JSON.parse(await command(container, [node, "--input-type=module", "--eval", seed], deadlineMs));
      phase = "snapshot";
      await command(container, [checkout, "snapshot", "--sha", base.sha], deadlineMs);
      phase = "edit";
      await command(container, [node, "--input-type=module", "--eval", mutate, mode], deadlineMs);
      if (mode === "mount") await command(container, ["/usr/bin/mount", "--bind", "/home/agent/outside-directory", "/workspace/untrusted"], deadlineMs);
      phase = "export";
      const artifact = await exportGithubWorkspace(container, base.sha,
        mode === "budget" ? 175 : maxPublicationWireBytes, AbortSignal.timeout(deadlineMs), async () => true);
      const changes = artifact.changes.map(change => change.kind === "delete" ? change : {
        kind: change.kind, path: change.path, mode: change.mode, sha: change.blobSha,
        contentVerified: new TextDecoder().decode(change.bytes) === (change.path === "change.txt" ? "after\n" : "new\n"),
      }).sort((left, right) => left.path.localeCompare(right.path));
      result = { status: "exported", phase, baseSha: base.sha, baseTreeSha: artifact.baseTreeSha,
        baseTreeMatched: artifact.baseTreeSha === base.baseTreeSha, treeSha: artifact.treeSha,
        treeMatched: artifact.treeSha === expectedTreeSha(), changes };
    } catch (error) {
      result = { status: "rejected", phase, reason: error instanceof GithubWorkspaceError ? error.code : "fixture_failed",
        ...(error instanceof FixtureError ? { diagnostic: error.diagnostic } : {}) };
    } finally {
      await container.destroy();
    }
    return { ...result, destroyed: !container.running && await container.inspect() === null };
  }
}

export default {
  fetch(request: Request, _env: unknown, ctx: ExecutionContext) {
    const [mode, id, extra] = new URL(request.url).pathname.slice(1).split("/");
    if (request.method !== "POST" || extra !== undefined ||
        !fixture.includes(mode as Fixture) || !id || !/^[a-f0-9-]{36}$/.test(id)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return ctx.exports.ExportRun.getByName(id).run(mode as Fixture).then(value => Response.json(value));
  },
};
