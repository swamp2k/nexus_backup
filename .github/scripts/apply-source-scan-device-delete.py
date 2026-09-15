from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"expected snippet not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


def insert_before(path, marker, addition):
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if marker not in text:
        raise SystemExit(f"marker not found in {path}: {marker[:120]!r}")
    p.write_text(text.replace(marker, addition + marker, 1), encoding="utf-8")


# ---------------------------------------------------------------------------
# Permanent deletion of disabled non-workstation managed devices.
# ---------------------------------------------------------------------------
replace_once(
    "apps/local-server/lib/managed-devices.mjs",
    "  async function authenticate(rawToken) {\n",
    '''  async function remove(deviceId) {\n    const normalizedId = requireId(deviceId, "device id");\n    const existing = await byId(db, normalizedId);\n    if (!existing) throw statusError(404, `Device not found: ${normalizedId}`);\n    if (Number(existing.enabled) === 1) throw statusError(409, "Disable the device before deleting it");\n    if (String(existing.kind) === "workstation") throw statusError(409, "Delete workstations from the Workstations page so workstation history is handled explicitly");\n    const result = await db.prepare("DELETE FROM managed_devices WHERE id=? AND enabled=0").bind(normalizedId).run();\n    if (Number(result.meta?.changes ?? 0) !== 1) throw statusError(409, "Device could not be deleted");\n    return { deleted: true, id: normalizedId };\n  }\n\n  async function authenticate(rawToken) {\n''',
)
replace_once(
    "apps/local-server/lib/managed-devices.mjs",
    "  return { list, create, rotateToken, update, authenticate, report };",
    "  return { list, create, rotateToken, update, remove, authenticate, report };",
)

# Gateway DELETE route + source scan routes + larger bounded workstation result body.
replace_once(
    "apps/local-server/bin/gateway.mjs",
    '''    const deviceMatch = path.match(/^\\/v1\\/local\\/devices\\/([^/]+)$/);\n    if (deviceMatch && request.method === "PATCH") {\n      sendJson(response, 200, { device: await deviceService.update(decodePathPart(deviceMatch[1]), await readJsonBody(request)) });\n      return;\n    }\n''',
    '''    const deviceMatch = path.match(/^\\/v1\\/local\\/devices\\/([^/]+)$/);\n    if (deviceMatch && request.method === "PATCH") {\n      sendJson(response, 200, { device: await deviceService.update(decodePathPart(deviceMatch[1]), await readJsonBody(request)) });\n      return;\n    }\n    if (deviceMatch && request.method === "DELETE") {\n      sendJson(response, 200, await deviceService.remove(decodePathPart(deviceMatch[1])));\n      return;\n    }\n''',
)
insert_before(
    "apps/local-server/bin/gateway.mjs",
    '''    const workstationPolicyMatch = path.match(/^\\/v1\\/local\\/workstations\\/([^/]+)\\/policy$/);\n''',
    '''    const workstationSourceScanMatch = path.match(/^\\/v1\\/local\\/workstations\\/([^/]+)\\/source-scan$/);\n    if (workstationSourceScanMatch && request.method === "GET") {\n      sendJson(response, 200, await workstationService.getSourceScan(decodePathPart(workstationSourceScanMatch[1])));\n      return;\n    }\n    if (workstationSourceScanMatch && request.method === "POST") {\n      sendJson(response, 202, { run: await workstationService.queueSourceScan(decodePathPart(workstationSourceScanMatch[1]), await readJsonBody(request)) });\n      return;\n    }\n''',
)
replace_once(
    "apps/local-server/bin/gateway.mjs",
    '''    const workstationResultMatch = path.match(/^\\/v1\\/device\\/workstation\\/runs\\/([^/]+)\\/result$/);\n    if (workstationResultMatch && request.method === "POST") {\n      sendJson(response, 200, { run: await workstationService.finish(requireBearerToken(request), decodePathPart(workstationResultMatch[1]), await readJsonBody(request)) });\n      return;\n    }\n''',
    '''    const workstationResultMatch = path.match(/^\\/v1\\/device\\/workstation\\/runs\\/([^/]+)\\/result$/);\n    if (workstationResultMatch && request.method === "POST") {\n      // Source scans can contain a cached directory tree. Keep the endpoint bounded,\n      // but allow substantially more than ordinary control-plane mutations.\n      sendJson(response, 200, { run: await workstationService.finish(requireBearerToken(request), decodePathPart(workstationResultMatch[1]), await readJsonBody(request, 16 * 1024 * 1024)) });\n      return;\n    }\n''',
)
replace_once(
    "apps/local-server/bin/gateway.mjs",
    '''async function readJsonBody(request) {\n  const body = await readBody(request, 1_048_576);\n''',
    '''async function readJsonBody(request, limit = 1_048_576) {\n  const body = await readBody(request, limit);\n''',
)
replace_once(
    "apps/local-server/bin/gateway.mjs",
    '''async function readBody(request, limit) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > limit) throw statusError(413, "Request body exceeds 1 MiB"); chunks.push(chunk); } return chunks.length ? Buffer.concat(chunks) : undefined; }''',
    '''async function readBody(request, limit) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > limit) throw statusError(413, `Request body exceeds ${Math.ceil(limit / 1_048_576)} MiB`); chunks.push(chunk); } return chunks.length ? Buffer.concat(chunks) : undefined; }''',
)

