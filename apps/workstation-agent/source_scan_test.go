package main

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
