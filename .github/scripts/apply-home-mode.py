from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]


def read(path):
    return (ROOT / path).read_text()


def write(path, text):
    (ROOT / path).write_text(text)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# Gateway: authenticated workstation repository discovery. No secrets are
# returned; Home mode is derived from Repository settings + the Control host.
# ---------------------------------------------------------------------------
p = "apps/local-server/bin/gateway.mjs"
s = read(p)
s = replace_once(
    s,
    'import { resolvePublicOrigin } from "../lib/public-origin.mjs";\n',
    'import { resolvePublicOrigin } from "../lib/public-origin.mjs";\nimport { createRepositorySettingsService } from "../lib/repository-settings.mjs";\n',
    "gateway import",
)
s = replace_once(
    s,
    'const workstationService = createWorkstationService({ db, deviceService });\n',
    'const workstationService = createWorkstationService({ db, deviceService });\nconst repositorySettingsService = createRepositorySettingsService();\n',
    "gateway service",
)
anchor = '''    if (path === "/v1/device/workstation/status" && request.method === "POST") {
      sendJson(response, 200, await workstationService.reportStatus(requireBearerToken(request), await readJsonBody(request)));
      return;
    }
'''
route = anchor + '''    if (path === "/v1/device/workstation/repository-profile" && request.method === "GET") {
      const device = await deviceService.authenticate(requireBearerToken(request));
      if (device.kind !== "workstation") throw statusError(403, "Device token is not a workstation token");
      const settings = await repositorySettingsService.get();
      if (settings.configured.exposure !== "lan") {
        sendJson(response, 200, { mode: "remote", automatic: false });
        return;
      }
      const authority = singleHeader(request.headers.host) || `127.0.0.1:${publicPort}`;
      let controlHost;
      try {
        controlHost = new URL(`http://${authority}`).hostname;
      } catch {
        throw statusError(400, "Invalid Control host");
      }
      const repositoryHost = settings.configured.host || controlHost;
      const repositoryPort = settings.configured.endpointPort || settings.configured.listenPort;
      sendJson(response, 200, {
        mode: "home",
        automatic: true,
        repository: `rest:http://${repositoryHost}:${repositoryPort}/${encodeURIComponent(device.id)}`,
        insecureNoPassword: true,
        autoInit: true,
      });
      return;
    }
'''
s = replace_once(s, anchor, route, "gateway profile route")
write(p, s)


# ---------------------------------------------------------------------------
# Workstation config: Home mode marks Restic repositories as intentionally
# passwordless. Remote mode keeps all existing password/TLS fields.
# ---------------------------------------------------------------------------
p = "apps/workstation-agent/main.go"
s = read(p)
s = replace_once(
    s,
    '\tAutoInit      bool   `json:"autoInit"`\n',
    '\tAutoInit           bool   `json:"autoInit"`\n\tInsecureNoPassword bool   `json:"insecureNoPassword,omitempty"`\n',
    "config no-password field",
)
write(p, s)


