ARG NEXUS_BACKUP_VERSION=dev
ARG NEXUS_BACKUP_REVISION=unknown

FROM ghcr.io/drakkan/sftpgo:2.7.x@sha256:81dcb4e18a3d090b42dc1fec743c47fd4dfc9120b8dc4781c130cc2bb2ba9f72 AS receiver

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

FROM node:22-alpine AS build
WORKDIR /src
RUN npm install --global typescript@5.8.3
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --ignore-scripts
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ARG NEXUS_BACKUP_VERSION=dev
ARG NEXUS_BACKUP_REVISION=unknown
LABEL org.opencontainers.image.title="Nexus Backup" \
      org.opencontainers.image.description="Self-contained local-first backup, recovery and transfer appliance for Unraid" \
      org.opencontainers.image.source="https://github.com/swamp2k/nexus_backup" \
      org.opencontainers.image.version="$NEXUS_BACKUP_VERSION" \
      org.opencontainers.image.revision="$NEXUS_BACKUP_REVISION"
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      fuse3 \
      rclone \
      tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /usr/local/lib/nexus-receivers /etc/sftpgo /var/lib/sftpgo /srv/sftpgo/data /srv/sftpgo/backups

WORKDIR /app

COPY --from=build /src/packages/core/package.json ./packages/core/package.json
COPY --from=build /src/packages/core/dist ./packages/core/dist
COPY --from=build /src/apps/control-plane/package.json ./apps/control-plane/package.json
COPY --from=build /src/apps/control-plane/dist ./apps/control-plane/dist
COPY apps/local-server ./apps/local-server
COPY config/integrations.default.json ./defaults/integrations.json
COPY migrations ./migrations
COPY appliance/docker-entrypoint.sh /usr/local/bin/nexus-backup-entrypoint
COPY --from=receiver /usr/local/bin/sftpgo /usr/local/bin/sftpgo
COPY --from=receiver /etc/sftpgo/sftpgo.json /etc/sftpgo/sftpgo.json
COPY --from=workstation /out/nexus-backup-workstation-windows-amd64.exe ./apps/local-server/web/workstation/nexus-backup-workstation-windows-amd64.exe
COPY --from=workstation /out/nexus-backup-workstation-windows-amd64.exe.sha256 ./apps/local-server/web/workstation/nexus-backup-workstation-windows-amd64.exe.sha256

RUN build_revision="$(printf '%s' "$NEXUS_BACKUP_REVISION" | cut -c1-8)" \
    && build_identity="${NEXUS_BACKUP_VERSION} · ${build_revision}" \
    && escaped_identity="$(printf '%s' "$build_identity" | sed 's/[&|]/\\&/g')" \
    && sed -i "s|No cloud dependency|No cloud dependency · ${escaped_identity}|" /app/apps/local-server/web/index.html \
    && chmod 0755 /usr/local/bin/nexus-backup-entrypoint \
    && mkdir -p \
      /app/node_modules/@nexus-backup \
      /config/control \
      /run/nexus-backup \
      /state/mounts /state/rclone-vfs \
      /data /backup/generic /backup/workstations /restore /downloads \
    && ln -s /app/packages/core /app/node_modules/@nexus-backup/core

ENV NEXUS_BACKUP_VERSION=$NEXUS_BACKUP_VERSION \
    NEXUS_BACKUP_REVISION=$NEXUS_BACKUP_REVISION \
    NEXUS_BACKUP_CONFIG_DIR=/config/control \
    NEXUS_BACKUP_INTEGRATION_CONFIG=/config/integrations.json \
    NEXUS_BACKUP_URL=http://127.0.0.1:8787 \
    NEXUS_BACKUP_HOST=0.0.0.0 \
    NEXUS_BACKUP_PORT=8787 \
    NEXUS_BACKUP_INTERNAL_PORT=8788 \
    NEXUS_BACKUP_BACKUP_ROOT=/backup \
    NEXUS_BACKUP_SFTP_PORT=2222 \
    NEXUS_BACKUP_FTP_PORT=2121 \
    SFTPGO_SFTPD__BINDINGS__0__ADDRESS=0.0.0.0 \
    SFTPGO_SFTPD__BINDINGS__0__PORT=2222 \
    SFTPGO_FTPD__BINDINGS__0__ADDRESS=0.0.0.0 \
    SFTPGO_FTPD__BINDINGS__0__PORT=2121 \
    SFTPGO_FTPD__PASSIVE_PORT_RANGE__START=50000 \
    SFTPGO_FTPD__PASSIVE_PORT_RANGE__END=50010 \
    SFTPGO_WEBDAVD__BINDINGS__0__ADDRESS=127.0.0.1 \
    SFTPGO_WEBDAVD__BINDINGS__0__PORT=8383 \
    SFTPGO_HTTPD__BINDINGS__0__PORT=0 \
    SFTPGO_DATA_PROVIDER__EXTERNAL_AUTH_HOOK=http://127.0.0.1:8787/v1/internal/receiver-auth \
    SFTPGO_DATA_PROVIDER__EXTERNAL_AUTH_SCOPE=1 \
    SFTPGO_DATA_PROVIDER__USERS_BASE_DIR=/backup

EXPOSE 8787 2222 2121 50000-50010
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/nexus-backup-entrypoint"]
