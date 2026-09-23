/**
 * Error contract (T0). Every failure carries a machine class, a message safe to
 * show the user (no secrets) and the recovery action the user may take.
 *
 * Contract: failures are never swallowed by `.catch(() => {})` (TECHNICAL D9).
 */

import type { ErrorClass } from "./types.ts";

export interface ErrorAction {
  /** Short user-facing suggestion, e.g. "sprawdz konfiguracje klucza". */
  label: string;
  /** Machine hint the shell may use to offer a retry. */
  kind: "retry_delivery" | "fix_config" | "check_operation" | "resume_scan" | "none";
}

/**
 * Where a model call's transport failed, when the provider can tell (LF2):
 *   - `not_sent`: the request never left this machine (media upload failed, DNS,
 *     refused connection) - nothing can have been billed;
 *   - `headers`: the provider closed the connection before sending any response
 *     headers, i.e. before the first generated token, and it was not our own timeout.
 */
export type TransportPhase = "not_sent" | "headers";

export class OmniWatchError extends Error {
  readonly errorClass: ErrorClass;
  readonly operationId?: string;
  readonly action?: ErrorAction;
  readonly transportPhase?: TransportPhase;

  constructor(
    errorClass: ErrorClass,
    message: string,
    options?: { operationId?: string; action?: ErrorAction; cause?: unknown; transportPhase?: TransportPhase },
  ) {
    super(message);
    this.name = "OmniWatchError";
    this.errorClass = errorClass;
    this.operationId = options?.operationId;
    this.action = options?.action;
    if (options?.transportPhase) this.transportPhase = options.transportPhase;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isOmniWatchError(value: unknown): value is OmniWatchError {
  return value instanceof OmniWatchError;
}

export function toOmniWatchError(value: unknown, fallback: ErrorClass = "runtime_unavailable"): OmniWatchError {
  if (isOmniWatchError(value)) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new OmniWatchError(fallback, message, { cause: value });
}

export function isUnknownOutcome(value: unknown): boolean {
  return isOmniWatchError(value) && value.errorClass === "outcome_unknown";
}
