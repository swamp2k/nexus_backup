import { CompositeJobExecutor } from "./composite-executor.js";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import type { JobExecutor } from "./executor.js";
import { ManagedCleanupExecutor } from "./managed-cleanup-executor.js";
import { ManagedTransferExecutor } from "./managed-transfer-executor.js";
import { NodeCommandRunner, type CommandRunner } from "./process-runner.js";
import { RcloneDiscoveryExecutor } from "./rclone-discovery-executor.js";
import { RcloneTransferExecutor } from "./rclone-executor.js";
import { RcloneMountedResticExecutor } from "./rclone-mounted-restic-executor.js";
import { ResticBackupExecutor } from "./restic-executor.js";
import { ResticBrowseExecutor } from "./restic-browse-executor.js";
import { ResticCheckExecutor } from "./restic-check-executor.js";
import { ResticInventoryExecutor } from "./restic-inventory-executor.js";
import { ResticMaintenanceExecutor } from "./restic-maintenance-executor.js";
import { ResticRepositoryGate, ResticRepositoryLockedExecutor } from "./restic-repository-lock.js";
import { ResticRestoreExecutor } from "./restic-restore-executor.js";
import { ResticRestorePreviewExecutor } from "./restic-restore-preview-executor.js";
import type { AgentRuntimeConfig } from "./runtime-config.js";
import { createRedactingExecutionEventSink } from "./telemetry-redaction.js";

export function createDefaultJobExecutor(
  config: AgentRuntimeConfig,
  events: ExecutionEventSink = noopExecutionEventSink,
  runner: CommandRunner = new NodeCommandRunner(),
): CompositeJobExecutor {
  // Tool output is untrusted with respect to local-only credentials: Restic/rclone
  // may echo repository URLs, credential-file paths or secret environment values
  // while reporting failures. Scrub those values before any runtime event can be
  // persisted by the controller or displayed in the browser.
  const safeEvents = createRedactingExecutionEventSink(events, config.telemetryRedactionValues ?? []);
  const repositoryGate = new ResticRepositoryGate();
  const withRepositoryLock = (executor: JobExecutor) =>
    new ResticRepositoryLockedExecutor(executor, repositoryGate, safeEvents);

  return new CompositeJobExecutor({
    "restic-backup": withRepositoryLock(new ResticBackupExecutor(config, runner, safeEvents)),
    "rclone-transfer": new RcloneTransferExecutor(config, runner, safeEvents),
    "rclone-discovery": new RcloneDiscoveryExecutor(config, runner, safeEvents),
    "managed-transfer": new ManagedTransferExecutor(config, runner, safeEvents),
    "managed-cleanup": new ManagedCleanupExecutor(config, runner, safeEvents),
    "rclone-restic-backup": withRepositoryLock(new RcloneMountedResticExecutor(config, runner, safeEvents)),
    "restic-maintenance": withRepositoryLock(new ResticMaintenanceExecutor(config, runner, safeEvents)),
    "restic-inventory": withRepositoryLock(new ResticInventoryExecutor(config, runner, safeEvents)),
    "restic-check": withRepositoryLock(new ResticCheckExecutor(config, runner, safeEvents)),
    "restic-browse": withRepositoryLock(new ResticBrowseExecutor(config, runner, safeEvents)),
    "restic-restore-preview": withRepositoryLock(new ResticRestorePreviewExecutor(config, runner, safeEvents)),
    "restic-restore": withRepositoryLock(new ResticRestoreExecutor(config, runner, safeEvents)),
  });
}
