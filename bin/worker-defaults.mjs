import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authProgress, cfCommand, signals, versionPattern, workerVersion } from "./auth.mjs";
import { CliError, exit } from "./cli-errors.mjs";

export async function configureWorkerDefaults(target, env, timeout, { values, label, versionOptions }) {
  const fail = (code, message, category, uncertain) => new CliError(code, message, exit[category], { uncertain });
  const progress = (label, action) => authProgress(Boolean(process.stdin.isTTY && process.stderr.isTTY), env.TERM, label, action);
  const controller = new AbortController();
  const { signal } = controller;
  let mutationAttempted = false;
  const interrupt = () => controller.abort(fail("setup_cancelled", "Setup was interrupted.", "configuration", mutationAttempted));
  const secrets = Object.fromEntries(Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([name, text]) => [name, { name, type: "secret_text", text }]));
  const names = Object.keys(secrets);
  let scratch;
  for (const name of signals) process.on(name, interrupt);
  try {
    scratch = await mkdtemp(join(tmpdir(), "sandbox-runner-worker-defaults-"));
    const cf = cfCommand(target, scratch, env, {
      signal, timeout, onTimeout: () => fail("timeout", "The Cloudflare command timed out.", "timeout", mutationAttempted),
    });
    const readCloudflare = async action => {
      try {
        return await action();
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CliError) throw error;
        throw fail("cloudflare_read_failed", "Could not verify the Worker with cf. Check Cloudflare login, account, and Worker name.", "requestFailure");
      }
    };
    const readVersion = () => readCloudflare(() =>
      workerVersion(cf, target, fail, { ...versionOptions, bindingsToCheck: names }));
    const readVersions = () => readCloudflare(async () => {
      const versions = JSON.parse(await cf("workers", "versions", "list", "--worker-id", target.worker, "--per-page", "2", "-q"));
      const latest = Array.isArray(versions) ? versions[0] : undefined;
      if (typeof latest?.id !== "string" || !versionPattern.test(latest.id) ||
          !Number.isSafeInteger(latest.number) || latest.number < 1) {
        throw fail("worker_target_unverified", "Could not verify the Worker's version history.", "configuration");
      }
      return versions;
    });
    const before = await progress("Checking Cloudflare Worker…", readVersion);
    const body = join(scratch, "patch.json");
    try {
      await writeFile(body, JSON.stringify({ secrets }), {
        mode: 0o600, flag: "wx",
      });
    } catch {
      throw fail("setup_secret_file_failed", "Could not prepare the private settings file.", "configuration");
    }
    const { head, current } = await progress("Rechecking Cloudflare Worker…", async () => ({
      head: (await readVersions())[0], current: await readVersion(),
    }));
    if (current.id !== before.id) {
      throw fail("worker_target_changed", "The active Worker changed during setup. Start setup again for the current version.", "configuration");
    }
    if (current.id !== head.id && Number.isSafeInteger(current.number) && current.number > 0 && current.number < head.number) {
      throw fail("worker_latest_version_not_deployed", `Cloudflare requires the latest Worker version to be active before changing ${label}. Resolve the pending version in Cloudflare and try setup again.`, "configuration");
    }
    if (current.id !== head.id || current.number !== head.number) {
      throw fail("worker_target_unverified", "The active Worker version could not be reconciled with its version history.", "configuration");
    }
    try {
      let receipt;
      try {
        signal.throwIfAborted();
        mutationAttempted = true;
        receipt = JSON.parse(await progress(`Publishing ${label}…`, () =>
          cf("workers", "secrets", "bulk", "--worker", target.worker, "--body", "@" + body)));
      } finally {
        await rm(body, { force: true });
      }
      if (!names.every(name => receipt?.[name]?.name === name && receipt[name].type === "secret_text")) {
        throw new Error("Unverified settings update receipt");
      }
      const { versions, active } = await progress("Verifying active Worker version…", async () => ({
        versions: await readVersions(), active: await readVersion(),
      }));
      const [latest, previous] = versions;
      // The bulk API returns binding metadata. Match the sole new version to the active deployment.
      if (latest.id === head.id || latest.number !== head.number + 1 ||
          previous?.id !== head.id || previous.number !== head.number ||
          active.id !== latest.id || active.number !== latest.number || active.triggeredBy !== "secret" ||
          !names.every(name => active.present.has(name))) {
        throw new Error("Unverified settings update");
      }
      return active.id;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof CliError && error.code === "timeout") throw error;
      throw fail("cloudflare_update_unverified", `Could not confirm the ${label} update. Check the active Cloudflare Worker version before trying again.`, "requestFailure", true);
    }
  } finally {
    try {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    } finally {
      for (const name of signals) process.removeListener(name, interrupt);
    }
  }
}
