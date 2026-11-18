import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import pin from "./fixture-pin.json" with { type: "json" };
import { downloadTarball, registryDenied, registryHost, registryTarget } from "./registry.mjs";
import { witnessPath } from "./witness.mjs";

const caFile = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const workspace = "/workspace";
const sourceScope = "image-preseeded-synthetic-git";
const fixtureCwd = { cwd: workspace, user: "10001:10001" };
const fixtureEnv = { HOME: "/home/tester", CI: "true", NODE_EXTRA_CA_CERTS: caFile, NO_COLOR: "1" };
const resultKey = "result";
const registryOpenKey = "registry-open";
const registryRequestsKey = "registry-requests";
// Up to six retained streams fit within one SQLite-backed DO storage value, including JSON escaping.
const retainedStreamBytes = 32 * 1024;
const route = /^\/v1\/runs\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})(\/result)?$/;
const witnessRoute = /^\/witness\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\/(mac|vitest)\/[a-f0-9]{64}$/;
const vitestArgs = ["node", "node_modules/vitest/vitest.mjs", "run", "--maxWorkers=1", "--reporter=default"];
const offlineMarkers = ["QUALIFICATION_LOOPBACK_OK", "QUALIFICATION_REGISTRY_SEALED",
  "QUALIFICATION_DNS_BLOCKED", "QUALIFICATION_DIRECT_IP_TLS_BLOCKED", "QUALIFICATION_DIRECT_DOT_BLOCKED"];

type Output = { text: string; bytes: number };
type Command = { exitCode: number; stdout: Output; stderr: Output };
type WitnessSource = "mac" | "vitest";
type Report = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  cleanup: "pending" | "destroyed" | "failed";
  phase: string;
  sourceScope: typeof sourceScope;
  fixtureCommit: string;
  nodeVersion?: string;
  vitestVersion?: string;
  registryRequests?: number;
  internetAtStart?: false;
  registrySealed?: boolean;
  witness?: { macReached: boolean; vitestReached: boolean };
  install?: Command;
  pass?: Command;
  fail?: Command;
};

function equalBytes(left: string, right: string) {
  const encoder = new TextEncoder();
  const received = encoder.encode(left);
  const expected = encoder.encode(right);
  return received.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(received, expected);
}

async function readOutput(stream: ReadableStream<Uint8Array> | null | undefined): Promise<Output> {
  if (!stream) return { text: "", bytes: 0 };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes < retainedStreamBytes) text += decoder.decode(value.subarray(0, retainedStreamBytes - bytes), { stream: true });
      bytes += value.byteLength;
    }
    return { text: text + decoder.decode(), bytes };
  } finally {
    reader.releaseLock();
  }
}

export class RegistryRelay extends WorkerEntrypoint<Env, { id: string; install: boolean }> {
  async fetch(request: Request): Promise<Response> {
    if (!this.ctx.props.install) return registryDenied("sealed");
    const target = registryTarget(request);
    if (!target) return registryDenied("outside-lockfile");
    const run = this.ctx.exports.VitestRun.getByName(this.ctx.props.id);
    if (!await run.permitRegistryRequest()) return registryDenied("sealed");
    return downloadTarball(target, request.method);
  }
}

export class VitestRun extends DurableObject<Env> {
  async reserve(id: string): Promise<Report> {
    if (this.ctx.id.name !== id) throw new Error("Wrong run identity");
    return this.ctx.storage.transaction(async transaction => {
      const existing = await transaction.get<Report>(resultKey);
      if (existing) return existing;
      const report: Report = { id, status: "queued", cleanup: "pending", phase: "queued", sourceScope, fixtureCommit: pin.commit };
      await transaction.put(resultKey, report);
      await transaction.setAlarm(Date.now());
      return report;
    });
  }

  async read(): Promise<Report | undefined> {
    return this.ctx.storage.get<Report>(resultKey);
  }

