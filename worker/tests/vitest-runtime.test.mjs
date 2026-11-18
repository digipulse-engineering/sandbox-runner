import assert from "node:assert/strict";
import { test } from "node:test";
import { captureOutput, runVitest } from "../vitest/runtime.ts";

const sha = "a".repeat(40);
const digest = "b".repeat(64);
const tarball = "https://registry.npmjs.org/vitest/-/vitest-5.1.0.tgz";
const metadata = { sha, lockSha256: digest, nodeVersion: "v24.22.2", npmVersion: "11.21.1",
  lock: { vitestVersion: "5.1.0", tarballs: [tarball] } };
const launcher = "/opt/sandbox-runner-vitest/container.mjs";
const launcherArgs = native => native.slice(native.indexOf(launcher) + 1);

function setup(overrides = {}) {
  const phases = [];
  const attestations = [];
  const options = {
    expectedSha: sha, deadlineAt: Date.now() + 60_000, logBytes: 128, maxLockBytes: 4096,
    async checkout() { phases.push("git"); return overrides.checkoutSha ?? sha; },
    async sealCheckout() { phases.push("git-sealed"); },
    async openNpm(tarballs) { assert.deepEqual(tarballs, [tarball]); phases.push("npm-open"); },
    async sealNpm() { phases.push("npm-sealed"); if (overrides.failSeal) throw new Error("drain failed"); },
    async setPhase(phase, observed) {
      phases.push(phase);
      attestations.push([phase, { ...observed }]);
    },
    container: {
      async exec(argv, { cwd, user, env }) {
        assert.equal(cwd, "/workspace");
        assert.equal(user, "0:0");
        assert.deepEqual(Object.keys(env).sort(), ["CI", "HOME", "NO_COLOR", "PATH"]);
        const timeout = argv[13];
        assert.match(timeout, /^\d+(?:\.\d+)?s$/);
        assert.deepEqual(argv.slice(0, 16), ["/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all",
          "--ambient-caps=-all", "--no-new-privs", "--reuid", "10001", "--regid", "10001", "--clear-groups", "--",
          "/usr/bin/timeout", "--kill-after=5s", timeout, "/usr/local/bin/node", launcher]);
        const [phase, expectedSha, , lockedDigest] = launcherArgs(argv);
        assert.equal(expectedSha, sha);
        phases.push("exec-" + phase);
        overrides.onCommand?.(phase);
        if (phase !== "inspect") assert.equal(lockedDigest, digest);
        const output = phase === "inspect" ? JSON.stringify(overrides.metadata ?? metadata) : "command output";
        const exit = phase === "install" ? overrides.installExit ?? 0 : phase === "vitest" ? overrides.testExit ?? 0 : 0;
        return { exitCode: Promise.resolve(exit), stdout: new Response(output).body, stderr: new Response("").body };
      },
    },
  };
  return { phases, attestations, options };
}

test("attests the SHA and lock, drains network authority, and preserves the Vitest exit", async () => {
  for (const testExit of [0, 1]) {
    const { phases, attestations, options } = setup({ testExit });
    const result = await runVitest(options);
    assert.deepEqual(phases, ["checkout", "git", "git-sealed", "lockfile", "exec-inspect", "install", "npm-open",
      "exec-install", "npm-sealed", "test", "exec-vitest"]);
    assert.equal(result.status, testExit ? "failed" : "succeeded");
    assert.equal(result.reason, testExit ? "test_failed" : undefined);
    assert.equal(result.command.exitCode, testExit);
    assert.equal(result.command.stdout.text, "command output");
    assert.equal(result.checkoutSha, sha);
    assert.equal(result.lockSha256, digest);
    assert.equal(result.versions.vitestVersion, "5.1.0");
    const verified = { checkoutSha: sha, lockSha256: digest, versions: result.versions };
    assert.deepEqual(attestations, [["checkout", {}], ["lockfile", { checkoutSha: sha }],
      ["install", verified], ["test", verified]]);
  }
});

test("refuses to execute repository code when lock, installation, or egress closure fails", async () => {
  for (const [overrides, reason] of [
    [{ checkoutSha: "c".repeat(40) }, "checkout_failed"],
    [{ metadata: { ...metadata, lock: { vitestVersion: "5.1.0", tarballs: ["https://invalid.example/package.tgz"] } } }, "test_lockfile_unverified"],
    [{ installExit: 23 }, "test_install_failed"],
    [{ installExit: 124 }, "test_install_failed"],
  ]) {
    const { phases, options } = setup(overrides);
    assert.equal((await runVitest(options)).reason, reason);
    assert(!phases.includes("exec-vitest"));
    if (overrides.installExit) assert.equal(phases.at(-1), "npm-sealed");
  }
  const { phases, options } = setup({ failSeal: true });
  await assert.rejects(runVitest(options), /drain failed/);
  assert(!phases.includes("exec-vitest"));
});

