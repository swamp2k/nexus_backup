from pathlib import Path

root = Path(__file__).resolve().parents[2]
p = root / "apps/workstation-agent/restic.go"
s = p.read_text()
old = '''\tif err == nil {
\t\treturn nil
\t}
\tif !autoInit {
\t\treturn fmt.Errorf("open restic repository: %s", boundedText(output, 4000))
\t}
'''
new = '''\tif err == nil {
\t\treturn nil
\t}
\t// Runtime initialization of a remote repository is permitted only for the
\t// explicit Home-mode empty-password REST profile. Encrypted/Remote targets
\t// retain the old fail-closed behavior on auth/TLS/network errors.
\tif !autoInit || !noPassword {
\t\treturn fmt.Errorf("open restic repository: %s", boundedText(output, 4000))
\t}
'''
if s.count(old) != 1:
    raise SystemExit(f"expected one remote-init gate, found {s.count(old)}")
p.write_text(s.replace(old, new, 1))
