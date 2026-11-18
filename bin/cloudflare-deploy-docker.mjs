import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CliError, exit } from "./cli-errors.mjs";

const exec = promisify(execFile);

export async function dockerBuildEnv(env, cwd, signal, timeout) {
  const config = resolve(env.DOCKER_CONFIG || join(homedir(), ".docker"));
  const selected = { ...env, DOCKER_CONFIG: config };
  if (env.DOCKER_CERT_PATH) selected.DOCKER_CERT_PATH = resolve(env.DOCKER_CERT_PATH);
  if (env.DOCKER_CONTEXT || !env.DOCKER_HOST) {
    const inspect = async () => {
      const { stdout } = await exec("docker", ["context", "show"], { cwd, env: selected, signal, timeout });
      const context = stdout.trim();
      if (!/^[^\s\u0000-\u001f]+$/u.test(context)) throw new Error();
      return context;
    };
    try {
      selected.DOCKER_CONTEXT = env.DOCKER_CONTEXT || await inspect();
    } catch {
      signal.throwIfAborted();
      throw new CliError("docker_context_unverified", "Could not determine the selected Docker context.", exit.configuration);
    }
    // Docker gives a selected context priority over an explicit daemon host.
    delete selected.DOCKER_HOST;
  }
  return selected;
}

export async function dockerUploadEnv(build, scratch) {
  const directory = join(scratch, "docker");
  await mkdir(directory, { mode: 0o700 });
  if (build.DOCKER_CONTEXT && build.DOCKER_CONTEXT !== "default") {
    await symlink(join(build.DOCKER_CONFIG, "contexts"), join(directory, "contexts"), "dir");
  }
  // A present auths entry keeps Docker from auto-selecting a global credential helper.
  await writeFile(join(directory, "config.json"), JSON.stringify({ auths: { "registry.cloudflare.com": {} } }), {
    mode: 0o600, flag: "wx",
  });
  const env = { ...build, DOCKER_CONFIG: directory };
  if (build.DOCKER_HOST && (build.DOCKER_TLS || build.DOCKER_TLS_VERIFY) && !build.DOCKER_CERT_PATH) {
    env.DOCKER_CERT_PATH = build.DOCKER_CONFIG;
  }
  delete env.DOCKER_AUTH_CONFIG;
  return env;
}
