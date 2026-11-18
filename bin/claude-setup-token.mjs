import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

const successHeading = "Long-lived authentication token created successfully!";
const tokenHeading = /^Your OAuth token \(valid for [^()]+\):$/;
const tokenFooter = "Store this token securely.";
const tokenStart = /^sk-ant-oat[0-9]+-[A-Za-z0-9_-]*$/;
export const claudeOAuthToken = /^sk-ant-oat[0-9]+-[A-Za-z0-9_-]+$/;
// Cloudflare Workers limit each secret binding value to 5 KB.
// https://developers.cloudflare.com/workers/platform/limits/#environment-variables
const secretLimit = 5 * 1024;

function setupTokenReader() {
  let expected = "success";
  let parts = "";
  let credential;
  let complete = false;
  let ambiguous = false;
  const seen = { heading: false, label: false, tokenPrefix: false, footer: false };

  return {
    line(rawLine) {
      const line = stripVTControlCharacters(rawLine).trim();
      seen.heading ||= line.includes(successHeading);
      seen.label ||= line.includes("Your OAuth token (valid for");
      seen.tokenPrefix ||= line.includes("sk-ant-oat");
      seen.footer ||= line.includes(tokenFooter);
      if (line === successHeading || line === "✓ " + successHeading) {
        expected = "label";
        parts = "";
        complete = false;
        return;
      }
      if (!line) {
        if (expected === "continuation") expected = "footer";
        return;
      }
      if (expected === "label" && tokenHeading.test(line)) {
        expected = "token";
        return;
      }
      if (expected === "token" && tokenStart.test(line) && line.length <= secretLimit) {
        parts = line;
        expected = "continuation";
        return;
      }
      if (expected === "continuation" || expected === "footer") {
        if ((line === tokenFooter || line.startsWith(tokenFooter + " ")) && claudeOAuthToken.test(parts)) {
          if (credential !== undefined && credential !== parts) ambiguous = true;
          credential = parts;
          complete = true;
        } else if (expected === "continuation" && /^[A-Za-z0-9_-]+$/.test(line) &&
            !tokenStart.test(line) && parts.length + line.length <= secretLimit) {
          parts += line;
          return;
        }
      }
      if (tokenStart.test(line)) ambiguous = true;
      expected = "success";
      parts = "";
    },
    token() {
      if (complete && !ambiguous) return credential;
    },
    diagnostics() {
      return { ...seen, expected, complete, ambiguous };
    },
  };
}

function claudeEnv(env, configDir) {
  const allowed = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "LANG", "LANGUAGE",
    "TMPDIR", "TMP", "TEMP", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP", "DBUS_SESSION_BUS_ADDRESS",
  ]);
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key) || key.startsWith("LC_"))),
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    NO_COLOR: "1",
  };
}

export async function captureClaudeSetupToken({ env, cwd, signal, cancelled, timeout }) {
  signal.throwIfAborted();
  if (process.platform !== "darwin") return { reason: "unsupported_platform" };
  const configured = env.SANDBOX_RUNNER_CLAUDE_BIN ?? "claude";
  if (!configured || configured.includes("\0")) return { reason: "invalid_executable" };
  const executable = configured.includes("/") ? resolve(configured) : configured;
  const configDir = join(cwd, "claude");
  await mkdir(configDir, { mode: 0o700 });
  signal.throwIfAborted();
  // macOS script needs a POSIX pipe on stdin. Give Claude a TTY for input,
  // with separate output pipes so Ink renders complete frames.
  const command = 'exec /usr/bin/script -q /dev/null /bin/sh -c "$1" sandbox-runner-claude-setup-token "$2" setup-token < <(/bin/cat 2>/dev/null 3>&- 4>&-)';
  const claudeCommand = '/bin/stty rows 42 cols 256 && exec "$@" >&3 2>&4 3>&- 4>&-';
  const child = spawn("/bin/bash", [
    "-c", command, "sandbox-runner-claude-bridge", claudeCommand, executable,
  ], {
    cwd,
    env: claudeEnv(env, configDir),
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    detached: true,
    signal,
  });
  const reader = setupTokenReader();
  const stream = { ansi: false, carriageReturn: false, outputSeen: false, errorOutputSeen: false, bridgeOutputSeen: false };
  const stdout = child.stdio[3];
  stdout.on("data", chunk => {
    stream.outputSeen ||= chunk.length > 0;
    stream.ansi ||= chunk.includes(27);
    stream.carriageReturn ||= chunk.includes(13);
  });
  const lines = createInterface({ input: stdout, crlfDelay: Infinity });
  lines.on("line", reader.line);
  child.stdio[4].on("data", chunk => { stream.errorOutputSeen ||= chunk.length > 0; });
  for (const bridge of [child.stdout, child.stderr]) {
    bridge.on("data", chunk => { stream.bridgeOutputSeen ||= chunk.length > 0; });
  }

  let childFailed = false;
  let inputEnded = false;
  let expired = false;
  child.on("error", () => { childFailed = true; });
  child.stdin.on("error", () => {});
  const closed = new Promise(resolveClose => {
    child.once("close", (...result) => resolveClose(result));
  });

  const input = process.stdin;
  const forward = chunk => {
    const data = Buffer.from(chunk);
    // The outer terminal delivers lines ending in LF. Ink expects Enter as CR.
    for (let i = 0; i < data.length; i++) if (data[i] === 10) data[i] = 13;
    if (!child.stdin.write(data)) input.pause();
  };
  const resume = () => input.resume();
  const closeInput = () => child.stdin.end();
  const stop = () => {
    closeInput();
    child.kill();
  };
  const end = () => {
    inputEnded = true;
    stop();
  };
  input.on("data", forward);
  input.once("end", end);
  child.stdin.on("drain", resume);
  signal.addEventListener("abort", closeInput, { once: true });
  const deadline = setTimeout(() => {
    expired = true;
    stop();
  }, timeout);
  try {
    const [code, exitSignal] = await closed;
    signal.throwIfAborted();
    if (inputEnded || exitSignal === "SIGINT" || code === 130) throw cancelled();
    if (!expired && !childFailed && code === 0) {
      const credential = reader.token();
      if (credential) return { credential };
    }
    const reason = expired ? "timeout" : childFailed ? "spawn_failed" :
      exitSignal ? "child_signaled" : code === 127 ? "executable_not_found" : code !== 0 ? "child_exit" : "output_unrecognized";
    return { reason, exitCode: code, ...stream, ...reader.diagnostics() };
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", closeInput);
    input.pause();
    input.removeListener("data", forward);
    input.removeListener("end", end);
    child.stdin.removeListener("drain", resume);
    closeInput();
    lines.close();
  }
}
