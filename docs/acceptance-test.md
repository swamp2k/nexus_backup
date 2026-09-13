# Isolated workstation acceptance test

This runbook is the required real-machine proof before moving a workstation backup workload from PCWatch-backup to Nexus Backup.

It is deliberately destructive only to **disposable test data, a dedicated test Restic repository and Nexus-generated restore staging**. It must not modify, repoint, disable or share a repository with PCWatch-backup or any existing production backup.

Passing automated CI is a prerequisite, not a substitute for this test.

## 1. Hard safety boundaries

Use all of the following:

```text
Windows source:       C:\NexusBackup-Test
Reference manifest:   C:\NexusBackup-Test-reference.json   (outside source root)
Restic repository:    a brand-new Nexus acceptance repository
Restore destination:  Nexus-generated workstation staging only
```

The Restic repository must be isolated from every PCWatch and production Nexus repository. Never point Nexus at an existing repository merely to make this test easier.

For the intended Windows -> Unraid proof, the test repository must be on the Unraid side through the same class of transport intended for production, and the Windows `NexusBackupWorkstation` SYSTEM task must be able to reach it directly. NexusBackup-Agent's `/backup` container mapping is not itself a Windows-facing repository endpoint.

If no dedicated Windows-accessible Unraid Restic endpoint exists yet, **stop**. A local Windows repository can prove installer/agent mechanics, but it does not satisfy the final Windows -> Unraid acceptance requirement.

Keep PCWatch-backup and standalone Copyarr running exactly as they were, except do not configure them to touch this new test repository.

### Stop immediately if

- the repository location is not unquestionably the dedicated acceptance repository;
- snapshot inventory contains unexpected old/production snapshots before the first test backup;
- the Workstations recovery UI offers an arbitrary destination, overwrite control or delete option;
- a write restore targets anything except a newly generated staging directory;
- a failure changes the recorded last successful snapshot to a failed/partial run;
- PCWatch and Nexus would write to the same repository;
- any step requires exposing repository/password secrets to the Nexus browser/control plane.

## 2. Record the test identity

Before creating data, record:

- date/time;
- Nexus Control image version/digest;
- Nexus generic Agent image version/digest;
- Windows workstation agent version;
- workstation/device name shown by Nexus;
- dedicated repository identifier/location **without copying credentials into the test report**;
- transport used from Windows to Unraid;
- current last-success/snapshot state, if any.

The Control and Agent containers should be the same coordinated release. The workstation payload should be the one served by that Control release.

## 3. Create deterministic source data and a reference manifest

Run elevated or normal PowerShell on the workstation. This replaces only `C:\NexusBackup-Test` and its separate reference file:

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

Keep the reference file outside the source root so the backup cannot simply restore its own expected-answer file.

## 4. Configure the workstation policy for test data only

In Nexus, configure the workstation policy so the only acceptance source is:

```text
C:\NexusBackup-Test
```

Use a normal test schedule/retention, but use **Run now** for this procedure so timing is explicit.

Before starting:

- workstation is online;
- storage is ready;
- repository is the dedicated acceptance repository;
- no other workstation operation is active;
- the repository has no unexpected snapshots.

Do not add normal user/profile/application paths yet.

## 5. Baseline backup

Choose **Run now**.

Pass conditions:

- run reaches `completed`, not `partial` or `failed`;
- Nexus records a snapshot ID;
- last successful backup/snapshot changes to this completed run;
- no repository URL/password appears in browser-visible telemetry/errors;
- the dedicated repository receives the snapshot.

Record the run ID and snapshot ID as acceptance evidence.

If the first run fails because a remote repository is missing, fix/provision the dedicated test endpoint deliberately. Do not turn a generic authentication/network error into permission to initialize an unknown remote repository.

## 6. Snapshot inventory and browse

Open **Recovery** and refresh snapshot inventory.

Verify the new snapshot is present and belongs to the test workstation. Browse it non-recursively until the backed-up `NexusBackup-Test` tree can be identified.

Verify at least:

```text
alpha.txt
nested/
nested/beta.txt
binary-zero-1MiB.bin
```

An unexpected production path or unrelated snapshot is a stop condition.

