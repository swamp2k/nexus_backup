ARG NEXUS_BACKUP_VERSION=dev
ARG NEXUS_BACKUP_REVISION=unknown

FROM golang:1.24-alpine AS workstation
ARG NEXUS_BACKUP_VERSION
ARG NEXUS_BACKUP_REVISION
WORKDIR /src/apps/workstation-agent
COPY apps/workstation-agent/go.mod ./go.mod
COPY apps/workstation-agent/*.go ./
RUN mkdir -p /out \
    && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-X main.version=${NEXUS_BACKUP_VERSION} -X main.revision=${NEXUS_BACKUP_REVISION} -s -w" -o /out/nexus-backup-workstation-windows-amd64.exe . \
    && cd /out \
    && sha256sum nexus-backup-workstation-windows-amd64.exe > nexus-backup-workstation-windows-amd64.exe.sha256

FROM alpine:3.22 AS restic-windows
ARG RESTIC_VERSION=0.19.1
ARG RESTIC_ZIP_SHA256=da948ad707ed690426473aaba2046cd61f8f90f6f0e7dab6be0d5796531de67d
RUN apk add --no-cache ca-certificates curl unzip \
    && mkdir -p /out /tmp/restic \
    && curl -fL --retry 3 --retry-delay 2 \
      "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_windows_amd64.zip" \
      -o /tmp/restic.zip \
    && echo "${RESTIC_ZIP_SHA256}  /tmp/restic.zip" | sha256sum -c - \
    && unzip -q /tmp/restic.zip -d /tmp/restic \
    && RESTIC_EXE="$(find /tmp/restic -maxdepth 1 -type f -name 'restic*.exe' -print -quit)" \
    && test -n "$RESTIC_EXE" \
    && mv "$RESTIC_EXE" /out/restic.exe \
    && cd /out \
    && sha256sum restic.exe > restic.exe.sha256

FROM node:22-alpine AS build
WORKDIR /src
RUN npm install --global typescript@5.8.3
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --ignore-scripts
RUN npm run build

FROM node:22-alpine AS runtime
ARG NEXUS_BACKUP_VERSION=dev
ARG NEXUS_BACKUP_REVISION=unknown
ARG REST_SERVER_VERSION=0.14.0
ARG REST_SERVER_SHA256=4c9c95bc079a0334e81fad379b19dc5c3353c71c2c88d652cafce2081c2b1c66

LABEL org.opencontainers.image.title="Nexus Backup" \
      org.opencontainers.image.description="Self-contained local-first backup, recovery and transfer appliance for Unraid" \
      org.opencontainers.image.source="https://github.com/swamp2k/nexus_backup" \
      org.opencontainers.image.version="$NEXUS_BACKUP_VERSION" \
      org.opencontainers.image.revision="$NEXUS_BACKUP_REVISION" \
      org.opencontainers.image.vendor.rest-server.version="$REST_SERVER_VERSION"

RUN apk add --no-cache \
      apache2-utils \
      ca-certificates \
      curl \
      fuse3 \
      openssl \
      rclone \
      restic \
      tini \
    && mkdir -p /tmp/rest-server \
    && curl -fL --retry 3 --retry-delay 2 \
      "https://github.com/restic/rest-server/releases/download/v${REST_SERVER_VERSION}/rest-server_${REST_SERVER_VERSION}_linux_amd64.tar.gz" \
      -o /tmp/rest-server.tar.gz \
    && echo "${REST_SERVER_SHA256}  /tmp/rest-server.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/rest-server.tar.gz -C /tmp/rest-server \
    && REST_SERVER_BIN="$(find /tmp/rest-server -maxdepth 2 -type f -name 'rest-server*' -print -quit)" \
    && test -n "$REST_SERVER_BIN" \
    && install -m 0755 "$REST_SERVER_BIN" /usr/local/bin/rest-server \
    && rm -rf /tmp/rest-server /tmp/rest-server.tar.gz

WORKDIR /app

COPY --from=build /src/packages/core/package.json ./packages/core/package.json
COPY --from=build /src/packages/core/dist ./packages/core/dist
COPY --from=build /src/apps/control-plane/package.json ./apps/control-plane/package.json
COPY --from=build /src/apps/control-plane/dist ./apps/control-plane/dist
COPY --from=build /src/apps/agent/package.json ./apps/agent/package.json
COPY --from=build /src/apps/agent/dist ./apps/agent/dist
COPY --from=build /src/apps/agent/bin ./apps/agent/bin
COPY apps/local-server ./apps/local-server
COPY config/agent.default.json ./defaults/agent.json
COPY migrations ./migrations
COPY docs/emergency-recovery.md ./docs/emergency-recovery.md
COPY repository/docker-entrypoint.sh /usr/local/bin/nexus-repository-entrypoint
COPY repository/client.sh /usr/local/bin/nexus-repository-client
COPY repository/settings.sh /usr/local/bin/nexus-repository-settings
COPY appliance/docker-entrypoint.sh /usr/local/bin/nexus-backup-entrypoint
COPY --from=workstation /out/nexus-backup-workstation-windows-amd64.exe ./apps/local-server/web/workstation/nexus-backup-workstation-windows-amd64.exe
COPY --from=workstation /out/nexus-backup-workstation-windows-amd64.exe.sha256 ./apps/local-server/web/workstation/nexus-backup-workstation-windows-amd64.exe.sha256
COPY --from=restic-windows /out/restic.exe ./apps/local-server/web/workstation/restic.exe
COPY --from=restic-windows /out/restic.exe.sha256 ./apps/local-server/web/workstation/restic.exe.sha256

RUN build_revision="$(printf '%s' "$NEXUS_BACKUP_REVISION" | cut -c1-8)" \
    && build_identity="${NEXUS_BACKUP_VERSION} · ${build_revision}" \
    && escaped_identity="$(printf '%s' "$build_identity" | sed 's/[&|]/\\&/g')" \
    && sed -i "s|No cloud dependency|No cloud dependency · ${escaped_identity}|" /app/apps/local-server/web/index.html \
    && chmod 0755 \
      /usr/local/bin/nexus-backup-entrypoint \
      /usr/local/bin/nexus-repository-entrypoint \
      /usr/local/bin/nexus-repository-client \
      /usr/local/bin/nexus-repository-settings \
    && mkdir -p \
      /app/node_modules/@nexus-backup \
      /config/control /config/agent /config/repository \
      /run/nexus-backup \
      /state/mounts /state/rclone-vfs /state/restic-cache \
      /data /backup/generic /backup/workstations /restore /downloads \
    && ln -s /app/packages/core /app/node_modules/@nexus-backup/core

ENV NEXUS_BACKUP_VERSION=$NEXUS_BACKUP_VERSION \
    NEXUS_BACKUP_REVISION=$NEXUS_BACKUP_REVISION \
    NEXUS_BACKUP_AGENT_VERSION=$NEXUS_BACKUP_VERSION \
    NEXUS_BACKUP_CONFIG_DIR=/config/control \
    NEXUS_BACKUP_CONFIG=/config/agent/agent.json \
    NEXUS_BACKUP_RUNTIME_DIR=/run/nexus-backup \
    NEXUS_BACKUP_AGENT_CONFIG=/config/agent/agent.json \
    NEXUS_BACKUP_AGENT_TOKEN_FILE=/run/nexus-backup/agent-token \
    NEXUS_BACKUP_AGENT_ID=local-agent \
    NEXUS_BACKUP_URL=http://127.0.0.1:8787 \
    NEXUS_BACKUP_HOST=0.0.0.0 \
    NEXUS_BACKUP_PORT=8787 \
    NEXUS_BACKUP_INTERNAL_PORT=8788 \
    NEXUS_BACKUP_REPOSITORY_CONFIG_DIR=/config/repository \
    NEXUS_BACKUP_REPOSITORY_DATA_DIR=/backup/workstations \
    NEXUS_BACKUP_REPOSITORY_EXPOSURE=lan \
    NEXUS_BACKUP_REPOSITORY_PORT=8000 \
    NEXUS_BACKUP_REPOSITORY_ENDPOINT_PORT=8000

EXPOSE 8787 8000
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/nexus-backup-entrypoint"]
