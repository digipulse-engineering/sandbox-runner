#!/usr/bin/env python3
"""Generate deterministic Smart HTTP objects for the public synthetic Vitest repo."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

worker = Path(__file__).resolve().parents[1]
source = worker / "qualification" / "vitest" / "project"
passing = """import { readFileSync } from 'node:fs';
import { get } from 'node:https';
import { expect, test } from 'vitest';
test('runs unprivileged with npm egress sealed', async () => {
  expect(process.getuid()).toBe(10001);
  expect(process.getgid()).toBe(10001);
  expect(() => process.setuid(0)).toThrow(/EPERM/);
  for (const key of ['SANDBOX_RUNNER_TOKEN', 'GITHUB_APP_PRIVATE_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    expect(process.env[key]).toBeUndefined();
  }
  const ca = readFileSync('/etc/cloudflare/certs/cloudflare-containers-ca.crt');
  const status = await new Promise((resolve, reject) => {
    const request = get('https://registry.npmjs.org/vitest/-/vitest-5.1.0.tgz', { ca }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('registry probe timed out')));
  });
  expect(status).toBe(403);
  console.log('SANDBOX_RUNNER_VITEST_PASS');
});
"""
failing = """import { expect, test } from 'vitest';
test('reports the deliberate assertion', () => {
  console.log('SANDBOX_RUNNER_VITEST_FAIL');
  expect('ACTUAL_FIXTURE').toBe('EXPECTED_FIXTURE');
});
"""
waiting = """import { test } from 'vitest';
test('waits for cancellation', async () => {
  await new Promise(() => {});
}, 120000);
"""
command = """import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { get } from 'node:https';

