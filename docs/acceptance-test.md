# Isolated workstation acceptance test

This is the required real-machine proof before moving a workstation backup workload from PCWatch-backup to Nexus Backup.

The procedure is destructive only to **disposable test data, a dedicated workstation Repository namespace and Nexus-generated restore staging**. PCWatch-backup and standalone Copyarr remain unchanged throughout.

Automated CI and a published image are prerequisites, not substitutes for this test.

## 1. Hard safety boundaries

Use:

```text
Windows source:       C:\NexusBackup-Test
Reference manifest:   C:\NexusBackup-Test-reference.json   (outside source root)
Repository transport: Nexus Backup port 8000 over pinned TLS
Repository namespace: brand-new per-workstation acceptance namespace
Restore destination:  Nexus-generated workstation staging only
```

The intended proof is:

```text
Balder-PC Restic -> TLS -> NexusBackup appliance Repository process -> /backup/workstations
```

Keep PCWatch-backup and standalone Copyarr running exactly as they were.

Stop immediately if:

- `/backup` points at a PCWatch/production repository tree;
- the workstation namespace is not unquestionably disposable;
- snapshot inventory contains unexpected production snapshots before the first test backup;
- Recovery offers an arbitrary destination, overwrite control or delete option;
- a write restore targets anything except a fresh generated staging directory;
- a failed/partial operation replaces the recorded last successful snapshot;
- any step requires exposing Repository transport credentials or the Restic encryption password to Control/browser/API.

## 2. Record the test identity

Before creating data record only non-secret identity/evidence:

- date/time;
- exact Nexus Backup appliance version and immutable image digest;
- image `org.opencontainers.image.revision`;
- Windows workstation-agent version;
- workstation/device name shown by Nexus;
- Repository principal + namespace **without password**;
- Repository LAN host and TLS port;
- current last-success/snapshot state, if any.

The workstation payload must be the one bundled by that exact appliance image.

## 3. Provision the isolated Repository namespace

The single `NexusBackup` container must already be installed according to `docs/fresh-install.md`, with workstation storage beneath:

```text
/backup/workstations
```

Create/reuse only the dedicated acceptance principal from the **NexusBackup container console**:

```sh
nexus-repository-client balder-pc acceptance
```

It prints local PowerShell environment values for:

```text
NEXUS_BACKUP_REPOSITORY
NEXUS_BACKUP_REST_USERNAME
NEXUS_BACKUP_REST_PASSWORD
NEXUS_BACKUP_REPOSITORY_CA_B64
NEXUS_BACKUP_REPOSITORY_CA_SHA256
```

Do not put those secret-bearing values in the acceptance report.

In the same elevated PowerShell used for installation, paste the helper output and add a new disposable Restic encryption password:

```powershell
$env:NEXUS_BACKUP_RESTIC_PASSWORD='<new disposable acceptance encryption password>'
```

Then use Nexus **Add workstation** and run the generated one-line installer.

Pass provisioning only if it:

- verifies the locally supplied CA SHA before trusting Repository TLS;
- initializes/verifies the exact acceptance namespace;
- leaves remote runtime `autoInit=false`;
- stores transport + encryption secrets only below `%ProgramData%\NexusBackup` with SYSTEM/Admin ACL;
- brings the workstation online/storage-ready without exposing those secrets to Control.

## 4. Create deterministic source data and independent reference

Run on the workstation:

```powershell
$root = 'C:\NexusBackup-Test'
$reference = 'C:\NexusBackup-Test-reference.json'

Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
Remove-Item -Force $reference -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $root 'nested') | Out-Null

$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $root 'alpha.txt'), "Nexus Backup acceptance`r`n", $utf8)
[IO.File]::WriteAllText((Join-Path $root 'nested\beta.txt'), "nested acceptance`r`n", $utf8)

$binary = Join-Path $root 'binary-zero-1MiB.bin'
$stream = [IO.File]::Create($binary)
try { $stream.SetLength(1MB) } finally { $stream.Dispose() }

$manifest = Get-ChildItem $root -File -Recurse | Sort-Object FullName | ForEach-Object {
    [pscustomobject]@{
        Path = $_.FullName.Substring($root.Length + 1).Replace('\','/')
        Length = $_.Length
        Sha256 = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLowerInvariant()
    }
}
$manifest | ConvertTo-Json -Depth 3 | Set-Content -Encoding UTF8 $reference
Get-Content $reference
```

The reference stays outside the source root so backup cannot restore its own expected answer.

