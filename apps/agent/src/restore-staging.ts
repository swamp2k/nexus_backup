const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function restoreStagingTarget(
  root: string,
  jobId: string,
  attempt: number,
  kind: "preview" | "write",
): string {
  if (typeof root !== "string" || !root.startsWith("/") || root.includes("\0")) {
    throw new Error("restore staging root must be an absolute local path");
  }
  if (!JOB_ID.test(jobId)) throw new Error("restore job id is invalid for local staging");
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("restore attempt is invalid for local staging");
  const base = root.length > 1 ? root.replace(/\/+$/, "") : root;
  const leaf = `.nexus-backup-${kind}-${jobId}-a${attempt}`;
  return base === "/" ? `/${leaf}` : `${base}/${leaf}`;
}
