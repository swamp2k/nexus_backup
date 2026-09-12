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
import { ResticInventoryExecutor } from "./restic-inventory-executor.js";
import { ResticMaintenanceExecutor } from "./restic-maintenance-executor.js";
import { ResticRepositoryGate, ResticRepositoryLockedExecutor } from "./restic-repository-lock.js";
import { ResticRestoreExecutor } from "./restic-restore-executor.js";
import { ResticRestorePreviewExecutor } from "./restic-restore-preview-executor.js";
import type { AgentRuntimeConfig } from "./runtime-config.js";

export function createDefaultJobExecutor(
  config: AgentRuntimeConfig,
  events: ExecutionEventSink = noopExecutionEventSink,
  runner: CommandRunner = new NodeCommandRunner(),
): CompositeJobExecutor {
  const repositoryGate = new ResticRepositoryGate();
  const withRepositoryLock = (executor: JobExecutor) =>
    new ResticRepositoryLockedExecutor(executor, repositoryGate, events);

  return new CompositeJobExecutor({
    "restic-backup": withRepositoryLock(new ResticBackupExecutor(config, runner, events)),
    "rclone-transfer": new RcloneTransferExecutor(config, runner, events),
    "rclone-discovery": new RcloneDiscoveryExecutor(config, runner, events),
    "managed-transfer": new ManagedTransferExecutor(config, runner, events),
    "managed-cleanup": new ManagedCleanupExecutor(config, runner, events),
    "rclone-restic-backup": withRepositoryLock(new RcloneMountedResticExecutor(config, runner, events)),
    "restic-maintenance": withRepositoryLock(new ResticMaintenanceExecutor(config, runner, events)),
    "restic-inventory": withRepositoryLock(new ResticInventoryExecutor(config, runner, events)),
    "restic-browse": withRepositoryLock(new ResticBrowseExecutor(config, runner, events)),
    "restic-restore-preview": withRepositoryLock(new ResticRestorePreviewExecutor(config, runner, events)),
    "restic-restore": withRepositoryLock(new ResticRestoreExecutor(config, runner, events)),
  });
}