# ---------------------------------------------------------------------------
# Restic execution: use --insecure-no-password consistently for Home mode and
# permit first-use initialization of the trusted-LAN REST repository.
# ---------------------------------------------------------------------------
p = "apps/workstation-agent/restic.go"
s = read(p)
s = replace_once(
    s,
    '''\tallowInit := cfg.AutoInit && localRepositoryPath(cfg.Repository) != ""
\tif err := ensureRepositoryContext(ctx, cfg.ResticPath, env, cfg.Repository, allowInit); err != nil {
''',
    '''\tallowInit := cfg.AutoInit && (localRepositoryPath(cfg.Repository) != "" || (cfg.InsecureNoPassword && strings.HasPrefix(strings.ToLower(cfg.Repository), "rest:http://")))
\tif err := ensureRepositoryContext(ctx, cfg.ResticPath, env, cfg.Repository, allowInit, cfg.InsecureNoPassword); err != nil {
''',
    "home remote init",
)
s = replace_once(
    s,
    '''\targs = append(args, run.SourcePaths...)

\tresult := runBackupCommand(ctx, cfg.ResticPath, env, args, report)
''',
    '''\targs = append(args, run.SourcePaths...)
\targs = resticCLIArgs(cfg, args...)

\tresult := runBackupCommand(ctx, cfg.ResticPath, env, args, report)
''',
    "backup no-password args",
)
s = replace_once(
    s,
    '''\tif err := applyRetentionContext(ctx, cfg.ResticPath, env, tag, run.Retention); err != nil {
''',
    '''\tif err := applyRetentionContext(ctx, cfg.ResticPath, env, tag, run.Retention, cfg.InsecureNoPassword); err != nil {
''',
    "retention mode",
)
s = replace_once(
    s,
    '''func ensureRepositoryContext(ctx context.Context, resticPath string, env []string, repository string, autoInit bool) error {
\tif local := localRepositoryPath(repository); local != "" {
''',
    '''func ensureRepositoryContext(ctx context.Context, resticPath string, env []string, repository string, autoInit bool, insecureNoPassword ...bool) error {
\tnoPassword := len(insecureNoPassword) > 0 && insecureNoPassword[0]
\tif local := localRepositoryPath(repository); local != "" {
''',
    "ensure signature",
)
s = replace_once(
    s,
    '''\t\t\tinitCmd := commandContextWithTree(ctx, resticPath, "init")
''',
    '''\t\t\tinitCmd := commandContextWithTree(ctx, resticPath, resticCLIArgsForMode(noPassword, "init")...)
''',
    "local init args",
)
s = replace_once(
    s,
    '''\tcheck := commandContextWithTree(ctx, resticPath, "cat", "config")
\tcheck.Env = env
\toutput, err := combinedOutputTree(check)
\tif ctx.Err() != nil {
\t\treturn fmt.Errorf("open restic repository cancelled: %w", ctx.Err())
\t}
\tif err != nil {
\t\treturn fmt.Errorf("open restic repository: %s", boundedText(output, 4000))
\t}
\treturn nil
''',
    '''\tcheck := commandContextWithTree(ctx, resticPath, resticCLIArgsForMode(noPassword, "cat", "config")...)
\tcheck.Env = env
\toutput, err := combinedOutputTree(check)
\tif ctx.Err() != nil {
\t\treturn fmt.Errorf("open restic repository cancelled: %w", ctx.Err())
\t}
\tif err == nil {
\t\treturn nil
\t}
\tif !autoInit {
\t\treturn fmt.Errorf("open restic repository: %s", boundedText(output, 4000))
\t}
\tinitCmd := commandContextWithTree(ctx, resticPath, resticCLIArgsForMode(noPassword, "init")...)
\tinitCmd.Env = env
\tinitOutput, initErr := combinedOutputTree(initCmd)
\tif ctx.Err() != nil {
\t\treturn fmt.Errorf("initialize restic repository cancelled: %w", ctx.Err())
\t}
\tif initErr != nil {
\t\treturn fmt.Errorf("initialize restic repository: %s", boundedText(initOutput, 4000))
\t}
\tprobe := commandContextWithTree(ctx, resticPath, resticCLIArgsForMode(noPassword, "cat", "config")...)
\tprobe.Env = env
\tprobeOutput, probeErr := combinedOutputTree(probe)
\tif probeErr != nil {
\t\treturn fmt.Errorf("open initialized restic repository: %s", boundedText(probeOutput, 4000))
\t}
\treturn nil
''',
    "remote home init",
)
s = replace_once(
    s,
    '''func applyRetentionContext(ctx context.Context, resticPath string, env []string, tag string, retention retentionPolicy) error {
''',
    '''func applyRetentionContext(ctx context.Context, resticPath string, env []string, tag string, retention retentionPolicy, insecureNoPassword ...bool) error {
''',
    "retention signature",
)
s = replace_once(
    s,
    '''\tcmd := commandContextWithTree(ctx, resticPath, args...)
\tcmd.Env = env
\toutput, err := combinedOutputTree(cmd)
''',
    '''\tnoPassword := len(insecureNoPassword) > 0 && insecureNoPassword[0]
\tcmd := commandContextWithTree(ctx, resticPath, resticCLIArgsForMode(noPassword, args...)...)
\tcmd.Env = env
\toutput, err := combinedOutputTree(cmd)
''',
    "retention command",
)
s = replace_once(
    s,
    '''\tif strings.TrimSpace(cfg.PasswordFile) == "" {
\t\treturn errors.New("passwordFile is not configured locally")
\t}
\tcontent, err := os.ReadFile(cfg.PasswordFile)
\tif err != nil {
\t\treturn fmt.Errorf("read restic password file: %w", err)
\t}
\tif strings.TrimSpace(string(content)) == "" {
\t\treturn errors.New("restic password file is empty")
\t}
''',
    '''\tif !cfg.InsecureNoPassword {
\t\tif strings.TrimSpace(cfg.PasswordFile) == "" {
\t\t\treturn errors.New("passwordFile is not configured locally")
\t\t}
\t\tcontent, err := os.ReadFile(cfg.PasswordFile)
\t\tif err != nil {
\t\t\treturn fmt.Errorf("read restic password file: %w", err)
\t\t}
\t\tif strings.TrimSpace(string(content)) == "" {
\t\t\treturn errors.New("restic password file is empty")
\t\t}
\t}
''',
    "password validation",
)
s = replace_once(
    s,
    '''\tblocked := map[string]struct{}{
\t\t"RESTIC_REPOSITORY":    {},
\t\t"RESTIC_PASSWORD_FILE": {},
\t\t"RESTIC_REST_USERNAME": {},
\t\t"RESTIC_REST_PASSWORD": {},
\t\t"RESTIC_CACERT":        {},
\t}
''',
    '''\tblocked := map[string]struct{}{
\t\t"RESTIC_REPOSITORY":       {},
\t\t"RESTIC_PASSWORD":         {},
\t\t"RESTIC_PASSWORD_FILE":    {},
\t\t"RESTIC_PASSWORD_COMMAND": {},
\t\t"RESTIC_REST_USERNAME":    {},
\t\t"RESTIC_REST_PASSWORD":    {},
\t\t"RESTIC_CACERT":           {},
\t}
''',
    "password env cleanup",
)
s = replace_once(
    s,
    '''\tenv = append(env,
\t\t"RESTIC_REPOSITORY="+cfg.Repository,
\t\t"RESTIC_PASSWORD_FILE="+cfg.PasswordFile,
\t)
''',
    '''\tenv = append(env, "RESTIC_REPOSITORY="+cfg.Repository)
\tif !cfg.InsecureNoPassword {
\t\tenv = append(env, "RESTIC_PASSWORD_FILE="+cfg.PasswordFile)
\t}
''',
    "password env",
)
insert_before = '''func redactBackupError(cfg config, err error) error {
'''
helpers = '''func resticCLIArgs(cfg config, args ...string) []string {
\treturn resticCLIArgsForMode(cfg.InsecureNoPassword, args...)
}

func resticCLIArgsForMode(insecureNoPassword bool, args ...string) []string {
\tif !insecureNoPassword {
\t\treturn args
\t}
\tresult := make([]string, 0, len(args)+1)
\tresult = append(result, "--insecure-no-password")
\treturn append(result, args...)
}

'''
s = replace_once(s, insert_before, helpers + insert_before, "restic arg helpers")
write(p, s)


