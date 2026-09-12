declare const process: {
  env: Record<string, string | undefined>;
};

declare module "node:child_process" {
  interface ReadableLike {
    setEncoding(encoding: string): void;
    on(event: "data", listener: (chunk: string) => void): void;
  }

  interface ChildProcessLike {
    stdout: ReadableLike;
    stderr: ReadableLike;
    once(event: "error", listener: (error: Error) => void): void;
    once(event: "close", listener: (code: number | null, signal: string | null) => void): void;
    kill(signal?: string): boolean;
  }

  export function spawn(
    command: string,
    args: readonly string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      shell: false;
      windowsHide: boolean;
      stdio: ["ignore", "pipe", "pipe"];
    },
  ): ChildProcessLike;
}
