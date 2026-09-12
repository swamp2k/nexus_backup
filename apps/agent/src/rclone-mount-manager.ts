import type { ExecutionEventSink } from "./execution-events.js";
import { noopExecutionEventSink } from "./execution-events.js";
import type { CommandRunner } from "./process-runner.js";
import { ToolExitError } from "./process-runner.js";
import type { AgentRuntimeConfig, LocalRcloneMountConfig } from "./runtime-config.js";

export interface RcloneMountLease {
  endpointId: string;
  mountPoint: string;
  release(): Promise<void>;
}

export class RcloneMountManager {
  readonly #config: AgentRuntimeConfig;
  readonly #runner: CommandRunner;
  readonly #events: ExecutionEventSink;
  readonly #active = new Set<string>();

  constructor(config: AgentRuntimeConfig, runner: CommandRunner, events: ExecutionEventSink = noopExecutionEventSink) {
    this.#config = config;
    this.#runner = runner;
    this.#events = events;
  }

  async mount(endpointId: string, signal: AbortSignal): Promise<RcloneMountLease> {
    if (this.#active.has(endpointId)) throw new Error(`rclone endpoint is already mounted by this agent: ${endpointId}`);
    const endpoint = this.#config.rcloneEndpoint(endpointId);
    const mount = endpoint.mount;
    if (!mount) throw new Error(`rclone endpoint is not configured for mounting: ${endpointId}`);

    this.#active.add(endpointId);
    try {
      const result = await this.#runner.run({
        executable: this.#config.tools.rcloneBinary ?? "rclone",
        args: this.#mountArgs(endpoint.fs, mount),
      }, signal, {
        stdout: (line) => this.#events.emit({ type: "log", tool: "rclone", stream: "stdout", message: line }),
        stderr: (line) => this.#events.emit({ type: "log", tool: "rclone", stream: "stderr", message: line }),
      });
      if (result.exitCode !== 0) throw new ToolExitError("rclone mount", result);
    } catch (error) {
      this.#active.delete(endpointId);
      throw error;
    }

    let released = false;
    return {
      endpointId,
      mountPoint: mount.mountPoint,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await this.#unmount(mount.mountPoint);
        } finally {
          this.#active.delete(endpointId);
        }
      },
    };
  }

  #mountArgs(fs: string, mount: LocalRcloneMountConfig): string[] {
    const args = [
      "mount",
      fs,
      mount.mountPoint,
      "--daemon",
      "--daemon-wait", mount.daemonWait ?? "1m",
      "--read-only",
      "--vfs-cache-mode", mount.vfsCacheMode ?? "off",
    ];
    if (mount.cacheDir) args.push("--cache-dir", mount.cacheDir);
    if (mount.vfsCacheMaxSize) args.push("--vfs-cache-max-size", mount.vfsCacheMaxSize);
    if (mount.dirCacheTime) args.push("--dir-cache-time", mount.dirCacheTime);
    if (mount.pollInterval) args.push("--poll-interval", mount.pollInterval);
    if (mount.bufferSize) args.push("--buffer-size", mount.bufferSize);
    args.push(...(mount.args ?? []));
    if (this.#config.tools.rcloneConfigPath) args.push("--config", this.#config.tools.rcloneConfigPath);
    return args;
  }

  async #unmount(mountPoint: string): Promise<void> {
    const controller = new AbortController();
    const timeoutMs = this.#config.tools.unmountTimeoutMs ?? 10_000;
    const timer = setTimeout(
      () => controller.abort(new Error(`Unmount timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    try {
      const result = await this.#runner.run({
        executable: this.#config.tools.unmountBinary ?? "fusermount3",
        args: [...(this.#config.tools.unmountArgs ?? ["-u"]), mountPoint],
      }, controller.signal, {
        stdout: (line) => this.#events.emit({ type: "log", tool: "rclone", stream: "stdout", message: line }),
        stderr: (line) => this.#events.emit({ type: "log", tool: "rclone", stream: "stderr", message: line }),
      });
      if (result.exitCode !== 0) throw new ToolExitError("rclone unmount", result);
    } finally {
      clearTimeout(timer);
    }
  }
}
