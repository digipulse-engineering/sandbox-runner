import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as entrypoint from "./worker.ts" with { type: "cf-worker" };

const name = process.env.VITEST_QUALIFICATION_NAME ?? "sandbox-runner-vitest-qualification";
const witnessOrigin = process.env.VITEST_QUALIFICATION_WITNESS_ORIGIN ?? "";
if (witnessOrigin) {
  const url = new URL(witnessOrigin);
  const [worker, subdomain, ...suffix] = url.hostname.split(".");
  if (url.origin !== witnessOrigin || url.protocol !== "https:" || url.port || worker !== name || !subdomain ||
      suffix.join(".") !== "workers.dev") throw new Error("Use the dedicated canary's HTTPS workers.dev origin for the witness");
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
    workersDev: true,
    previewUrls: false,
    observability: { enabled: false },
    exports: {
      VitestRun: exports.durableObject({ storage: "sqlite", container }),
      RegistryRelay: exports.worker(),
    },
    env: {
      VITEST_QUALIFICATION_TOKEN: bindings.secret(),
      COMMAND_TIMEOUT_SECONDS: bindings.text(process.env.VITEST_QUALIFICATION_COMMAND_TIMEOUT_SECONDS ?? "120"),
      PROBE_TIMEOUT_MS: bindings.text(process.env.VITEST_QUALIFICATION_PROBE_TIMEOUT_MS ?? "3000"),
      WITNESS_ORIGIN: bindings.text(witnessOrigin),
    },
  },
  containers: [container],
});
