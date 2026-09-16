$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) { throw "Nexus Backup installer: $Message" }

function Download-VerifiedAsset([string]$Url, [string]$ChecksumUrl, [string]$Destination) {
  $checksumPath = "$Destination.sha256"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
    Invoke-WebRequest -UseBasicParsing -Uri $ChecksumUrl -OutFile $checksumPath
    $expected = ((Get-Content -Raw -Path $checksumPath).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $Destination).Hash.ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$' -or $actual -ne $expected) {
      Fail "Checksum mismatch for $Url"
    }
  } finally {
    Remove-Item $checksumPath -Force -ErrorAction SilentlyContinue
  }
}

function Write-PinnedBase64Asset([string]$Base64, [string]$ExpectedSha256, [string]$Destination) {
  $expected = $ExpectedSha256.Trim().ToLowerInvariant()
  if ($expected -notmatch '^[0-9a-f]{64}$') { Fail 'Pinned Repository CA SHA-256 must contain exactly 64 hexadecimal characters.' }
  if ([string]::IsNullOrWhiteSpace($Base64)) { Fail 'Pinned Repository CA payload is empty.' }
  try {
    $bytes = [Convert]::FromBase64String($Base64.Trim())
  } catch {
    Fail 'Pinned Repository CA payload is not valid base64.'
  }
  if ($bytes.Length -eq 0) { Fail 'Pinned Repository CA payload decoded to an empty file.' }
  [IO.File]::WriteAllBytes($Destination, $bytes)
  $actual = (Get-FileHash -Algorithm SHA256 -Path $Destination).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { Fail 'Pinned Repository CA checksum mismatch.' }
}

function Write-WorkstationConfig([string]$Path, [System.Collections.IDictionary]$Config) {
  $json = $Config | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Short-NativeOutput($Value) {
  $text = (($Value | Out-String).Trim())
  if ($text.Length -gt 1200) { return $text.Substring(0, 1200) + ' [truncated]' }
  return $text
}

function Invoke-PinnedRepositoryProvision([string]$ResticExe, [System.Collections.IDictionary]$Config) {
  $repository = ([string]$Config['repository']).Trim()
  $username = ([string]$Config['restUsername']).Trim()
  $transportPassword = ([string]$Config['restPassword']).Trim()
  $passwordFile = ([string]$Config['passwordFile']).Trim()
  $caFile = ([string]$Config['caCertPath']).Trim()
  if ($repository -notmatch '^rest:https://' -or [string]::IsNullOrWhiteSpace($username) -or [string]::IsNullOrWhiteSpace($transportPassword) -or [string]::IsNullOrWhiteSpace($caFile)) {
    return
  }
  if (-not (Test-Path -LiteralPath $passwordFile -PathType Leaf)) { Fail 'Pinned Repository provisioning requires the local Restic encryption password file.' }
  if (-not (Test-Path -LiteralPath $caFile -PathType Leaf)) { Fail 'Pinned Repository provisioning requires the verified local CA certificate.' }

  $names = @('RESTIC_REPOSITORY','RESTIC_PASSWORD_FILE','RESTIC_REST_USERNAME','RESTIC_REST_PASSWORD','RESTIC_CACERT')
  $previous = @{}
  foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  try {
    $env:RESTIC_REPOSITORY = $repository
    $env:RESTIC_PASSWORD_FILE = $passwordFile
    $env:RESTIC_REST_USERNAME = $username
    $env:RESTIC_REST_PASSWORD = $transportPassword
    $env:RESTIC_CACERT = $caFile

    Write-Host 'Nexus Backup: provisioning pinned Repository endpoint...'
    $initOutput = & $ResticExe init 2>&1
    $initExit = $LASTEXITCODE
    if ($initExit -ne 0) {
      # An already initialized repository is expected on reinstall. Prove that the
      # exact pinned endpoint can be opened with this encryption key. Auth/TLS/network
      # failures fail installation here and are never converted into runtime init.
      $probeOutput = & $ResticExe cat config 2>&1
      if ($LASTEXITCODE -ne 0) {
        Fail "Pinned Repository could neither be initialized nor opened. init: $(Short-NativeOutput $initOutput); probe: $(Short-NativeOutput $probeOutput)"
      }
      Write-Host 'Nexus Backup: existing pinned Repository verified.'
    } else {
      $probeOutput = & $ResticExe cat config 2>&1
      if ($LASTEXITCODE -ne 0) {
        Fail "Pinned Repository was initialized but could not be reopened: $(Short-NativeOutput $probeOutput)"
      }
      Write-Host 'Nexus Backup: new pinned Repository initialized and verified.'
    }
  } finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
  }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'Administrator/System rights are required. Run the command elevated or through PCWatch.'
}
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'Workstation agent v1 supports Windows x64 only.' }

