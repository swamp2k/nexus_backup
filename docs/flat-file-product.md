# Flat-file product contract

Nexus-managed storage is rooted at `/backup`. Each repository has a stable ID, a display name, and a safe relative folder. Repository folders contain ordinary files and directories; Nexus never requires Restic, a special database format, or a Nexus-specific restore utility to read them.

## Workstations

Enrollment selects a repository and workstation destination folder. Nexus creates a restricted receiver identity and a workstation policy. The Windows client reports through its device token, polls for a scheduled run, and uploads each selected source file through the authenticated workstation upload endpoint. Uploads are written to a temporary file, flushed, and atomically renamed. A later backup never mirrors deletions.

The server validates every relative path, resolves existing path components to catch symlink escapes, and binds the request to the workstation receiver root. A client cannot address another repository or workstation folder.

## Receiver users

Manual receiver users can be assigned to any repository subfolder. Passwords are generated randomly (or must be at least 20 characters when supplied) and only password hashes are stored. A user can be disabled or removed without changing the repository files.

The bundled SFTPGo process handles SFTP and FTP. It delegates password authentication to the loopback Nexus hook, which returns the assigned home directory and root permissions. Nexus handles WebDAV at `/dav/<username>[/path]`. The FTP passive range is `50000-50010` by default.

## Remote connection

Remote HTTP access is disabled by default. When enabled, Nexus accepts the configured exact hostname plus local/private hosts. The setting is an application Host gate, not a replacement for a firewall or TLS reverse proxy. SFTP and FTP are LAN receiver services and do not use the HTTP Host gate.

## Safety rules

- User-controlled paths reject empty, dot, dot-dot, NUL, and newline segments.
- Repository and receiver roots are checked against the canonical `/backup` root.
- Workstation upload destinations are created below the assigned receiver root only.
- Existing destination files are replaced atomically; unrelated destination files are never deleted.
- Receiver credentials are not embedded in the visible one-line installer command.
