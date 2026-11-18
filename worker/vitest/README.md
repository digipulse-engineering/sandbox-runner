# Native Vitest runtime

The runtime uses a dedicated Cloudflare Container application with the `default` scheduling policy and a fixed image. The owner starts it with `enableInternet: false`. Native commands run as UID and GID `10001` with `setpriv --no-new-privs` and a fixed environment. The image checks process credentials, capabilities and the refusal to regain root before starting a command.

The run owner supplies the verified Git checkout and the durable network gates. `runVitest` checks the exact checkout SHA, validates the tracked npm lockfile, and admits only the pinned tarball URLs for `npm ci --ignore-scripts`. The lockfile SHA-256 is rechecked before installation and test execution. The supported lockfile inputs are npm v2 and v3 with public registry tarballs and SHA-512 integrity. In-tree workspace links are checked against the checkout filesystem.

The owner closes and drains the Git relay before opening npm, then closes and drains npm before the local Vitest executable starts. The gate tracks leases through response consumption, cancellation and errors. A Git relay integration must preserve the upload-pack response framing. Cloudflare uses chunked framing for ordinary wrapped streams. [Cloudflare response framing](https://developers.cloudflare.com/workers/runtime-apis/response/#set-the-content-length-header)

The execution result records the verified SHA, lock digest, runtime versions, elapsed time and bounded command output. The owner supplies a durable deadline shared by checkout, network drain and native commands. It persists the result before destroying the container, then verifies and records cleanup. Cancellation closes both gates and stops the container. The gateway owns the public run identity and replay contract.
