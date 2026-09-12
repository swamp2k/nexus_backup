import type { BackupJob } from "@nexus-backup/core";
import type { ControlPlaneClient, LeaseGrant } from "./control-plane.js";
import type { JobExecutor } from "./executor.js";

export interface AgentRunnerOptions {
  agentId: string;
  controlPlane: ControlPlaneClient;
  executor: JobExecutor;
  maxHeartbeatMs?: number;
}

interface HeartbeatLoop {
  stop(): void;
  done: Promise<void>;
  failed: Promise<never>;
}

export class AgentRunner {
  readonly #agentId: string;
  readonly #controlPlane: ControlPlaneClient;
  readonly #executor: JobExecutor;
  readonly #maxHeartbeatMs: number;

  constructor(options: AgentRunnerOptions) {
    this.#agentId = options.agentId;
    this.#controlPlane = options.controlPlane;
    this.#executor = options.executor;
    this.#maxHeartbeatMs = options.maxHeartbeatMs ?? 5_000;
  }

  async runOne(signal: AbortSignal = new AbortController().signal): Promise<BackupJob | null> {
    const grant = await this.#controlPlane.claim(this.#agentId);
    if (!grant) return null;

    await this.#controlPlane.transition(grant.job.id, this.#agentId, grant.leaseToken, "preparing");
    await this.#controlPlane.transition(grant.job.id, this.#agentId, grant.leaseToken, "running");

    const executionController = new AbortController();
    const abortExecution = () => executionController.abort(signal.reason);
    if (signal.aborted) abortExecution();
    else signal.addEventListener("abort", abortExecution, { once: true });

    const heartbeat = this.#startHeartbeat(grant, signal);
    try {
      const execution = this.#executor.execute(grant.job, executionController.signal);
      const result = await Promise.race([execution, heartbeat.failed]);

      heartbeat.stop();
      await heartbeat.done;
      await this.#controlPlane.transition(grant.job.id, this.#agentId, grant.leaseToken, "finalizing");
      await this.#controlPlane.transition(grant.job.id, this.#agentId, grant.leaseToken, result.status, result.message);
      return { ...grant.job, state: result.status };
    } catch (error) {
      executionController.abort(error);
      heartbeat.stop();
      await heartbeat.done.catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.#controlPlane.transition(
          grant.job.id,
          this.#agentId,
          grant.leaseToken,
          signal.aborted ? "interrupted" : "failed",
          message,
        );
      } catch (reportError) {
        throw new AggregateError([error, reportError], `Job ${grant.job.id} failed and its failure state could not be reported`);
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", abortExecution);
    }
  }

  #startHeartbeat(grant: LeaseGrant, signal: AbortSignal): HeartbeatLoop {
    const intervalMs = Math.max(100, Math.min(this.#maxHeartbeatMs, Math.floor(grant.leaseTtlMs / 3)));
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });

    let rejectFailure!: (reason: unknown) => void;
    const failed = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });

    const done = (async () => {
      try {
        while (!controller.signal.aborted) {
          await sleep(intervalMs, controller.signal);
          if (controller.signal.aborted) break;
          await this.#controlPlane.heartbeat(grant.job.id, this.#agentId, grant.leaseToken);
        }
      } catch (error) {
        if (!controller.signal.aborted) rejectFailure(error);
        throw error;
      } finally {
        signal.removeEventListener("abort", stop);
      }
    })();

    // The runner observes failures through `failed`; suppress a second unhandled rejection
    // from the cleanup promise until it explicitly awaits `done`.
    void done.catch(() => undefined);
    return { stop, done, failed };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
