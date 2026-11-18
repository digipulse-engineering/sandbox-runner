import { authenticate, versionPattern } from "./auth.mjs";
import { CliError, exit, readTimeout } from "./cli-errors.mjs";

// Private child entry point. Each credential prompt gets a fresh terminal stream.
const [expectedVersion, ...args] = process.argv.slice(2);
try {
  if (!versionPattern.test(expectedVersion)) {
    throw new CliError("configuration_error", "The expected Worker version is invalid.", exit.configuration);
  }
  const output = await authenticate(args, process.env, {
    CliError, exit, timeout: readTimeout(process.env), expectedVersion,
  });
  process.stdout.write(JSON.stringify(output) + "\n");
} catch (error) {
  const failure = error instanceof CliError
    ? error
    : new CliError("internal_error", "Could not complete credential setup.", exit.requestFailure);
  process.stdout.write(JSON.stringify({
    error: failure.code, message: failure.message, uncertain: failure.uncertain || undefined,
  }) + "\n");
  process.exitCode = failure.exitCode;
}