test("reports TERM and forced KILL at the deadline while preserving an early runtime failure", async t => {
  let clock = 10_000;
  t.mock.method(Date, "now", () => clock);
  const early = setup({ testExit: 137 });
  assert.equal((await runVitest(early.options)).reason, "test_runtime_failed");
  for (const testExit of [124, 137]) {
    const { options } = setup({ testExit, onCommand(phase) {
      if (phase === "vitest") clock = options.deadlineAt;
    } });
    const result = await runVitest(options);
    assert.equal(result.reason, "test_timed_out");
    assert.equal(result.command.exitCode, testExit);
  }
});

test("bounds each captured stream and still drains the full native output", async () => {
  const data = new TextEncoder().encode("prefix plus tail");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(data.subarray(0, 3));
      controller.enqueue(data.subarray(3));
      controller.close();
    },
  });
  assert.deepEqual(await captureOutput(stream, 6), { text: "prefix", bytes: data.length, truncated: true });
});

test("sends command argv over stdin and distinguishes child exits, signals and launcher errors", async () => {
  const argv = ["node", "--kill-after=1s", "", "$(touch nope)"];
  const stdout = { data: "b3V0", bytes: 3, truncated: false };
  const stderr = { data: "ZXJy", bytes: 3, truncated: false };
  for (const [envelope, reason, nativeExit] of [
    [{ exitCode: 0, stdout, stderr }, undefined, 0],
    [{ exitCode: 124, stdout, stderr }, "test_command_failed", 0],
    [{ exitCode: 125, stdout, stderr }, "test_command_failed", 0],
    [{ signal: 15, stdout, stderr }, "test_command_signaled", 0],
    [{ startError: "invalid_executable" }, "test_command_invalid_executable", 0],
    [{ exitCode: 0, stdout: { ...stdout, bytes: 4 }, stderr }, "test_runtime_failed", 0],
    [{}, "test_runtime_failed", 125],
  ]) {
    const { options } = setup();
    options.argv = argv;
    const phases = [];
    options.openNpm = async urls => assert.deepEqual(urls, []);
    options.sealNpm = async () => phases.push("sealed");
    options.container.exec = async (native, { stdin }) => {
      const [phase, ...args] = launcherArgs(native);
      phases.push(phase);
      let output = "";
      if (phase === "inspect-command") output = JSON.stringify({ ...metadata, lock: { tarballs: [] } });
      if (phase === "command") {
        assert.deepEqual(args, [sha, String(options.maxLockBytes), digest, String(options.logBytes)]);
        assert.deepEqual(await new Response(stdin).json(), argv);
        output = JSON.stringify(envelope);
      } else assert.equal(stdin, undefined);
      return { exitCode: Promise.resolve(phase === "command" ? nativeExit : 0), stdout: new Response(output).body };
    };
    const result = await runVitest(options);
    assert.deepEqual(phases, ["inspect-command", "install-command", "sealed", "command"]);
    assert.equal(result.reason, reason);
    assert.equal(result.status, reason ? "failed" : "succeeded");
    assert.equal(result.versions.vitestVersion, undefined);
    if (reason === "test_runtime_failed" || envelope.startError) assert.equal(result.command, undefined);
    else assert.equal(result.command.stdout.text, "out");
  }
});

test("seeds the pnpm store before draining egress and performs checkout installation offline", async () => {
  const argv = ["pnpm", "run", "types"];
  for (const failure of [undefined, "fetch-pnpm", "install-pnpm", "seal", "version"]) {
    const { options, phases } = setup();
    options.argv = argv;
    options.sealNpm = async () => {
      phases.push("npm-sealed");
      if (failure === "seal") throw new Error("drain failed");
    };
    options.container.exec = async (native, { stdin }) => {
      const [phase, , , lockedDigest] = launcherArgs(native);
      phases.push("exec-" + phase);
      let output = "";
      if (phase === "inspect-command") output = JSON.stringify({ ...metadata, pnpmVersion: failure === "version" ? "0.0.0" : "10.34.8" });
      else assert.equal(lockedDigest, digest);
      if (phase === "command") {
        assert.deepEqual(await new Response(stdin).json(), argv);
        const empty = { data: "", bytes: 0, truncated: false };
        output = JSON.stringify({ exitCode: 0, stdout: empty, stderr: empty });
      } else assert.equal(stdin, undefined);
      return { exitCode: Promise.resolve(phase === failure ? 125 : 0), stdout: new Response(output).body };
    };
    if (failure === "seal") await assert.rejects(runVitest(options), /drain failed/);
    else {
      const run = await runVitest(options);
      assert.equal(run.status, failure ? "failed" : "succeeded");
      assert.equal(run.reason, failure === "version" ? "test_lockfile_unverified" : failure ? "test_install_failed" : undefined);
      assert.equal(run.versions?.pnpmVersion, failure === "version" ? undefined : "10.34.8");
    }
    const expected = ["checkout", "git", "git-sealed", "lockfile", "exec-inspect-command"];
    if (failure !== "version") expected.push("install", "npm-open", "exec-fetch-pnpm", "npm-sealed");
    if (!failure || failure === "install-pnpm") expected.push("exec-install-pnpm");
    if (!failure) expected.push("test", "exec-command");
    assert.deepEqual(phases, expected);
  }
});
