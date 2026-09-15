from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"expected snippet not found in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")

# Preserve legacy/unknown status behavior. Only gate ordinary work when the
# workstation has explicitly reported that repository storage is not ready.
replace_once(
    "apps/local-server/lib/workstations.mjs",
    '''    const status = await db.prepare("SELECT repository_configured FROM workstation_status WHERE device_id=?").bind(device.id).first();
    const repositoryReady = Number(status?.repository_configured ?? 0) === 1;
    const row = repositoryReady
      ? await db.prepare(`SELECT * FROM workstation_runs WHERE device_id=? AND state='queued' ORDER BY queued_at ASC,id ASC LIMIT 1`).bind(device.id).first()
      : await db.prepare(`SELECT * FROM workstation_runs WHERE device_id=? AND state='queued' AND operation='source-scan' ORDER BY queued_at ASC,id ASC LIMIT 1`).bind(device.id).first();
''',
    '''    const status = await db.prepare("SELECT repository_configured FROM workstation_status WHERE device_id=?").bind(device.id).first();
    const repositoryKnownMissing = status !== null && status !== undefined && Number(status.repository_configured) !== 1;
    const row = repositoryKnownMissing
      ? await db.prepare(`SELECT * FROM workstation_runs WHERE device_id=? AND state='queued' AND operation='source-scan' ORDER BY queued_at ASC,id ASC LIMIT 1`).bind(device.id).first()
      : await db.prepare(`SELECT * FROM workstation_runs WHERE device_id=? AND state='queued' ORDER BY queued_at ASC,id ASC LIMIT 1`).bind(device.id).first();
''',
)

# Canonicalize drive ordering so the Windows scanner's sorted result always
# matches the request even if the user selected drives in a different order.
replace_once(
    "apps/local-server/lib/workstations.mjs",
    '''  return result;
}
function normalizeReportedDrives(value) {
''',
    '''  return result.sort();
}
function normalizeReportedDrives(value) {
''',
)

# Bound source-scan payload size before it ever reaches the HTTP result limit.
p = Path("apps/workstation-agent/source_scan.go")
text = p.read_text(encoding="utf-8")
text = text.replace(
    '''const maxSourceScanNodes = 75000
''',
    '''const (
    maxSourceScanNodes       = 75000
    maxSourceScanApproxBytes = 10 * 1024 * 1024
)
''',
    1,
)
text = text.replace(
    '''type sourceScanResult struct {
    Drives    []string
    Nodes     []sourceScanNode
    Truncated bool
}
''',
    '''type sourceScanResult struct {
    Drives      []string
    Nodes       []sourceScanNode
    Truncated   bool
    approxBytes int
}
''',
    1,
)
text = text.replace(
    '''func scanSourceDirectory(ctx context.Context, path, parent string, result *sourceScanResult) sourceScanNode {
    node := sourceScanNode{Path: path, Parent: parent, Name: sourceNodeName(path)}
    if err := ctx.Err(); err != nil { node.Inaccessible = true; return node }
    if len(result.Nodes) >= maxSourceScanNodes { result.Truncated = true; return node }
''',
    '''func scanSourceDirectory(ctx context.Context, path, parent string, result *sourceScanResult) sourceScanNode {
    node := sourceScanNode{Path: path, Parent: parent, Name: sourceNodeName(path)}
    if err := ctx.Err(); err != nil { node.Inaccessible = true; return node }
    estimated := len(node.Path) + len(node.Parent) + len(node.Name) + 160
    if len(result.Nodes) >= maxSourceScanNodes || result.approxBytes+estimated > maxSourceScanApproxBytes {
        result.Truncated = true
        return node
    }
''',
    1,
)
# Account for each persisted node at append sites.
text = text.replace(
    '''        result.Nodes = append(result.Nodes, node)
        return node
''',
    '''        result.Nodes = append(result.Nodes, node)
        result.approxBytes += estimated
        return node
''',
    1,
)
text = text.replace(
    '''    result.Nodes = append(result.Nodes, node)
    return node
}
''',
    '''    if result.approxBytes+estimated <= maxSourceScanApproxBytes && len(result.Nodes) < maxSourceScanNodes {
        result.Nodes = append(result.Nodes, node)
        result.approxBytes += estimated
    } else {
        result.Truncated = true
    }
    return node
}
''',
    1,
)
p.write_text(text, encoding="utf-8")

# Regression: explicit needs-storage status only leases source-scan; absent
# status keeps historic backup polling behavior.
path = Path("apps/local-server/test/workstations.test.mjs")
text = path.read_text(encoding="utf-8")
marker = 'test("source scan runs without repository setup and persists the latest tree",async()=>{\n'
addition = '''test("explicit needs-storage status leaves ordinary backup queued while source scan may run",async()=>{\n  const f=await fixture();\n  try{\n    await f.service.putPolicy(f.device.id,policy);\n    const backup=await f.service.runNow(f.device.id);\n    await f.service.reportStatus(f.token,{repositoryConfigured:false,agentState:"needs-storage",localDrives:["C:\\\\"]});\n    const firstPoll=await f.service.poll(f.token);\n    assert.equal(firstPoll.run,null);\n    // Remove the queued backup only for this fixture so a source scan can own the one-active-run invariant.\n    await f.db.prepare("UPDATE workstation_runs SET state='cancelled',finished_at=updated_at WHERE id=?").bind(backup.id).run();\n    const scan=await f.service.queueSourceScan(f.device.id,{drives:["C:\\\\"]});\n    const secondPoll=await f.service.poll(f.token);\n    assert.equal(secondPoll.run.id,scan.id);\n    assert.equal(secondPoll.run.operation,"source-scan");\n  }finally{await f.close();}\n});\n\n'''
if marker not in text:
    raise SystemExit("source scan test marker not found")
path.write_text(text.replace(marker, addition + marker, 1), encoding="utf-8")

print("source scan CI fixes applied")