# ---------------------------------------------------------------------------
# Workstation source-scan orchestration and persisted last scan.
# ---------------------------------------------------------------------------
insert_before(
    "apps/local-server/lib/workstations.mjs",
    '''  async function queueRecovery(deviceId, operation, input = {}) {\n''',
    '''  async function queueSourceScan(deviceId, input = {}) {\n    const device = await requireWorkstation(deviceId);\n    if (!device.enabled) throw statusError(409, "Workstation is disabled");\n    if (!device.capabilities.includes("workstation.source-scan.v1")) throw statusError(409, "Workstation agent does not support source scans; update it first");\n    if (!isOnline(device.lastSeenAt, nowDate(now))) throw statusError(409, "Workstation must be online to scan backup sources");\n    const drives = normalizeSourceDrives(input?.drives);\n    const active = await activeRun(device.id);\n    if (active) throw statusError(409, `Workstation already has an active ${active.operation} run`);\n    const at = nowDate(now).toISOString();\n    const runId = requireId(id(), "generated run id");\n    const operationKey = `workstation:${device.id}:source-scan:${at}:${randomUUID()}`;\n    await db.prepare(`\n      INSERT INTO workstation_runs(id,device_id,operation_key,state,operation,request_json,source_paths_json,exclude_patterns_json,retention_json,\n        queued_at,created_at,updated_at)\n      VALUES(?,?,?,'queued','source-scan',?,'[]','[]','{}',?,?,?)\n    `).bind(runId, device.id, operationKey, JSON.stringify({ drives }), at, at, at).run();\n    return presentRun(await db.prepare("SELECT * FROM workstation_runs WHERE id=?").bind(runId).first());\n  }\n\n  async function getSourceScan(deviceId) {\n    const device = await requireWorkstation(deviceId);\n    const row = await db.prepare("SELECT * FROM workstation_source_scans WHERE device_id=?").bind(device.id).first();\n    const latestRun = await db.prepare(`\n      SELECT * FROM workstation_runs WHERE device_id=? AND operation='source-scan' ORDER BY queued_at DESC,id DESC LIMIT 1\n    `).bind(device.id).first();\n    return {\n      scan: row ? {\n        deviceId: device.id, sourceRunId: nullableString(row.source_run_id), scannedAt: String(row.scanned_at),\n        drives: parseArray(row.drives_json), nodes: parseJson(row.tree_json, []), truncated: Number(row.truncated) === 1,\n      } : null,\n      run: presentRun(latestRun),\n    };\n  }\n\n''',
)

replace_once(
    "apps/local-server/lib/workstations.mjs",
    '''  async function poll(rawToken) {\n    const device = await requireAuthenticatedWorkstation(rawToken);\n    await recoverExpired(device.id);\n    const row = await db.prepare(`\n      SELECT * FROM workstation_runs WHERE device_id=? AND state='queued' ORDER BY queued_at ASC,id ASC LIMIT 1\n    `).bind(device.id).first();\n''',
    '''  async function poll(rawToken) {\n    const device = await requireAuthenticatedWorkstation(rawToken);\n    await recoverExpired(device.id);\n    const status = await db.prepare("SELECT repository_configured FROM workstation_status WHERE device_id=?").bind(device.id).first();\n    const repositoryReady = Number(status?.repository_configured ?? 0) === 1;\n    const row = repositoryReady\n      ? await db.prepare(`SELECT * FROM workstation_runs WHERE device_id=? AND state='queued' ORDER BY queued_at ASC,id ASC LIMIT 1`).bind(device.id).first()\n      : await db.prepare(`SELECT * FROM workstation_runs WHERE device_id=? AND state='queued' AND operation='source-scan' ORDER BY queued_at ASC,id ASC LIMIT 1`).bind(device.id).first();\n''',
)

