import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { object } from "./github-auth.ts";

const binary = "/usr/local/bin/sandbox-runner-checkout";
const nativeErrors = [
  "github_publication_limit_exceeded", "github_publication_unsafe_workspace",
  "github_publication_baseline_invalid", "github_publication_workspace_busy",
] as const;
type ExportErrorCode = typeof nativeErrors[number] | "github_publication_export_failed" | "github_publication_authority_closed";

// JSON text, decoded blobs and a GitHub request can coexist in an isolate.
// This bound leaves headroom within the 128 MB per-isolate memory limit.
// https://developers.cloudflare.com/workers/platform/limits/#memory
export const maxPublicationWireBytes = 8 * 1024 * 1024;

export function publicationWireBudget(config: string | undefined): number | undefined {
  if (config === undefined || config === "") return maxPublicationWireBytes;
  if (config.trim() !== config || !/^\d+$/.test(config)) return;
  const bytes = Number(config);
  if (bytes >= 1 && bytes <= maxPublicationWireBytes) return bytes;
}

const maxDiagnosticBytes = Math.max(...nativeErrors.map(code => code.length)) + 1;
const oid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/u.test(value) &&
  value.length === 40;

type PublicationChange =
  | { kind: "delete"; path: string }
  | { kind: "put"; path: string; mode: "100644" | "100755"; blobSha: string; bytes: Uint8Array };
export type WorkspaceExport = { baseTreeSha: string; treeSha: string; changes: PublicationChange[] };

export class GithubWorkspaceError extends Error {
  readonly code: ExportErrorCode;

  constructor(code: ExportErrorCode) {
    super(code);
    this.name = "GithubWorkspaceError";
    this.code = code;
  }
}

function invalid(): never {
  throw new GithubWorkspaceError("github_publication_export_failed");
}

export function safePublicationPath(path: unknown): path is string {
  if (typeof path !== "string" || !path.isWellFormed()) return false;
  return path.split("/").every(part => {
    const alias = part.normalize("NFKC").toLowerCase().replace(/[. ]+$/u, "");
    return !!alias && alias !== ".git" && !/^git~[0-9]+$/u.test(alias) &&
      !/[\\:\p{Cc}\p{Cf}]/u.test(part) && !/[/\\:\p{Cc}\p{Cf}]/u.test(alias);
  });
}

function decoded(line: string): Record<string, unknown> {
  const record = object(JSON.parse(line));
  if (!record) return invalid();
  return record;
}

export function parseWorkspaceExport(bytes: Uint8Array, baseSha: string): WorkspaceExport {
  const last = bytes.length - 1;
  if (!oid(baseSha) || bytes[last] !== 10) return invalid();
  const end = bytes.lastIndexOf(10, last - 1);
  if (end < 0) return invalid();
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const footer = decoded(text.decode(bytes.subarray(end + 1, last)));
    const payload = bytes.subarray(0, end + 1);
    if (Object.keys(footer).length !== 1 || footer.sha256 !== createHash("sha256").update(payload).digest("hex")) {
      return invalid();
    }
    const source = text.decode(payload.subarray(0, -1));
    const headerEnd = source.indexOf("\n");
    if (headerEnd < 0) return invalid();
    const summaryStart = source.lastIndexOf("\n") + 1;
    const header = decoded(source.slice(0, headerEnd));
    if (Object.keys(header).length !== 3 || header.version !== 1 || header.baseSha !== baseSha || !oid(header.baseTreeSha)) {
      return invalid();
    }
    const summary = decoded(source.slice(summaryStart));
    if (Object.keys(summary).length !== 2 || !oid(summary.treeSha) ||
        typeof summary.changes !== "number" || !Number.isSafeInteger(summary.changes) || summary.changes < 0 ||
        ((summary.changes === 0) !== (summary.treeSha === header.baseTreeSha))) return invalid();

    const changes: PublicationChange[] = [];
    const seen = new Set<string>();
    let offset = headerEnd + 1;
    while (offset < summaryStart) {
      if (changes.length === summary.changes) return invalid();
      const lineEnd = source.indexOf("\n", offset);
      const record = decoded(source.slice(offset, lineEnd));
      offset = lineEnd + 1;
      const { path, kind } = record;
      if (!safePublicationPath(path) || seen.has(path)) return invalid();
      seen.add(path);
      if (kind === "delete" && Object.keys(record).length === 2) {
        changes.push({ kind, path });
        continue;
      }
      const { mode, blobSha, data } = record;
      if (kind !== "put" || Object.keys(record).length !== 5 || (mode !== "100644" && mode !== "100755") ||
          !oid(blobSha) || typeof data !== "string") return invalid();
      const contents = Buffer.from(data, "base64");
      const verified = createHash("sha1").update("blob " + contents.byteLength + "\0").update(contents).digest("hex");
      if (contents.toString("base64") !== data || verified !== blobSha) return invalid();
      changes.push({ kind, path, mode, blobSha, bytes: contents });
    }
    if (changes.length !== summary.changes) return invalid();
    return { baseTreeSha: header.baseTreeSha, treeSha: summary.treeSha, changes };
  } catch {
    return invalid();
  }
}

export async function readPublicationBytes(
  stream: ReadableStream<Uint8Array> | null | undefined, maxBytes: number, overflow: ExportErrorCode,
): Promise<Uint8Array> {
  if (!stream) return invalid();
  const reader = stream.getReader();
  let bytes = new Uint8Array(0);
  let count = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > maxBytes - count) throw new GithubWorkspaceError(overflow);
      const end = count + chunk.value.byteLength;
      if (end > bytes.length) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(end, bytes.length * 2)));
        grown.set(bytes.subarray(0, count));
        bytes = grown;
      }
      bytes.set(chunk.value, count);
      count = end;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.subarray(0, count);
}

export async function exportGithubWorkspace(
  container: Pick<Container, "exec">, baseSha: string, maxBytes: number, signal: AbortSignal,
  authorize: () => Promise<boolean>,
): Promise<WorkspaceExport> {
  if (!oid(baseSha) || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > maxPublicationWireBytes) {
    return invalid();
  }
  let process: ExecProcess | undefined;
  let exited = false;
  try {
    if (!await authorize()) throw new GithubWorkspaceError("github_publication_authority_closed");
    process = await container.exec([binary, "export", "--sha", baseSha, "--max-bytes", String(maxBytes)], {
      cwd: "/workspace", env: { PATH: "/nonexistent" }, stdout: "pipe", stderr: "pipe", signal,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readPublicationBytes(process.stdout, maxBytes, "github_publication_limit_exceeded"),
      readPublicationBytes(process.stderr, maxDiagnosticBytes, "github_publication_export_failed"), process.exitCode,
    ]);
    exited = true;
    if (exitCode !== 0) {
      const diagnostic = new TextDecoder().decode(stderr);
      const code = nativeErrors.find(candidate => diagnostic === candidate + "\n");
      if (code) throw new GithubWorkspaceError(code);
      return invalid();
    }
    if (stderr.byteLength !== 0 || signal.aborted) return invalid();
    return parseWorkspaceExport(stdout, baseSha);
  } catch (error) {
    if (!exited) {
      try { process?.kill(9); } catch { /* The process can already have exited. */ }
    }
    if (error instanceof GithubWorkspaceError) throw error;
    return invalid();
  }
}
