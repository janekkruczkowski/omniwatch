/**
 * Worker process spawning (T3, D5).
 *
 * Arguments are passed as a list, never through a shell, and only non-secret
 * locations travel in argv: the worker loads the API key itself from the
 * environment named by the config file. The parent waits for an explicit
 * readiness line, so "the process started" is never confused with "the work runs".
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { OmniWatchError } from "../contracts/errors.ts";

export interface SpawnWorkerOptions {
  /** Entry point executed with the current Node binary (usually the CLI). */
  entry: string;
  /** Extra argv for the worker command (operation ids, config path, data dir). */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  readyTimeoutMs?: number;
  /** Keep the worker alive if the parent exits (used by the panel). */
  detached?: boolean;
}

export interface SpawnedWorker {
  pid: number | undefined;
  child: ChildProcess;
  /** Resolves when the worker confirmed readiness; rejects on early exit/timeout. */
  ready: Promise<void>;
  stop(): void;
}

export function spawnWorkerProcess(options: SpawnWorkerOptions): SpawnedWorker {
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  const child = spawn(process.execPath, [options.entry, "worker", ...(options.args ?? [])], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: options.detached ?? false,
  });

  let settled = false;
  let timer: NodeJS.Timeout | null = null;

  const ready = new Promise<void>((resolve, reject) => {
    const fail = (error: OmniWatchError): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };

    timer = setTimeout(() => {
      fail(
        new OmniWatchError(
          "runtime_unavailable",
          `Proces roboczy nie potwierdzil gotowosci w ${readyTimeoutMs} ms; zadanie pozostaje oczekujace.`,
          { action: { label: "sprawdz proces roboczy", kind: "check_operation" } },
        ),
      );
    }, readyTimeoutMs);
    timer.unref?.();

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const event = JSON.parse(trimmed) as { event?: string };
          if (event.event === "ready") succeed();
        } catch {
          // Non-JSON worker logs are not a readiness signal.
        }
      }
    });
    child.once("error", (error) => {
      fail(
        new OmniWatchError("runtime_unavailable", `Nie mozna uruchomic procesu roboczego: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.once("exit", (code, signal) => {
      fail(
        new OmniWatchError(
          "runtime_unavailable",
          `Proces roboczy zakonczyl sie przed potwierdzeniem gotowosci (kod ${String(code)}, sygnal ${String(signal)}).`,
        ),
      );
    });
  });

  return {
    pid: child.pid,
    child,
    ready,
    stop: () => {
      child.kill("SIGTERM");
    },
  };
}
