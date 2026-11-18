import type { PresetAgent, Outcome } from "./contract.ts";

export type ReviewVerdict = "PASS" | "FAIL" | "ESCALATE";
export type ReviewResult = { verdict: ReviewVerdict; findings: string[] };
export type ReviewView = { producerAgent: PresetAgent } & (ReviewResult | { verdict?: never; findings?: never });

// The SQLite Durable Object value also stores up to 1 MiB of admitted input.
// Leave room for JSON metadata and the validated result in its 2 MiB value limit.
const maxReviewBytes = 512 * 1024;

export function reviewPrompt(criteria: string): string {
  return [
    "Review the exact commit already checked out in /workspace. Inspect the repository in read-only mode.",
    "Return only one JSON object with keys verdict and findings. Use PASS, FAIL or ESCALATE for verdict.",
    "Use an array of concise strings for findings. Cite paths and line numbers when relevant.",
    "Include at least one finding for FAIL or ESCALATE. PASS may have an empty findings array.",
    "",
    "Review criteria:",
    criteria,
  ].join("\n");
}

export function parseReviewResult(text: string | undefined): ReviewResult | undefined {
  if (text === undefined || text.length > maxReviewBytes || new TextEncoder().encode(text).byteLength > maxReviewBytes) return;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => key !== "verdict" && key !== "findings")) return;
    const { verdict, findings } = value;
    if ((verdict !== "PASS" && verdict !== "FAIL" && verdict !== "ESCALATE") ||
        !Array.isArray(findings) || (verdict !== "PASS" && findings.length === 0) ||
        !findings.every(finding => typeof finding === "string" && finding.trim() && finding.isWellFormed())) return;
    return { verdict, findings };
  } catch {
    return;
  }
}

export function withReviewResult(outcome: Outcome, review: ReviewView | undefined): Outcome & { review?: ReviewView } {
  if (!review || outcome.status !== "succeeded") return outcome;
  const result = parseReviewResult(outcome.output);
  return result
    ? { status: "succeeded", review: { producerAgent: review.producerAgent, ...result } }
    : { status: "failed", reason: "review_verdict_invalid" };
}