# ---------------------------------------------------------------------------
# Recovery/integrity must carry the no-password flag too.
# ---------------------------------------------------------------------------
p = "apps/workstation-agent/recovery.go"
s = read(p)
s = s.replace('ensureRepositoryContext(ctx, cfg.ResticPath, env, cfg.Repository, false)', 'ensureRepositoryContext(ctx, cfg.ResticPath, env, cfg.Repository, false, cfg.InsecureNoPassword)')
s = replace_once(
    s,
    '''\tcmd := commandContextWithTree(ctx, cfg.ResticPath,
\t\t"snapshots", "--json", "--latest", fmt.Sprint(maxRecoverySnapshots), "--group-by", "", "--tag", "nexus-workstation:"+deviceID,
\t)
''',
    '''\tcmd := commandContextWithTree(ctx, cfg.ResticPath,
\t\tresticCLIArgs(cfg, "snapshots", "--json", "--latest", fmt.Sprint(maxRecoverySnapshots), "--group-by", "", "--tag", "nexus-workstation:"+deviceID)...,
\t)
''',
    "snapshot args",
)
s = replace_once(
    s,
    '''\tcmd := commandContextWithTree(ctx, cfg.ResticPath, "ls", "--json", id, selectedPath)
''',
    '''\tcmd := commandContextWithTree(ctx, cfg.ResticPath, resticCLIArgs(cfg, "ls", "--json", id, selectedPath)...)
''',
    "browse args",
)
s = replace_once(
    s,
    '''\tresult := runRestoreCommand(ctx, cfg.ResticPath, env, args, target, dryRun)
''',
    '''\targs = resticCLIArgs(cfg, args...)
\tresult := runRestoreCommand(ctx, cfg.ResticPath, env, args, target, dryRun)
''',
    "restore args",
)
write(p, s)

p = "apps/workstation-agent/integrity.go"
s = read(p)
s = replace_once(s, 'ensureRepositoryContext(ctx, cfg.ResticPath, env, cfg.Repository, false)', 'ensureRepositoryContext(ctx, cfg.ResticPath, env, cfg.Repository, false, cfg.InsecureNoPassword)', "integrity ensure")
s = replace_once(s, 'commandContextWithTree(ctx, cfg.ResticPath, "check")', 'commandContextWithTree(ctx, cfg.ResticPath, resticCLIArgs(cfg, "check")...)', "integrity args")
write(p, s)


