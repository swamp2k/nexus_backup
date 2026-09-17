# Nexus Backup on Unraid

Nexus Backup is one host-networked Unraid container. It keeps the application,
SQLite database, schedules, workstation orchestration and transfer receivers
together. There is no separate appliance Agent or Repository process.

The product stores ordinary files below the single `/backup` mapping:

```text
/backup/<repository>/<workstation or transfer folder>/...
```

Repositories are created from the dashboard and cannot point outside `/backup`.
Workstations copy selected Windows folders into their selected repository;
missing source files are not deleted from the destination.

## Services

With host networking enabled, the container provides:

```text
8787       Nexus dashboard, API and integrated WebDAV receiver
2222       SFTP receiver
2121       FTP receiver
50000-50010 FTP passive range
```

SFTPGo is bundled and pinned in the image. Nexus owns receiver users and maps
each user to a restricted repository folder. The application-level Remote
connection hostname setting gates HTTP/dashboard/WebDAV requests; it is not a
firewall and cannot constrain FTP/SFTP hostnames.

## Persistent layout

```text
/config       SQLite database, local auth and integration settings
/state        transfer staging and runtime state
/data         read-only source mapping
/backup       ordinary Nexus-managed repository files
/restore      restore staging mapping for compatibility workflows
/downloads    compatibility transfer destination mapping
```

Recommended host mappings are the same paths exposed in the template. Keep
`/data` limited to the shares Nexus should read; do not map the entire host
filesystem casually.

## Install

1. Install `unraid/templates/nexus-backup.xml`.
2. Review the `/data`, `/backup`, `/restore` and `/downloads` mappings.
3. Start the container and open `http://<unraid-ip>:8787/`.
4. Complete local-admin setup.
5. Create a repository, then enroll workstations from the Workstations page.
6. Use Repositories → Receiver access for cameras, software and other clients.

The workstation installer downloads only the Nexus workstation client. Its
one-time enrollment exchange writes the receiver credentials and selected
repository identity into the protected Windows ProgramData config.

## Updates

The public image is:

```text
ghcr.io/swamp2k/nexus-backup:<version>
```

Pin a version and, for production, its immutable image digest. The container
is intentionally a single Unraid application and receiver services stop with
the application runtime.
