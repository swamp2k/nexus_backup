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
    if ($expected -notmatch '^[0-9a-f]{64}$' -or $actual -ne $expected) { Fail "Checksum mismatch for $Url" }
  } finally { Remove-Item $checksumPath -Force -ErrorAction SilentlyContinue }
}
function Get-OptionalProperty($Object, [string]$Name) { if ($null -eq $Object) { return $null }; $property = $Object.PSObject.Properties[$Name]; if ($null -eq $property) { return $null }; return $property.Value }
function Write-Config([string]$Path, [System.Collections.IDictionary]$Config) { $Config | ConvertTo-Json -Depth 6 | Set-Content -Path $Path -Encoding utf8 }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Administrator/System rights are required.' }
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'The workstation client supports Windows x64 only.' }
$serverUrl=([string]$env:NEXUS_BACKUP_URL).Trim().TrimEnd('/')
$bootstrapToken=([string]$env:NEXUS_BACKUP_TOKEN).Trim()
if ([string]::IsNullOrWhiteSpace($serverUrl) -or $serverUrl -notmatch '^https?://') { Fail 'NEXUS_BACKUP_URL must be an HTTP or HTTPS Nexus URL.' }

$installDir=Join-Path $env:ProgramFiles 'Nexus Backup Workstation'
$dataDir=Join-Path $env:ProgramData 'NexusBackup'
$configPath=Join-Path $dataDir 'workstation.json'
$clientPath=Join-Path $installDir 'nexus-backup-workstation.exe'
$taskName='NexusBackupWorkstation'
New-Item -ItemType Directory -Path $installDir,$dataDir -Force | Out-Null
& icacls.exe $dataDir '/inheritance:e' '/T' '/C' | Out-Null
& icacls.exe $dataDir '/reset' '/T' '/C' | Out-Null

$deviceToken=''
$old=$null
if(Test-Path $configPath){try{$old=Get-Content -Raw $configPath|ConvertFrom-Json;$oldDeviceToken = Get-OptionalProperty $old 'deviceToken';if($oldDeviceToken -and ([string]$oldDeviceToken).StartsWith('nxbdev_')){$deviceToken=[string]$oldDeviceToken}}catch{Write-Warning 'Existing workstation config was invalid; replacing it.'}}
$tmp=Join-Path $env:TEMP ("nexus-backup-workstation-{0}.exe" -f [guid]::NewGuid().ToString('N'))
try {
  Download-VerifiedAsset "$serverUrl/workstation/nexus-backup-workstation-windows-amd64.exe" "$serverUrl/workstation/nexus-backup-workstation-windows-amd64.exe.sha256" $tmp
  if([string]::IsNullOrWhiteSpace($deviceToken)){
    if([string]::IsNullOrWhiteSpace($bootstrapToken) -or -not $bootstrapToken.StartsWith('nxbdev_')){Fail 'A fresh NEXUS_BACKUP_TOKEN enrollment credential is required.'}
    $body=@{version='installer';hostname=[Environment]::MachineName;platform='windows/amd64';capabilities=@('workstation.bootstrap.v1','workstation.source-scan.v1','workstation.flat-file.v1')}|ConvertTo-Json
    $bootstrap=Invoke-RestMethod -UseBasicParsing -Method Post -Uri "$serverUrl/v1/device/report" -Headers @{Authorization="Bearer $bootstrapToken"} -ContentType 'application/json' -Body $body
    $deviceToken=[string]$bootstrap.deviceToken
    if([string]::IsNullOrWhiteSpace($deviceToken)){Fail 'Nexus did not return a workstation device token.'}
  }
  $profile=Invoke-RestMethod -UseBasicParsing -Method Get -Uri "$serverUrl/v1/device/workstation/repository-profile" -Headers @{Authorization="Bearer $deviceToken"}
  $config=[ordered]@{serverUrl=$serverUrl;deviceToken=$deviceToken;receiverProtocol=([string]$profile.transport);receiverHost=([string]$profile.receiverHost);receiverPort=[int]$profile.receiverPort;receiverUsername=([string]$profile.receiverUsername);receiverPassword=([string](Get-OptionalProperty $profile 'receiverPassword'));repositoryId=([string]$profile.repositoryId);destinationFolder=([string]$profile.destinationFolder);pollSeconds=15;reportSeconds=60}
  if($old){foreach($name in @('pollSeconds','reportSeconds','receiverPassword')){$value = Get-OptionalProperty $old $name;if($null -ne $value){$config[$name]=$value}}}
  Write-Config $configPath $config
  try{Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue}catch{}
  Start-Sleep -Milliseconds 300
  Move-Item -Force $tmp $clientPath
  $action=New-ScheduledTaskAction -Execute $clientPath -Argument '--run' -WorkingDirectory $installDir
  $trigger=New-ScheduledTaskTrigger -AtStartup
  $principalTask=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principalTask -Settings $settings -Force|Out-Null
  Start-ScheduledTask -TaskName $taskName
  Write-Host 'Nexus Backup workstation client installed and started.'
} finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue;Remove-Item Env:NEXUS_BACKUP_TOKEN -ErrorAction SilentlyContinue }