## 7. Repository integrity

Run the workstation **repository integrity check**.

Pass conditions:

- operation completes successfully;
- UI reports **Integrity OK**;
- the previous successful backup/snapshot remains unchanged;
- controller telemetry still does not reveal repository/password details.

A green `restic check` is consistency evidence only. Continue to the real restore; do not treat this step as restore proof.

## 8. Dry-run restore preview

From Recovery, select the complete test source tree (or the whole acceptance snapshot if the UI cannot select exactly that tree) and run the dry-run preview.

Verify:

- it is explicitly a dry-run;
- the selection matches the expected snapshot/path;
- no browser-provided Windows destination is requested;
- no overwrite/delete control exists;
- Nexus returns the typed confirmation only after the completed preview.

Do not proceed if preview contents or scope are surprising.

## 9. Real staging restore

Enter the exact confirmation phrase for the completed preview and start the real restore.

Pass conditions:

- restore uses a new workstation-generated staging path;
- it never writes in-place over `C:\NexusBackup-Test`;
- it completes successfully;
- `--overwrite never` semantics remain in force;
- the run result identifies the staging target so it can be inspected.

A typical target is beneath the workstation Nexus data directory's `restores` tree, but **do not assume the internal Restic drive/path layout below the target**. Locate the restored `NexusBackup-Test` directory inside the reported staging target and use that directory as `$restoredRoot` below.

## 10. Byte/hash/content verification

Set `$restoredRoot` to the restored `NexusBackup-Test` directory beneath the staging target, then run:

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
    if ([int64]$got.Length -ne [int64]$item.Length) {
        $failures.Add("length mismatch: $($item.Path)")
    }
    if ($got.Sha256 -ne $item.Sha256) {
        $failures.Add("sha256 mismatch: $($item.Path)")
    }
}

$expectedPaths = @($expected | ForEach-Object { $_.Path })
foreach ($item in $actual) {
    if ($expectedPaths -notcontains $item.Path) {
        $failures.Add("unexpected file: $($item.Path)")
    }
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    throw 'Nexus Backup acceptance restore verification FAILED'
}