# ---------------------------------------------------------------------------
# Installer: ordinary ProgramData ACLs + automatic Home Repository discovery.
# Remote/Internet env provisioning remains available as the advanced path.
# ---------------------------------------------------------------------------
p = "apps/local-server/web/install.ps1"
s = read(p)
acl_block = '''# Device credentials, REST transport credentials and the Restic encryption password
# live below ProgramData. Do not inherit ordinary Users read access; retain only
# SYSTEM and local Administrators.
& icacls.exe $dataDir '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '/T' '/C' | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'Could not secure the local NexusBackup data directory ACL.' }
'''
s = replace_once(
    s,
    acl_block,
    '''# Home mode deliberately uses ordinary ProgramData inheritance. Older beta
# installs stripped inheritance; reset those ACLs during repair/update so the
# config is administratively boring again instead of becoming a hidden secret store.
& icacls.exe $dataDir '/inheritance:e' '/T' '/C' | Out-Null
& icacls.exe $dataDir '/reset' '/T' '/C' | Out-Null
''',
    "installer ACL reset",
)
profile_anchor = '''  $config = [ordered]@{
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
  }
'''
profile_replacement = '''  $repositoryProfile = $null
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
'''
s = replace_once(s, profile_anchor, profile_replacement, "installer profile")
s = replace_once(
    s,
    '''    foreach ($name in @('repository','passwordFile','resticPath','restUsername','restPassword','caCertPath','pollSeconds','reportSeconds','autoInit')) {
''',
    '''    foreach ($name in @('repository','passwordFile','resticPath','restUsername','restPassword','caCertPath','pollSeconds','reportSeconds','autoInit','insecureNoPassword')) {
''',
    "installer preserve home mode",
)
repo_override_anchor = '''  if (-not [string]::IsNullOrWhiteSpace([string]$env:NEXUS_BACKUP_REPOSITORY)) {
    $config['repository'] = ([string]$env:NEXUS_BACKUP_REPOSITORY).Trim()
  }
'''
repo_override_replacement = '''  if ($null -ne $repositoryProfile -and [string]$repositoryProfile.mode -eq 'home' -and [string]::IsNullOrWhiteSpace([string]$config['repository'])) {
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
'''
s = replace_once(s, repo_override_anchor, repo_override_replacement, "installer repository profile application")
s = replace_once(
    s,
    '''  $isPinnedRest = [string]$config['repository'] -match '^rest:https://' -and -not [string]::IsNullOrWhiteSpace([string]$config['restUsername'])
''',
    '''  $isPinnedRest = -not [bool]$config['insecureNoPassword'] -and [string]$config['repository'] -match '^rest:https://' -and -not [string]::IsNullOrWhiteSpace([string]$config['restUsername'])
''',
    "remote provisioning gate",
)
second_acl = '''  Write-WorkstationConfig $configPath $config
  & icacls.exe $dataDir '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '/T' '/C' | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'Could not protect Nexus Backup workstation configuration.' }
'''
s = replace_once(
    s,
    second_acl,
    '''  Write-WorkstationConfig $configPath $config
''',
    "installer second ACL",
)
s = replace_once(
    s,
    '''  Write-Host 'Nexus Backup workstation agent installed and started.'
  if ([string]::IsNullOrWhiteSpace([string]$config['repository']) -or -not (Test-Path $passwordPath)) {
    Write-Host 'Storage is not configured yet; Nexus will show this workstation as Needs storage setup.'
  }
''',
    '''  Write-Host 'Nexus Backup workstation agent installed and started.'
  $storageReady = -not [string]::IsNullOrWhiteSpace([string]$config['repository']) -and ([bool]$config['insecureNoPassword'] -or (Test-Path $passwordPath))
  if (-not $storageReady) {
    Write-Host 'Storage is not configured yet; Nexus will show this workstation as Needs storage setup.'
  } elseif ([bool]$config['insecureNoPassword']) {
    Write-Host 'Nexus Backup Home mode is ready: no Restic password, Repository credential or CA setup is required.'
  }
''',
    "installer final storage status",
)
s = replace_once(
    s,
    'Remove-Item Env:NEXUS_BACKUP_TOKEN,Env:NEXUS_BACKUP_REPOSITORY,Env:NEXUS_BACKUP_REST_USERNAME,Env:NEXUS_BACKUP_REST_PASSWORD,Env:NEXUS_BACKUP_REPOSITORY_CA_B64,Env:NEXUS_BACKUP_REPOSITORY_CA_SHA256,Env:NEXUS_BACKUP_RESTIC_PASSWORD -ErrorAction SilentlyContinue',
    'Remove-Item Env:NEXUS_BACKUP_TOKEN,Env:NEXUS_BACKUP_REPOSITORY,Env:NEXUS_BACKUP_REST_USERNAME,Env:NEXUS_BACKUP_REST_PASSWORD,Env:NEXUS_BACKUP_REPOSITORY_CA_B64,Env:NEXUS_BACKUP_REPOSITORY_CA_SHA256,Env:NEXUS_BACKUP_RESTIC_PASSWORD,Env:NEXUS_BACKUP_RESTIC_NO_PASSWORD -ErrorAction SilentlyContinue',
    "installer env cleanup",
)
write(p, s)


