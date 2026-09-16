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

const (
	maxSourceScanNodes       = 75000
	maxSourceScanApproxBytes = 10 * 1024 * 1024
	sourceScanProgressEvery  = 500 * time.Millisecond
)

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
	Drives      []string
	Nodes       []sourceScanNode
	Truncated   bool
	approxBytes int
}

type sourceScanProgress struct {
	Files       int64
	Directories int64
	Bytes       int64
	CurrentPath string
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
		if len(result.Nodes) >= maxSourceScanNodes {
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

	estimated := len(node.Path) + len(node.Parent) + len(node.Name) + 160
	if len(w.result.Nodes) >= maxSourceScanNodes || w.result.approxBytes+estimated > maxSourceScanApproxBytes {
		w.result.Truncated = true
		return node, nil
	}

	entries, err := os.ReadDir(path)
	if err != nil {
		node.Inaccessible = true
		w.result.Nodes = append(w.result.Nodes, node)
		w.result.approxBytes += estimated
		return node, nil
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return node, err
		}
		if entry.Type()&os.ModeSymlink != 0 || isSourceReparse(entry) {
			continue
		}
		childPath := filepath.Join(path, entry.Name())
		if entry.IsDir() {
			if len(w.result.Nodes) >= maxSourceScanNodes {
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
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil || !info.Mode().IsRegular() {
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
	if w.result.approxBytes+estimated <= maxSourceScanApproxBytes && len(w.result.Nodes) < maxSourceScanNodes {
		w.result.Nodes = append(w.result.Nodes, node)
		w.result.approxBytes += estimated
	} else {
		w.result.Truncated = true
	}
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
