export type ExecutionEvent =
  | {
      type: "log";
      tool: "restic" | "rclone";
      stream: "stdout" | "stderr";
      message: string;
    }
  | {
      type: "progress";
      tool: "restic" | "rclone";
      bytesDone?: number;
      bytesTotal?: number;
      filesDone?: number;
      filesTotal?: number;
      speedBytesPerSecond?: number;
      etaSeconds?: number | null;
      errors?: number;
    }
  | {
      type: "summary";
      tool: "restic" | "rclone";
      data: Readonly<Record<string, unknown>>;
    };

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

export function progressEvent(
  tool: ExecutionProgressEvent["tool"],
  fields: ExecutionProgressFields,
): ExecutionProgressEvent {
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

export interface ExecutionEventSink {
  emit(event: ExecutionEvent): void;
}

export const noopExecutionEventSink: ExecutionEventSink = { emit() {} };