# ---------------------------------------------------------------------------
# Remote helper becomes explicitly Remote-only. Home mode is automatic.
# ---------------------------------------------------------------------------
p = "repository/client.sh"
s = read(p)
needle = '''APPEND_ONLY=$("$SETTINGS_BIN" get append-only 2>/dev/null || { [ "$EXPOSURE" = internet ] && echo true || echo false; })

[ -n "$HOST" ] || { echo "Repository endpoint host is not configured" >&2; exit 1; }
'''
replacement = '''APPEND_ONLY=$("$SETTINGS_BIN" get append-only 2>/dev/null || { [ "$EXPOSURE" = internet ] && echo true || echo false; })

if [ "$EXPOSURE" = "lan" ]; then
  echo "Nexus Backup Home mode configures workstation repositories automatically; no Repository credentials or CA are required."
  exit 0
fi

[ -n "$HOST" ] || { echo "Repository endpoint host is not configured" >&2; exit 1; }
'''
s = replace_once(s, needle, replacement, "remote helper home message")
write(p, s)


# ---------------------------------------------------------------------------
# Compose/Unraid: Home mode should work with no Repository host or initial user.
# ---------------------------------------------------------------------------
p = "compose.yaml"
s = read(p)
s = s.replace('NEXUS_BACKUP_REPOSITORY_HOST: ${NEXUS_BACKUP_REPOSITORY_HOST:-localhost}', 'NEXUS_BACKUP_REPOSITORY_HOST: ${NEXUS_BACKUP_REPOSITORY_HOST:-}')
s = s.replace('NEXUS_BACKUP_REPOSITORY_INITIAL_USER: ${NEXUS_BACKUP_REPOSITORY_INITIAL_USER:-nexus-workstation}', 'NEXUS_BACKUP_REPOSITORY_INITIAL_USER: ${NEXUS_BACKUP_REPOSITORY_INITIAL_USER:-}')
write(p, s)

p = "unraid/templates/nexus-backup.xml"
s = read(p)
s = s.replace('dashboard/control plane, local execution agent and TLS Restic workstation repository endpoint', 'dashboard/control plane, local execution agent and Restic workstation repository endpoint')
s = replace_once(
    s,
    '<Requires>Set Repository endpoint host to the DNS name or IPv4 address Windows workstations actually use. Internet exposure should use a stable public DNS name/IP plus a router/firewall port forward to the Repository listen port. Review source, backup, restore and download mappings before enabling jobs. Only add SYS_ADMIN and /dev/fuse manually if you deliberately enable the optional rclone-mounted remote-source feature.</Requires>',
    '<Requires>Home mode is the default and needs no Repository hostname, password, certificate or per-PC transport credentials. Configure a stable public DNS name/IP only when deliberately enabling Remote/Internet Repository mode. Review source, backup, restore and download mappings before enabling jobs. Only add SYS_ADMIN and /dev/fuse manually if you deliberately enable the optional rclone-mounted remote-source feature.</Requires>',
    "unraid requirements",
)
s = s.replace('Repository TLS keys and transport credentials under this path are secrets.', 'Remote-mode Repository TLS keys and transport credentials under this path are secrets.')
s = replace_once(
    s,
    '<Config Name="Repository endpoint host" Target="NEXUS_BACKUP_REPOSITORY_HOST" Default="" Description="Canonical DNS name or IPv4 address used by workstations. For Internet mode use the public/DDNS hostname. This identity is pinned in the self-signed Repository TLS certificate." Type="Variable" Display="always" Required="true" Mask="false"/>',
    '<Config Name="Repository endpoint host" Target="NEXUS_BACKUP_REPOSITORY_HOST" Default="" Description="Optional in Home mode. Required only for Remote/Internet mode, where this becomes the public/DDNS identity pinned in the Repository TLS certificate." Type="Variable" Display="advanced" Required="false" Mask="false"/>',
    "unraid host optional",
)
s = s.replace('Description="Local TLS Restic REST port on Unraid."', 'Description="Local Restic REST port on Unraid. Home mode uses plain HTTP on the trusted LAN; Remote mode uses TLS."')
s = replace_once(
    s,
    '<Config Name="Initial workstation user" Target="NEXUS_BACKUP_REPOSITORY_INITIAL_USER" Default="nexus-workstation" Description="Creates one initial private REST transport principal if missing. Additional per-workstation users can be created from the NexusBackup container console with nexus-repository-client." Type="Variable" Display="advanced" Required="false" Mask="false"/>',
    '<Config Name="Initial remote workstation user" Target="NEXUS_BACKUP_REPOSITORY_INITIAL_USER" Default="" Description="Remote/Internet mode only. Optionally creates one initial private REST transport principal. Home mode needs no Repository users." Type="Variable" Display="advanced" Required="false" Mask="false"/>',
    "unraid initial user",
)
write(p, s)


