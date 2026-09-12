export interface RepositoryInventoryStatsEvent {
  totalSize: number | null;
  totalFileCount: number | null;
  totalBlobCount: number | null;
  snapshotsCount: number | null;
  totalUncompressedSize: number | null;
  compressionRatio: number | null;
  compressionProgress: number | null;
  compressionSpaceSaving: number | null;
}

export interface RepositoryInventorySnapshotEvent {
  id: string;
  shortId: string | null;
  time: string;
  parent: string | null;
  hostname: string | null;
  username: string | null;
  paths: readonly string[];
  tags: readonly string[];
  programVersion: string | null;
  totalFilesProcessed: number | null;
  totalBytesProcessed: number | null;
  dataAdded: number | null;
  dataAddedPacked: number | null;
}

export interface RepositorySnapshotBrowseEntryEvent {
  path: string;
  name: string;
  nodeType: string;
  size: number | null;
  mtime: string | null;
  permissions: string | null;
}

export type TransferReadiness = "stability" | "rtorrent_complete" | "rtorrent_incomplete";

export interface TransferDiscoveryEntryEvent {
  relPath: string;
  size: number;
  modTime: string;
  readiness: TransferReadiness;
  torrentHash?: string;
  torrentName?: string;
  torrentRoot?: string;
}

export interface TransferDiscoveryRtorrentEvent {
  configured: boolean;
  available: boolean;
}

export type ExecutionEvent =
  | { type: "log"; tool: "restic" | "rclone"; stream: "stdout" | "stderr"; message: string }
  | { type: "progress"; tool: "restic" | "rclone"; bytesDone?: number; bytesTotal?: number; filesDone?: number; filesTotal?: number; speedBytesPerSecond?: number; etaSeconds?: number | null; errors?: number }
  | { type: "summary"; tool: "restic" | "rclone"; data: Readonly<Record<string, unknown>> }
  | { type: "inventory"; tool: "restic"; repositoryId: string; stats: RepositoryInventoryStatsEvent; snapshots: readonly RepositoryInventorySnapshotEvent[]; snapshotLimit: number; truncated: boolean }
  | { type: "snapshot-browse"; tool: "restic"; repositoryId: string; snapshotId: string; path: string; entries: readonly RepositorySnapshotBrowseEntryEvent[]; entryLimit: number; truncated: boolean }
  | { type: "transfer-discovery"; tool: "rclone"; ruleId: string; rtorrent: TransferDiscoveryRtorrentEvent; entries: readonly TransferDiscoveryEntryEvent[] };

export type ExecutionProgressEvent = Extract<ExecutionEvent, { type: "progress" }>;

export interface ExecutionProgressFields {
  bytesDone?: number | undefined;
  bytesTotal?: number | undefined;
  filesDone?: number | undefined;
  filesTotal?: number | undefined;
  speedBytesPerSecond?: number | undefined;
  etaSeconds?: number | null | undefined;
  errors?: number | undefined;
}

export function progressEvent(tool: ExecutionProgressEvent["tool"], fields: ExecutionProgressFields): ExecutionProgressEvent {
  const event: ExecutionProgressEvent = { type: "progress", tool };
  if (fields.bytesDone !== undefined) event.bytesDone = fields.bytesDone;
  if (fields.bytesTotal !== undefined) event.bytesTotal = fields.bytesTotal;
  if (fields.filesDone !== undefined) event.filesDone = fields.filesDone;
  if (fields.filesTotal !== undefined) event.filesTotal = fields.filesTotal;
  if (fields.speedBytesPerSecond !== undefined) event.speedBytesPerSecond = fields.speedBytesPerSecond;
  if (fields.etaSeconds !== undefined) event.etaSeconds = fields.etaSeconds;
  if (fields.errors !== undefined) event.errors = fields.errors;
  return event;
}

export interface ExecutionEventSink { emit(event: ExecutionEvent): void; }
export const noopExecutionEventSink: ExecutionEventSink = { emit() {} };
