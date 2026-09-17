package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// executeFlatFileBackup copies source files into the workstation's restricted
// repository folder through the device-token upload endpoint. The server uses
// an atomic temporary-file rename, so an interrupted upload cannot replace a
// previously completed file.
func executeFlatFileBackup(ctx context.Context, cfg config, run workstationRun, report func(backupProgress)) backupResult {
	started := time.Now()
	result := backupResult{}
	if err := validateRun(run); err != nil {
		result.Err = err
		result.Duration = time.Since(started)
		return result
	}
	if strings.TrimSpace(cfg.RepositoryID) == "" {
		result.Err = errors.New("repositoryId is not configured")
		result.Duration = time.Since(started)
		return result
	}
	if strings.ToLower(strings.TrimSpace(cfg.ReceiverProtocol)) != "webdav" {
		result.Err = fmt.Errorf("unsupported flat-file receiver protocol %q", cfg.ReceiverProtocol)
		result.Duration = time.Since(started)
		return result
	}
	client := newAPIClient(cfg.ServerURL, cfg.DeviceToken)

	var bytesTotal, bytesDone, filesDone int64
	for _, source := range run.SourcePaths {
		rootInfo, err := os.Lstat(source)
		if err != nil {
			result.Err = fmt.Errorf("inspect source %q: %w", source, err)
			break
		}
		if rootInfo.Mode()&os.ModeSymlink != 0 {
			result.Err = fmt.Errorf("source path must not be a symlink: %q", source)
			break
		}
		rootName := filepath.Base(filepath.Clean(source))
		err = filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			rel, err := filepath.Rel(source, path)
			if err != nil {
				return err
			}
			if rel != "." && excludedFlatFilePath(rel, entry.Name(), run.ExcludePatterns) {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.Type()&os.ModeSymlink != 0 {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if !entry.Type().IsRegular() {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if info.Size() > 0 {
				bytesTotal += info.Size()
			}
			uploadPath := filepath.ToSlash(filepath.Join(rootName, rel))
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			err = client.uploadFile(ctx, uploadPath, file, info.Size())
			closeErr := file.Close()
			if err != nil {
				return fmt.Errorf("upload %q: %w", uploadPath, err)
			}
			if closeErr != nil {
				return fmt.Errorf("close source %q: %w", path, closeErr)
			}
			filesDone++
			bytesDone += info.Size()
			result.FilesNew++
			result.DataAdded += info.Size()
			if report != nil {
				percent := float64(0)
				if bytesTotal > 0 {
					percent = float64(bytesDone) / float64(bytesTotal) * 100
				}
				report(backupProgress{Phase: "uploading", Percent: percent, BytesDone: bytesDone, BytesTotal: bytesTotal, FilesDone: filesDone, CurrentPath: uploadPath})
			}
			return nil
		})
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				result.Cancelled = true
			}
			result.Err = err
			break
		}
	}
	result.Duration = time.Since(started)
	result.Partial = result.Err != nil && result.FilesNew > 0 && !result.Cancelled
	return result
}

func excludedFlatFilePath(relative, base string, patterns []string) bool {
	relative = filepath.ToSlash(relative)
	for _, pattern := range patterns {
		pattern = filepath.ToSlash(strings.TrimSpace(pattern))
		if pattern == "" {
			continue
		}
		if matched, _ := filepath.Match(pattern, relative); matched {
			return true
		}
		if matched, _ := filepath.Match(pattern, base); matched {
			return true
		}
	}
	return false
}