replace_once(
    "apps/local-server/lib/workstations.mjs",
    '''      if (state === "completed") await persistRecoveryResult(device.id, normalizedRunId, operation, request, resultValue, at.toISOString());\n''',
    '''      if (state === "completed") {\n        if (operation === "source-scan") await persistSourceScan(device.id, normalizedRunId, resultValue, at.toISOString());\n        else await persistRecoveryResult(device.id, normalizedRunId, operation, request, resultValue, at.toISOString());\n      }\n''',
)
insert_before(
    "apps/local-server/lib/workstations.mjs",
    '''  async function persistRecoveryResult(deviceId, runId, operation, request, value, scannedAt) {\n''',
    '''  async function persistSourceScan(deviceId, runId, value, scannedAt) {\n    await db.prepare(`\n      INSERT INTO workstation_source_scans(device_id,source_run_id,scanned_at,drives_json,tree_json,truncated) VALUES(?,?,?,?,?,?)\n      ON CONFLICT(device_id) DO UPDATE SET source_run_id=excluded.source_run_id,scanned_at=excluded.scanned_at,\n        drives_json=excluded.drives_json,tree_json=excluded.tree_json,truncated=excluded.truncated\n    `).bind(deviceId, runId, scannedAt, JSON.stringify(value.drives), JSON.stringify(value.nodes), value.truncated ? 1 : 0).run();\n  }\n\n''',
)
replace_once(
    "apps/local-server/lib/workstations.mjs",
    '''  return {\n    list, getPolicy, putPolicy, runNow, runDue, queueRecovery, getRecoveryInventory, getRecoveryBrowse, getRun, getLatestCheck,\n    poll, progress, finish, reportStatus, recoverExpired,\n  };\n''',
    '''  return {\n    list, getPolicy, putPolicy, runNow, runDue, queueSourceScan, getSourceScan, queueRecovery, getRecoveryInventory, getRecoveryBrowse, getRun, getLatestCheck,\n    poll, progress, finish, reportStatus, recoverExpired,\n  };\n''',
)
replace_once(
    "apps/local-server/lib/workstations.mjs",
    '''    lastError: optionalString(value.lastError, "lastError", 4000),\n  };\n}\n''',
    '''    lastError: optionalString(value.lastError, "lastError", 4000),\n    localDrives: normalizeReportedDrives(value.localDrives),\n  };\n}\n''',
)
replace_once(
    "apps/local-server/lib/workstations.mjs",
    '''      INSERT INTO workstation_status(device_id,repository_configured,repository_kind,agent_state,current_run_id,last_backup_at,last_success_at,last_snapshot_id,last_error,updated_at)\n      VALUES(?,?,?,?,?,?,?,?,?,?)\n      ON CONFLICT(device_id) DO UPDATE SET repository_configured=excluded.repository_configured,repository_kind=excluded.repository_kind,\n        agent_state=excluded.agent_state,current_run_id=excluded.current_run_id,last_backup_at=COALESCE(excluded.last_backup_at,workstation_status.last_backup_at),\n        last_success_at=COALESCE(excluded.last_success_at,workstation_status.last_success_at),\n        last_snapshot_id=COALESCE(excluded.last_snapshot_id,workstation_status.last_snapshot_id),last_error=excluded.last_error,updated_at=excluded.updated_at\n    `).bind(\n      device.id,\n      status.repositoryConfigured ? 1 : 0,\n      status.repositoryKind,\n      status.agentState,\n      status.currentRunId,\n      status.lastBackupAt,\n      status.lastSuccessAt,\n      status.lastSnapshotId,\n      status.lastError,\n      at,\n    ).run();\n''',
    '''      INSERT INTO workstation_status(device_id,repository_configured,repository_kind,agent_state,current_run_id,last_backup_at,last_success_at,last_snapshot_id,last_error,local_drives_json,updated_at)\n      VALUES(?,?,?,?,?,?,?,?,?,?,?)\n      ON CONFLICT(device_id) DO UPDATE SET repository_configured=excluded.repository_configured,repository_kind=excluded.repository_kind,\n        agent_state=excluded.agent_state,current_run_id=excluded.current_run_id,last_backup_at=COALESCE(excluded.last_backup_at,workstation_status.last_backup_at),\n        last_success_at=COALESCE(excluded.last_success_at,workstation_status.last_success_at),\n        last_snapshot_id=COALESCE(excluded.last_snapshot_id,workstation_status.last_snapshot_id),last_error=excluded.last_error,\n        local_drives_json=excluded.local_drives_json,updated_at=excluded.updated_at\n    `).bind(\n      device.id,\n      status.repositoryConfigured ? 1 : 0,\n      status.repositoryKind,\n      status.agentState,\n      status.currentRunId,\n      status.lastBackupAt,\n      status.lastSuccessAt,\n      status.lastSnapshotId,\n      status.lastError,\n      JSON.stringify(status.localDrives),\n      at,\n    ).run();\n''',
)
replace_once(
    "apps/local-server/lib/workstations.mjs",
    '''        s.repository_configured,s.repository_kind,s.agent_state,s.current_run_id,s.last_backup_at,s.last_success_at,\n        s.last_snapshot_id,s.last_error AS status_error,s.updated_at AS status_updated_at,\n''',
    '''        s.repository_configured,s.repository_kind,s.agent_state,s.current_run_id,s.last_backup_at,s.last_success_at,\n        s.last_snapshot_id,s.last_error AS status_error,s.local_drives_json,s.updated_at AS status_updated_at,\n''',
)
replace_once(
    "apps/local-server/lib/workstations.mjs",
    '''      lastError: nullableString(row.status_error), updatedAt: nullableString(row.status_updated_at),\n''',
    '''      lastError: nullableString(row.status_error), localDrives: parseArray(row.local_drives_json), updatedAt: nullableString(row.status_updated_at),\n''',
)
replace_once(
    "apps/local-server/lib/workstations.mjs",
    '''  const max = operation === "backup" ? 64 * 1024 : 900 * 1024;\n''',
    '''  const max = operation === "backup" ? 64 * 1024 : operation === "source-scan" ? 15 * 1024 * 1024 : 900 * 1024;\n''',
)
replace_once(
    "apps/local-server/lib/workstations.mjs",
    '''  if (value.operation !== operation) throw new RangeError("recovery result operation does not match the leased run");\n  if (state === "failed" && (operation === "check" || operation === "inventory" || operation === "browse")) {\n''',
    '''  if (value.operation !== operation) throw new RangeError("workstation result operation does not match the leased run");\n  if (state === "failed" && (operation === "source-scan" || operation === "check" || operation === "inventory" || operation === "browse")) {\n''',
)
insert_before(
    "apps/local-server/lib/workstations.mjs",
    '''  if (operation === "check") {\n''',
    '''  if (operation === "source-scan") {\n    const drives = normalizeSourceDrives(value.drives);\n    if (JSON.stringify(drives) !== JSON.stringify(normalizeSourceDrives(request.drives))) throw new RangeError("source scan result does not match requested drives");\n    if (!Array.isArray(value.nodes) || value.nodes.length > 75000) throw new RangeError("source scan result has too many directories");\n    return { operation, drives, nodes: value.nodes.map(normalizeSourceScanNode), truncated: value.truncated === true };\n  }\n''',
)
insert_before(
    "apps/local-server/lib/workstations.mjs",
    '''function normalizeSnapshotId(value) {\n''',
    '''function normalizeSourceDrives(value) {\n  if (!Array.isArray(value) || value.length < 1 || value.length > 26) throw new RangeError("drives must contain 1-26 drive roots");\n  const result=[];const seen=new Set();\n  for (const item of value) {\n    const drive=requireRawString(item,"drive",3,3).replace("/","\\\\").toUpperCase();\n    if (!/^[A-Z]:\\\\$/.test(drive)) throw new RangeError("drives must be Windows drive roots such as C:\\\\\");\n    if (!seen.has(drive)) { seen.add(drive); result.push(drive); }\n  }\n  return result;\n}\nfunction normalizeReportedDrives(value) {\n  if (value === undefined || value === null) return [];\n  return normalizeSourceDrives(value);\n}\nfunction normalizeSourceScanNode(value) {\n  if (!isRecord(value)) throw new RangeError("source scan node is invalid");\n  const path=requireRawString(value.path,"source path",3,1024);\n  const parent=value.parent ? requireRawString(value.parent,"source parent",3,1024) : "";\n  const name=requireRawString(value.name,"source name",1,255);\n  return {\n    path,parent,name,bytes:optionalNonNegativeInteger(value.bytes,"source bytes")??0,\n    files:optionalNonNegativeInteger(value.files,"source files")??0,\n    directories:optionalNonNegativeInteger(value.directories,"source directories")??0,\n    inaccessible:value.inaccessible===true,\n  };\n}\n\n''',
)

