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

function Write-WorkstationConfig([string]$Path, [hashtable]$Config) {
  $json = $Config | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
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
$agentPath = Join-Path $installDir 'nexus-backup-workstation.exe'
$resticPath = Join-Path $installDir 'restic.exe'
$taskName = 'NexusBackupWorkstation'
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

# Device credentials and the Restic password live below ProgramData. Do not inherit
# ordinary Users read access; retain only SYSTEM and local Administrators.
& icacls.exe $dataDir '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '/T' '/C' | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'Could not secure the local NexusBackup data directory ACL.' }

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

  $config = [ordered]@{
    serverUrl = $serverUrl
    deviceToken = $deviceToken
    repository = ''
    passwordFile = $passwordPath
    resticPath = $resticPath
    pollSeconds = 15
    reportSeconds = 60
    autoInit = $true
  }
  if ($null -ne $old) {
    foreach ($name in @('repository','passwordFile','resticPath','pollSeconds','reportSeconds','autoInit')) {
      if ($null -ne $old.$name) { $config[$name] = $old.$name }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$env:NEXUS_BACKUP_REPOSITORY)) {
    $config['repository'] = [string]$env:NEXUS_BACKUP_REPOSITORY
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$env:NEXUS_BACKUP_RESTIC_PASSWORD)) {
    [IO.File]::WriteAllText($passwordPath, [string]$env:NEXUS_BACKUP_RESTIC_PASSWORD, (New-Object Text.UTF8Encoding($false)))
  }

  # Persist the permanent token before touching the existing installation. If a later
  # file replacement fails, rerunning the same installer can repair it without needing
  # the already-consumed bootstrap token.
  Write-WorkstationConfig $configPath $config
  & icacls.exe $dataDir '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '/T' '/C' | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'Could not protect Nexus Backup workstation configuration.' }

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
  if ([string]::IsNullOrWhiteSpace([string]$config['repository']) -or -not (Test-Path $passwordPath)) {
    Write-Host 'Storage is not configured yet; Nexus will show this workstation as Needs storage setup.'
  }
} finally {
  Remove-Item $tmpAgent,$tmpRestic -Force -ErrorAction SilentlyContinue
}
