import type { BackupJob } from "@nexus-backup/core";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import type { JobExecutionResult, JobExecutor } from "./executor.js";

export class ResticRepositoryGate {
  readonly #tails = new Map<string, Promise<void>>();

  isBusy(repositoryId: string): boolean {
    return this.#tails.has(repositoryId);
  }

  async run<T>(repositoryId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    const key = requireRepositoryId(repositoryId);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => hold);
    this.#tails.set(key, tail);

    try {
      await waitFor(previous, signal);
      if (signal.aborted) throw abortReason(signal);
      return await task();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

export class ResticRepositoryLockedExecutor implements JobExecutor {
  readonly #inner: JobExecutor;
  readonly #gate: ResticRepositoryGate;
  readonly #events: ExecutionEventSink;

  constructor(
    inner: JobExecutor,
    gate: ResticRepositoryGate,
    events: ExecutionEventSink = noopExecutionEventSink,
  ) {
    this.#inner = inner;
    this.#gate = gate;
    this.#events = events;
  }

  async execute(job: BackupJob, signal: AbortSignal): Promise<JobExecutionResult> {
    const repositoryId = repositoryIdFromPayload(job.payload);
    const waited = this.#gate.isBusy(repositoryId);
    if (waited) {
      this.#events.emit({
        type: "log",
        tool: "restic",
        stream: "stdout",
        message: `Waiting for repository lock: ${repositoryId}`,
      });
    }
    return this.#gate.run(repositoryId, signal, async () => {
      if (waited) {
        this.#events.emit({
          type: "log",
          tool: "restic",
          stream: "stdout",
          message: `Repository lock acquired: ${repositoryId}`,
        });
      }
      return this.#inner.execute(job, signal);
    });
  }
}

export function repositoryIdFromPayload(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("restic job payload must be an object");
  }
  const repositoryId = (value as Record<string, unknown>).repositoryId;
  return requireRepositoryId(repositoryId);
}

function requireRepositoryId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("repositoryId must be a non-empty string");
  return value.trim();
}

function waitFor(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => { cleanup(); resolve(); },
      () => { cleanup(); resolve(); },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Job aborted while waiting for repository lock");
}