## 5. Configure only the disposable source

The only acceptance source is:

```text
C:\NexusBackup-Test
```

Use **Run now**. Before starting verify workstation online/storage-ready, no unrelated operation active, correct disposable namespace, and no unexpected snapshots.

## 6. Baseline backup

Run backup and require:

- `completed`, not `partial`/`failed`;
- snapshot ID recorded;
- last-success points at that run;
- `/backup/workstations` receives the isolated repository data;
- no Repository URL/username/password/CA path/encryption password appears in Control-visible telemetry/errors.

Record only run ID and snapshot ID.

## 7. Inventory, browse and integrity

Refresh workstation Recovery inventory and find:

```text
alpha.txt
nested/
nested/beta.txt
binary-zero-1MiB.bin
```

Then run workstation **repository integrity check**. Require **Integrity OK** while previous successful backup/snapshot state remains unchanged.

`restic check` is consistency evidence only; continue to a real restore.

## 8. Dry-run preview and real staging restore

Run a dry-run preview for the test tree. Verify no browser-provided destination, overwrite or delete control exists.

After the preview completes, enter the exact confirmation phrase and start write restore. Require:

- a fresh workstation-generated staging path;
- live `C:\NexusBackup-Test` is never an output destination;
- `--overwrite never` and no `--delete`;
- restore completes and reports the staging target.

## 9. Independent byte/hash verification

Set `$restoredRoot` to the restored test directory beneath the reported staging target:

```powershell
$restoredRoot = '<restored NexusBackup-Test directory beneath the reported staging target>'
$reference = 'C:\NexusBackup-Test-reference.json'
$expected = @(Get-Content -Raw $reference | ConvertFrom-Json)

$actual = Get-ChildItem $restoredRoot -File -Recurse | ForEach-Object {
    [pscustomobject]@{
        Path = $_.FullName.Substring($restoredRoot.Length + 1).Replace('\','/')
        Length = $_.Length
        Sha256 = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLowerInvariant()
    }
}

$actualByPath = @{}
foreach ($item in $actual) { $actualByPath[$item.Path] = $item }
$failures = New-Object System.Collections.Generic.List[string]
foreach ($item in $expected) {
    if (-not $actualByPath.ContainsKey($item.Path)) {
        $failures.Add("missing: $($item.Path)")
        continue
    }
    $got = $actualByPath[$item.Path]
    if ([int64]$got.Length -ne [int64]$item.Length) { $failures.Add("length mismatch: $($item.Path)") }
    if ($got.Sha256 -ne $item.Sha256) { $failures.Add("sha256 mismatch: $($item.Path)") }
}
$expectedPaths = @($expected | ForEach-Object { $_.Path })
foreach ($item in $actual) {
    if ($expectedPaths -notcontains $item.Path) { $failures.Add("unexpected file: $($item.Path)") }
}
if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    throw 'Nexus Backup acceptance restore verification FAILED'
}
Write-Host 'Nexus Backup acceptance restore verification PASSED'
```

This is the core acceptance gate. Do not continue to resilience tests unless it passes.

## 10. Whole-appliance restart

With no operation active, restart **NexusBackup** once from Unraid.

Require all of the following after the same single container returns:

- local admin login and Control history/policies preserved;
- internal Agent returns online with its inert/explicit config intact;
- Repository TLS certificate/CA SHA is unchanged because `/config/repository` persisted;
- acceptance namespace and snapshots remain present;
- workstation reconnects without reprovisioning;
- integrity check returns **Integrity OK**.

If an ordinary appliance restart changes Repository CA with the same `/config`, fail/investigate.

## 11. Workstation-agent restart

With no workstation operation active:

```powershell
Stop-ScheduledTask -TaskName NexusBackupWorkstation
Start-Sleep -Seconds 5
Start-ScheduledTask -TaskName NexusBackupWorkstation
```

Require durable local credential reconnect and unchanged prior successful state.

## 12. Temporary Control-path outage during active backup

If baseline data is too small, add a deterministic disposable 512 MiB file:

```powershell
$path = 'C:\NexusBackup-Test\resilience-random.bin'
$size = 512MB
$chunk = New-Object byte[] (1MB)
$rng = New-Object System.Random 20260913
$stream = [IO.File]::Create($path)
try {
    for ($written = 0L; $written -lt $size; $written += $chunk.Length) {
        $rng.NextBytes($chunk)
        $count = [Math]::Min($chunk.Length, $size - $written)
        $stream.Write($chunk, 0, [int]$count)
    }
} finally { $stream.Dispose() }
```