Write-Host 'Nexus Backup acceptance restore verification PASSED'
```

This is the core acceptance gate. Do not proceed to resilience testing unless it passes.

## 11. Idle controller restart

With no operation active, restart only `NexusBackup-Control`.

Verify after it returns:

- local admin login still works;
- workstation/device entry is preserved;
- policy/history is preserved;
- the previously successful snapshot remains the recorded last success;
- workstation reconnects without re-enrollment.

A control restart must not require repository secrets to be re-entered into Control.

## 12. Generic Agent restart

Restart `NexusBackup-Agent` while no generic-agent job is active.

Verify:

- it reconnects with the existing shared local-agent token;
- its explicit `agent.json` remains unchanged;
- no inert-default file overwrites an existing config;
- configured generic repository/source metadata shown by the dashboard remains sanitized.

This restart is platform evidence; workstation backup bytes do not pass through the generic Agent.

## 13. Workstation agent restart

With no workstation operation active:

```powershell
Stop-ScheduledTask -TaskName NexusBackupWorkstation
Start-Sleep -Seconds 5
Start-ScheduledTask -TaskName NexusBackupWorkstation
```

Verify the workstation returns online using its durable local token and the previous successful backup/snapshot remains intact.

## 14. Temporary Control-path outage during an active backup

This verifies that a transient control-plane communication loss does not immediately kill healthy local Restic work.

Use only the test repository. If the tiny baseline dataset finishes too quickly, add a disposable larger test file first. A seeded pseudo-random file avoids a trivially compressible zero file:

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

Regenerate `C:\NexusBackup-Test-reference.json` after adding the file if this snapshot may later be restore-verified.

Start **Run now** and wait until Nexus shows active backup progress. Then, from an elevated PowerShell, temporarily block only the Control port — not the repository transport port:

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

- local backup is not immediately cancelled merely because Control cannot be reached for this short interval;
- after connectivity returns, the run either completes/ACKs correctly or reports a truthful failure — never a fabricated success;
- the previously known good success remains available if this run fails.

Confirm cleanup with:

```powershell
Get-NetFirewallRule -DisplayName 'NexusBackup-Acceptance-Block-Control' -ErrorAction SilentlyContinue
```

If the repository transport uses TCP 8787 too, choose a different isolation method; do not accidentally make the repository unavailable while claiming to test only Control loss.

## 15. Repository unavailable

Make **only the dedicated acceptance repository endpoint** unavailable using the transport-specific mechanism for that test endpoint: for example stop its dedicated service/export or otherwise deny this test repository. Never rename, stop or unmount a production repository to run this test.

Run a workstation repository integrity check while it is unavailable.

Pass conditions:

- check fails clearly;
- it is not interpreted as permission to auto-initialize an unknown remote repository;
- last successful backup/snapshot remains unchanged;
- restoring repository availability and rerunning the check returns to Integrity OK.

Record the failure text only after confirming it is redacted of repository/password secrets.

## 16. Interrupted write restore

Use the acceptance repository and a snapshot large enough that staging restore remains active long enough to interrupt.

1. perform a fresh successful dry-run preview;
2. type the exact confirmation and start the real staging restore;
3. while the write restore is active, stop the workstation Scheduled Task:

```powershell
Stop-ScheduledTask -TaskName NexusBackupWorkstation
```

4. allow the controller lease/recovery logic to observe the interruption;
5. start the task again:

```powershell
Start-ScheduledTask -TaskName NexusBackupWorkstation
```

Pass conditions:

- the interrupted write restore does **not** become completed;
- it is not automatically requeued/replayed;
- an orphaned partial staging directory may remain and is treated only as disposable/manual-cleanup evidence;
- previous successful backup state remains intact;
- a new restore attempt requires a new/current preview/confirmation as applicable;
- the fresh restore receives a new staging target rather than reusing the interrupted target.

Never manually copy the interrupted staging tree into live data.

## 17. Re-verify after fault tests

After repository/service connectivity is restored and all agents are online:

1. run repository integrity again and require **Integrity OK**;
2. if `NexusBackup-Test` changed during resilience testing, regenerate/update the independent reference manifest **before** the final backup;
3. run one final normal backup of that exact current `NexusBackup-Test` source;
4. perform a final staging restore from that final snapshot;
5. repeat the byte/hash verification against the pre-backup reference manifest.

Do not edit the source or reference manifest between the final backup and hash comparison. Acceptance ends on a known-good restore, not merely on successful failure injection.

## 18. Evidence to retain

Keep a short acceptance record containing:

- exact Nexus versions/digests;
- workstation version;
- dedicated test repository identifier (no secret);
- baseline backup run + snapshot ID;
- integrity result;
- successful preview + staging restore run IDs;
- hash-verification PASS output;
- controller/agent/workstation restart observations;
- temporary Control outage result;
- repository-unavailable failure/result;
- interrupted-restore result/new-target proof;
- final integrity + final restore/hash PASS.

Do not store raw tokens, Restic passwords, SSH private keys, rclone tokens or full secret-bearing config files in the acceptance report.

## 19. Pass/fail decision

The workstation acceptance is **PASS** only if:

- backup completes to the intended isolated Unraid-side repository;
- inventory/browse are correct;
- repository integrity is OK when repository is healthy;
- dry-run and staging-only recovery safety boundaries hold;
- restored bytes match the independent reference manifest;
- controller/agent/workstation restarts preserve identity/state;
- transient Control loss does not invent success or unsafe cancellation semantics;
- repository failure is truthful and does not overwrite last known good state;
- interrupted write restore fails/manual-retry-only and never writes in place;
- a final post-fault staging restore again passes byte/hash verification.

Anything else is **FAIL/INVESTIGATE**. Do not cut over the workstation.

## 20. After a PASS

A PASS proves the isolated workload path; it does not itself authorize production migration.

Keep PCWatch-backup untouched until the subsequent cutover plan chooses one workstation at a time, confirms the production repository/retention policy, and ensures Nexus and PCWatch will never write concurrently to the same Restic repository.

The next project gate after this runbook is the M9 architecture/security review and final acceptance preflight.
