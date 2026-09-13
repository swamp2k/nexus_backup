# Isolated workstation acceptance test

This is the required real-machine proof before moving a workstation backup workload from PCWatch-backup to Nexus Backup.

The procedure is deliberately destructive only to **disposable test data, a dedicated NexusBackup-Repository namespace and Nexus-generated restore staging**. It must not modify, repoint, disable or share storage with PCWatch-backup or any existing production backup.

Passing automated CI is a prerequisite, not a substitute for this test.

## 1. Hard safety boundaries

Use all of the following:

```text
Windows source:       C:\NexusBackup-Test
Reference manifest:   C:\NexusBackup-Test-reference.json   (outside source root)
Repository transport: NexusBackup-Repository over TLS
Repository namespace: a brand-new per-workstation acceptance namespace
Restore destination:  Nexus-generated workstation staging only
```

NexusBackup-Agent `/backup` is **not** the workstation endpoint. The intended proof is:

```text
Balder-PC Restic -> TLS -> NexusBackup-Repository -> isolated Unraid storage
```

Keep PCWatch-backup and standalone Copyarr running exactly as they were. They must not touch the acceptance repository.

### Stop immediately if

- the Repository container is mapped to a PCWatch/production repository tree;
- the workstation Repository URL/namespace is not unquestionably the disposable acceptance namespace;
- snapshot inventory contains unexpected old/production snapshots before the first test backup;
- the Recovery UI offers an arbitrary destination, overwrite control or delete option;
- a write restore targets anything except a newly generated staging directory;
- a failed/partial operation replaces the recorded last successful snapshot;
- generic Agent and workstation Repository storage overlap;
- any step requires exposing Repository transport credentials or the Restic encryption password to Control/browser/API.

## 2. Record the test identity

Before creating data, record:

- date/time;
- Nexus Control image version/digest;
- Nexus Agent image version/digest;
- Nexus Repository image version/digest;
- Windows workstation-agent version;
- workstation/device name shown by Nexus;
- dedicated Repository principal + repository name **without the password**;
- Repository LAN host and TLS port, without credentials;
- current last-success/snapshot state, if any.

Control, Agent and Repository should be the same coordinated Nexus release. The workstation payload must be the one served by that Control release.

## 3. Provision the isolated Nexus Repository namespace

Repository must already be installed as described in `docs/fresh-install.md` and use dedicated workstation storage such as:

```text
/mnt/user/backups/nexus-backup/workstations
```

For this test create/reuse only the dedicated Balder acceptance principal/namespace from the Repository container console:

```sh
nexus-repository-client balder-pc acceptance
```

The command prints local PowerShell environment lines containing:

```text
NEXUS_BACKUP_REPOSITORY
NEXUS_BACKUP_REST_USERNAME
NEXUS_BACKUP_REST_PASSWORD
NEXUS_BACKUP_REPOSITORY_CA_B64
NEXUS_BACKUP_REPOSITORY_CA_SHA256
```

Do **not** put those values in the acceptance report. The public CA is carried directly in the local helper output; Repository exposes no HTTP bootstrap port. The installer decodes that exact CA and refuses it unless `NEXUS_BACKUP_REPOSITORY_CA_SHA256` matches.

In the same elevated PowerShell that will run the Nexus workstation installer, paste those environment lines and add a new disposable Restic encryption password:

```powershell
$env:NEXUS_BACKUP_RESTIC_PASSWORD='<new disposable acceptance encryption password>'
```

Then use Nexus **Add workstation** and run its generated one-line install/enrollment command.

The install is acceptable only if it:

- decodes and verifies the locally supplied CA SHA before trusting Repository TLS;
- initializes the exact new acceptance namespace or verifies it if already initialized;
- leaves remote runtime `autoInit=false`;
- stores Repository transport + encryption secrets locally below `%ProgramData%\NexusBackup` with SYSTEM/Admin-only ACL;
- brings the workstation online as storage-ready without exposing those secrets to Control.

If Repository auth/TLS/network provisioning fails, fix the provisioning problem. Do not loosen runtime auto-init or switch to a production repository.