# ---------------------------------------------------------------------------
# Agent: source scan capability, local drive inventory and run-once scan.
# ---------------------------------------------------------------------------
replace_once(
    "apps/workstation-agent/client.go",
    '''type workstationStatus struct {\n\tRepositoryConfigured bool   `json:"repositoryConfigured"`\n\tRepositoryKind       string `json:"repositoryKind,omitempty"`\n\tAgentState           string `json:"agentState"`\n''',
    '''type workstationStatus struct {\n\tRepositoryConfigured bool     `json:"repositoryConfigured"`\n\tRepositoryKind       string   `json:"repositoryKind,omitempty"`\n\tAgentState           string   `json:"agentState"`\n\tLocalDrives          []string `json:"localDrives,omitempty"`\n''',
)
replace_once(
    "apps/workstation-agent/client.go",
    '''type recoveryRequest struct {\n\tSnapshotID string `json:"snapshotId,omitempty"`\n\tPath       string `json:"path,omitempty"`\n}\n''',
    '''type recoveryRequest struct {\n\tSnapshotID string   `json:"snapshotId,omitempty"`\n\tPath       string   `json:"path,omitempty"`\n\tDrives     []string `json:"drives,omitempty"`\n}\n''',
)
replace_once(
    "apps/workstation-agent/main.go",
    '''\tresponse, err := a.client.reportDevice(deviceReport{\n\t\tVersion:      version,\n\t\tHostname:     hostname,\n\t\tPlatform:     runtime.GOOS + "/" + runtime.GOARCH,\n\t\tCapabilities: []string{"workstation.backup.v1", "workstation.recovery.v1", "workstation.restore-staging.v1", "workstation.integrity.v1", "restic.v1", "windows-vss.v1"},\n\t})\n''',
    '''\tcapabilities := []string{"workstation.backup.v1", "workstation.recovery.v1", "workstation.restore-staging.v1", "workstation.integrity.v1", "restic.v1", "windows-vss.v1"}\n\tif runtime.GOOS == "windows" { capabilities = append(capabilities, "workstation.source-scan.v1") }\n\tresponse, err := a.client.reportDevice(deviceReport{\n\t\tVersion:      version,\n\t\tHostname:     hostname,\n\t\tPlatform:     runtime.GOOS + "/" + runtime.GOARCH,\n\t\tCapabilities: capabilities,\n\t})\n''',
)
replace_once(
    "apps/workstation-agent/main.go",
    '''\tstatus := workstationStatus{\n\t\tRepositoryConfigured: a.repositoryReady(),\n\t\tRepositoryKind:       repositoryKind(a.cfg.Repository),\n\t\tAgentState:           "idle",\n''',
    '''\tstatus := workstationStatus{\n\t\tRepositoryConfigured: a.repositoryReady(),\n\t\tRepositoryKind:       repositoryKind(a.cfg.Repository),\n\t\tAgentState:           "idle",\n\t\tLocalDrives:          availableDriveRoots(),\n''',
)
replace_once(
    "apps/workstation-agent/main.go",
    '''func (a *agent) pollOnce() error {\n\tif !a.repositoryReady() {\n\t\treturn nil\n\t}\n\ta.mu.Lock()\n''',
    '''func (a *agent) pollOnce() error {\n\ta.mu.Lock()\n''',
)
insert_before(
    "apps/workstation-agent/recovery_execute.go",
    '''\tcase "check":\n''',
    '''\tcase "source-scan":\n\t\tresult, err := scanSourceTree(ctx, run.Request.Drives)\n\t\tif err != nil { return map[string]any{"operation": operation, "drives": run.Request.Drives}, err }\n\t\tnodes := make([]map[string]any, 0, len(result.Nodes))\n\t\tfor _, node := range result.Nodes {\n\t\t\tnodes = append(nodes, map[string]any{\n\t\t\t\t"path": node.Path, "parent": node.Parent, "name": node.Name, "bytes": node.Bytes,\n\t\t\t\t"files": node.Files, "directories": node.Directories, "inaccessible": node.Inaccessible,\n\t\t\t})\n\t\t}\n\t\treturn map[string]any{"operation": operation, "drives": result.Drives, "nodes": nodes, "truncated": result.Truncated}, nil\n\n''',
)