$serverUrl = ([string]$env:NEXUS_BACKUP_URL).Trim()
$bootstrapToken = ([string]$env:NEXUS_BACKUP_TOKEN).Trim()
if ([string]::IsNullOrWhiteSpace($serverUrl) -or $serverUrl -notmatch '^https?://') {
  Fail 'NEXUS_BACKUP_URL must be an HTTP or HTTPS Nexus URL.'
}
$serverUrl = $serverUrl.TrimEnd('/')

$installDir = Join-Path $env:ProgramFiles 'Nexus Backup Workstation'
$dataDir = Join-Path $env:ProgramData 'NexusBackup'
$configPath = Join-Path $dataDir 'workstation.json'
$passwordPath = Join-Path $dataDir 'restic-password'
$caCertPath = Join-Path $dataDir 'repository-ca.pem'
$agentPath = Join-Path $installDir 'nexus-backup-workstation.exe'
$resticPath = Join-Path $installDir 'restic.exe'
$taskName = 'NexusBackupWorkstation'
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

# Home mode deliberately uses ordinary ProgramData inheritance. Older beta
# installs stripped inheritance; reset those ACLs during repair/update so the
# config is administratively boring again instead of becoming a hidden secret store.
& icacls.exe $dataDir '/inheritance:e' '/T' '/C' | Out-Null
& icacls.exe $dataDir '/reset' '/T' '/C' | Out-Null

$old = $null
$deviceToken = ''
if (Test-Path $configPath) {
  try {
    $old = Get-Content -Raw -Path $configPath | ConvertFrom-Json
    if ($null -ne $old.deviceToken -and ([string]$old.deviceToken).StartsWith('nxbdev_')) {
      $deviceToken = [string]$old.deviceToken
    }
  } catch { Write-Warning 'Existing workstation.json was invalid; replacing it with safe defaults.' }
}

