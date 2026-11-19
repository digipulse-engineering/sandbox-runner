FROM --platform=$BUILDPLATFORM golang:1.26.11-bookworm@sha256:dc40a13b61304647ed7e5d581d246b86413dfc29d63c6d018310feb93cd98fc0 AS checkout-build
ARG TARGETOS TARGETARCH
WORKDIR /src
ENV GOTOOLCHAIN=local GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOVCS=*:off
COPY checkout/go.mod checkout/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download && go mod verify
COPY checkout/main.go checkout/export.go checkout/export_linux.go checkout/supervisor_linux.go ./
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOPROXY=off \
    go build -trimpath -buildvcs=false -ldflags '-buildid=' -o /sandbox-runner-checkout .

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS opencode-build
WORKDIR /tmp/opencode
RUN npm pack --ignore-scripts --registry=https://registry.npmjs.org @opencode/cli-linux-x64@2.2.7 \
    && echo "c24fc33c7c6be266a25be166429f33b685e5a3fbc2e6ab261081ec2cd68d2d92f689a2187e1caa1517ba091b02571cbe89bd2c7cad3b5f621ea45c3b6522aa35  opencode-cli-linux-x64-2.2.7.tgz" | sha512sum -c - \
    && tar -xOzf opencode-cli-linux-x64-2.2.7.tgz package/bin/opencode > /opencode \
    && echo "589253d36810f21217edd51545cd435b328cdc3cf4f451fbe0cce6f88afcf5e1  /opencode" | sha256sum -c -

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN npm install --global --no-fund --no-audit @anthropic-ai/claude-code@2.1.289 \
    && claude --version \
    && npm cache clean --force
RUN npm install --global --no-fund --no-audit @openai/codex@0.157.0 \
    && test "$(codex --version)" = "codex-cli 0.157.0" \
    && npm cache clean --force \
    && groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --create-home agent \
    && install -d -o agent -g agent /workspace
RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends git=1:2.39.5-0+deb12u3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=checkout-build --chown=0:0 --chmod=755 /sandbox-runner-checkout /usr/local/bin/sandbox-runner-checkout
COPY --from=opencode-build --chown=0:0 --chmod=755 /opencode /usr/local/bin/opencode
# The daemon starts as root and launches the OpenCode reviewer as agent.
RUN install -d -m 0755 /opt/sandbox-runner
COPY --chown=0:0 --chmod=644 daemon.mjs /opt/sandbox-runner/daemon.mjs
COPY --chown=0:0 --chmod=644 opencode-review-runner.mjs /opt/sandbox-runner/opencode-review-runner.mjs
RUN node -e 'process.setgroups([]); process.setgid(10001); process.setuid(10001); const fs = require("node:fs"); fs.accessSync("/opt/sandbox-runner/opencode-review-runner.mjs", fs.constants.R_OK)'
ENTRYPOINT ["node", "/opt/sandbox-runner/daemon.mjs"]