Path("apps/workstation-agent/source_scan.go").write_text(r'''package main

import (
    "context"
    "errors"
    "os"
    "path/filepath"
    "runtime"
    "sort"
    "strings"
)

const maxSourceScanNodes = 75000

type sourceScanNode struct {
    Path         string
    Parent       string
    Name         string
    Bytes        int64
    Files        int64
    Directories  int64
    Inaccessible bool
}

type sourceScanResult struct {
    Drives    []string
    Nodes     []sourceScanNode
    Truncated bool
}

// availableDriveRoots is intentionally lightweight. It only discovers roots;
// the expensive recursive sizing happens exclusively when the user starts a
// source scan from Nexus.
func availableDriveRoots() []string {
    if runtime.GOOS != "windows" {
        return nil
    }
    roots := make([]string, 0, 8)
    for letter := 'A'; letter <= 'Z'; letter++ {
        root := string(letter) + `:\`
        info, err := os.Stat(root)
        if err == nil && info.IsDir() {
            roots = append(roots, root)
        }
    }
    return roots
}

func scanSourceTree(ctx context.Context, roots []string) (sourceScanResult, error) {
    if len(roots) == 0 {
        return sourceScanResult{}, errors.New("source scan requires at least one drive")
    }
    normalized := make([]string, 0, len(roots))
    seen := map[string]bool{}
    for _, raw := range roots {
        root := filepath.Clean(strings.TrimSpace(raw))
        if root == "." || root == "" || !filepath.IsAbs(root) {
            return sourceScanResult{}, errors.New("source scan roots must be absolute")
        }
        key := strings.ToLower(root)
        if !seen[key] {
            seen[key] = true
            normalized = append(normalized, root)
        }
    }
    sort.Strings(normalized)
    result := sourceScanResult{Drives: normalized, Nodes: make([]sourceScanNode, 0, 4096)}
    for _, root := range normalized {
        if err := ctx.Err(); err != nil { return result, err }
        if len(result.Nodes) >= maxSourceScanNodes { result.Truncated = true; break }
        scanSourceDirectory(ctx, root, "", &result)
    }
    return result, nil
}

func scanSourceDirectory(ctx context.Context, path, parent string, result *sourceScanResult) sourceScanNode {
    node := sourceScanNode{Path: path, Parent: parent, Name: sourceNodeName(path)}
    if err := ctx.Err(); err != nil { node.Inaccessible = true; return node }
    if len(result.Nodes) >= maxSourceScanNodes { result.Truncated = true; return node }

    entries, err := os.ReadDir(path)
    if err != nil {
        node.Inaccessible = true
        result.Nodes = append(result.Nodes, node)
        return node
    }
    for _, entry := range entries {
        if err := ctx.Err(); err != nil { node.Inaccessible = true; break }
        if entry.Type()&os.ModeSymlink != 0 { continue } // never follow junction/symlink trees
        childPath := filepath.Join(path, entry.Name())
        if entry.IsDir() {
            if len(result.Nodes) >= maxSourceScanNodes { result.Truncated = true; break }
            child := scanSourceDirectory(ctx, childPath, path, result)
            node.Bytes += child.Bytes
            node.Files += child.Files
            node.Directories += 1 + child.Directories
            continue
        }
        info, infoErr := entry.Info()
        if infoErr != nil || !info.Mode().IsRegular() { continue }
        node.Files++
        if info.Size() > 0 { node.Bytes += info.Size() }
    }
    result.Nodes = append(result.Nodes, node)
    return node
}

func sourceNodeName(path string) string {
    cleaned := filepath.Clean(path)
    base := filepath.Base(cleaned)
    if base == "." || base == string(filepath.Separator) || base == "\\" { return cleaned }
    return base
}
''', encoding="utf-8")

Path("apps/workstation-agent/source_scan_test.go").write_text(r'''package main

import (
    "context"
    "os"
    "path/filepath"
    "testing"
)

func TestScanSourceTreeCachesRecursiveDirectorySizes(t *testing.T) {
    root := t.TempDir()
    nested := filepath.Join(root, "docs", "nested")
    if err := os.MkdirAll(nested, 0o755); err != nil { t.Fatal(err) }
    if err := os.WriteFile(filepath.Join(root, "root.bin"), []byte("1234"), 0o644); err != nil { t.Fatal(err) }
    if err := os.WriteFile(filepath.Join(nested, "file.bin"), []byte("123456"), 0o644); err != nil { t.Fatal(err) }

    result, err := scanSourceTree(context.Background(), []string{root})
    if err != nil { t.Fatal(err) }
    if result.Truncated { t.Fatal("small fixture should not truncate") }
    var rootNode *sourceScanNode
    for i := range result.Nodes {
        if result.Nodes[i].Path == filepath.Clean(root) { rootNode = &result.Nodes[i]; break }
    }
    if rootNode == nil { t.Fatal("root node not found") }
    if rootNode.Bytes != 10 { t.Fatalf("bytes=%d want 10", rootNode.Bytes) }
    if rootNode.Files != 2 { t.Fatalf("files=%d want 2", rootNode.Files) }
    if rootNode.Directories != 2 { t.Fatalf("directories=%d want 2", rootNode.Directories) }
}
''', encoding="utf-8")

