import { CompositeJobExecutor } from "./composite-executor.js";
import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import { NodeCommandRunner, type CommandRunner } from "./process-runner.js";
import { RcloneTransferExecutor } from "./rclone-executor.js";
import { ResticBackupExecutor } from "./restic-executor.js";
import type { AgentRuntimeConfig } from "./runtime-config.js";

export function createDefaultJobExecutor(
  config: AgentRuntimeConfig,
  events: ExecutionEventSink = noopExecutionEventSink,
  runner: CommandRunner = new NodeCommandRunner(),
): CompositeJobExecutor {
  return new CompositeJobExecutor({
    "restic-backup": new ResticBackupExecutor(config, runner, events),
    "rclone-transfer": new RcloneTransferExecutor(config, runner, events),
  });
}
