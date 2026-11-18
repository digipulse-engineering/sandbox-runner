import { operationId, sameProfileRequest } from "../contract.ts";
import type { RunProfileReceipt } from "../contract.ts";
import type { GithubRepository } from "../github-read.ts";
import { parseRepositoryRequest, sameRequestedSource } from "../github-source.ts";
import type { RepositoryInput, RepositoryReference } from "../github-source.ts";

const fields = new Set(["kind", "suite", "operationId", "repository", "sandboxProvider"]);
const providerName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export type TestSuite = "vitest" | "command";
// Historical Vitest admissions did not store a suite or an argument vector.
type TestTask = { suite?: "vitest" } | { suite: "command"; argv: string[]; checkout?: "shallow" };
export type TestSubmission = {
  operationId: string; repository?: RepositoryInput; repositoryRef?: RepositoryReference; sandboxProvider?: string;
  profile?: RunProfileReceipt;
} & TestTask;
export type TestAdmission = TestSubmission & {
  repository: RepositoryInput;
  githubRepository: GithubRepository;
  admittedAt: number;
  deadlineAt: number;
  maxLockBytes: number;
  logBytes: number;
};

export function parseTestSubmission(value: unknown, allowProfileCheckout = false): TestSubmission | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  const { suite, argv, checkout } = input;
  if (input.kind !== "test" || (suite !== "vitest" && suite !== "command") ||
      Object.keys(input).some(key => !fields.has(key) && !(suite === "command" && (key === "argv" || (key === "checkout" && allowProfileCheckout))))) return;
  const id = operationId(input.operationId);
  const repository = parseRepositoryRequest(input.repository);
  const { sandboxProvider } = input;
  if (!id || id.length !== 36 || !repository || (Object.hasOwn(input, "sandboxProvider") &&
      (typeof sandboxProvider !== "string" || sandboxProvider.trim() !== sandboxProvider || !providerName.test(sandboxProvider)))) return;
  const source = { operationId: id, ...(typeof sandboxProvider === "string" ? { sandboxProvider } : {}),
    ...("ref" in repository ? { repositoryRef: repository } : { repository }) };
  if (suite === "vitest") return source;
  if (Object.hasOwn(input, "checkout") && (checkout !== "shallow" || !("sha" in repository))) return;
  if (!Array.isArray(argv) || !argv[0] || !argv.every(arg => typeof arg === "string" && arg.isWellFormed() && !arg.includes("\0"))) return;
  return { ...source, suite, argv: [...argv], ...(checkout === "shallow" ? { checkout } : {}) };
}

export function sameTestSubmission(left: TestSubmission, right: TestSubmission): boolean {
  if (left.operationId !== right.operationId || left.sandboxProvider !== right.sandboxProvider ||
      !sameProfileRequest(left.profile, right.profile) ||
      !sameRequestedSource(left, right)) return false;
  if (left.suite !== "command") return right.suite !== "command";
  return right.suite === "command" && left.checkout === right.checkout && left.argv.length === right.argv.length &&
    left.argv.every((arg, index) => arg === right.argv[index]);
}