# Fetch the exact workstation payload bundled with this Nexus control image before
# consuming a one-shot enrollment credential. The target PC needs no Internet access.
$tmpAgent = Join-Path $env:TEMP ("nexus-backup-workstation-{0}.exe" -f [guid]::NewGuid().ToString('N'))
$tmpRestic = Join-Path $env:TEMP ("nexus-backup-restic-{0}.exe" -f [guid]::NewGuid().ToString('N'))
$tmpCa = Join-Path $env:TEMP ("nexus-backup-repository-ca-{0}.pem" -f [guid]::NewGuid().ToString('N'))
try {
  Write-Host 'Nexus Backup: downloading workstation agent from local Nexus...'
  Download-VerifiedAsset `
    "$serverUrl/workstation/nexus-backup-workstation-windows-amd64.exe" `
    "$serverUrl/workstation/nexus-backup-workstation-windows-amd64.exe.sha256" `
    $tmpAgent

  Write-Host 'Nexus Backup: downloading bundled Restic...'
  Download-VerifiedAsset `
    "$serverUrl/workstation/restic.exe" `
    "$serverUrl/workstation/restic.exe.sha256" `
    $tmpRestic

  # A fresh workstation enrollment token is valid for only a short window and can
  # be used once. Exchange it directly with Nexus; PCWatch never receives the
  # resulting long-lived device token.
  if ([string]::IsNullOrWhiteSpace($deviceToken)) {
    if ([string]::IsNullOrWhiteSpace($bootstrapToken) -or -not $bootstrapToken.StartsWith('nxbdev_')) {
      Fail 'A fresh NEXUS_BACKUP_TOKEN enrollment credential is required for first install.'
    }
    $bootstrapBody = @{
      version = 'installer'
      hostname = [Environment]::MachineName
      platform = 'windows/amd64'
      capabilities = @('workstation.bootstrap.v1')
    } | ConvertTo-Json -Depth 4
    try {
      $bootstrap = Invoke-RestMethod -UseBasicParsing -Method Post -Uri "$serverUrl/v1/device/report" `
        -Headers @{ Authorization = "Bearer $bootstrapToken" } -ContentType 'application/json' -Body $bootstrapBody
    } catch {
      Fail "Could not enroll workstation. The install credential may be expired or already used. $($_.Exception.Message)"
    }
    $deviceToken = [string]$bootstrap.deviceToken
    if ([string]::IsNullOrWhiteSpace($deviceToken) -or -not $deviceToken.StartsWith('nxbdev_')) {
      Fail 'Nexus did not return a workstation device token.'
    }
  }

  $repositoryProfile = $null
  try {
    $repositoryProfile = Invoke-RestMethod -UseBasicParsing -Method Get -Uri "$serverUrl/v1/device/workstation/repository-profile" `
      -Headers @{ Authorization = "Bearer $deviceToken" }
  } catch {
    Write-Warning "Could not discover Nexus Home Repository settings; workstation will remain usable for scanning and can be repaired later. $($_.Exception.Message)"
  }

  $config = [ordered]@{
    serverUrl = $serverUrl
    deviceToken = $deviceToken
    repository = ''
    passwordFile = $passwordPath
    resticPath = $resticPath
    restUsername = ''
    restPassword = ''
    caCertPath = ''
    pollSeconds = 15
    reportSeconds = 60
    autoInit = $true
    insecureNoPassword = $false
  }
  if ($null -ne $old) {
    foreach ($name in @('repository','passwordFile','resticPath','restUsername','restPassword','caCertPath','pollSeconds','reportSeconds','autoInit','insecureNoPassword')) {
      if ($null -ne $old.$name) { $config[$name] = $old.$name }
    }
  }
  if ($null -ne $repositoryProfile -and [string]$repositoryProfile.mode -eq 'home' -and [string]::IsNullOrWhiteSpace([string]$config['repository'])) {
    $config['repository'] = ([string]$repositoryProfile.repository).Trim()
    $config['passwordFile'] = ''
    $config['restUsername'] = ''
    $config['restPassword'] = ''
    $config['caCertPath'] = ''
    $config['autoInit'] = $true
    $config['insecureNoPassword'] = $true
    Write-Host "Nexus Backup: Home Repository configured automatically at $($config['repository'])"
  }

  if (-not [string]::IsNullOrWhiteSpace([string]$env:NEXUS_BACKUP_REPOSITORY)) {
    $config['repository'] = ([string]$env:NEXUS_BACKUP_REPOSITORY).Trim()
    $config['insecureNoPassword'] = $false
  }
  if (([string]$env:NEXUS_BACKUP_RESTIC_NO_PASSWORD).Trim().ToLowerInvariant() -in @('1','true','yes')) {
    $config['passwordFile'] = ''
    $config['insecureNoPassword'] = $true
  }

  $restUsername = ([string]$env:NEXUS_BACKUP_REST_USERNAME).Trim()
  $restPassword = ([string]$env:NEXUS_BACKUP_REST_PASSWORD).Trim()
  if ([string]::IsNullOrWhiteSpace($restUsername) -xor [string]::IsNullOrWhiteSpace($restPassword)) {
    Fail 'NEXUS_BACKUP_REST_USERNAME and NEXUS_BACKUP_REST_PASSWORD must be supplied together.'
  }
  if (-not [string]::IsNullOrWhiteSpace($restUsername)) {
    if ([string]$config['repository'] -notmatch '^rest:https://') {
      Fail 'REST transport credentials are only accepted for a rest:https:// repository.'
    }
    $config['restUsername'] = $restUsername
    $config['restPassword'] = $restPassword
  }

  $caB64 = ([string]$env:NEXUS_BACKUP_REPOSITORY_CA_B64).Trim()
  $caSha = ([string]$env:NEXUS_BACKUP_REPOSITORY_CA_SHA256).Trim()
  if ([string]::IsNullOrWhiteSpace($caB64) -xor [string]::IsNullOrWhiteSpace($caSha)) {
    Fail 'NEXUS_BACKUP_REPOSITORY_CA_B64 and NEXUS_BACKUP_REPOSITORY_CA_SHA256 must be supplied together.'
  }
  if (-not [string]::IsNullOrWhiteSpace($caB64)) {
    Write-Host 'Nexus Backup: decoding and verifying Repository CA certificate from local onboarding values...'
    Write-PinnedBase64Asset $caB64 $caSha $tmpCa
    Move-Item -Force $tmpCa $caCertPath
    $config['caCertPath'] = $caCertPath
  }

  if (-not [string]::IsNullOrWhiteSpace([string]$env:NEXUS_BACKUP_RESTIC_PASSWORD)) {
    [IO.File]::WriteAllText($passwordPath, [string]$env:NEXUS_BACKUP_RESTIC_PASSWORD, (New-Object Text.UTF8Encoding($false)))
  }

  $isPinnedRest = -not [bool]$config['insecureNoPassword'] -and [string]$config['repository'] -match '^rest:https://' -and -not [string]::IsNullOrWhiteSpace([string]$config['restUsername'])
  if ($isPinnedRest -and [string]::IsNullOrWhiteSpace([string]$config['caCertPath'])) {
    Fail 'Authenticated Nexus Repository setup requires a locally supplied and SHA-256-verified CA certificate.'
  }

  # A Nexus-managed REST repository is initialized/verified only during this explicit
  # local provisioning step. Normal Agent runtime never initializes a remote repository
  # after a failed auth/TLS/network probe.
  if ($isPinnedRest) {
    Invoke-PinnedRepositoryProvision $tmpRestic $config
    $config['autoInit'] = $false
  }

  # Persist the permanent token and local repository credentials before touching the
  # existing installation. If a later file replacement fails, rerunning the installer
  # can repair it without needing the already-consumed bootstrap token.
  Write-WorkstationConfig $configPath $config

  try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch {}
  Start-Sleep -Milliseconds 300

  Move-Item -Force $tmpAgent $agentPath
  Move-Item -Force $tmpRestic $resticPath

  $action = New-ScheduledTaskAction -Execute $agentPath -Argument '--run' -WorkingDirectory $installDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principalTask = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principalTask -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName

  Write-Host 'Nexus Backup workstation agent installed and started.'
  $storageReady = -not [string]::IsNullOrWhiteSpace([string]$config['repository']) -and ([bool]$config['insecureNoPassword'] -or (Test-Path $passwordPath))
  if (-not $storageReady) {
    Write-Host 'Storage is not configured yet; Nexus will show this workstation as Needs storage setup.'
  } elseif ([bool]$config['insecureNoPassword']) {
    Write-Host 'Nexus Backup Home mode is ready: no Restic password, Repository credential or CA setup is required.'
  }
} finally {
  Remove-Item $tmpAgent,$tmpRestic,$tmpCa -Force -ErrorAction SilentlyContinue
  Remove-Item Env:NEXUS_BACKUP_TOKEN,Env:NEXUS_BACKUP_REPOSITORY,Env:NEXUS_BACKUP_REST_USERNAME,Env:NEXUS_BACKUP_REST_PASSWORD,Env:NEXUS_BACKUP_REPOSITORY_CA_B64,Env:NEXUS_BACKUP_REPOSITORY_CA_SHA256,Env:NEXUS_BACKUP_RESTIC_PASSWORD,Env:NEXUS_BACKUP_RESTIC_NO_PASSWORD -ErrorAction SilentlyContinue
}