Regenerate the reference manifest before any later verified snapshot.

Start **Run now**, wait for active progress, then block **only port 8787** from Windows. Repository port 8000 must remain reachable:

```powershell
$nexusIp = '<Unraid/Nexus IP>'
New-NetFirewallRule -DisplayName 'NexusBackup-Acceptance-Block-Control' `
    -Direction Outbound -Action Block -Protocol TCP -RemoteAddress $nexusIp -RemotePort 8787
try { Start-Sleep -Seconds 15 }
finally { Remove-NetFirewallRule -DisplayName 'NexusBackup-Acceptance-Block-Control' -ErrorAction SilentlyContinue }
```

Require Repository traffic to continue, no fabricated success, and previous known-good success preserved if the run ultimately fails.

## 13. Repository-path outage without stopping the appliance

Because Control/Agent/Repository now share one container, do **not** stop a separate Repository container; none exists.

Instead block only Repository port 8000 from the workstation while leaving Control 8787 reachable:

```powershell
$nexusIp = '<Unraid/Nexus IP>'
New-NetFirewallRule -DisplayName 'NexusBackup-Acceptance-Block-Repository' `
    -Direction Outbound -Action Block -Protocol TCP -RemoteAddress $nexusIp -RemotePort 8000
try {
    # While this rule exists, request workstation repository integrity from Nexus.
    Start-Sleep -Seconds 30
} finally {
    Remove-NetFirewallRule -DisplayName 'NexusBackup-Acceptance-Block-Repository' -ErrorAction SilentlyContinue
}
```

Require:

- integrity operation fails clearly while 8000 is blocked;
- no remote `restic init` is attempted;
- last successful backup/snapshot stays unchanged;
- failure text remains secret-redacted;
- after removing the rule, a new integrity run returns **Integrity OK** without reprovisioning.

This isolates Repository-path failure without destroying the one-appliance process model.

## 14. Interrupted write restore

Use a snapshot large enough to keep restore active:

1. complete a fresh dry-run preview;
2. confirm and start write restore;
3. while active run `Stop-ScheduledTask -TaskName NexusBackupWorkstation`;
4. allow lease/recovery logic to observe interruption;
5. restart with `Start-ScheduledTask -TaskName NexusBackupWorkstation`.

Require interrupted restore never becomes completed, is never auto-replayed, prior success remains intact, and a fresh preview/retry receives a **different staging target**.

## 15. Final post-fault proof

After everything is healthy:

1. require **Integrity OK**;
2. if source changed, regenerate the independent reference **before** backup;
3. run final normal backup;
4. run final fresh staging restore;
5. repeat independent byte/hash verification.

Acceptance must finish on a known-good restored byte-for-byte result.

## 16. Evidence to retain

Keep only non-secret evidence:

- exact appliance version + immutable digest + revision;
- workstation-agent version;
- principal/namespace names, no passwords;
- baseline/final run and snapshot IDs;
- integrity results;
- preview/restore run IDs;
- hash-verification PASS outputs;
- appliance/workstation restart observations;
- Control-port outage result;
- Repository-port outage result;
- interrupted restore/new-staging proof;
- final integrity + restore/hash PASS.

Never retain raw tokens, REST passwords, Restic encryption passwords, CA private keys, rclone tokens or secret-bearing configs in the acceptance report.

## 17. PASS / FAIL

PASS requires all of these:

- backup bytes reach isolated `/backup/workstations` through Repository TLS;
- inventory/browse are correct;
- integrity is healthy when Repository is reachable;
- preview/write restore safety boundaries hold;
- restored bytes match the independent manifest;
- whole-appliance restart preserves Control, Agent and Repository state;
- transient Control loss does not invent success/unsafe cancellation;
- Repository-path outage is truthful and never triggers remote auto-init;
- interrupted restore is manual-retry-only and never writes in place;
- final post-fault staging restore again passes hash verification.

Anything else is **FAIL / INVESTIGATE**. Do not cut over the workstation.

## 18. After a PASS

A PASS proves the isolated Balder-PC -> NexusBackup appliance -> Unraid path. It still does **not** authorize production migration.

Keep PCWatch-backup unchanged until later cutover explicitly:

- provides the production repository/retention plan;
- proves workstation Restic encryption-key recovery and `/config/repository` off-host recovery;
- cuts over one workstation at a time;
- guarantees PCWatch and Nexus never write the same Restic repository concurrently.
