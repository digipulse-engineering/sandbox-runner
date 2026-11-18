import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as entrypoint from "./worker.ts" with { type: "cf-worker" };

const name = "sandbox-runner-github-export-fixture";
const deadline = process.env.SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS ?? "25000";
if (!/^\d+$/.test(deadline) || Number(deadline) < 1 || Number(deadline) > 2_147_483_647) {
  throw new Error("Invalid fixture command deadline.");
}
const container = defineContainer({
  name,
  schedulingPolicy: "durable-object",
  images: { base: { dockerfile: "./Dockerfile" } },
});

export default defineConfig({
  worker: {
    name,
    compatibilityDate: "2026-11-12",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    workersDev: false,
    previewUrls: false,
    exports: { ExportRun: exports.durableObject({ storage: "sqlite", container }) },
    env: { COMMAND_TIMEOUT_MS: bindings.text(deadline) },
    observability: { enabled: false },
  },
  containers: [container],
});