# ---------------------------------------------------------------------------
# Dashboard: persistent TreeSize snapshot picker, no live scanning on expand.
# ---------------------------------------------------------------------------
replace_once(
    "apps/local-server/web/session.js",
    '''<div class="transfer-head"><div class="transfer-title"><span class="transfer-state${ws.online?"":" paused"}"></span><div><h2>${esc(ws.name)}</h2><span>${esc(ws.hostname||ws.id)} · ${esc(ws.version||"not installed yet")}</span></div></div><div class="transfer-actions"><span class="badge ${stateTone}">${state}</span><button class="button ghost compact" data-ws-action="policy" data-id="${attr(ws.id)}">Policy</button><button class="button primary compact" data-ws-action="run" data-id="${attr(ws.id)}" ${!ws.online||!status.repositoryConfigured||!ws.policy?"disabled":""}>Run now</button></div></div>''',
    '''<div class="transfer-head"><div class="transfer-title"><span class="transfer-state${ws.online?"":" paused"}"></span><div><h2>${esc(ws.name)}</h2><span>${esc(ws.hostname||ws.id)} · ${esc(ws.version||"not installed yet")}</span></div></div><div class="transfer-actions"><span class="badge ${stateTone}">${state}</span><button class="button ghost compact" data-ws-action="sources" data-id="${attr(ws.id)}">Sources</button><button class="button ghost compact" data-ws-action="policy" data-id="${attr(ws.id)}">Policy</button><button class="button primary compact" data-ws-action="run" data-id="${attr(ws.id)}" ${!ws.online||!status.repositoryConfigured||!ws.policy?"disabled":""}>Run now</button></div></div>''',
)
replace_once(
    "apps/local-server/web/session.js",
    '''      if(button.dataset.wsAction==="policy"){openPolicy(ws);return;}\n      if(button.dataset.wsAction==="run"){\n''',
    '''      if(button.dataset.wsAction==="sources"){void openSources(ws);return;}\n      if(button.dataset.wsAction==="policy"){openPolicy(ws);return;}\n      if(button.dataset.wsAction==="run"){\n''',
)
insert_before(
    "apps/local-server/web/session.js",
    '''  function openPolicy(ws){\n''',
    r'''  async function openSources(ws){
    closeModal();
    const supported=ws.capabilities?.includes("workstation.source-scan.v1");
    const drives=ws.status?.localDrives??[];
    const selected=new Set(ws.policy?.sourcePaths??[]);
    modal=document.createElement("div");modal.className="modal-backdrop";
    modal.innerHTML=`<section class="modal ws-policy-modal" role="dialog" aria-modal="true"><div class="modal-header"><div><p class="eyebrow">${esc(ws.name)}</p><h2>Backup sources</h2></div><button class="icon-button" data-ws-close>×</button></div>
      <p class="muted-2">Run TreeSize once for the drives you want to inspect. Nexus stores that scan, and folder selection below only reads the saved snapshot — expanding folders never scans the PC again.</p>
      <div class="ws-source-scan-controls"><div><strong>Drives</strong><div data-source-drives>${drives.map(d=>`<label><input type="checkbox" value="${attr(d)}" checked> ${esc(d)}</label>`).join("")||'<span class="muted-2">No local drives reported yet.</span>'}</div></div><button class="button ghost" data-source-scan ${!supported||!ws.online||!drives.length?"disabled":""}>Run TreeSize scan</button></div>
      <div class="transfer-note" data-source-status>${!supported?"Update the workstation agent to enable source scanning.":"Loading latest saved scan…"}</div>
      <div class="ws-source-tree" data-source-tree></div>
      <div class="modal-actions"><button type="button" class="button ghost" data-ws-close>Cancel</button><button type="button" class="button primary" data-source-save ${!supported?"disabled":""}>Save selected folders</button></div></section>`;
    document.body.append(modal);modal.querySelectorAll("[data-ws-close]").forEach(button=>button.addEventListener("click",closeModal));
    const statusEl=modal.querySelector("[data-source-status]");const treeEl=modal.querySelector("[data-source-tree]");

    async function loadScan(){
      const data=await request(`/v1/local/workstations/${encodeURIComponent(ws.id)}/source-scan`);
      renderSourceScan(data);return data;
    }
    function renderSourceScan(data){
      const scan=data.scan;const run=data.run;
      if(run?.active){statusEl.textContent=`TreeSize ${run.state}… The previous completed scan remains available until this one finishes.`}
      else if(scan){statusEl.textContent=`Last TreeSize scan: ${new Date(scan.scannedAt).toLocaleString()} · ${scan.nodes.length} folders${scan.truncated?" · truncated":""}`}
      else{statusEl.textContent="No saved TreeSize scan yet. Select one or more drives and run the scan once."}
      treeEl.innerHTML="";if(!scan?.nodes?.length)return;
      const children=new Map();
      for(const node of scan.nodes){const key=node.parent||"";if(!children.has(key))children.set(key,[]);children.get(key).push(node)}
      for(const group of children.values())group.sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:"base"}));
      const renderChildren=(parent,host)=>{for(const node of children.get(parent)||[]){
        const row=document.createElement("div");row.className="ws-source-row";
        const hasChildren=(children.get(node.path)||[]).length>0;
        row.innerHTML=`<button type="button" class="icon-button compact" data-source-expand ${hasChildren?"":"disabled"}>${hasChildren?"▸":"·"}</button><label><input type="checkbox" data-source-path value="${attr(node.path)}" ${selected.has(node.path)?"checked":""}> <strong>${esc(node.name)}</strong></label><span>${bytes(node.bytes)} · ${node.files} files${node.inaccessible?" · inaccessible":""}</span>`;
        host.append(row);
        if(hasChildren){const child=document.createElement("div");child.className="ws-source-children";child.hidden=true;host.append(child);row.querySelector("[data-source-expand]").addEventListener("click",event=>{if(!child.dataset.loaded){renderChildren(node.path,child);child.dataset.loaded="1"}child.hidden=!child.hidden;event.currentTarget.textContent=child.hidden?"▸":"▾"})}
      }};
      renderChildren("",treeEl);
    }
    modal.querySelector("[data-source-scan]")?.addEventListener("click",async event=>{
      const selectedDrives=[...modal.querySelectorAll("[data-source-drives] input:checked")].map(input=>input.value);if(!selectedDrives.length){toast("Choose a drive","Select at least one drive to scan.",true);return}
      event.currentTarget.disabled=true;
      try{const queued=await request(`/v1/local/workstations/${encodeURIComponent(ws.id)}/source-scan`,{method:"POST",body:{drives:selectedDrives}});statusEl.textContent="TreeSize scan queued…";
        for(let i=0;i<300;i++){await new Promise(resolve=>setTimeout(resolve,2000));const data=await loadScan();if(data.run?.id===queued.run?.id&&data.run?.terminal)break}
      }catch(error){toast("TreeSize scan failed",error.message,true)}finally{event.currentTarget.disabled=false}
    });
    modal.querySelector("[data-source-save]")?.addEventListener("click",async event=>{
      const paths=compactSourcePaths([...modal.querySelectorAll("[data-source-path]:checked")].map(input=>input.value));
      if(!paths.length){toast("No backup folders selected","Choose at least one folder from the saved scan.",true);return}
      const p=ws.policy??{enabled:false,excludePatterns:[],schedule:{kind:"daily",time:"02:00"},timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC",retention:{keepDaily:7,keepWeekly:4,keepMonthly:12}};
      event.currentTarget.disabled=true;
      try{await request(`/v1/local/workstations/${encodeURIComponent(ws.id)}/policy`,{method:"PUT",body:{enabled:p.enabled===true,sourcePaths:paths,excludePatterns:p.excludePatterns??[],schedule:p.schedule??{kind:"daily",time:"02:00"},timezone:p.timezone??"UTC",retention:p.retention??{keepDaily:7,keepWeekly:4,keepMonthly:12}}});closeModal();toast("Backup sources saved",`${ws.name}: ${paths.length} source path(s)`);await refresh(true)}
      catch(error){toast("Could not save backup sources",error.message,true);event.currentTarget.disabled=false}
    });
    try{await loadScan()}catch(error){statusEl.textContent=error.message}
  }

  function compactSourcePaths(paths){const sorted=[...new Set(paths)].sort((a,b)=>a.length-b.length||a.localeCompare(b));const kept=[];for(const path of sorted){const lower=path.toLowerCase();if(kept.some(parent=>lower===parent.toLowerCase()||lower.startsWith(parent.toLowerCase().replace(/\\+$/,"")+"\\")))continue;kept.push(path)}return kept}

''',
)
# Add source picker styling to the workstation style block.
replace_once(
    "apps/local-server/web/session.js",
    '''    .workstation-grid{display:grid;gap:16px}.workstation-card{overflow:hidden}.ws-progress{padding:0 18px 16px}''',
    '''    .workstation-grid{display:grid;gap:16px}.workstation-card{overflow:hidden}.ws-source-scan-controls{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;margin:14px 0}.ws-source-scan-controls [data-source-drives]{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px}.ws-source-tree{max-height:52vh;overflow:auto;border:1px solid var(--border,#2b3442);border-radius:10px;margin:14px 0}.ws-source-row{display:grid;grid-template-columns:32px minmax(220px,1fr) auto;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--border,#2b3442)}.ws-source-row>span{color:var(--muted,#9aa5b5);font-size:12px}.ws-source-children{padding-left:22px}.ws-progress{padding:0 18px 16px}''',
)