# ---------------------------------------------------------------------------
# Repository settings UI: Home first, Remote hardening remains opt-in.
# ---------------------------------------------------------------------------
p = "apps/local-server/web/repository-settings.js"
s = read(p)
s = s.replace('const endpoint=c.host?`https://${c.host}:${c.endpointPort||c.listenPort}`:"Not configured";\n  const internet=c.exposure==="internet";', 'const internet=c.exposure==="internet";\n  const homeHost=c.host||location.hostname;\n  const endpoint=internet?(c.host?`https://${c.host}:${c.endpointPort||c.listenPort}`:"Not configured"):`http://${homeHost}:${c.listenPort||8000}/<workstation>`;')
s = s.replace('<div><p class="eyebrow">Workstation Repository</p><h2>Network & protection</h2><p class="muted small">Expose Restic directly over HTTPS. No VPN or cloud data proxy is required.</p></div>\n      ${badge(internet?"Internet":"LAN",internet?"warn":"success")}', '<div><p class="eyebrow">Workstation Repository</p><h2>${internet?"Remote mode":"Home mode"}</h2><p class="muted small">${internet?"Hardened direct-Internet Repository with TLS, authentication and private namespaces.":"Trusted-LAN default: no Repository password, certificate or per-PC transport credentials."}</p></div>\n      ${badge(internet?"Remote / Internet":"Home / LAN",internet?"warn":"success")}')
s = s.replace('<label><span>Exposure</span><select name="exposure"><option value="lan" ${c.exposure==="lan"?"selected":""}>LAN only</option><option value="internet" ${internet?"selected":""}>Direct Internet</option></select><small>Internet mode is for remote PCs reaching this Restic endpoint through your router/firewall.</small></label>', '<label><span>Mode</span><select name="exposure"><option value="lan" ${c.exposure==="lan"?"selected":""}>Home / trusted LAN</option><option value="internet" ${internet?"selected":""}>Remote / Internet</option></select><small>Home mode is deliberately simple. Remote mode turns the existing TLS/auth hardening back on.</small></label>')
s = s.replace('<label><span>Endpoint hostname / IP</span><input name="host" required value="${attr(c.host||"")}" placeholder="backup.example.com"><small>This exact identity is pinned into the Repository TLS certificate.</small></label>', '<label><span>Endpoint hostname / IP</span><input name="host" ${internet?"required":""} value="${attr(c.host||"")}" placeholder="${internet?"backup.example.com":"optional — Control host is used automatically"}"><small>${internet?"Required for Remote mode and pinned into its TLS certificate.":"Optional in Home mode. Leave blank and Nexus uses the same LAN host as Control."}</small></label>')
s = s.replace('<div class="repo-settings-columns"><label><span>Local listen port</span><input name="listenPort" type="number" min="1" max="65535" required value="${attr(c.listenPort||8000)}"><small>Port on Tower.</small></label><label><span>Advertised endpoint port</span><input name="endpointPort" type="number" min="1" max="65535" required value="${attr(c.endpointPort||c.listenPort||8000)}"><small>May be 443 while router forwards to local 8000.</small></label></div>', '<div class="repo-settings-columns"><label><span>Local listen port</span><input name="listenPort" type="number" min="1" max="65535" required value="${attr(c.listenPort||8000)}"><small>${internet?"Port on Tower behind the router/firewall.":"Home Repository port on the LAN."}</small></label><label><span>Advertised endpoint port</span><input name="endpointPort" type="number" min="1" max="65535" required value="${attr(c.endpointPort||c.listenPort||8000)}"><small>${internet?"May be 443 while router forwards to local 8000.":"Normally the same as the local port."}</small></label></div>')
s = s.replace('<label class="repo-settings-toggle"><input name="appendOnly" type="checkbox" ${c.appendOnly?"checked":""}><span><strong>Append-only Repository</strong><small>Recommended for Internet exposure. Workstations can add backups but cannot delete or modify existing repository objects through the REST endpoint.</small></span></label>', '<label class="repo-settings-toggle"><input name="appendOnly" type="checkbox" ${c.appendOnly?"checked":""}><span><strong>Append-only Repository</strong><small>${internet?"Recommended for hostile-network exposure.":"Off by default at home so normal retention/prune works without extra maintenance."}</small></span></label>')
s = s.replace('${protection("TLS",p.tls?`TLS ${esc(p.tlsMinVersion||"1.3")} minimum`:"Off",Boolean(p.tls))}\n      ${protection("Authentication",p.bcryptAuth?"bcrypt per workstation":"Off",Boolean(p.bcryptAuth))}\n      ${protection("Private namespaces",p.privateRepositories?"Enabled":"Off",Boolean(p.privateRepositories))}', '${protection("Transport",p.tls?`TLS ${esc(p.tlsMinVersion||"1.3")} minimum`:"Plain HTTP on trusted LAN",Boolean(p.tls))}\n      ${protection("Repository auth",p.bcryptAuth?"bcrypt per workstation":"None in Home mode",Boolean(p.bcryptAuth))}\n      ${protection("Private namespaces",p.privateRepositories?"Enabled":"Folder per workstation",Boolean(p.privateRepositories))}')
s = s.replace('${internet?\'<div class="transfer-note mt-16"><strong>Router/firewall required:</strong> forward only the advertised Repository port to the local Repository listen port. Do not expose the Nexus Control UI just because Repository is Internet-facing.</div>\':""}', '${internet?\'<div class="transfer-note mt-16"><strong>Advanced Remote mode:</strong> forward only the advertised Repository port. Control should use its own HTTPS path.</div>\':\'<div class="transfer-note mt-16"><strong>Home trust boundary:</strong> Nexus assumes your LAN and Unraid are trusted. Restic keeps dedup/snapshots but uses an intentionally empty password.</div>\'}')
write(p, s)