  async permitRegistryRequest(): Promise<boolean> {
    return this.ctx.storage.transaction(async transaction => {
      if (!await transaction.get<boolean>(registryOpenKey)) return false;
      const count = await transaction.get<number>(registryRequestsKey) ?? 0;
      await transaction.put(registryRequestsKey, count + 1);
      return true;
    });
  }

  async recordWitness(source: WitnessSource): Promise<void> {
    await this.ctx.storage.transaction(async transaction => {
      await transaction.put(`witness-${source}`, true);
      if (source !== "vitest") return;
      const report = await transaction.get<Report>(resultKey);
      if (!report?.witness) return;
      report.witness.vitestReached = true;
      report.status = "failed";
      await transaction.put(resultKey, report);
    });
  }

  async alarm(): Promise<void> {
    const report = await this.read();
    if (!report || report.status === "succeeded" || report.status === "failed") return;
    const container = this.ctx.container;
    try {
      if (!container) throw new Error("Missing native container binding");
      if (report.status !== "queued") throw new Error("Prior execution interrupted");
      report.status = "running";
      report.phase = "start";
      await this.ctx.storage.put(resultKey, report);
      const timeout = this.env.COMMAND_TIMEOUT_SECONDS;
      const probeTimeout = this.env.PROBE_TIMEOUT_MS;
      if (![timeout, probeTimeout].every(value => /^[1-9][0-9]*$/.test(value))) throw new Error("Invalid command or probe timeout");
      const registry = (install: boolean) => container.interceptOutboundHttps(registryHost,
        this.ctx.exports.RegistryRelay({ props: { id: report.id, install } }));
      await registry(false);
      container.start({ image: container.images.base, enableInternet: false, labels: { run: report.id } });
      report.internetAtStart = false;
      // A lost alarm still leaves the platform with a bounded idle lifetime.
      await container.setInactivityTimeout(3 * Number(timeout) * 1000);

      const execute = async (argv: string[], additionalEnv: Record<string, string> = {}): Promise<Command> => {
        const process = await container.exec(["timeout", "--kill-after=5s", `${timeout}s`, ...argv], {
          ...fixtureCwd, env: { ...fixtureEnv, ...additionalEnv },
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          process.exitCode, readOutput(process.stdout), readOutput(process.stderr),
        ]);
        return { exitCode, stdout, stderr };
      };

      report.phase = "verify-source";
      const source = await execute(["/opt/vitest-qualification/source-info.sh"]);
      const [commit, nodeVersion] = source.stdout.text.trim().split("\n");
      if (source.exitCode !== 0 || commit !== pin.commit || !/^v24\.\d+\.\d+$/.test(nodeVersion)) {
        throw new Error("Fixture commit or Node version mismatch");
      }
      report.nodeVersion = nodeVersion;
      report.phase = "install";
      await this.ctx.storage.put(registryOpenKey, true);
      await registry(true);
      report.install = await execute([
        "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier",
        "--registry=https://registry.npmjs.org/", "--cache=/tmp/vitest-qualification-cache", "--fetch-retries=0",
      ], { NPM_CONFIG_USERCONFIG: "/tmp/qualification-user.npmrc", NPM_CONFIG_GLOBALCONFIG: "/tmp/qualification-global.npmrc" });

      report.phase = "seal-registry";
      await this.ctx.storage.delete(registryOpenKey);
      await registry(false);
      report.registrySealed = true;
      report.registryRequests = await this.ctx.storage.get<number>(registryRequestsKey) ?? 0;
      if (report.install.exitCode !== 0 || report.registryRequests === 0) throw new Error("Package installation failed");
      const version = await execute(["node", "-p", 'require("./node_modules/vitest/package.json").version']);
      if (version.exitCode !== 0 || version.stdout.text.trim() !== pin.vitest) throw new Error("Vitest version mismatch");
      report.vitestVersion = pin.vitest;

      report.phase = "vitest";
      const witnessUrl = this.env.WITNESS_ORIGIN && this.env.WITNESS_ORIGIN +
        await witnessPath(this.env.VITEST_QUALIFICATION_TOKEN, report.id, "vitest");
      const testArgs = [...vitestArgs, `--testTimeout=${Number(timeout) * 1000}`];
      report.pass = await execute([...testArgs, "pass.test.mjs", "offline.test.mjs"], {
        QUALIFICATION_PROBE_TIMEOUT_MS: probeTimeout,
        ...(witnessUrl ? { QUALIFICATION_WITNESS_URL: witnessUrl } : {}),
      });
      report.fail = await execute([...testArgs, "fail.test.mjs"]);
      if (witnessUrl) {
        report.witness = {
          macReached: await this.ctx.storage.get<boolean>("witness-mac") === true,
          vitestReached: await this.ctx.storage.get<boolean>("witness-vitest") === true,
        };
        if (!report.witness.macReached || report.witness.vitestReached ||
            !report.pass.stdout.text.includes("QUALIFICATION_HTTPS_WITNESS_BLOCKED")) throw new Error("Witness probe mismatch");
      }
      const finalRegistryRequests = await this.ctx.storage.get<number>(registryRequestsKey);
      if (report.pass.exitCode !== 0 || report.fail.exitCode !== 1 ||
          finalRegistryRequests !== report.registryRequests ||
          !["QUALIFICATION_PASS_STDOUT", ...offlineMarkers].every(marker => report.pass?.stdout.text.includes(marker)) ||
          !report.fail.stdout.text.includes("QUALIFICATION_FAIL_STDOUT") ||
          !report.fail.stderr.text.includes("QUALIFICATION_EXPECTED") ||
          !report.fail.stderr.text.includes("QUALIFICATION_ACTUAL")) throw new Error("Vitest or offline probe mismatch");
      report.phase = "complete";
      report.status = "succeeded";
    } catch {
      report.status = "failed";
    } finally {
      try {
        await this.ctx.storage.delete(registryOpenKey);
        if (container?.running) await container.destroy();
        report.cleanup = container && !container.running && await container.inspect() === null ? "destroyed" : "failed";
      } catch {
        report.cleanup = "failed";
      }
      if (report.cleanup === "failed") report.status = "failed";
      await this.ctx.storage.transaction(async transaction => {
        if (report.witness && await transaction.get<boolean>("witness-vitest")) {
          report.witness.vitestReached = true;
          report.status = "failed";
        }
        await transaction.put(resultKey, report);
      });
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const hidden = () => Response.json({ error: "not_found" }, { status: 404 });
    const control = env.VITEST_QUALIFICATION_TOKEN;
    if (!control) return hidden();
    const url = new URL(request.url);
    const witness = witnessRoute.exec(url.pathname);
    if (witness && request.method === "GET" && !url.search && url.origin === env.WITNESS_ORIGIN) {
      const [, id, source] = witness;
      if (!equalBytes(url.pathname, await witnessPath(control, id, source))) return hidden();
      await ctx.exports.VitestRun.getByName(id).recordWitness(source as WitnessSource);
      return Response.json({ received: true }, { headers: { "cache-control": "no-store" } });
    }
    if (!equalBytes(request.headers.get("authorization") ?? "", "Bearer " + control)) return hidden();
    const matched = route.exec(url.pathname);
    if (!matched || url.search) return hidden();
    const [, id, result] = matched;
    const run = ctx.exports.VitestRun.getByName(id);
    if (request.method === "POST" && !result) {
      await request.body?.cancel();
      return Response.json(await run.reserve(id), { status: 202 });
    }
    if (request.method !== "GET") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const report = await run.read();
    if (!report) return Response.json({ error: "run_not_found" }, { status: 404 });
    if (result && report.cleanup === "pending") return Response.json({ error: "run_in_progress" }, { status: 409 });
    return Response.json(report);
  },
} satisfies ExportedHandler<Env>;
