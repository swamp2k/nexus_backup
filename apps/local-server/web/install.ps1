$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) { throw "Nexus Backup installer: $Message" }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'Administrator/System rights are required. Run the command elevated or through PCWatch.'
}
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'Workstation agent v1 supports Windows x64 only.' }

$serverUrl = [string]$env:NEXUS_BACKUP_URL
$deviceToken = [string]$env:NEXUS_BACKUP_TOKEN
if ([string]::IsNullOrWhiteSpace($serverUrl)) { Fail 'NEXUS_BACKUP_URL is required.' }
if ([string]::IsNullOrWhiteSpace($deviceToken) -or -not $deviceToken.StartsWith('nxbdev_')) { Fail 'NEXUS_BACKUP_TOKEN is required.' }
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

try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 300

Write-Host 'Nexus Backup: finding latest workstation agent release...'
$release = Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'NexusBackupInstaller' } -Uri 'https://api.github.com/repos/swamp2k/nexus_backup/releases/latest'
$assetName = 'nexus-backup-workstation-windows-amd64.exe'
$asset = @($release.assets | Where-Object { $_.name -eq $assetName }) | Select-Object -First 1
$checksumAsset = @($release.assets | Where-Object { $_.name -eq "$assetName.sha256" }) | Select-Object -First 1
if (-not $asset -or -not $checksumAsset) { Fail 'latest Nexus Backup release does not contain the workstation agent and checksum yet' }
$tmpAgent = Join-Path $env:TEMP ("nexus-backup-workstation-{0}.exe" -f [guid]::NewGuid().ToString('N'))
$tmpChecksum = "$tmpAgent.sha256"
Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $tmpAgent
Invoke-WebRequest -UseBasicParsing -Uri $checksumAsset.browser_download_url -OutFile $tmpChecksum
$expectedAgentHash = ((Get-Content -Raw -Path $tmpChecksum).Trim() -split '\s+')[0].ToLowerInvariant()
$actualAgentHash = (Get-FileHash -Algorithm SHA256 -Path $tmpAgent).Hash.ToLowerInvariant()
if ($expectedAgentHash -notmatch '^[0-9a-f]{64}$' -or $actualAgentHash -ne $expectedAgentHash) {
  Remove-Item $tmpAgent,$tmpChecksum -Force -ErrorAction SilentlyContinue
  Fail 'Workstation agent checksum did not match the published release.'
}
Move-Item -Force $tmpAgent $agentPath
Remove-Item $tmpChecksum -Force -ErrorAction SilentlyContinue

if (-not (Test-Path $resticPath)) {
  $resticVersion = '0.19.1'
  $resticZip = Join-Path $env:TEMP ("restic-{0}.zip" -f [guid]::NewGuid().ToString('N'))
  $resticExtract = Join-Path $env:TEMP ("restic-{0}" -f [guid]::NewGuid().ToString('N'))
  Write-Host "Nexus Backup: installing Restic $resticVersion..."
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/restic/restic/releases/download/v$resticVersion/restic_${resticVersion}_windows_amd64.zip" -OutFile $resticZip
  $hash = (Get-FileHash -Algorithm SHA256 -Path $resticZip).Hash.ToLowerInvariant()
  if ($hash -ne 'da948ad707ed690426473aaba2046cd61f8f90f6f0e7dab6be0d5796531de67d') {
    Remove-Item $resticZip -Force -ErrorAction SilentlyContinue
    Fail 'Restic download checksum did not match the pinned release.'
  }
  Expand-Archive -Path $resticZip -DestinationPath $resticExtract -Force
  $downloadedRestic = Get-ChildItem -Path $resticExtract -Filter 'restic*.exe' | Select-Object -First 1
  if (-not $downloadedRestic) { Fail 'Restic archive did not contain restic.exe.' }
  Move-Item -Force $downloadedRestic.FullName $resticPath
  Remove-Item $resticZip -Force -ErrorAction SilentlyContinue
  Remove-Item $resticExtract -Recurse -Force -ErrorAction SilentlyContinue
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
if (Test-Path $configPath) {
  try {
    $old = Get-Content -Raw -Path $configPath | ConvertFrom-Json
    foreach ($name in @('repository','passwordFile','resticPath','pollSeconds','reportSeconds','autoInit')) {
      if ($null -ne $old.$name) { $config[$name] = $old.$name }
    }
  } catch { Write-Warning 'Existing workstation.json was invalid; replacing it with safe defaults.' }
}
if (-not [string]::IsNullOrWhiteSpace([string]$env:NEXUS_BACKUP_REPOSITORY)) {
  $config['repository'] = [string]$env:NEXUS_BACKUP_REPOSITORY
}
if (-not [string]::IsNullOrWhiteSpace([string]$env:NEXUS_BACKUP_RESTIC_PASSWORD)) {
  [IO.File]::WriteAllText($passwordPath, [string]$env:NEXUS_BACKUP_RESTIC_PASSWORD, (New-Object Text.UTF8Encoding($false)))
}
$configJson = $config | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($configPath, $configJson, (New-Object Text.UTF8Encoding($false)))

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