# ---------------------------------------------------------------------------
# Tests: contract for Home-mode Restic argument/config semantics.
# ---------------------------------------------------------------------------
p = "apps/workstation-agent/home_mode_test.go"
write(p, r'''package main

import (
    "os"
    "path/filepath"
    "testing"
)

func TestHomeModeRepositoryNeedsNoPasswordFile(t *testing.T) {
    cfg := config{Repository: "rest:http://192.168.1.2:8000/device-home", InsecureNoPassword: true}
    if err := validateRepositoryConfig(cfg); err != nil {
        t.Fatalf("home mode config should be ready without a password file: %v", err)
    }
}

func TestEncryptedRepositoryStillRequiresPasswordFile(t *testing.T) {
    cfg := config{Repository: "rest:https://backup.example.test/device"}
    if err := validateRepositoryConfig(cfg); err == nil {
        t.Fatal("encrypted/remote config should still require passwordFile")
    }
}

func TestHomeModeResticArgsAlwaysCarryNoPasswordFlag(t *testing.T) {
    cfg := config{InsecureNoPassword: true}
    args := resticCLIArgs(cfg, "backup", "C:\\Data")
    if len(args) < 2 || args[0] != "--insecure-no-password" || args[1] != "backup" {
        t.Fatalf("unexpected args: %#v", args)
    }
}

func TestHomeModeEnvironmentDoesNotReferencePasswordFile(t *testing.T) {
    dir := t.TempDir()
    cfg := config{
        Repository: "rest:http://127.0.0.1:8000/test",
        PasswordFile: filepath.Join(dir, "does-not-exist"),
        InsecureNoPassword: true,
    }
    env := resticEnvironment(cfg)
    for _, entry := range env {
        if len(entry) >= len("RESTIC_PASSWORD_FILE=") && entry[:len("RESTIC_PASSWORD_FILE=")] == "RESTIC_PASSWORD_FILE=" {
            t.Fatalf("home mode leaked password-file env: %q", entry)
        }
    }
    if _, err := os.Stat(cfg.PasswordFile); !os.IsNotExist(err) {
        t.Fatalf("test expected missing password file, got %v", err)
    }
}
''')

p = "apps/local-server/test/home-mode-contract.test.mjs"
write(p, r'''import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const installer = await readFile(new URL("../web/install.ps1", import.meta.url), "utf8");
const gateway = await readFile(new URL("../bin/gateway.mjs", import.meta.url), "utf8");
const repository = await readFile(new URL("../../../repository/docker-entrypoint.sh", import.meta.url), "utf8");

test("Home mode is automatic and does not ACL-hide workstation config", () => {
  assert.match(installer, /repository-profile/);
  assert.match(installer, /insecureNoPassword/);
  assert.doesNotMatch(installer, /\/inheritance:r/);
  assert.match(installer, /\/inheritance:e/);
  assert.match(gateway, /mode: "home"/);
  assert.match(gateway, /rest:http:\/\//);
});

test("LAN repository is no-auth HTTP while Remote mode retains hardening", () => {
  assert.match(repository, /--no-auth/);
  assert.match(repository, /if \[ "\$EXPOSURE" = "internet" \]/);
  assert.match(repository, /--private-repos/);
  assert.match(repository, /--tls-min-ver 1\.3/);
});
''')


