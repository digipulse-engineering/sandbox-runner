import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { githubAppCredentials, githubCheckoutFixture } from "../github-checkout.ts";
import type { GithubCheckoutEnv } from "../github-checkout.ts";
import { githubFixtureFetcher, githubFixtureReadToken } from "../github-fixtures.ts";
import { forwardGithubRead, githubGitHost, mintGithubReadToken } from "../github-read.ts";
import type { GithubRepository } from "../github-read.ts";
import { appendRunEvents, runEventsPage } from "../run-events.ts";
import { sameTestSubmission } from "./admission.ts";
import type { TestAdmission } from "./admission.ts";
import { advanceEgress, fetchLockedTarball, leaseEgress, npmEgressTarget, releaseEgress, withEgressLease } from "./egress.ts";
import type { EgressGate } from "./egress.ts";
import { runNativeCommand, runVitest, untilRunStops } from "./runtime.ts";
import type { VitestAttestation, VitestExecution, VitestPhase } from "./runtime.ts";
import { createVitestState, finishVitest, recordVitestCleanup, setVitestPhase, startVitest, terminateVitest, vitestSettled, vitestView } from "./state.ts";
import type { VitestRunState, VitestRunView } from "./state.ts";

type VitestEnv = Env & GithubCheckoutEnv;
type Mode = "checkout" | "install";
const admissionKey = "admission";
const stateKey = "state";
const gateKey = "egress";
const urlsKey = "tarballs";
const deadline = new Error("Vitest deadline elapsed");
const cancelled = new Error("Vitest run cancelled");
const sealed: EgressGate = { phase: "closed", leases: [] };

function denied() {
  return Response.json({ error: "egress_denied" }, { status: 403, headers: { "cache-control": "no-store" } });
}

export class VitestEgress extends WorkerEntrypoint<VitestEnv, { id: string; mode: Mode }> {
  async fetch(request: Request): Promise<Response> {
    const { id, mode } = this.ctx.props;
    const owner = this.ctx.exports.VitestRun.getByName(id);
    const target = mode === "install" ? npmEgressTarget(request) : undefined;
    if (mode === "install" && !target) return denied();
    const lease = crypto.randomUUID();
    const allowed = await owner.beginEgress(mode, lease, target);
    if (!allowed) return denied();
    using repository = typeof allowed === "object" ? allowed : undefined;
    const release = () => owner.endEgress(lease);
    const background = (work: Promise<void>) => this.ctx.waitUntil(work);
    try {
      return await withEgressLease(async () => {
        if (mode === "install" && target) return fetchLockedTarball(target, request.method);
        if (!repository) return denied();
        const fixture = githubCheckoutFixture(this.env);
        const credentials = fixture ? undefined : githubAppCredentials(this.env);
        if (!fixture && !credentials) return denied();
        const fetcher = fixture ? githubFixtureFetcher(repository) : fetch;
        return forwardGithubRead(request, {
          repository,
          getToken: selected => credentials ? mintGithubReadToken(selected, credentials)
            : Promise.resolve(githubFixtureReadToken(selected)),
          subject: { containerId: id, contractId: null },
          journal: () => {},
          async fetcher(url, init) {
            if (!await owner.checkoutLeaseOpen(lease)) return denied();
            return fetcher(url, init);
          },
        });
      }, release, background);
    } catch {
      return Response.json({ error: "egress_unavailable" }, { status: 502 });
    }
  }
}

export class VitestRun extends DurableObject<VitestEnv> {
  #active?: AbortController;

