# Native workspace export fixture

This local `cf dev` fixture starts the product image with internet disabled. A synthetic commit is created before the root-only snapshot. The fixture then changes the workspace as UID/GID 10001 and replaces `.git` with an external symlink. It calls the same native export command and receipt parser that the publication integration will use. The response includes synthetic paths and hashes, with file contents reduced to booleans.

The successful case checks an executable modification, a deletion, an addition, and an ignored file. The other cases check symlinks, hardlinks, a bind mount on the same filesystem, Git path aliases, the wire byte budget, and an active background process. Each case destroys its container.

From the project root, with the Worker's npm dependencies already installed:

```sh
mkdir -p worker/.local
project=$(mktemp -d "$PWD/worker/.local/export-fixture.XXXXXXXX")
mkdir "$project/checkout"
cp worker/Dockerfile worker/.dockerignore worker/vite.config.ts worker/package.json \
  worker/prepare-sdk.sh worker/daemon.ts worker/claude-terminal-diagnostics.ts \
  worker/checkout-daemon.ts worker/github-export.ts worker/github-auth.ts worker/run-input-validation.mjs "$project/"
cp worker/checkout/go.mod worker/checkout/go.sum worker/checkout/main.go \
  worker/checkout/export.go worker/checkout/export_linux.go "$project/checkout/"
cp worker/qualification/github-export/cloudflare.config.ts \
  worker/qualification/github-export/worker.ts worker/qualification/github-export/verify.mjs "$project/"
ln -s "$PWD/worker/node_modules" "$project/node_modules"
cd "$project"
bash prepare-sdk.sh
./node_modules/.bin/cf dev --port 8911
```

In another shell, run `node verify.mjs` from the staged directory. `SANDBOX_RUNNER_TEST_URL` selects the loopback endpoint. `SANDBOX_RUNNER_GITHUB_CHECKOUT_TIMEOUT_MS` configures the native command deadline when starting the fixture. The default uses the checkout canary's deadline. Stop the local server after the matrix.

The native export stream uses newline-delimited JSON. A header identifies the base commit and tree. Delta records contain deletions or regular-file puts with mode and Git blob SHA. A summary supplies the candidate tree SHA and delta count. The footer hashes every preceding byte with SHA-256. The Worker requires native exit 0 and validates the size, framing, digest, path and blob records before returning a candidate. Its 8 MiB ceiling allows room within the 128 MB isolate memory limit for the wire buffer, decoded JSON and blobs. Calls may set a lower limit. [Cloudflare Workers memory limit](https://developers.cloudflare.com/workers/platform/limits/#memory)
