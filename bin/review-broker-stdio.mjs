import { createInterface } from "node:readline";
import { advanceReview } from "./review-broker.mjs";
import { readTimeout } from "./cli-errors.mjs";
import { hasDuplicateJsonKeys } from "../worker/profile-json.mjs";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
const lines = input[Symbol.asyncIterator]();
const lifetime = new AbortController();
input.on("close", () => lifetime.abort());
process.stdout.on("error", () => lifetime.abort());

function write(message) {
  return new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(message) + "\n", error => error ? reject(error) : resolve());
  });
}

async function read() {
  const { value, done } = await lines.next();
  if (done) return;
  const message = JSON.parse(value);
  if (hasDuplicateJsonKeys(value)) throw new TypeError("Duplicate message key");
  return message;
}

async function main() {
  if (process.argv.length !== 2 || process.stdin.isTTY || process.stdout.isTTY) throw new TypeError("Private stdio required");
  const request = await read();
  if (request?.type !== "advance") throw new TypeError("Expected advance request");
  const decision = await advanceReview(request.input, {
    origin: process.env.SANDBOX_RUNNER_URL,
    token: process.env.SANDBOX_RUNNER_TOKEN,
    timeoutMs: readTimeout(process.env),
    allowLoopbackFixture: process.env.SANDBOX_RUNNER_BROKER_LOOPBACK_FIXTURE === "1",
    signal: lifetime.signal,
    async persist(attempt) {
      await write({ type: "persist", attempt });
      const acknowledgement = await read();
      if (acknowledgement?.type !== "persisted" || acknowledgement.operationId !== attempt.journal.operationId ||
          acknowledgement.stage !== attempt.stage || lifetime.signal.aborted) throw new TypeError("Journal commit unconfirmed");
    },
    async authorizeSubmission(operationId) {
      await write({ type: "authorize", operationId });
      const acknowledgement = await read();
      if (acknowledgement?.type !== "authorization" || acknowledgement.operationId !== operationId) return;
      return { allowed: acknowledgement.allowed, expiresAt: acknowledgement.expiresAt };
    },
  });
  await write({ type: "result", decision });
}

try {
  await main();
} catch {
  process.exitCode = 1;
  if (!process.stdout.destroyed) {
    await write({ type: "error", code: "review_broker_step_unconfirmed" }).catch(() => {});
  }
} finally {
  input.close();
  process.stdin.pause();
}
