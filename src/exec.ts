/**
 * One subprocess collector. A command's stdout and stderr are accumulated to
 * completion and the exit code reported; a spawn that never starts reports 1
 * rather than throwing, because every caller here treats "did not run" and
 * "ran and failed" the same way.
 */
import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Exec = (args: readonly string[]) => Promise<ExecResult>;

/** The collector bound to one binary, which is the only thing that varies between callers. */
export function binExec(bin: string): Exec {
  return (args) =>
    new Promise((resolve) => {
      const proc = spawn(bin, args);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk;
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk;
      });
      proc.on("close", (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
}
