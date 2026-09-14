# Direct-Internet workstation Repository acceptance

This is the network-path proof for Nexus Backup workstations that are not on the Unraid LAN. It complements `docs/acceptance-test.md`; it does not replace the full backup/restore/hash acceptance.

PCWatch-backup and standalone Copyarr remain untouched during this proof.

## Required topology

```text
Control/orchestration:
remote workstation -> HTTPS control origin -> Nexus Control

Backup payload:
remote workstation -> direct HTTPS -> public Repository endpoint -> Tower Repository listen port
```

The Repository path must not traverse Cloudflare or another cloud data proxy. A Cloudflare Tunnel may carry Control traffic only.

Record non-secret identity:

- Nexus image version/digest/revision;
- workstation name;
- public Repository hostname + advertised port;
- Tower local Repository listen port;
- Control public origin;
- Repository exposure/append-only state.

Never retain REST passwords, Restic encryption passwords, CA private keys or device bearer tokens in acceptance evidence.

## 1. Configure Internet Repository policy

In **Settings -> Workstation Repository -> Network & protection** require:

```text
Exposure:             Direct Internet
Endpoint hostname:    <public/DDNS hostname>
Local listen port:    8000 (or chosen local port)
Advertised port:      <public port, e.g. 443>
Append-only:          Enabled
```

Save and restart the single NexusBackup container if the UI reports restart required.

After restart require:

- saved and running policy agree;
- TLS minimum is shown as 1.3;
- bcrypt authentication and private namespaces are enabled;
- append-only is enabled;
- rate-limit/brute-force controls are not falsely shown as enabled if not implemented.

Router/firewall should forward **only** the public Repository TCP port to Tower's Repository listen port. Do not expose Control :8787 as part of this port-forward.

## 2. Configure the separate Control path

Off-LAN workstations still need Control for enrollment, polling and status. Configure an explicit HTTPS public Control origin, normally via the lightweight remote-control tunnel:

```text
NEXUS_BACKUP_PUBLIC_URL=https://<control-hostname>
```

The Control hostname and Repository hostname are separate roles. Backup bytes must never use the Control hostname.

From the off-LAN workstation verify the Control health/origin is reachable before enrollment.

## 3. Prove the Repository is reachable from a genuinely external network

Run this from a workstation/network that is not behind the same LAN/NAT as Tower. Do not use local split DNS as the only proof.

Use the dedicated acceptance principal generated locally in Nexus:

```sh
nexus-repository-client <workstation> internet-acceptance
```

Provision the workstation using the helper output and a disposable Restic encryption password. The generated `NEXUS_BACKUP_REPOSITORY` must contain the configured public hostname and advertised public port, not Tower's private address/listen port.

Require enrollment/control to use the configured Control public origin while Repository traffic uses the direct public Repository endpoint.

## 4. Backup path proof

Create a small disposable source on the external workstation and run a Nexus workstation backup.

Require:

- workstation is online/storage-ready through Control;
- backup completes through the direct Repository endpoint;
- Repository receives the snapshot under the dedicated namespace;
- no backup payload is sent to the Control/Cloudflare hostname;
- Control-visible logs remain free of Repository credentials and Restic encryption secrets.

Record only run/snapshot IDs.

## 5. Append-only destructive-operation proof

Append-only must prevent the remote workstation credential from deleting existing repository objects.

The normal product CI already proves the REST endpoint returns HTTP 403 for a remote snapshot delete and preserves the snapshot. On the real external workstation do not intentionally damage a non-disposable repository; use only the dedicated acceptance namespace.

A failed destructive request must not make the previous successful snapshot disappear. Verify inventory/integrity still sees the known-good snapshot afterward.

Do not disable append-only merely to make remote `forget/prune` work. Production retention for Internet workstations belongs on the local Tower/Nexus side.

## 6. Restore proof over the same external path

Use the normal Nexus recovery flow against the external workstation:

1. inventory/browse the known snapshot;
2. run dry-run restore preview;
3. perform staging-only write restore;
4. independently compare restored hashes/bytes to the disposable source/reference.

All normal restore invariants still apply: no browser-supplied arbitrary target, no in-place restore, `--overwrite never`, no delete, interrupted restore manual retry only.

## PASS / FAIL

PASS requires all of:

- actual off-LAN Control path works independently of Repository data path;
- actual off-LAN backup reaches the direct HTTPS Repository endpoint;
- advertised public host/port and pinned Repository CA are correct;
- append-only is enabled and known-good snapshots survive refused destructive access;
- external staging restore passes independent content/hash verification;
- backup payload does not traverse Control/Cloudflare;
- PCWatch-backup and Copyarr remain unchanged.

Anything else is **FAIL / INVESTIGATE**. Do not cut over that remote workstation.
