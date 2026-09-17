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

type backupResult struct {
	SnapshotID                              string
	FilesNew, FilesChanged, FilesUnmodified int64
	DataAdded                               int64
	Duration                                time.Duration
	Partial, Cancelled                      bool
	Err                                     error
}

func validateRun(run workstationRun) error {
	if strings.TrimSpace(run.ID) == "" || strings.TrimSpace(run.LeaseToken) == "" {
		return errors.New("backup run lease is incomplete")
	}
	if len(run.SourcePaths) == 0 {
		return errors.New("backup run has no source paths")
	}
	return nil
}

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

	type sourceFile struct {
		path, uploadPath string
		info             fs.FileInfo
	}
	var files []sourceFile
	seenRoots := make(map[string]string)
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
		rootKey := strings.ToLower(rootName)
		if previous, exists := seenRoots[rootKey]; exists {
			result.Err = fmt.Errorf("source roots %q and %q have the same destination name %q; select distinct roots or rename them", previous, source, rootName)
			break
		}
		seenRoots[rootKey] = source
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
			uploadPath := filepath.ToSlash(filepath.Join(rootName, rel))
			files = append(files, sourceFile{path: path, uploadPath: uploadPath, info: info})
			return nil
		})
		if err != nil {
			result.Err = err
			break
		}
	}
	if result.Err == nil {
		var bytesTotal, bytesDone, filesDone int64
		for _, item := range files {
			if err := ctx.Err(); err != nil {
				result.Err = err
				break
			}
			bytesTotal += item.info.Size()
			metadata, exists, err := client.fileMetadata(ctx, item.uploadPath)
			if err != nil {
				result.Err = fmt.Errorf("inspect remote %q: %w", item.uploadPath, err)
				break
			}
			if exists && metadata.Size == item.info.Size() && metadata.Mtime.UnixMilli() == item.info.ModTime().UnixMilli() {
				result.FilesUnmodified++
				bytesDone += item.info.Size()
				continue
			}
			file, err := os.Open(item.path)
			if err != nil {
				result.Err = err
				break
			}
			err = client.uploadFileWithMtime(ctx, item.uploadPath, file, item.info.Size(), item.info.ModTime())
			closeErr := file.Close()
			if err != nil {
				result.Err = fmt.Errorf("upload %q: %w", item.uploadPath, err)
				break
			}
			if closeErr != nil {
				result.Err = fmt.Errorf("close source %q: %w", item.path, closeErr)
				break
			}
			filesDone++
			bytesDone += item.info.Size()
			if exists {
				result.FilesChanged++
			} else {
				result.FilesNew++
			}
			result.DataAdded += item.info.Size()
			if report != nil {
				percent := float64(0)
				if bytesTotal > 0 {
					percent = float64(bytesDone) / float64(bytesTotal) * 100
				}
				report(backupProgress{Phase: "uploading", Percent: percent, BytesDone: bytesDone, BytesTotal: bytesTotal, FilesDone: filesDone, FilesTotal: int64(len(files)), CurrentPath: item.uploadPath})
			}
		}
	}
	if result.Err != nil && (errors.Is(result.Err, context.Canceled) || errors.Is(result.Err, context.DeadlineExceeded)) {
		result.Cancelled = true
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