# Devices UI: disabled PCWatch/generic devices can be permanently deleted.
replace_once(
    "apps/local-server/web/index.html",
    '''<button class="button ghost compact" data-device-action="rotate" data-id="${deviceAttr(device.id)}">Rotate token</button><button class="button ghost compact" data-device-action="toggle" data-id="${deviceAttr(device.id)}">${device.enabled?"Disable":"Enable"}</button>''',
    '''<button class="button ghost compact" data-device-action="rotate" data-id="${deviceAttr(device.id)}">Rotate token</button><button class="button ghost compact" data-device-action="toggle" data-id="${deviceAttr(device.id)}">${device.enabled?"Disable":"Enable"}</button>${!device.enabled&&device.kind!=="workstation"?`<button class="button ghost compact" data-device-action="delete" data-id="${deviceAttr(device.id)}">Delete device</button>`:""}''',
)
replace_once(
    "apps/local-server/web/index.html",
    '''          }else if(button.dataset.deviceAction==="rotate"){\n            const result=await deviceApi(`/v1/local/devices/${encodeURIComponent(device.id)}/rotate-token`,{method:"POST",body:{}});\n            showDeviceToken(result.device,result.token,true);\n          }\n''',
    '''          }else if(button.dataset.deviceAction==="rotate"){\n            const result=await deviceApi(`/v1/local/devices/${encodeURIComponent(device.id)}/rotate-token`,{method:"POST",body:{}});\n            showDeviceToken(result.device,result.token,true);\n          }else if(button.dataset.deviceAction==="delete"){\n            if(!confirm(`Permanently delete ${device.name}? This cannot be undone.`))return;\n            await deviceApi(`/v1/local/devices/${encodeURIComponent(device.id)}`,{method:"DELETE"});\n            deviceToast("Device deleted",device.name);\n          }\n''',
)

# ---------------------------------------------------------------------------
# Tests.
# ---------------------------------------------------------------------------
insert_before(
    "apps/local-server/test/managed-devices.test.mjs",
    '''test("device reports reject oversized and malformed metadata",()=>{\n''',
    '''test("disabled non-workstation devices can be permanently deleted",async()=>{\n  const f=await fixture();\n  try{\n    const created=await f.service.create({name:"Old PCWatch",kind:"pcwatch"});\n    await assert.rejects(()=>f.service.remove(created.device.id),/Disable.*before deleting/i);\n    await f.service.update(created.device.id,{enabled:false});\n    const deleted=await f.service.remove(created.device.id);\n    assert.deepEqual(deleted,{deleted:true,id:created.device.id});\n    assert.equal((await f.service.list()).length,0);\n    await assert.rejects(()=>f.service.authenticate(created.token),/Invalid/i);\n  }finally{await f.close();}\n});\n\ntest("managed-device delete refuses workstation rows",async()=>{\n  const f=await fixture();\n  try{\n    const created=await f.service.create({name:"Workstation",kind:"workstation"});\n    await f.service.update(created.device.id,{enabled:false});\n    await assert.rejects(()=>f.service.remove(created.device.id),/Workstations page/i);\n  }finally{await f.close();}\n});\n\n''',
)
# Workstation fixture advertises source scan for source-scan tests.
replace_once(
    "apps/local-server/test/workstations.test.mjs",
    '''  const bootstrap=await devices.report(created.token,{version:"installer",hostname:"balder-pc",platform:"windows/amd64",capabilities:["workstation.bootstrap.v1"]});\n''',
    '''  const bootstrap=await devices.report(created.token,{version:"installer",hostname:"balder-pc",platform:"windows/amd64",capabilities:["workstation.bootstrap.v1","workstation.source-scan.v1"]});\n''',
)
insert_before(
    "apps/local-server/test/workstations.test.mjs",
    '''test("install command is a direct irm enrollment command",()=>{\n''',
    '''test("source scan runs without repository setup and persists the latest tree",async()=>{\n  const f=await fixture();\n  try{\n    await f.service.reportStatus(f.token,{repositoryConfigured:false,agentState:"needs-storage",localDrives:["C:\\\\","D:\\\\"]});\n    const queued=await f.service.queueSourceScan(f.device.id,{drives:["C:\\\\"]});\n    const leased=await f.service.poll(f.token);\n    assert.equal(leased.run.id,queued.id);\n    assert.equal(leased.run.operation,"source-scan");\n    assert.deepEqual(leased.run.request.drives,["C:\\\\"]);\n    await f.service.finish(f.token,queued.id,{leaseToken:leased.run.leaseToken,status:"success",result:{operation:"source-scan",drives:["C:\\\\"],nodes:[{path:"C:\\\\",parent:"",name:"C:\\\\",bytes:123,files:2,directories:1},{path:"C:\\\\Users",parent:"C:\\\\",name:"Users",bytes:100,files:1,directories:0}],truncated:false}});\n    const cached=await f.service.getSourceScan(f.device.id);\n    assert.equal(cached.scan.nodes.length,2);\n    assert.equal(cached.scan.nodes[1].path,"C:\\\\Users");\n    const listed=(await f.service.list())[0];\n    assert.deepEqual(listed.status.localDrives,["C:\\\\","D:\\\\"]);\n  }finally{await f.close();}\n});\n\n''',
)

