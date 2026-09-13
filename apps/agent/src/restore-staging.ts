import { mkdir } from "node:fs/promises";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function restoreStagingTarget(
  root: string,
  jobId: string,
  attempt: number,
  kind: "preview" | "write",
): string {
  const base = normalizeStagingRoot(root);
  if (!JOB_ID.test(jobId)) throw new Error("restore job id is invalid for local staging");
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("restore attempt is invalid for local staging");
  const leaf = `.nexus-backup-${kind}-${jobId}-a${attempt}`;
  return base === "/" ? `/${leaf}` : `${base}/${leaf}`;
}

export async function prepareRestoreStagingTarget(
  root: string,
  jobId: string,
  attempt: number,
): Promise<string> {
  const target = restoreStagingTarget(root, jobId, attempt, "write");
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new Error("restore staging target already exists; refusing to reuse an interrupted restore tree");
    }
    throw error;
  }
  return target;
}

function normalizeStagingRoot(root: string): string {
  if (typeof root !== "string" || !root.startsWith("/") || root.includes("\0")) {
    throw new Error("restore staging root must be an absolute local path");
  }
  if (root.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("restore staging root may not contain dot segments");
  }
  return root.length > 1 ? root.replace(/\/+$/, "") || "/" : "/";
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