const argv = process.argv.slice(2);
if (argv[0] === 'wait') {
  setInterval(() => {}, 1000);
} else if (argv[0] === 'exit') {
  console.log('FIXTURE_COMMAND_EXIT');
  console.error('FIXTURE_COMMAND_STDERR');
  process.exitCode = Number(argv[1]);
} else if (argv[0] === 'signal') {
  process.kill(process.pid, 'SIGTERM');
} else {
  assert.deepEqual(argv, ['--kill-after=1s', '--no-new-privs', '', 'a b', '$(touch SHELL_INJECTION)', '; touch SHELL_INJECTION', '`touch SHELL_INJECTION`', 'é\\n🚀']);
  assert.equal(process.getuid(), 10001);
  assert.equal(process.getgid(), 10001);
  assert.throws(() => process.setuid(0), /EPERM/);
  assert.throws(() => process.setgid(0), /EPERM/);
  assert(!existsSync('SHELL_INJECTION') && !existsSync('UNWANTED_LIFECYCLE'));
  for (const key of ['SANDBOX_RUNNER_TOKEN', 'GITHUB_APP_PRIVATE_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NODE_EXTRA_CA_CERTS']) {
    assert.equal(process.env[key], undefined);
  }
  assert.equal(process.env.PATH.split(':')[0], '/workspace/node_modules/.bin');
  const semver = spawnSync('semver', ['1.2.3'], { encoding: 'utf8' });
  assert.equal(semver.status, 0);
  assert.equal(semver.stdout.trim(), '1.2.3');
  const ca = readFileSync('/etc/cloudflare/certs/cloudflare-containers-ca.crt');
  function status(url) {
    return new Promise((resolve, reject) => {
      const request = get(url, { ca }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('sealed route probe timed out')));
    });
  }
  assert.deepEqual(await Promise.all([
    status('https://registry.npmjs.org/semver/-/semver-7.8.6.tgz'),
    status('https://github.harness.internal/fixture/vitest.git/info/refs?service=git-upload-pack'),
  ]), [403, 403]);
  console.log('FIXTURE_COMMAND_ARGV_AND_SEALED_ROUTES');
}
"""

def pkt(value):
    body = value.encode("ascii")
    return f"{len(body) + 4:04x}".encode("ascii") + body

with tempfile.TemporaryDirectory() as path:
    root = Path(path)
    env = {"PATH": os.environ["PATH"], "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
           "GIT_AUTHOR_NAME": "Vitest fixture", "GIT_COMMITTER_NAME": "Vitest fixture",
           "GIT_AUTHOR_EMAIL": "vitest@example.invalid", "GIT_COMMITTER_EMAIL": "vitest@example.invalid",
           "GIT_AUTHOR_DATE": "2026-11-12T00:00:00Z", "GIT_COMMITTER_DATE": "2026-11-12T00:00:00Z"}

    def git(*args, body=None):
        return subprocess.run(["git", *args], cwd=root, env=env, input=body, check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

    def encode(body):
        return base64.b64encode(body).decode("ascii")

    git("init", "--initial-branch=main", "--object-format=sha1")
    git("config", "uploadpack.allowReachableSHA1InWant", "true")
    for name in ("package.json", "package-lock.json"):
        shutil.copyfile(source / name, root / name)
    entries = {}
    for name, fixture in (("pass", passing), ("fail", failing), ("cancel", waiting)):
        (root / "fixture.test.mjs").write_text(fixture)
        git("add", "package.json", "package-lock.json", "fixture.test.mjs")
        git("commit", "-m", f"Synthetic Vitest {name}")
        sha = git("rev-parse", "HEAD").decode("ascii").strip()
        wire = pkt(f"want {sha} side-band-64k ofs-delta\n") + b"0000" + pkt("done\n")
        entries[name] = {"sha": sha, "pack": encode(git("upload-pack", "--stateless-rpc", ".", body=wire))}

    git("checkout", "--orphan", "command")
    (root / "fixture.test.mjs").unlink(missing_ok=True)
    dependency = json.loads((worker / "package-lock.json").read_text())["packages"]["node_modules/semver"]
    scripts = {"postinstall": "node -e \"require('node:fs').writeFileSync('UNWANTED_LIFECYCLE','ran')\""}
    package = {"name": "sandbox-runner-command-fixture", "version": "1.0.0", "private": True,
               "dependencies": {"semver": dependency["version"]}, "scripts": scripts}
    lock_root = {key: package[key] for key in ("name", "version", "dependencies")}
    lock = {"name": package["name"], "version": package["version"], "lockfileVersion": 3, "requires": True,
            "packages": {"": {**lock_root, "hasInstallScript": True},
                         "node_modules/semver": {key: dependency[key] for key in ("version", "resolved", "integrity", "bin", "engines")}}}
    (root / "package.json").write_text(json.dumps(package, indent=2) + "\n")
    (root / "package-lock.json").write_text(json.dumps(lock, indent=2) + "\n")
    (root / "fixture-command.mjs").write_text(command)
    no_shebang = root / "fixture-no-shebang"
    no_shebang.write_text("printf SHELL_FALLBACK_EXECUTED\\n\n")
    no_shebang.chmod(0o755)
    git("add", "-A")
    git("commit", "-m", "Synthetic argv command with no Vitest dependency")
    sha = git("rev-parse", "HEAD").decode("ascii").strip()
    wire = pkt(f"want {sha} side-band-64k ofs-delta\n") + b"0000" + pkt("done\n")
    entries["command"] = {"sha": sha, "pack": encode(git("upload-pack", "--stateless-rpc", ".", body=wire))}

    git("checkout", "main")
    advertisement = pkt("# service=git-upload-pack\n") + b"0000" + git("upload-pack", "--stateless-rpc", "--advertise-refs", ".")
    fixture = {"advertisement": encode(advertisement), "entries": entries}
    (worker / "vitest" / "fixture-data.ts").write_text(
        "// Generated by tests/build-vitest-fixture.py from a public synthetic fixture.\n"
        + "export const vitestFixtureData = " + json.dumps(fixture, indent=2) + " as const;\n"
    )
