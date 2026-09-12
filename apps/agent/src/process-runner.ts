import { spawn } from "node:child_process";

export interface CommandSpec {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  terminateGraceMs?: number;
}

export interface CommandLineHandlers {
  stdout?(line: string): void;
  stderr?(line: string): void;
}

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface CommandRunner {
  run(spec: CommandSpec, signal: AbortSignal, handlers?: CommandLineHandlers): Promise<CommandResult>;
}

export class CommandAbortedError extends Error {
  constructor(message = "Command execution was aborted", options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandAbortedError";
  }
}

export class ToolExitError extends Error {
  readonly tool: string;
  readonly exitCode: number | null;
  readonly stderrTail: string;

  constructor(tool: string, result: CommandResult) {
    super(`${tool} exited with code ${result.exitCode ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}`);
    this.name = "ToolExitError";
    this.tool = tool;
    this.exitCode = result.exitCode;
    this.stderrTail = result.stderrTail;
  }
}

export interface NodeCommandRunnerOptions {
  captureLimitChars?: number;
  terminateGraceMs?: number;
}

export class NodeCommandRunner implements CommandRunner {
  readonly #captureLimitChars: number;
  readonly #terminateGraceMs: number;

  constructor(options: NodeCommandRunnerOptions = {}) {
    this.#captureLimitChars = options.captureLimitChars ?? 64 * 1024;
    this.#terminateGraceMs = options.terminateGraceMs ?? 5_000;
  }

  async run(spec: CommandSpec, signal: AbortSignal, handlers: CommandLineHandlers = {}): Promise<CommandResult> {
    if (signal.aborted) throw new CommandAbortedError("Command execution was aborted before start", { cause: signal.reason });
    if (!spec.executable.trim()) throw new TypeError("Command executable must not be empty");

    const startedAt = Date.now();
    const child = spawn(spec.executable, [...spec.args], {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = new LineCollector(this.#captureLimitChars, handlers.stdout);
    const stderr = new LineCollector(this.#captureLimitChars, handlers.stderr);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let aborted = false;
    const abort = () => {
      if (aborted) return;
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), spec.terminateGraceMs ?? this.#terminateGraceMs);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();

    return await new Promise<CommandResult>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (killTimer) clearTimeout(killTimer);
        stdout.finish();
        stderr.finish();
        callback();
      };

      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (exitCode, processSignal) => finish(() => {
        if (aborted || signal.aborted) {
          reject(new CommandAbortedError("Command execution was aborted", { cause: signal.reason }));
          return;
        }
        resolve({
          exitCode,
          signal: processSignal,
          durationMs: Date.now() - startedAt,
          stdoutTail: stdout.tail,
          stderrTail: stderr.tail,
        });
      }));
    });
  }
}

class LineCollector {
  readonly #limit: number;
  readonly #handler: ((line: string) => void) | undefined;
  #pending = "";
  #tail = "";

  constructor(limit: number, handler?: (line: string) => void) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("captureLimitChars must be a positive integer");
    this.#limit = limit;
    this.#handler = handler;
  }

  get tail(): string { return this.#tail; }

  push(chunk: string): void {
    this.#capture(chunk);
    this.#pending += chunk;
    for (;;) {
      const newline = this.#pending.indexOf("\n");
      if (newline < 0) break;
      const line = this.#pending.slice(0, newline).replace(/\r$/, "");
      this.#pending = this.#pending.slice(newline + 1);
      this.#handler?.(line);
    }
  }

  finish(): void {
    if (this.#pending) this.#handler?.(this.#pending.replace(/\r$/, ""));
    this.#pending = "";
  }

  #capture(chunk: string): void {
    this.#tail = (this.#tail + chunk).slice(-this.#limit);
  }
}
