package main

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestScanSourceTreeCachesRecursiveDirectorySizes(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "docs", "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "root.bin"), []byte("1234"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "file.bin"), []byte("123456"), 0o644); err != nil {
		t.Fatal(err)
	}

	var latest sourceScanProgress
	result, err := scanSourceTree(context.Background(), []string{root}, func(progress sourceScanProgress) error {
		latest = progress
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Truncated {
		t.Fatal("small fixture should not truncate")
	}
	var rootNode *sourceScanNode
	for i := range result.Nodes {
		if result.Nodes[i].Path == filepath.Clean(root) {
			rootNode = &result.Nodes[i]
			break
		}
	}
	if rootNode == nil {
		t.Fatal("root node not found")
	}
	if rootNode.Bytes != 10 {
		t.Fatalf("bytes=%d want 10", rootNode.Bytes)
	}
	if rootNode.Files != 2 {
		t.Fatalf("files=%d want 2", rootNode.Files)
	}
	if rootNode.Directories != 2 {
		t.Fatalf("directories=%d want 2", rootNode.Directories)
	}
	if latest.Files != 2 {
		t.Fatalf("progress files=%d want 2", latest.Files)
	}
	if latest.Bytes != 10 {
		t.Fatalf("progress bytes=%d want 10", latest.Bytes)
	}
	if latest.Directories != 3 {
		t.Fatalf("progress directories=%d want 3", latest.Directories)
	}
}

// A truncated scan must still let the browser walk down from the drive root:
// scanDirectory appends nodes depth-first, so if the root's own node were only
// recorded after all its children were, a truncation deep inside would drop
// the root (and every ancestor down to the cutoff) from the result entirely.
func TestScanSourceTreeKeepsRootNodeWhenTruncatedDeepInside(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 5; i++ {
		nested := filepath.Join(root, "a", strconv.Itoa(i))
		if err := os.MkdirAll(nested, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(nested, "file.bin"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	original := maxSourceScanNodes
	maxSourceScanNodes = 2
	defer func() { maxSourceScanNodes = original }()

	result, err := scanSourceTree(context.Background(), []string{root}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Truncated {
		t.Fatal("scan should report truncation once the node budget is hit")
	}

	var rootNode *sourceScanNode
	for i := range result.Nodes {
		if result.Nodes[i].Path == filepath.Clean(root) {
			rootNode = &result.Nodes[i]
			break
		}
	}
	if rootNode == nil {
		t.Fatal("root node was dropped by truncation; the file browser would have no top of the tree to render")
	}
	if rootNode.Parent != "" {
		t.Fatalf("root node parent=%q want empty", rootNode.Parent)
	}
}
