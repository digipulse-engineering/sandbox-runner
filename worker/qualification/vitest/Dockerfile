FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
RUN apt-get update \
    && apt-get install --no-install-recommends -y git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 tester \
    && useradd --uid 10001 --gid 10001 --create-home tester
COPY project/ /opt/vitest-qualification/project/
COPY fixture-pin.json /opt/vitest-qualification/
COPY --chmod=755 fixture-source.sh source-info.sh /opt/vitest-qualification/
RUN /opt/vitest-qualification/fixture-source.sh /opt/vitest-qualification/project /workspace \
      "$(node -p 'require("/opt/vitest-qualification/fixture-pin.json").commit')" \
    && chown -R 10001:10001 /workspace
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["sleep", "infinity"]
