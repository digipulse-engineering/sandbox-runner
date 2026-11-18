FROM --platform=$BUILDPLATFORM golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS checkout-build
ARG TARGETOS TARGETARCH
WORKDIR /src
ENV GOTOOLCHAIN=local GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOVCS=*:off
COPY checkout/go.mod checkout/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download && go mod verify
COPY checkout/main.go checkout/export.go checkout/export_linux.go checkout/supervisor_linux.go ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOPROXY=off \
    go build -trimpath -buildvcs=false -ldflags '-buildid=' -o /sandbox-runner-checkout .
COPY vitest/command.go /src/command/command.go
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOPROXY=off \
    go build -trimpath -buildvcs=false -ldflags '-buildid=' -o /sandbox-runner-command ./command/command.go

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
RUN apt-get update \
    && apt-get install --no-install-recommends -y git=1:2.39.5-0+deb12u3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && command -v setpriv \
    && groupadd --gid 10001 tester \
    && useradd --uid 10001 --gid 10001 --create-home tester \
    && install -d -o tester -g tester /workspace \
    && install -d -o root -g root -m 0755 /opt/sandbox-runner-vitest
RUN set -eux; \
    tools=/opt/sandbox-runner-vitest/tools; \
    stage=$(mktemp -d); \
    cd "$stage"; \
    npm pack --ignore-scripts --registry=https://registry.npmjs.org pnpm@10.34.8 yaml@2.8.3; \
    printf '%s\n' \
      'f627a8e971343afe49dfd0f63d028234201dfa831d5cb588733e1e5f8db26bf16989a32161ab5c1b4db3b1fdbc373160606b5b89e002df6dd19a85adf91fc5a8  pnpm-10.34.8.tgz' \
      '02f6da08b38ed8eb70fe55b96e687d77f58475c0c5750a766766541f7a57f54da2872518d27bcbbfb27a4eb5a8c2495118f61b07f22e20c7d88316823e0e41a6  yaml-2.8.3.tgz' \
      | sha512sum -c -; \
    mkdir -p "$tools/pnpm" "$tools/yaml"; \
    tar -xzf pnpm-10.34.8.tgz -C "$tools/pnpm" --strip-components=1; \
    tar -xzf yaml-2.8.3.tgz -C "$tools/yaml" --strip-components=1; \
    test "$(node "$tools/pnpm/bin/pnpm.cjs" --version)" = 10.34.8; \
    cd /; \
    rm -rf "$stage"; \
    npm cache clean --force
COPY --chown=0:0 --chmod=755 vitest/pnpm.sh /opt/sandbox-runner-vitest/bin/pnpm
COPY --from=checkout-build --chown=0:0 --chmod=755 /sandbox-runner-checkout /usr/local/bin/sandbox-runner-checkout
COPY --from=checkout-build --chown=0:0 --chmod=755 /sandbox-runner-command /usr/local/bin/sandbox-runner-command
COPY --chown=0:0 --chmod=644 vitest/container.mjs vitest/container-files.mjs vitest/lockfile.ts vitest/pnpm.mjs vitest/pnpm-lockfile.mjs /opt/sandbox-runner-vitest/
USER 10001:10001
# A checkout's package manager pin and workspace config must never replace the bundled pnpm.
RUN --network=none set -eu; \
    fixture=$(mktemp -d); \
    trap 'rm -rf "$fixture"' EXIT; \
    export HOME="$fixture" PATH="/opt/sandbox-runner-vitest/bin:$PATH"; \
    cd "$fixture"; \
    printf '%s\n' '{"name":"fixture","packageManager":"pnpm@10.11.1"}' > package.json; \
    printf '%s\n' 'packages: [packages/*]' 'managePackageManagerVersions: true' 'packageManagerStrictVersion: true' > pnpm-workspace.yaml; \
    printf '%s\n' 'manage-package-manager-versions=true' 'package-manager-strict-version=true' > .npmrc; \
    mkdir -p packages/example; \
    cd packages/example; \
    printf '%s\n' '{"name":"example","scripts":{"child-version":"pnpm --version"}}' > package.json; \
    test "$(pnpm --version)" = 10.34.8; \
    pnpm --help > /dev/null; \
    test "$(pnpm --silent run child-version)" = 10.34.8; \
    test "$(pnpm exec node -p 'process.argv[1]' 'argument with spaces')" = 'argument with spaces'
WORKDIR /workspace
# Keep PID 1 outside the tester's UID and use only the fixed image executable.
USER 0:0
ENTRYPOINT ["/usr/bin/sleep", "infinity"]