## 4. Create deterministic source data and independent reference manifest

Run PowerShell on the workstation. This replaces only the disposable source/reference paths:

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

Keep the reference outside the source root so the backup cannot restore its own expected-answer file.

## 5. Configure the workstation policy for test data only

The only acceptance source is:

```text
C:\NexusBackup-Test
```

Use **Run now** so timing is explicit. Before starting verify:

- workstation is online and storage-ready;
- Repository container is healthy;
- the namespace is `balder-pc/acceptance` (or your explicitly recorded equivalent);
- no other workstation operation is active;
- there are no unexpected snapshots;
- no normal user/profile/application path has been added.

## 6. Baseline backup

Choose **Run now**.

Pass conditions:

- run reaches `completed`, not `partial` or `failed`;
- a snapshot ID is recorded;
- last-success points to this completed backup;
- the isolated Repository namespace receives the snapshot;
- no Repository URL, username, transport password, CA path or encryption password appears in Control/browser-visible telemetry/errors.

Record only the run ID and snapshot ID as evidence.

## 7. Snapshot inventory and browse

Refresh Recovery snapshot inventory and verify the new snapshot belongs to this test workstation. Browse until the `NexusBackup-Test` tree is identifiable.

Verify at least:

```text
alpha.txt
nested/
nested/beta.txt
binary-zero-1MiB.bin
```

Any unrelated snapshot/production path is a stop condition.

## 8. Repository integrity

Run workstation **repository integrity check**.

Pass conditions:

- operation completes successfully;
- UI reports **Integrity OK**;
- prior successful backup/snapshot remains unchanged;
- telemetry remains secret-free.

`restic check` is consistency evidence only. Continue to real restore proof.

## 9. Dry-run restore preview

Select the complete test source tree (or whole acceptance snapshot if needed) and run dry-run preview.

Verify:

- it is explicitly dry-run;
- snapshot/path scope matches expectation;
- no browser-provided Windows destination is requested;
- no overwrite/delete control exists;
- confirmation is available only after the preview completes.

## 10. Real staging restore

Enter the exact confirmation phrase and start the real restore.

Pass conditions:

- a **new** workstation-generated staging path is used;
- live `C:\NexusBackup-Test` is never an output destination;
- restore completes;
- `--overwrite never` remains in force;
- result reports the staging target.

Locate the restored `NexusBackup-Test` directory beneath that staging target; do not assume an internal drive/path layout.

## 11. Independent byte/hash/content verification

Set `$restoredRoot` to the restored test directory and run:

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

## 12. Idle Control restart

With no operation active restart only `NexusBackup-Control`.

Verify local admin login, device/policy/history, last-success state and workstation reconnect all survive. No Repository/encryption secret may need to be entered into Control.

## 13. Generic Agent restart

Restart `NexusBackup-Agent` while idle. Verify its token/config survive and dashboard metadata stays sanitized. Workstation backup bytes do not pass through this Agent.

## 14. Repository restart

Restart **only** `NexusBackup-Repository` while idle.

Verify:

- TLS certificate/CA SHA remains unchanged because Repository `/config` persisted;
- workstation repository operations work without reprovisioning;
- acceptance namespace/snapshot remain present;
- generic Agent state is unaffected.

If the CA changes after an ordinary restart with the same `/config`, fail/investigate.

## 15. Workstation-agent restart

With no workstation operation active:

```powershell
Stop-ScheduledTask -TaskName NexusBackupWorkstation
Start-Sleep -Seconds 5
Start-ScheduledTask -TaskName NexusBackupWorkstation
```

Verify it returns online using durable local credentials and prior successful state remains intact.

## 16. Temporary Control-path outage during active backup

If the baseline dataset finishes too quickly, add a disposable deterministic pseudo-random file:

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

Regenerate the reference manifest if this snapshot will later be verified.

Start **Run now** and wait for active progress. Block **only Control 8787** from the workstation; Repository TLS 8000 must remain reachable:

```powershell
$controlIp = '<Unraid/Nexus Control IP>'
New-NetFirewallRule -DisplayName 'NexusBackup-Acceptance-Block-Control' `
    -Direction Outbound -Action Block -Protocol TCP -RemoteAddress $controlIp -RemotePort 8787
try {
    Start-Sleep -Seconds 15
} finally {
    Remove-NetFirewallRule -DisplayName 'NexusBackup-Acceptance-Block-Control' -ErrorAction SilentlyContinue
}
```

Pass conditions:

- local Restic backup is not immediately killed by transient Control loss;
- Repository traffic continues over 8000;
- after Control returns, result is truthful — completed/ACKed or failed, never fabricated success;
- previous known-good success remains if this run fails.

## 17. Repository unavailable

Stop **only the disposable `NexusBackup-Repository` container**. Do not alter `/config` or `/data`, and do not touch PCWatch storage.

Run workstation repository integrity while Repository is stopped.

Pass conditions:

- check fails clearly;
- no remote `restic init` is attempted;
- last successful backup/snapshot stays unchanged;
- failure text visible through Control is redacted of repository/credential details.

Start Repository again and require a new integrity run to return **Integrity OK** without workstation reprovisioning.

## 18. Interrupted write restore

Use a snapshot large enough to keep staging restore active long enough to interrupt.

1. complete a fresh dry-run preview;
2. type the exact confirmation and start write restore;
3. while active stop the workstation task:

```powershell
Stop-ScheduledTask -TaskName NexusBackupWorkstation
```

4. allow lease/recovery logic to observe interruption;
5. restart:

```powershell
Start-ScheduledTask -TaskName NexusBackupWorkstation
```

Pass conditions:

- interrupted restore never becomes completed;
- it is not auto-requeued/replayed;
- orphaned partial staging is disposable evidence only;
- last successful backup remains unchanged;
- fresh retry requires a current preview/confirmation;
- fresh retry gets a **different new staging target**.

Never copy interrupted staging into live data.

## 19. Final post-fault verification

After all services are healthy:

1. require **Integrity OK**;
2. if test source changed, regenerate the independent reference manifest **before** final backup;
3. run a final normal backup;
4. perform final staging restore;
5. repeat independent byte/hash verification.

Do not modify source/reference between final backup and comparison. Acceptance must end on a known-good restore.

## 20. Evidence to retain

Keep only non-secret evidence:

- exact Control/Agent/Repository versions + digests;
- workstation-agent version;
- principal/repository names, no password;
- baseline and final run/snapshot IDs;
- integrity results;
- preview/restore run IDs;
- hash-verification PASS outputs;
- Control/Agent/Repository/workstation restart observations;
- Control outage result;
- Repository unavailable result;
- interrupted restore/new-staging proof;
- final integrity + final restore/hash PASS.

Do **not** retain raw tokens, REST transport passwords, Restic encryption passwords, CA private keys, rclone tokens or secret-bearing config files in the acceptance report.

## 21. PASS / FAIL

Acceptance is **PASS** only if:

- backup bytes reach the intended isolated NexusBackup-Repository storage;
- inventory/browse are correct;
- repository integrity is OK when healthy;
- preview/write restore safety boundaries hold;
- restored bytes match the independent manifest;
- Control/Agent/Repository/workstation restarts preserve expected state;
- transient Control loss does not invent success or unsafe cancellation;
- Repository outage is truthful and never triggers remote auto-init;
- interrupted restore is manual-retry-only and never writes in place;
- final post-fault staging restore again passes hash verification.

Anything else is **FAIL / INVESTIGATE**. Do not cut over the workstation.

## 22. After a PASS

A PASS proves the isolated Balder-PC -> NexusBackup-Repository -> Unraid data path. It does **not** authorize production migration yet.

Keep PCWatch-backup unchanged until a later cutover explicitly:

- provides a production repository/retention plan;
- proves workstation Restic encryption-key recovery and Repository `/config` recovery from off-host material;
- cuts over one workstation at a time;
- guarantees PCWatch and Nexus never write the same Restic repository concurrently.

Only after those recovery/cutover gates should the corresponding production workload move away from PCWatch-backup.
