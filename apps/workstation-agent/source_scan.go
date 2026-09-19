package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Production source scans retain every directory, matching PCWatch TreeSize.
// Tests may set this to a positive value to exercise truncation behavior.
var maxSourceScanNodes = 0

const sourceScanProgressEvery = 500 * time.Millisecond

type sourceScanNode struct {
	Path         string `json:"path"`
	Parent       string `json:"parent"`
	Name         string `json:"name"`
	Bytes        int64  `json:"bytes"`
	Files        int64  `json:"files"`
	Directories  int64  `json:"directories"`
	ErrorCount   int64  `json:"error_count,omitempty"`
	Inaccessible bool   `json:"inaccessible,omitempty"`
}

type sourceScanResult struct {
	Drives         []string         `json:"drives"`
	Nodes          []sourceScanNode `json:"nodes"`
	Truncated      bool             `json:"truncated"`
	TotalBytes     int64            `json:"totalBytes"`
	FileCount      int64            `json:"fileCount"`
	DirectoryCount int64            `json:"directoryCount"`
	ErrorCount     int64            `json:"errorCount"`
}

type sourceScanProgress struct {
	Files       int64  `json:"files"`
	Directories int64  `json:"directories"`
	Bytes       int64  `json:"bytes"`
	Errors      int64  `json:"errors"`
	CurrentPath string `json:"currentPath,omitempty"`
}

type sourceScanWalker struct {
	result       *sourceScanResult
	onProgress   func(sourceScanProgress) error
	progress     sourceScanProgress
	lastProgress time.Time
}

// availableDriveRoots is OS-specific. On Windows it uses the same native
// logical-drive discovery pattern as PCWatch instead of probing A:\\..Z:\\
// with os.Stat. The recursive walk still only runs after an explicit scan.

func scanSourceTree(ctx context.Context, roots []string, onProgress func(sourceScanProgress) error) (sourceScanResult, error) {
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
	walker := sourceScanWalker{result: &result, onProgress: onProgress}
	if err := walker.emitProgress(true); err != nil {
		return result, err
	}
	for _, root := range normalized {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if maxSourceScanNodes > 0 && len(result.Nodes) >= maxSourceScanNodes {
			result.Truncated = true
			break
		}
		if _, err := walker.scanDirectory(ctx, root, ""); err != nil {
			return result, err
		}
	}
	if err := walker.emitProgress(true); err != nil {
		return result, err
	}
	result.TotalBytes = walker.progress.Bytes
	result.FileCount = walker.progress.Files
	result.DirectoryCount = walker.progress.Directories
	result.ErrorCount = walker.progress.Errors
	return result, nil
}

func (w *sourceScanWalker) scanDirectory(ctx context.Context, path, parent string) (sourceScanNode, error) {
	node := sourceScanNode{Path: path, Parent: parent, Name: sourceNodeName(path)}
	if err := ctx.Err(); err != nil {
		return node, err
	}
	w.progress.Directories++
	w.progress.CurrentPath = path
	if err := w.emitProgress(false); err != nil {
		return node, err
	}

	if maxSourceScanNodes > 0 && len(w.result.Nodes) >= maxSourceScanNodes {
		w.result.Truncated = true
		return node, nil
	}

	entries, err := os.ReadDir(path)
	if err != nil {
		node.Inaccessible = true
		node.ErrorCount++
		w.progress.Errors++
		w.result.Nodes = append(w.result.Nodes, node)
		return node, nil
	}

	// Reserve this node's slot before descending so a truncation partway
	// through its children can never drop it: without an entry here, a
	// deep cutoff would also erase every ancestor back to the drive root,
	// leaving the browser with no top of the tree to render at all.
	index := len(w.result.Nodes)
	w.result.Nodes = append(w.result.Nodes, node)

	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return node, err
		}
		if entry.Type()&os.ModeSymlink != 0 || isSourceReparse(entry) {
			continue
		}
		childPath := filepath.Join(path, entry.Name())
		if entry.IsDir() {
			if maxSourceScanNodes > 0 && len(w.result.Nodes) >= maxSourceScanNodes {
				w.result.Truncated = true
				break
			}
			child, err := w.scanDirectory(ctx, childPath, path)
			if err != nil {
				return node, err
			}
			node.Bytes += child.Bytes
			node.Files += child.Files
			node.Directories += 1 + child.Directories
			node.ErrorCount += child.ErrorCount
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			node.ErrorCount++
			w.progress.Errors++
			continue
		}
		if !info.Mode().IsRegular() {
			continue
		}
		size := info.Size()
		node.Files++
		if size > 0 {
			node.Bytes += size
		}
		w.progress.Files++
		if size > 0 {
			w.progress.Bytes += size
		}
		w.progress.CurrentPath = childPath
		if err := w.emitProgress(false); err != nil {
			return node, err
		}
	}
	w.result.Nodes[index] = node
	return node, nil
}

func (w *sourceScanWalker) emitProgress(force bool) error {
	if w.onProgress == nil {
		return nil
	}
	now := time.Now()
	if !force && !w.lastProgress.IsZero() && now.Sub(w.lastProgress) < sourceScanProgressEvery {
		return nil
	}
	w.lastProgress = now
	return w.onProgress(w.progress)
}

func sourceNodeName(path string) string {
	cleaned := filepath.Clean(path)
	base := filepath.Base(cleaned)
	if base == "." || base == string(filepath.Separator) || base == "\\" {
		return cleaned
	}
	return base
}
