# Nexus Backup

Nexus Backup is a one-container, local-first appliance for ordinary file backups, workstation replication, transfer automation, and incoming file receivers.

The product stores readable files beneath one host-mounted `/backup` root. A named repository is simply a folder; a workstation or receiver user is assigned a folder below that repository. No special repository format or recovery tool is required to read the stored files.

## Current product model

- The authenticated Nexus application owns the SQLite database, schedules, repositories, receiver users, and transfer metadata.
- Workstations replicate selected Windows folders as ordinary files. Missing source files are not deleted from the destination.
- SFTP and FTP are provided by the bundled SFTPGo receiver engine; WebDAV is routed through Nexus HTTP.
- Receiver accounts use cryptographically random passwords, secure server-side hashes, and restricted repository roots.
- The optional remote connection setting gates HTTP Host names. LAN access remains available while disabled.
- Cloudflare is optional remote control only; backup bytes do not pass through it.

## Data paths

```text
Windows workstation -> Nexus device upload -> /backup/<repository>/<workstation>/
Receiver user       -> SFTP/FTP/WebDAV   -> /backup/<repository>/<assigned folder>/
Transfer source     -> local execution    -> /backup/<repository>/<transfer folder>/
```

See [docs/flat-file-product.md](docs/flat-file-product.md) for the storage, receiver, and workstation contracts. See [unraid/README.md](unraid/README.md) for deployment details.

## Run locally

```bash
docker compose up --build
```

Then open `http://localhost:8787` and complete local first-run authentication. Configure `/backup` with `NEXUS_BACKUP_BACKUP_PATH` in Compose or through the Unraid template.

## Unraid

Use [unraid/templates/nexus-backup.xml](unraid/templates/nexus-backup.xml). The application uses host networking so the default receiver ports are SFTP `2222`, FTP `2121`, FTP passive `50000-50010`, and Nexus/WebDAV HTTP `8787`.

## Development

```bash
npm test
npm run build
```

The Windows workstation client is built from `apps/workstation-agent` during the image build. Its installer is served by Nexus and verifies the client checksum before installation.
