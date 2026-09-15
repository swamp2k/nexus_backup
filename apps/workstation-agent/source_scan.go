package main

import (
    "context"
    "errors"
    "os"
    "path/filepath"
    "runtime"
    "sort"
    "strings"
)

const (
    maxSourceScanNodes       = 75000
    maxSourceScanApproxBytes = 10 * 1024 * 1024
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
    estimated := len(node.Path) + len(node.Parent) + len(node.Name) + 160
    if len(result.Nodes) >= maxSourceScanNodes || result.approxBytes+estimated > maxSourceScanApproxBytes {
        result.Truncated = true
        return node
    }

    entries, err := os.ReadDir(path)
    if err != nil {
        node.Inaccessible = true
        result.Nodes = append(result.Nodes, node)
        result.approxBytes += estimated
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
    if result.approxBytes+estimated <= maxSourceScanApproxBytes && len(result.Nodes) < maxSourceScanNodes {
        result.Nodes = append(result.Nodes, node)
        result.approxBytes += estimated
    } else {
        result.Truncated = true
    }
    return node
}

func sourceNodeName(path string) string {
    cleaned := filepath.Clean(path)
    base := filepath.Base(cleaned)
    if base == "." || base == string(filepath.Separator) || base == "\\" { return cleaned }
    return base
}