# ---------------------------------------------------------------------------
# CI: default appliance exercise is now Home mode. The next existing step still
# proves direct-Internet TLS/auth/append-only behavior, keeping both contracts.
# ---------------------------------------------------------------------------
p = ".github/workflows/ci.yml"
s = read(p)
s = s.replace('assert variables["NEXUS_BACKUP_REPOSITORY_HOST"]["Required"] == "true"', 'assert variables["NEXUS_BACKUP_REPOSITORY_HOST"]["Required"] == "false"')
s = s.replace("NEXUS_BACKUP_REPOSITORY_HOST=127.0.0.1 docker compose config > /tmp/nexus-compose.yml", "docker compose config > /tmp/nexus-compose.yml")
start = s.index('      - name: Exercise complete appliance with real Restic\n')
end = s.index('      - name: Exercise direct Internet Repository protections\n', start)
home_step = r'''      - name: Exercise complete Home appliance with real Restic
        shell: bash
        run: |
          set -euo pipefail
          for volume in nexus-config-ci nexus-state-ci nexus-backup-ci; do docker volume create "$volume" >/dev/null; done
          cleanup() {
            docker rm -f nexus-backup-ci >/dev/null 2>&1 || true
            docker volume rm nexus-config-ci nexus-state-ci nexus-backup-ci >/dev/null 2>&1 || true
            rm -rf /tmp/nexus-home-source /tmp/nexus-home-restore
          }
          trap cleanup EXIT

          docker run -d --name nexus-backup-ci \
            -p 18787:8787 \
            -p 18000:8000 \
            -v nexus-config-ci:/config \
            -v nexus-state-ci:/state \
            -v nexus-backup-ci:/backup \
            nexus-backup:ci >/dev/null

          ready=0
          for _ in $(seq 1 60); do
            control=0; repository=0; agent=0
            curl -fsS -o /dev/null http://127.0.0.1:18787/healthz && control=1 || true
            curl -fsS -o /dev/null http://127.0.0.1:18000/ && repository=1 || true
            docker logs nexus-backup-ci 2>&1 | grep -Fq '"message":"agent online"' && agent=1 || true
            if [ "$control" = 1 ] && [ "$repository" = 1 ] && [ "$agent" = 1 ]; then ready=1; break; fi
            if [ "$(docker inspect -f '{{.State.Running}}' nexus-backup-ci 2>/dev/null || true)" != true ]; then break; fi
            sleep 1
          done
          if [ "$ready" != 1 ]; then
            docker inspect nexus-backup-ci --format '{{json .State}}' >&2 || true
            docker logs nexus-backup-ci >&2 || true
            exit 1
          fi

          mkdir -p /tmp/nexus-home-source /tmp/nexus-home-restore
          printf 'home-mode-ci\n' > /tmp/nexus-home-source/probe.txt
          repo=rest:http://127.0.0.1:18000/ci-home
          docker run --rm --network host --entrypoint restic \
            -e RESTIC_REPOSITORY="$repo" \
            nexus-backup:ci --insecure-no-password init >/dev/null
          docker run --rm --network host --entrypoint restic \
            -e RESTIC_REPOSITORY="$repo" \
            -v /tmp/nexus-home-source:/source:ro \
            nexus-backup:ci --insecure-no-password backup /source >/dev/null
          docker run --rm --network host --entrypoint restic \
            -e RESTIC_REPOSITORY="$repo" \
            nexus-backup:ci --insecure-no-password check >/dev/null
          docker run --rm --network host --entrypoint restic \
            -e RESTIC_REPOSITORY="$repo" \
            -v /tmp/nexus-home-restore:/restore \
            nexus-backup:ci --insecure-no-password restore latest --target /restore >/dev/null
          grep -Fqx 'home-mode-ci' /tmp/nexus-home-restore/source/probe.txt

          if curl -fsS http://127.0.0.1:18000/ci-home/config >/dev/null 2>&1; then
            : # Home mode intentionally exposes the Repository to the trusted LAN without auth.
          else
            echo 'Home Repository unexpectedly requires auth/TLS' >&2
            exit 1
          fi

          docker exec nexus-backup-ci sh -ec 'pid="$(pidof rest-server)"; test -n "$pid"; kill "$pid"'
          stopped=0
          for _ in $(seq 1 20); do
            if [ "$(docker inspect -f '{{.State.Running}}' nexus-backup-ci 2>/dev/null || true)" != true ]; then stopped=1; break; fi
            sleep 1
          done
          [ "$stopped" = 1 ] || { echo 'appliance stayed alive after Repository process died' >&2; docker logs nexus-backup-ci >&2; exit 1; }
'''
s = s[:start] + home_step + s[end:]
write(p, s)

print("Home-mode refactor applied")