  async #writeState(transaction: DurableObjectTransaction, next: VitestRunState, previous?: VitestRunState) {
    await transaction.put(stateKey, next);
    await appendRunEvents(transaction, previous, next);
  }

  async reserve(admission: TestAdmission, stop = false): Promise<VitestRunView> {
    if (admission.operationId !== this.ctx.id.name) throw new Error("Invalid test run identity");
    const view = await this.ctx.storage.transaction(async transaction => {
      const original = await transaction.get<TestAdmission>(admissionKey);
      if (original && (!sameTestSubmission(original, admission) ||
          original.githubRepository.repositoryId !== admission.githubRepository.repositoryId)) throw new Error("Test admission changed");
      const existing = await transaction.get<VitestRunState>(stateKey);
      if (existing && (!stop || vitestSettled(existing))) return vitestView(existing);
      const state = existing ?? createVitestState(admission.operationId, admission.repository, admission.admittedAt, admission.deadlineAt, admission.suite);
      const next = stop ? terminateVitest(state, "run_cancelled", Date.now()) : state;
      if (!existing) await transaction.put(admissionKey, admission);
      if (stop) await this.#closeGate(transaction);
      await this.#writeState(transaction, next, existing);
      await transaction.setAlarm(Date.now());
      return vitestView(next);
    });
    if (view.status === "cancelled") this.#active?.abort(cancelled);
    return view;
  }

  async read(): Promise<VitestRunView | undefined> {
    const state = await this.ctx.storage.get<VitestRunState>(stateKey);
    return state && vitestView(state);
  }

  async summary(): Promise<Pick<VitestRunView, "status" | "cleanup"> | undefined> {
    const state = await this.ctx.storage.get<VitestRunState>(stateKey);
    if (state) return { status: state.status, cleanup: state.cleanup };
  }

  async events(after: number) {
    return this.ctx.storage.transaction(async transaction => {
      const state = await transaction.get<VitestRunState>(stateKey);
      return state ? runEventsPage(transaction, state, after) : undefined;
    });
  }

  async beginEgress(mode: Mode, lease: string, target?: string): Promise<GithubRepository | true | false> {
    return this.ctx.storage.transaction(async transaction => {
      const state = await transaction.get<VitestRunState>(stateKey);
      const gate = await transaction.get<EgressGate>(gateKey);
      if (state?.status !== "running" || Date.now() >= state.deadlineAt || !gate) return false;
      const permitted = leaseEgress(gate, mode, lease);
      if (!permitted) return false;
      if (mode === "install" && (!target || !(await transaction.get<string[]>(urlsKey))?.includes(target))) return false;
      const admission = mode === "checkout" ? await transaction.get<TestAdmission>(admissionKey) : undefined;
      if (mode === "checkout" && !admission) return false;
      await transaction.put(gateKey, permitted);
      return admission?.githubRepository ?? true;
    });
  }

  async checkoutLeaseOpen(lease: string): Promise<boolean> {
    const gate = await this.ctx.storage.get<EgressGate>(gateKey);
    return gate?.phase === "checkout" && gate.leases.includes(lease);
  }

  async endEgress(lease: string): Promise<void> {
    await this.ctx.storage.transaction(async transaction => {
      const gate = await transaction.get<EgressGate>(gateKey);
      if (gate?.leases.includes(lease)) await transaction.put(gateKey, releaseEgress(gate, lease));
    });
  }

  async #closeGate(transaction: DurableObjectTransaction): Promise<void> {
    const gate = await transaction.get<EgressGate>(gateKey) ?? sealed;
    await transaction.put(gateKey, { ...gate, phase: "closed" });
    await transaction.delete(urlsKey);
  }

  async #settle(execution?: VitestExecution, reason?: "test_timed_out" | "test_runtime_lost" | "test_runtime_failed") {
    await this.ctx.storage.transaction(async transaction => {
      const state = await transaction.get<VitestRunState>(stateKey);
      if (!state || vitestSettled(state)) return;
      const next = execution ? finishVitest(state, execution)
        : terminateVitest(state, reason ?? "test_runtime_failed", Date.now());
      await this.#closeGate(transaction);
      await this.#writeState(transaction, next, state);
      await transaction.setAlarm(Date.now());
    });
  }

  async #phase(phase: VitestPhase, observed: VitestAttestation, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.ctx.storage.transaction(async transaction => {
      const state = await transaction.get<VitestRunState>(stateKey);
      const next = state && setVitestPhase(state, phase);
      if (!next) throw cancelled;
      if (Date.now() >= next.deadlineAt) throw deadline;
      await this.#writeState(transaction, { ...next, ...observed }, state);
    });
    signal.throwIfAborted();
  }

  async #drain(phase: "draining_checkout" | "closed", deadlineAt: number, signal: AbortSignal): Promise<void> {
    await this.ctx.storage.transaction(async transaction => {
      const gate = await transaction.get<EgressGate>(gateKey) ?? sealed;
      const next = advanceEgress(gate, phase);
      if (next) await transaction.put(gateKey, next);
      if (phase === "closed") await transaction.delete(urlsKey);
    });
    for (;;) {
      signal.throwIfAborted();
      const gate = await this.ctx.storage.get<EgressGate>(gateKey) ?? sealed;
      if (gate.leases.length === 0) return;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw deadline;
      await scheduler.wait(Math.min(remaining, 250));
    }
  }

  async #execute(admission: TestAdmission, signal: AbortSignal): Promise<VitestExecution> {
    const container = this.ctx.container;
    if (!container) throw new Error("Vitest container binding unavailable");
    const { operationId: id, repository, deadlineAt, maxLockBytes, logBytes } = admission;
    await container.interceptOutboundHttps(githubGitHost, this.ctx.exports.VitestEgress({ props: { id, mode: "checkout" } }));
    await container.interceptOutboundHttps("registry.npmjs.org", this.ctx.exports.VitestEgress({ props: { id, mode: "install" } }));
    signal.throwIfAborted();
    container.start({ enableInternet: false });
    await container.setInactivityTimeout(Math.max(1, deadlineAt - Date.now()));
    return runVitest({
      container, expectedSha: repository.sha, deadlineAt, maxLockBytes, logBytes,
      ...(admission.suite === "command" ? { argv: admission.argv } : {}),
      setPhase: (phase, observed) => this.#phase(phase, observed, signal),
      checkout: async absoluteDeadline => {
        signal.throwIfAborted();
        const ms = Math.min(absoluteDeadline - Date.now(), Number(this.env.SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS));
        if (ms <= 0) throw deadline;
        const checkout = await runNativeCommand(container,
          ["/usr/local/bin/sandbox-runner-checkout", "--repo", repository.slug, "--sha", repository.sha,
            ...(admission.suite === "command" && admission.checkout === "shallow" ? ["--shallow"] : [])], {
            timeoutSeconds: ms / 1000, stdoutBytes: logBytes, stderrBytes: logBytes,
            env: { PATH: "/nonexistent", SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS: String(ms) },
          });
        if (checkout.exitCode !== 0 || checkout.stdout.truncated) return;
        const receipt = JSON.parse(checkout.stdout.text);
        if (receipt?.checkout !== true || receipt.sha !== repository.sha) return;
        const image = (await container.inspect())?.image;
        const digest = /(?:^|@)(sha256:[a-f0-9]{64})$/.exec(image ?? "")?.[1];
        if (!digest && this.env.SANDBOX_RUNNER_MODE !== "fixture") throw new Error("Vitest image digest unavailable");
        if (digest) await this.ctx.storage.transaction(async transaction => {
          const state = await transaction.get<VitestRunState>(stateKey);
          if (state?.status === "running") await transaction.put(stateKey, { ...state, imageDigest: digest });
        });
        return receipt.sha;
      },
      sealCheckout: time => this.#drain("draining_checkout", time, signal),
      openNpm: async (tarballs, time) => {
        signal.throwIfAborted();
        if (Date.now() >= time) throw deadline;
        await this.ctx.storage.transaction(async transaction => {
          const state = await transaction.get<VitestRunState>(stateKey);
          const gate = await transaction.get<EgressGate>(gateKey);
          const next = gate && advanceEgress(gate, "install");
          if (state?.status !== "running" || !next) throw new Error("Git egress has not drained");
          await transaction.put(urlsKey, tarballs);
          await transaction.put(gateKey, next);
        });
      },
      sealNpm: time => this.#drain("closed", time, signal),
    });
  }

  async #cleanup(state: VitestRunState, retryCount: number): Promise<void> {
    if (state.cleanup !== "pending") return;
    let result: "destroyed" | "failed" = "destroyed";
    const container = this.ctx.container;
    try {
      if (!container) throw new Error("Vitest container binding unavailable");
      if (container.running || await container.inspect() !== null) await container.destroy();
      if (container.running || await container.inspect() !== null) throw new Error("Vitest container still present");
    } catch (error) {
      // Cloudflare retries an alarm six times after its initial attempt.
      if (retryCount < 6) throw error;
      result = "failed";
    }
    await this.ctx.storage.transaction(async transaction => {
      const latest = await transaction.get<VitestRunState>(stateKey);
      if (latest) await this.#writeState(transaction, recordVitestCleanup(latest, result), latest);
    });
  }

  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    const state = await this.ctx.storage.get<VitestRunState>(stateKey);
    if (!state) return;
    if (vitestSettled(state)) {
      if (!this.#active) await this.#cleanup(state, info?.retryCount ?? 0);
      return;
    }
    if (state.status === "running") {
      if (Date.now() >= state.deadlineAt) {
        this.#active?.abort(deadline);
        await this.#settle(undefined, "test_timed_out");
      } else if (!this.#active) {
        await this.#settle(undefined, "test_runtime_lost");
      }
      return;
    }
    if (this.#active) return;
    const admission = await this.ctx.storage.get<TestAdmission>(admissionKey);
    if (!admission) throw new Error("Vitest admission unavailable");
    const controller = new AbortController();
    this.#active = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const started = await this.ctx.storage.transaction(async transaction => {
        const latest = await transaction.get<VitestRunState>(stateKey);
        const next = latest && startVitest(latest, Date.now());
        if (!next) return;
        await this.#writeState(transaction, next, latest);
        await transaction.setAlarm(next.status === "running" ? next.deadlineAt : Date.now());
        if (next.status === "running") await transaction.put(gateKey, { phase: "checkout", leases: [] });
        return next;
      });
      if (started?.status !== "running") return;
      timer = setTimeout(() => controller.abort(deadline), Math.max(0, started.deadlineAt - Date.now()));
      const execution = await untilRunStops(() => this.#execute(admission, controller.signal), controller.signal);
      await this.#settle(execution);
    } catch (error) {
      await this.#settle(undefined, error === deadline || Date.now() >= admission.deadlineAt ? "test_timed_out" : "test_runtime_failed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.#active = undefined;
      const latest = await this.ctx.storage.get<VitestRunState>(stateKey);
      if (latest && vitestSettled(latest) && latest.cleanup === "pending") await this.ctx.storage.setAlarm(Date.now());
    }
  }
}