# Migration: add source-scan operation/cache and lightweight drive inventory.
Path("migrations/0016_workstation_source_scan.sql").write_text(r'''-- Run-once workstation TreeSize snapshots for standalone source selection.
-- Rebuild workstation_runs because SQLite cannot alter the operation CHECK in place.

CREATE TABLE workstation_snapshot_inventory_0016 AS
  SELECT device_id,source_run_id,scanned_at,snapshots_json FROM workstation_snapshot_inventory;
CREATE TABLE workstation_snapshot_browse_0016 AS
  SELECT device_id,snapshot_id,browse_path,source_run_id,scanned_at,entries_json,entry_limit,truncated FROM workstation_snapshot_browse;
DROP TABLE workstation_snapshot_browse;
DROP TABLE workstation_snapshot_inventory;

CREATE TABLE workstation_runs_0016 (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES managed_devices(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('queued','leased','running','completed','partial','failed','cancelled')),
  lease_token TEXT,
  lease_expires_at TEXT,
  scheduled_for TEXT,
  source_paths_json TEXT NOT NULL,
  exclude_patterns_json TEXT NOT NULL DEFAULT '[]',
  retention_json TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  leased_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  progress_json TEXT,
  result_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'backup'
    CHECK (operation IN ('backup','source-scan','check','inventory','browse','restore-preview','restore')),
  request_json TEXT
);
INSERT INTO workstation_runs_0016 (
  id,device_id,operation_key,state,lease_token,lease_expires_at,scheduled_for,source_paths_json,exclude_patterns_json,
  retention_json,queued_at,leased_at,started_at,finished_at,progress_json,result_json,error_message,created_at,updated_at,operation,request_json
)
SELECT
  id,device_id,operation_key,state,lease_token,lease_expires_at,scheduled_for,source_paths_json,exclude_patterns_json,
  retention_json,queued_at,leased_at,started_at,finished_at,progress_json,result_json,error_message,created_at,updated_at,operation,request_json
FROM workstation_runs;
DROP TABLE workstation_runs;
ALTER TABLE workstation_runs_0016 RENAME TO workstation_runs;
CREATE INDEX idx_workstation_runs_device_state ON workstation_runs(device_id,state,queued_at);
CREATE INDEX idx_workstation_runs_lease ON workstation_runs(state,lease_expires_at);
CREATE UNIQUE INDEX idx_workstation_runs_one_active_per_device ON workstation_runs(device_id) WHERE state IN ('queued','leased','running');
CREATE INDEX idx_workstation_runs_device_operation ON workstation_runs(device_id,operation,state,queued_at);

CREATE TABLE workstation_snapshot_inventory (
  device_id TEXT PRIMARY KEY REFERENCES managed_devices(id) ON DELETE CASCADE,
  source_run_id TEXT REFERENCES workstation_runs(id) ON DELETE SET NULL,
  scanned_at TEXT NOT NULL,
  snapshots_json TEXT NOT NULL
);
INSERT INTO workstation_snapshot_inventory(device_id,source_run_id,scanned_at,snapshots_json)
SELECT device_id,source_run_id,scanned_at,snapshots_json FROM workstation_snapshot_inventory_0016;
CREATE TABLE workstation_snapshot_browse (
  device_id TEXT NOT NULL REFERENCES managed_devices(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  browse_path TEXT NOT NULL,
  source_run_id TEXT REFERENCES workstation_runs(id) ON DELETE SET NULL,
  scanned_at TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  entry_limit INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  PRIMARY KEY(device_id,snapshot_id,browse_path)
);
INSERT INTO workstation_snapshot_browse(device_id,snapshot_id,browse_path,source_run_id,scanned_at,entries_json,entry_limit,truncated)
SELECT device_id,snapshot_id,browse_path,source_run_id,scanned_at,entries_json,entry_limit,truncated FROM workstation_snapshot_browse_0016;
CREATE INDEX idx_workstation_snapshot_browse_scan ON workstation_snapshot_browse(device_id,scanned_at DESC);
DROP TABLE workstation_snapshot_browse_0016;
DROP TABLE workstation_snapshot_inventory_0016;

ALTER TABLE workstation_status ADD COLUMN local_drives_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE workstation_source_scans (
  device_id TEXT PRIMARY KEY REFERENCES managed_devices(id) ON DELETE CASCADE,
  source_run_id TEXT REFERENCES workstation_runs(id) ON DELETE SET NULL,
  scanned_at TEXT NOT NULL,
  drives_json TEXT NOT NULL,
  tree_json TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1))
);
''', encoding="utf-8")

print("source scan + device delete edits applied")
