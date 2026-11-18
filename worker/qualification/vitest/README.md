# Native Cloudflare Containers qualification for Vitest

The canary runs two fixed Vitest commands through the Durable Object's native `ctx.container.exec()`. The source is a synthetic Git checkout seeded into the container image. The image build and the canary both check the exact commit in `fixture-pin.json`. This proves native execution independently of private Git transport. The image uses the pinned Node 24 base from Sandbox Runner and installs Git during the image build.

The container starts with `enableInternet: false`. During `npm ci --ignore-scripts`, the Worker permits GET and HEAD for the exact registry tarball URLs in `project/package-lock.json`. It opens the route after source verification and forwards requests to the fixed npm HTTPS origin without incoming headers or redirects. It closes the durable allow gate and replaces the intercept with a denying handler before starting Vitest. [Cloudflare outbound policies](https://developers.cloudflare.com/containers/configuration/outbound-traffic/#change-policies-at-runtime)

The passing command includes tests that verify loopback HTTP works, the previously allowed registry tarball returns the canary's denial, DNS lookups fail through the default and a public resolver, and direct public IP probes cannot establish TLS on the HTTPS and DNS-over-TLS ports. Both TLS probes record whether a TCP socket opened so the receipt can distinguish a connection accepted by the local proxy from a completed TLS handshake. Hosted runs also verify that a controlled HTTPS witness receives a signed request from the operator's machine and sees no request with the sandbox's separate signed nonce. The second command produces an intentional failing assertion. The receipt includes both exit codes and their output streams. Each stream retains a prefix of up to 32 KiB and records the original byte count. This bounds the combined record for Durable Object storage. [Cloudflare storage limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

## Build and run

Use Node 24, a Docker daemon with Buildx, and the `cf` version from the Worker lockfile. From the Sandbox Runner checkout root, install the Worker toolchain, enter this directory and link the installed dependencies.

```sh
npm --prefix worker ci --ignore-scripts
cd worker/qualification/vitest
ln -s ../../node_modules node_modules
export PATH="$PWD/node_modules/.bin:$PATH"
node --test registry.test.mjs witness.test.mjs
cf build
```

Create a private scratch directory and a synthetic control token. Choose a fresh canary name for each deployment.

```sh
scratch=$(mktemp -d)
chmod 700 "$scratch"
(umask 077; openssl rand -hex 32 > "$scratch/token")
(umask 077; printf 'VITEST_QUALIFICATION_TOKEN=%s\n' "$(cat "$scratch/token")" > "$scratch/secrets.env")
export VITEST_QUALIFICATION_NAME='<unique-canary-name>'
```

For local development, use the synthetic secret in this canary's `.dev.vars` and start the Worker on loopback. Use a fresh state directory for each run.

```sh
test ! -e .dev.vars && install -m 600 "$scratch/secrets.env" .dev.vars
VITEST_QUALIFICATION_STATE="$scratch/state" cf dev --port 8906
```

For a hosted qualification, check the exact Worker, Container application and registry image names are available on the selected Cloudflare account. Set `origin` to the dedicated canary's HTTPS `workers.dev` origin for the external witness. Deploy the canary with the synthetic secret file and the intended Cloudflare profile.

```sh
VITEST_QUALIFICATION_WITNESS_ORIGIN="$origin" cf deploy --profile "$profile" --secrets-file "$scratch/secrets.env"
```

From another shell, use the local `http://127.0.0.1:8906` or the deployed HTTPS Worker origin. Choose and keep a UUID before submitting so a disrupted invocation can be repeated for the same run.

```sh
node verify.mjs "$origin" "$scratch/token" "$operation_id" > "$scratch/result.json"
```

The verifier checks unauthenticated access, submits the run, retrieves the result from Durable Object storage after `destroy()` and `inspect()`, and compares the result, status and submission replay. For hosted evidence, also check that `cf containers applications instances list --application-id "$app_id" --state active` is empty for the dedicated application. Record the Worker version, image digest and application ID before removing the dedicated resources and scratch files. Remove the local `.dev.vars` created for the canary after stopping `cf dev`.

For hosted cleanup, delete the canary Worker by name. Check the application inventory and delete the exact canary application if it remains. Delete the recorded image tag after the application is gone. Recheck all three inventories for the canary identifiers.

```sh
cf workers delete --profile "$profile" --worker "$VITEST_QUALIFICATION_NAME"
cf containers applications delete --profile "$profile" "$app_id"
cf containers images delete --profile "$profile" "$image_tag"
```

`VITEST_QUALIFICATION_COMMAND_TIMEOUT_SECONDS` controls the deadline for each native command and the Vitest test timeout, with a default of 120 seconds. `VITEST_QUALIFICATION_PROBE_TIMEOUT_MS` sets the network probe observation window, with a default of 3,000 milliseconds. DNS and TLS record deadline expiration distinctly from a connection error. `VITEST_QUALIFICATION_VERIFY_TIMEOUT_MS` controls how long the verifier waits for a receipt, with a default of 240 seconds.

## Recorded qualification

- The local receipt records the initial TCP connection events, the TLS and DNS outcomes, and both Vitest exit codes. [Local evidence](evidence/local.json)
- The first hosted run exposed a mismatch between Vitest test deadlines and the network callbacks. The HTTPS witness and destruction were verified. [First hosted receipt](evidence/hosted-first.json)
- The corrected hosted run passed with Vitest 5.1.0 and Node 24. The receipt records the signed witness checks, the stopped instance and the final resource inventory. [Hosted evidence](evidence/hosted.json)
