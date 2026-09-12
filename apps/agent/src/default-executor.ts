import { CompositeJobExecutor } from "./composite-executor.js";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import type { JobExecutor } from "./executor.js";
import { NodeCommandRunner, type CommandRunner } from "./process-runner.js";
import { RcloneTransferExecutor } from "./rclone-executor.js";
import { RcloneMountedResticExecutor } from "./rclone-mounted-restic-executor.js";
import { ResticBackupExecutor } from "./restic-executor.js";
import { ResticMaintenanceExecutor } from "./restic-maintenance-executor.js";
import { ResticRepositoryGate, ResticRepositoryLockedExecutor } from "./restic-repository-lock.js";
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
    "rclone-restic-backup": withRepositoryLock(new RcloneMountedResticExecutor(config, runner, events)),
    "restic-maintenance": withRepositoryLock(new ResticMaintenanceExecutor(config, runner, events)),
  });
}
