import type { BackupJob } from "@nexus-backup/core";
import type { ControlPlaneClient, LeaseGrant } from "./control-plane.js";
import type { JobExecutor } from "./executor.js";

export interface AgentRunnerOptions {
  agentId: string;
  controlPlane: ControlPlaneClient;
  executor: JobExecutor;
  maxHeartbeatMs?: number;
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

    const heartbeat = this.#startHeartbeat(grant, signal);
    try {
      const result = await this.#executor.execute(grant.job, signal);
      await this.#controlPlane.transition(grant.job.id, this.#agentId, grant.leaseToken, "finalizing");
      await this.#controlPlane.transition(
        grant.job.id,
        this.#agentId,
        grant.leaseToken,
        result.status,
        result.message,
      );
      return { ...grant.job, state: result.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#controlPlane.transition(grant.job.id, this.#agentId, grant.leaseToken, signal.aborted ? "interrupted" : "failed", message);
      throw error;
    } finally {
      heartbeat.stop();
      await heartbeat.done;
    }
  }

  #startHeartbeat(grant: LeaseGrant, signal: AbortSignal): { stop(): void; done: Promise<void> } {
    const intervalMs = Math.max(100, Math.min(this.#maxHeartbeatMs, Math.floor(grant.leaseTtlMs / 3)));
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true });

    const done = (async () => {
      try {
        while (!controller.signal.aborted) {
          await sleep(intervalMs, controller.signal);
          if (controller.signal.aborted) break;
          await this.#controlPlane.heartbeat(grant.job.id, this.#agentId, grant.leaseToken);
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        signal.removeEventListener("abort", stop);
      }
    })();

    return { stop, done };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
