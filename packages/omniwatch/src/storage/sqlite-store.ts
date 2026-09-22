/**
 * `StorePort` implementation on `node:sqlite` (T2 / D3).
 *
 * Rules enforced here:
 * - every mutation is a short transaction; model calls and Vault writes never
 *   run inside one,
 * - `claimOperation` is atomic and idempotent: the unique `analysis_key` index
 *   plus a compare-and-set on state means two processes racing the same work
 *   end up with exactly one operation row,
 * - state transitions are conditional (`WHERE state = <expected>`); a
 *   delivered operation is never blindly overwritten,
 * - every SQLite failure (busy, full disk, closed connection, missing table)
 *   becomes `OmniWatchError("storage_unavailable", ...)`. Nothing is cached in
 *   RAM and no error is swallowed.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { OmniWatchError } from "../contracts/errors.ts";
import type {
  BufferPayload,
  ClaimOperationInput,
  ClaimOperationResult,
  StorePort,
} from "../contracts/ports.ts";
import type {
  AnalysisRequest,
  AttemptPhase,
  AttemptRecord,
  ConversationTurn,
  DeliveryRecord,
  ErrorClass,
  MemoryRef,
  Mode,
  Operation,
  OperationState,
  RunItem,
  RunItemState,
  RunRecord,
  ScanReport,
  ScanSettings,
  SourceRef,
  Usage,
} from "../contracts/types.ts";
import {
  assertSchemaSupported,
  isBusy,
  isUniqueViolation,
  openDatabase,
  runMigrations,
  storageFailure,
  type Migration,
} from "./schema.ts";

/** D5 takeover window: a heartbeat older than this may be replaced. */
export const DEFAULT_OWNER_STALE_AFTER_MS = 30_000;

const DELIVERY_PAGE_DEFAULT = 50;
const RUN_ITEM_PAGE_DEFAULT = 50;
const TURN_PAGE_DEFAULT = 100;

export interface SqliteStoreOptions {
  path: string;
  migrations?: Migration[];
  busyTimeoutMs?: number;
  now?: () => string;
  ownerStaleAfterMs?: number;
}

/** Which operation states may follow a given state (D3 flow). */
const ALLOWED_TRANSITIONS: Record<OperationState, OperationState[]> = {
  pending: ["running", "result_ready", "failed", "outcome_unknown", "budget_paused"],
  running: ["pending", "result_ready", "failed", "outcome_unknown", "budget_paused"],
  result_ready: ["delivered", "failed", "budget_paused"],
  delivered: [],
  failed: ["pending", "running", "budget_paused"],
  outcome_unknown: ["pending", "running", "failed"],
  budget_paused: ["pending", "running", "failed"],
};

const ATTEMPT_PHASE_RANK: Record<AttemptPhase, number> = {
  intent: 0,
  started: 1,
  response: 2,
  unknown: 2,
  failed: 2,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson<T>(value: unknown, what: string, operationId?: string): T {
  if (typeof value !== "string") {
    throw new OmniWatchError("storage_unavailable", `uszkodzony wpis w bazie: ${what} nie jest tekstem`, {
      operationId,
    });
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new OmniWatchError("storage_unavailable", `uszkodzony JSON w bazie (${what}): ${messageOf(error)}`, {
      operationId,
      cause: error,
    });
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * D11: no API keys or prompt secrets may reach the database. The patterns are
 * deliberately narrow (a provider key, a Bearer header, an explicit assignment)
 * so ordinary prompt text is not rejected.
 */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "klucz dostawcy", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: "naglowek Bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/ },
  { name: "wartosc API_KEY", pattern: /\b[A-Z][A-Z0-9_]*API_KEY\b\s*[:=]\s*\S+/ },
];

export function assertNoStoredSecrets(what: string, text: string): void {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new OmniWatchError(
        "invalid_input",
        `odrzucono zapis ${what}: wykryto ${name}; sekrety nie trafiaja do SQLite ani do argv`,
        { action: { label: "usun sekret z konfiguracji stanu", kind: "fix_config" } },
      );
    }
  }
}

/** Matches the whitespace normalization used by the frozen analysis key. */
export function normalizeSeenText(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

export function classifyTransition(
  from: OperationState,
  to: OperationState,
): "allowed" | "same_state" | "refused" {
  if (from === to) return "same_state";
  return ALLOWED_TRANSITIONS[from].includes(to) ? "allowed" : "refused";
}

export function operationIdForAnalysisKey(analysisKey: string): string {
  return `op_${analysisKey.slice(0, 24)}`;
}

export function deliveryIdForAnalysisKey(analysisKey: string): string {
  return `dlv_${analysisKey.slice(0, 24)}`;
}

interface OperationRow {
  id: string;
  analysis_key: string;
  request_json: string;
  state: string;
  error_class: string | null;
  error_message: string | null;
  run_id: string | null;
  execution_snapshot_json: string | null;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  operation_id: string;
  phase: string;
  part_index: number;
  model: string | null;
  request_summary: string | null;
  response_summary: string | null;
  usage_json: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  operation_id: string;
  analysis_id: string;
  state: string;
  payload_json: string | null;
  memory_ref_json: string | null;
  error_message: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  collection_id: string;
  trigger: string;
  state: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface RunItemRow {
  run_id: string;
  ordinal: number;
  source_id: string;
  source_ref_json: string;
  operation_id: string;
  state: string;
  title: string | null;
  updated_at: string;
}

interface ReportRow {
  id: string;
  run_id: string;
  state: string;
  new_analyses: number;
  failed_items: number;
  pending_items: number;
  summary: string;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  turn_id: string;
  conversation_id: string;
  parent_turn_id: string | null;
  role: string;
  mode: string;
  text: string;
  created_at: string;
}

interface OwnerRow {
  token: string;
  pid: number;
  heartbeat_at: string;
  acquired_at: string;
}

export class SqliteStore implements StorePort {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly migrationList: Migration[];
  private readonly nowFn: () => string;
  private readonly ownerStaleAfterMs: number;
  private closed = false;

  constructor(options: SqliteStoreOptions) {
    this.path = options.path;
    this.db = openDatabase(options.path, { busyTimeoutMs: options.busyTimeoutMs });
    this.migrationList = options.migrations ?? [];
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.ownerStaleAfterMs = options.ownerStaleAfterMs ?? DEFAULT_OWNER_STALE_AFTER_MS;
  }

  /* ------------------------------------------------------------- lifecycle -- */

  migrate(): void {
    this.guard("migrate", () => {
      const result = runMigrations(
        this.db,
        this.migrationList.length > 0 ? this.migrationList : undefined,
        { now: this.nowFn },
      );
      assertSchemaSupported(this.db);
      return result;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (error) {
      throw storageFailure(`nie mozna zamknac bazy SQLite: ${messageOf(error)}`, error);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Diagnostic/test seam: caps the database at its current page count, so the
   * next write that needs a new page raises SQLITE_FULL. T07 fault injection
   * uses it to prove that a full disk stops paid work through the real SQLite
   * error path instead of a mock.
   */
  capStorageToCurrentPages(): void {
    this.guard("capStorageToCurrentPages", () => {
      // VACUUM drops the free pages first, so the cap is the real used size and
      // the next row that needs a page raises SQLITE_FULL.
      this.db.exec("VACUUM;");
      const row = this.db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined;
      const pages = Number(row?.page_count ?? 0);
      if (!Number.isFinite(pages) || pages <= 0) {
        throw new OmniWatchError("storage_unavailable", "nie mozna ustalic rozmiaru bazy SQLite");
      }
      this.db.exec(`PRAGMA max_page_count = ${pages};`);
    });
  }

  /* --------------------------------------------------------------- helpers -- */

  private storageError(label: string, error: unknown, operationId?: string): OmniWatchError {
    if (error instanceof OmniWatchError) return error;
    const detail = messageOf(error);
    const suffix = isBusy(error)
      ? "baza jest zajeta przez inny proces; ponow po zakonczeniu tamtej transakcji"
      : detail;
    return new OmniWatchError("storage_unavailable", `${label}: ${suffix}`, {
      operationId,
      cause: error,
      action: {
        label: "sprawdz katalog danych OmniWatch i wolne miejsce na dysku",
        kind: "check_operation",
      },
    });
  }

  private guard<T>(label: string, fn: () => T, operationId?: string): T {
    if (this.closed) {
      throw new OmniWatchError(
        "storage_unavailable",
        `magazyn stanu jest zamkniety (${label}); ten runtime nie trzyma kopii stanu w pamieci`,
        {
          operationId,
          action: { label: "uruchom proces roboczy ponownie", kind: "check_operation" },
        },
      );
    }
    try {
      return fn();
    } catch (error) {
      throw this.storageError(label, error, operationId);
    }
  }

  private transaction<T>(label: string, fn: () => T, operationId?: string): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      let rollbackFailure: unknown;
      try {
        this.db.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        rollbackFailure = rollbackError;
      }
      // SQLite aborts the transaction itself on SQLITE_FULL / SQLITE_IOERR, so
      // "no transaction is active" is the expected follow-up, not a new fault.
      const rollbackWasAlreadyDone =
        rollbackFailure !== undefined && /no transaction is active/i.test(messageOf(rollbackFailure));
      if (rollbackFailure !== undefined && !rollbackWasAlreadyDone) {
        throw this.storageError(
          `${label} (rollback rowniez sie nie powiodl: ${messageOf(rollbackFailure)})`,
          error,
          operationId,
        );
      }
      throw this.storageError(label, error, operationId);
    }
  }

  private now(): string {
    return this.nowFn();
  }

  private requireOperationRow(operationId: string): OperationRow {
    const row = this.db
      .prepare("SELECT * FROM operations WHERE id = ?")
      .get(operationId) as OperationRow | undefined;
    if (!row) {
      throw new OmniWatchError("invalid_input", `operacja ${operationId} nie istnieje w magazynie stanu`, {
        operationId,
      });
    }
    return row;
  }

  private requireDeliveryRow(deliveryId: string): DeliveryRow {
    const row = this.db
      .prepare("SELECT * FROM deliveries WHERE id = ?")
      .get(deliveryId) as DeliveryRow | undefined;
    if (!row) {
      throw new OmniWatchError("invalid_input", `dostarczenie ${deliveryId} nie istnieje w magazynie stanu`);
    }
    return row;
  }

  private mapOperation(row: OperationRow): Operation {
    return {
      id: row.id,
      analysisKey: row.analysis_key,
      request: parseJson<AnalysisRequest>(row.request_json, "operations.request_json", row.id),
      state: row.state as OperationState,
      errorClass: (row.error_class as ErrorClass | null) ?? null,
      errorMessage: row.error_message ?? null,
      runId: row.run_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapAttempt(row: AttemptRow): AttemptRecord {
    return {
      id: row.id,
      operationId: row.operation_id,
      phase: row.phase as AttemptPhase,
      partIndex: Number(row.part_index),
      model: row.model ?? null,
      requestSummary: row.request_summary ?? null,
      responseSummary: row.response_summary ?? null,
      usage: row.usage_json === null ? null : parseJson<Usage>(row.usage_json, "attempts.usage_json"),
      createdAt: row.created_at,
    };
  }

  private mapDelivery(row: DeliveryRow): DeliveryRecord {
    return {
      id: row.id,
      operationId: row.operation_id,
      analysisId: row.analysis_id,
      state: row.state as DeliveryRecord["state"],
      payloadPath: null,
      memoryRef:
        row.memory_ref_json === null
          ? null
          : parseJson<MemoryRef>(row.memory_ref_json, "deliveries.memory_ref_json"),
      errorMessage: row.error_message ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Extra (non-port) field used by the delivery helpers. */
  getDeliveryAttemptCount(deliveryId: string): number {
    return this.guard("getDeliveryAttemptCount", () => Number(this.requireDeliveryRow(deliveryId).attempt_count));
  }

  /**
   * Records that a delivery attempt is starting, *before* the knowledge
   * adapter is called. A crash inside that call therefore still leaves
   * `attempt_count > 0`, which tells the retry to look the note up by analysis
   * id instead of writing a second file.
   */
  beginDeliveryAttempt(deliveryId: string): number {
    return this.guard(
      "beginDeliveryAttempt",
      () =>
        this.transaction("beginDeliveryAttempt", () => {
          const current = this.requireDeliveryRow(deliveryId);
          const attemptCount = Number(current.attempt_count) + 1;
          this.db
            .prepare("UPDATE deliveries SET attempt_count = ?, updated_at = ? WHERE id = ?")
            .run(attemptCount, this.now(), deliveryId);
          return attemptCount;
        }),
      deliveryId,
    );
  }

  private mapRun(row: RunRow): RunRecord {
    return {
      id: row.id,
      collectionId: row.collection_id,
      trigger: row.trigger as RunRecord["trigger"],
      state: row.state as RunRecord["state"],
      settings: parseJson<ScanSettings>(row.settings_json, "runs.settings_json"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? null,
    };
  }

  private mapRunItem(row: RunItemRow): RunItem {
    return {
      runId: row.run_id,
      ordinal: Number(row.ordinal),
      sourceRef: parseJson<SourceRef>(row.source_ref_json, "run_items.source_ref_json"),
      operationId: row.operation_id,
      state: row.state as RunItemState,
      title: row.title ?? null,
      updatedAt: row.updated_at,
    };
  }

  private mapReport(row: ReportRow): ScanReport {
    return {
      id: row.id,
      runId: row.run_id,
      state: row.state as ScanReport["state"],
      newAnalyses: Number(row.new_analyses),
      failedItems: Number(row.failed_items),
      pendingItems: Number(row.pending_items),
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapTurn(row: TurnRow): ConversationTurn {
    return {
      turnId: row.turn_id,
      conversationId: row.conversation_id,
      parentTurnId: row.parent_turn_id ?? null,
      role: row.role as ConversationTurn["role"],
      mode: row.mode as Mode,
      text: row.text,
      createdAt: row.created_at,
    };
  }

  /* ------------------------------------------------------------ operations -- */

  claimOperation(input: ClaimOperationInput): ClaimOperationResult {
    return this.guard(
      "claimOperation",
      () =>
        this.transaction("claimOperation", () => {
          const analysisKey = input?.analysisKey;
          if (typeof analysisKey !== "string" || analysisKey.length === 0) {
            throw new OmniWatchError("invalid_input", "claimOperation wymaga niepustego analysisKey");
          }
          const existing = this.findOperationByKey(analysisKey);
          if (existing) return { operation: existing, created: false };

          const id = operationIdForAnalysisKey(analysisKey);
          const now = this.now();
          try {
            this.db
              .prepare(
                `INSERT INTO operations
                   (id, analysis_key, request_json, state, error_class, error_message, run_id, execution_snapshot_json, created_at, updated_at)
                 VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, ?)`,
              )
              .run(
                id,
                analysisKey,
                JSON.stringify(input.request),
                input.runId ?? null,
                null,
                now,
                now,
              );
          } catch (error) {
            if (isUniqueViolation(error)) {
              const raced = this.findOperationByKey(analysisKey);
              if (raced) return { operation: raced, created: false };
            }
            throw error;
          }
          return { operation: this.mapOperation(this.requireOperationRow(id)), created: true };
        }),
      undefined,
    );
  }

  private findOperationByKey(analysisKey: string): Operation | null {
    const row = this.db
      .prepare("SELECT * FROM operations WHERE analysis_key = ?")
      .get(analysisKey) as OperationRow | undefined;
    return row ? this.mapOperation(row) : null;
  }

  getOperation(operationId: string): Operation | null {
    return this.guard("getOperation", () => {
      const row = this.db
        .prepare("SELECT * FROM operations WHERE id = ?")
        .get(operationId) as OperationRow | undefined;
      return row ? this.mapOperation(row) : null;
    });
  }

  getOperationByKey(analysisKey: string): Operation | null {
    return this.guard("getOperationByKey", () => this.findOperationByKey(analysisKey));
  }

  listOperations(filter?: { state?: Operation["state"]; limit?: number }): Operation[] {
    return this.guard("listOperations", () => {
      const limit = clampLimit(filter?.limit, 100);
      const rows = (
        filter?.state
          ? this.db
              .prepare(
                "SELECT * FROM operations WHERE state = ? ORDER BY created_at ASC, id ASC LIMIT ?",
              )
              .all(filter.state, limit)
          : this.db
              .prepare("SELECT * FROM operations ORDER BY created_at ASC, id ASC LIMIT ?")
              .all(limit)
      ) as unknown as OperationRow[];
      return rows.map((row) => this.mapOperation(row));
    });
  }

  setOperationState(
    operationId: string,
    state: Operation["state"],
    patch?: { errorClass?: ErrorClass | null; errorMessage?: string | null },
  ): void {
    this.guard(
      "setOperationState",
      () =>
        this.transaction(
          "setOperationState",
          () => {
            const current = this.requireOperationRow(operationId);
            const transition = classifyTransition(current.state as OperationState, state);
            if (transition === "refused") {
              throw new OmniWatchError(
                "invalid_input",
                `przejscie stanu operacji ${operationId} z "${current.state}" do "${state}" jest niedozwolone`,
                { operationId, action: { label: "odczytaj ponownie stan operacji", kind: "check_operation" } },
              );
            }
            const clearsErrors =
              state === "pending" || state === "running" || state === "result_ready" || state === "delivered";
            const errorClass =
              patch && "errorClass" in patch
                ? (patch.errorClass ?? null)
                : clearsErrors
                  ? null
                  : current.error_class;
            const errorMessage =
              patch && "errorMessage" in patch
                ? (patch.errorMessage ?? null)
                : clearsErrors
                  ? null
                  : current.error_message;
            const result = this.db
              .prepare(
                `UPDATE operations
                    SET state = ?, error_class = ?, error_message = ?, updated_at = ?
                  WHERE id = ? AND state = ?`,
              )
              .run(state, errorClass, errorMessage, this.now(), operationId, current.state);
            if (Number(result.changes) !== 1) {
              throw new OmniWatchError(
                "storage_unavailable",
                `stan operacji ${operationId} zmienil sie rownolegle; zapis odrzucony`,
                { operationId, action: { label: "odczytaj ponownie stan operacji", kind: "check_operation" } },
              );
            }
          },
          operationId,
        ),
      operationId,
    );
  }

  attachOperationToRun(operationId: string, runId: string, ordinal: number): void {
    this.guard(
      "attachOperationToRun",
      () =>
        this.transaction(
          "attachOperationToRun",
          () => {
            const operation = this.requireOperationRow(operationId);
            const request = parseJson<AnalysisRequest>(
              operation.request_json,
              "operations.request_json",
              operationId,
            );
            const now = this.now();
            this.db
              .prepare(
                `INSERT INTO run_items (run_id, ordinal, source_id, source_ref_json, operation_id, state, title, updated_at)
                 VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)
                 ON CONFLICT(run_id, ordinal) DO UPDATE SET
                   source_id = excluded.source_id,
                   source_ref_json = excluded.source_ref_json,
                   operation_id = excluded.operation_id,
                   updated_at = excluded.updated_at`,
              )
              .run(
                runId,
                Math.trunc(ordinal),
                request.sourceRef.sourceId,
                JSON.stringify(request.sourceRef),
                operationId,
                now,
              );
            this.db
              .prepare("UPDATE operations SET run_id = COALESCE(run_id, ?), updated_at = ? WHERE id = ?")
              .run(runId, now, operationId);
          },
          operationId,
        ),
      operationId,
    );
  }

  /** D5 execution snapshot: model, parameters and prompt-version info per operation. */
  recordExecutionSnapshot(operationId: string, snapshot: Record<string, unknown>): void {
    this.guard(
      "recordExecutionSnapshot",
      () =>
        this.transaction(
          "recordExecutionSnapshot",
          () => {
            this.requireOperationRow(operationId);
            const serialized = JSON.stringify(snapshot);
            assertNoStoredSecrets("snapshotu wykonania", serialized);
            this.db
              .prepare("UPDATE operations SET execution_snapshot_json = ?, updated_at = ? WHERE id = ?")
              .run(serialized, this.now(), operationId);
          },
          operationId,
        ),
      operationId,
    );
  }

  getExecutionSnapshot(operationId: string): Record<string, unknown> | null {
    return this.guard("getExecutionSnapshot", () => {
      const row = this.requireOperationRow(operationId);
      return row.execution_snapshot_json === null
        ? null
        : parseJson<Record<string, unknown>>(
            row.execution_snapshot_json,
            "operations.execution_snapshot_json",
            operationId,
          );
    });
  }

  /* -------------------------------------------------------------- attempts -- */

  recordAttempt(record: Omit<AttemptRecord, "createdAt">): void {
    this.guard(
      "recordAttempt",
      () =>
        this.transaction(
          "recordAttempt",
          () => {
            this.requireOperationRow(record.operationId);
            const now = this.now();
            const existing = this.db
              .prepare("SELECT * FROM attempts WHERE id = ?")
              .get(record.id) as AttemptRow | undefined;
            const incomingRank = ATTEMPT_PHASE_RANK[record.phase] ?? 0;
            if (existing && (ATTEMPT_PHASE_RANK[existing.phase as AttemptPhase] ?? 0) > incomingRank) {
              // Never downgrade the journal: a later intent callback must not
              // erase the fact that the provider call already started.
              return;
            }
            this.db
              .prepare(
                `INSERT INTO attempts
                   (id, operation_id, phase, part_index, model, request_summary, response_summary, usage_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   phase = excluded.phase,
                   part_index = excluded.part_index,
                   model = COALESCE(excluded.model, attempts.model),
                   request_summary = COALESCE(excluded.request_summary, attempts.request_summary),
                   response_summary = COALESCE(excluded.response_summary, attempts.response_summary),
                   usage_json = COALESCE(excluded.usage_json, attempts.usage_json),
                   updated_at = excluded.updated_at`,
              )
              .run(
                record.id,
                record.operationId,
                record.phase,
                Math.trunc(record.partIndex),
                record.model ?? null,
                record.requestSummary ?? null,
                record.responseSummary ?? null,
                jsonOrNull(record.usage ?? null),
                existing?.created_at ?? now,
                now,
              );
          },
          record.operationId,
        ),
      record.operationId,
    );
  }

  listAttempts(operationId: string): AttemptRecord[] {
    return this.guard("listAttempts", () => {
      const rows = this.db
        .prepare("SELECT * FROM attempts WHERE operation_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(operationId) as unknown as AttemptRow[];
      return rows.map((row) => this.mapAttempt(row));
    });
  }

  /* ---------------------------------------------------------------- buffer -- */

  saveBuffer(operationId: string, payload: BufferPayload): void {
    this.guard(
      "saveBuffer",
      () =>
        this.transaction(
          "saveBuffer",
          () => {
            const operation = this.requireOperationRow(operationId);
            const result = payload?.result;
            if (!result || typeof result !== "object") {
              throw new OmniWatchError("invalid_input", "saveBuffer wymaga payload.result");
            }
            if (result.analysisKey !== operation.analysis_key) {
              throw new OmniWatchError(
                "invalid_input",
                `wynik nalezy do innego klucza analizy niz operacja ${operationId}; zapis odrzucony`,
                { operationId },
              );
            }
            const now = this.now();
            const existing = this.deliveryRowForOperation(operationId);
            if (existing) {
              this.db
                .prepare(
                  `UPDATE deliveries
                      SET payload_json = ?,
                          analysis_id = ?,
                          state = CASE WHEN state = 'confirmed' THEN 'confirmed' ELSE 'pending' END,
                          updated_at = ?
                    WHERE id = ?`,
                )
                .run(JSON.stringify(payload), result.analysisId, now, existing.id);
              return;
            }
            this.db
              .prepare(
                `INSERT INTO deliveries
                   (id, operation_id, analysis_id, state, payload_json, memory_ref_json, error_message, attempt_count, created_at, updated_at)
                 VALUES (?, ?, ?, 'pending', ?, NULL, NULL, 0, ?, ?)`,
              )
              .run(
                deliveryIdForAnalysisKey(operation.analysis_key),
                operationId,
                result.analysisId,
                JSON.stringify(payload),
                now,
                now,
              );
          },
          operationId,
        ),
      operationId,
    );
  }

  getBuffer(operationId: string): BufferPayload | null {
    return this.guard("getBuffer", () => {
      const row = this.deliveryRowForOperation(operationId);
      if (!row || row.payload_json === null) return null;
      return parseJson<BufferPayload>(row.payload_json, "deliveries.payload_json", operationId);
    });
  }

  clearBuffer(operationId: string): void {
    this.guard(
      "clearBuffer",
      () =>
        this.transaction(
          "clearBuffer",
          () => {
            this.db
              .prepare("UPDATE deliveries SET payload_json = NULL, updated_at = ? WHERE operation_id = ?")
              .run(this.now(), operationId);
          },
          operationId,
        ),
      operationId,
    );
  }

  /* -------------------------------------------------------------- delivery -- */

  private deliveryRowForOperation(operationId: string): DeliveryRow | undefined {
    return this.db
      .prepare("SELECT * FROM deliveries WHERE operation_id = ?")
      .get(operationId) as DeliveryRow | undefined;
  }

  createDelivery(record: Omit<DeliveryRecord, "createdAt" | "updatedAt">): DeliveryRecord {
    return this.guard(
      "createDelivery",
      () =>
        this.transaction(
          "createDelivery",
          () => {
            this.requireOperationRow(record.operationId);
            const now = this.now();
            const existing = this.deliveryRowForOperation(record.operationId);
            if (existing) {
              // Delivery identity is the operation: a duplicate create is an
              // idempotent merge, never a second record.
              this.db
                .prepare(
                  `UPDATE deliveries
                      SET state = CASE WHEN state = 'confirmed' THEN 'confirmed' ELSE ? END,
                          analysis_id = ?,
                          memory_ref_json = COALESCE(?, memory_ref_json),
                          error_message = COALESCE(?, error_message),
                          updated_at = ?
                    WHERE id = ?`,
                )
                .run(
                  record.state,
                  record.analysisId,
                  jsonOrNull(record.memoryRef),
                  record.errorMessage ?? null,
                  now,
                  existing.id,
                );
              return this.mapDelivery(this.requireDeliveryRow(existing.id));
            }
            this.db
              .prepare(
                `INSERT INTO deliveries
                   (id, operation_id, analysis_id, state, payload_json, memory_ref_json, error_message, attempt_count, created_at, updated_at)
                 VALUES (?, ?, ?, ?, NULL, ?, ?, 0, ?, ?)`,
              )
              .run(
                record.id,
                record.operationId,
                record.analysisId,
                record.state,
                jsonOrNull(record.memoryRef),
                record.errorMessage ?? null,
                now,
                now,
              );
            return this.mapDelivery(this.requireDeliveryRow(record.id));
          },
          record.operationId,
        ),
      record.operationId,
    );
  }

  getDelivery(deliveryId: string): DeliveryRecord | null {
    return this.guard("getDelivery", () => {
      const row = this.db
        .prepare("SELECT * FROM deliveries WHERE id = ?")
        .get(deliveryId) as DeliveryRow | undefined;
      return row ? this.mapDelivery(row) : null;
    });
  }

  getDeliveryForOperation(operationId: string): DeliveryRecord | null {
    return this.guard("getDeliveryForOperation", () => {
      const row = this.deliveryRowForOperation(operationId);
      return row ? this.mapDelivery(row) : null;
    });
  }

  updateDelivery(
    deliveryId: string,
    patch: { state?: DeliveryRecord["state"]; memoryRef?: MemoryRef | null; errorMessage?: string | null },
  ): void {
    this.guard(
      "updateDelivery",
      () =>
        this.transaction("updateDelivery", () => {
          const current = this.requireDeliveryRow(deliveryId);
          const requested = "state" in patch && patch.state ? patch.state : current.state;
          // A confirmed delivery is never reopened.
          const nextState = current.state === "confirmed" ? "confirmed" : requested;
          const keepMemoryRef = !("memoryRef" in patch) && current.memory_ref_json !== null;
          const memoryRef = "memoryRef" in patch ? (patch.memoryRef ?? null) : null;
          const errorMessage =
            "errorMessage" in patch ? (patch.errorMessage ?? null) : current.error_message;
          // Attempt counting happens in beginDeliveryAttempt, before the
          // adapter call, so an interrupted write is still visible on retry.
          const attemptCount = Number(current.attempt_count);
          const now = this.now();
          if (keepMemoryRef) {
            this.db
              .prepare(
                `UPDATE deliveries
                    SET state = ?, error_message = ?, attempt_count = ?, updated_at = ?
                  WHERE id = ?`,
              )
              .run(nextState, errorMessage, attemptCount, now, deliveryId);
          } else {
            this.db
              .prepare(
                `UPDATE deliveries
                    SET state = ?, memory_ref_json = ?, error_message = ?, attempt_count = ?, updated_at = ?
                  WHERE id = ?`,
              )
              .run(nextState, jsonOrNull(memoryRef), errorMessage, attemptCount, now, deliveryId);
          }
          if (nextState === "confirmed") {
            // Confirmed delivery => finished operation, in the same transaction.
            this.db
              .prepare(
                `UPDATE operations
                    SET state = 'delivered', error_class = NULL, error_message = NULL, updated_at = ?
                  WHERE id = ? AND state <> 'delivered'`,
              )
              .run(now, current.operation_id);
          }
        }),
      deliveryId,
    );
  }

  listPendingDeliveries(limit?: number): DeliveryRecord[] {
    return this.guard("listPendingDeliveries", () => {
      const rows = this.db
        .prepare(
          "SELECT * FROM deliveries WHERE state = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT ?",
        )
        .all(clampLimit(limit, DELIVERY_PAGE_DEFAULT)) as unknown as DeliveryRow[];
      return rows.map((row) => this.mapDelivery(row));
    });
  }

  /* ----------------------------------------------------------- conversations -- */

  ensureConversation(conversationId: string, sourceRef: SourceRef): void {
    this.guard(
      "ensureConversation",
      () =>
        this.transaction("ensureConversation", () => {
          this.db
            .prepare(
              "INSERT INTO conversations (id, source_ref_json, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
            )
            .run(conversationId, JSON.stringify(sourceRef), this.now());
        }),
      undefined,
    );
  }

  appendTurn(turn: ConversationTurn): void {
    this.guard(
      "appendTurn",
      () =>
        this.transaction("appendTurn", () => {
          if (turn.parentTurnId !== null && turn.parentTurnId !== undefined) {
            const parent = this.db
              .prepare("SELECT conversation_id FROM conversation_turns WHERE turn_id = ?")
              .get(turn.parentTurnId) as { conversation_id?: string } | undefined;
            if (!parent) {
              throw new OmniWatchError(
                "invalid_input",
                `turn ${turn.turnId} wskazuje nieistniejacy parentTurnId ${turn.parentTurnId}`,
              );
            }
            if (parent.conversation_id !== turn.conversationId) {
              throw new OmniWatchError(
                "invalid_input",
                `turn ${turn.turnId} wskazuje parenta z innej rozmowy niz ${turn.conversationId}`,
              );
            }
          }
          // Idempotent by turn identity and by "one assistant answer per user
          // turn" (the partial unique index in schema.ts).
          this.db
            .prepare(
              `INSERT INTO conversation_turns
                 (turn_id, conversation_id, parent_turn_id, role, mode, text, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT DO NOTHING`,
            )
            .run(
              turn.turnId,
              turn.conversationId,
              turn.parentTurnId ?? null,
              turn.role,
              turn.mode,
              turn.text,
              turn.createdAt,
            );
        }),
      undefined,
    );
  }

  listTurns(conversationId: string, limit?: number): ConversationTurn[] {
    return this.guard("listTurns", () => {
      const capped = clampLimit(limit, TURN_PAGE_DEFAULT);
      const rows = this.db
        .prepare(
          `SELECT * FROM (
             SELECT rowid AS _rowid, * FROM conversation_turns
              WHERE conversation_id = ?
              ORDER BY created_at DESC, rowid DESC
              LIMIT ?
           ) ORDER BY created_at ASC, _rowid ASC`,
        )
        .all(conversationId, capped) as unknown as TurnRow[];
      return rows.map((row) => this.mapTurn(row));
    });
  }

  getTurn(turnId: string): ConversationTurn | null {
    return this.guard("getTurn", () => {
      const row = this.db
        .prepare("SELECT * FROM conversation_turns WHERE turn_id = ?")
        .get(turnId) as TurnRow | undefined;
      return row ? this.mapTurn(row) : null;
    });
  }

  /* ------------------------------------------------------------------ runs -- */

  createRun(run: Omit<RunRecord, "createdAt" | "updatedAt">): RunRecord {
    return this.guard(
      "createRun",
      () =>
        this.transaction("createRun", () => {
          const now = this.now();
          this.db
            .prepare(
              `INSERT INTO collections (id, settings_json, created_at, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
            )
            .run(
              run.collectionId,
              JSON.stringify(run.settings),
              now,
              now,
            );
          this.db
            .prepare(
              `INSERT INTO runs (id, collection_id, trigger, state, settings_json, created_at, updated_at, completed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 state = excluded.state,
                 settings_json = excluded.settings_json,
                 updated_at = excluded.updated_at`,
            )
            .run(
              run.id,
              run.collectionId,
              run.trigger,
              run.state,
              JSON.stringify(run.settings),
              now,
              now,
              run.completedAt ?? null,
            );
          const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(run.id) as unknown as RunRow;
          return this.mapRun(row);
        }),
      undefined,
    );
  }

  getRun(runId: string): RunRecord | null {
    return this.guard("getRun", () => {
      const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
      return row ? this.mapRun(row) : null;
    });
  }

  updateRun(runId: string, patch: { state?: RunRecord["state"]; completedAt?: string | null }): void {
    this.guard(
      "updateRun",
      () =>
        this.transaction("updateRun", () => {
          const current = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
            | RunRow
            | undefined;
          if (!current) {
            throw new OmniWatchError("invalid_input", `przebieg ${runId} nie istnieje`);
          }
          const completedAt = "completedAt" in patch ? (patch.completedAt ?? null) : current.completed_at;
          this.db
            .prepare("UPDATE runs SET state = ?, completed_at = ?, updated_at = ? WHERE id = ?")
            .run(patch.state ?? current.state, completedAt, this.now(), runId);
        }),
      undefined,
    );
  }

  addRunItem(item: Omit<RunItem, "updatedAt">): void {
    this.guard(
      "addRunItem",
      () =>
        this.transaction(
          "addRunItem",
          () => {
            this.db
              .prepare(
                `INSERT INTO run_items (run_id, ordinal, source_id, source_ref_json, operation_id, state, title, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(run_id, ordinal) DO UPDATE SET
                   source_id = excluded.source_id,
                   source_ref_json = excluded.source_ref_json,
                   operation_id = excluded.operation_id,
                   state = excluded.state,
                   title = COALESCE(excluded.title, run_items.title),
                   updated_at = excluded.updated_at`,
              )
              .run(
                item.runId,
                Math.trunc(item.ordinal),
                item.sourceRef.sourceId,
                JSON.stringify(item.sourceRef),
                item.operationId,
                item.state,
                item.title ?? null,
                this.now(),
              );
          },
          item.operationId,
        ),
      item.operationId,
    );
  }

  updateRunItem(
    runId: string,
    ordinal: number,
    patch: { state?: RunItemState; title?: string | null },
  ): void {
    this.guard(
      "updateRunItem",
      () =>
        this.transaction("updateRunItem", () => {
          const current = this.db
            .prepare("SELECT * FROM run_items WHERE run_id = ? AND ordinal = ?")
            .get(runId, Math.trunc(ordinal)) as RunItemRow | undefined;
          if (!current) {
            throw new OmniWatchError(
              "invalid_input",
              `pozycja ${ordinal} przebiegu ${runId} nie istnieje`,
            );
          }
          const title = "title" in patch ? (patch.title ?? null) : current.title;
          this.db
            .prepare("UPDATE run_items SET state = ?, title = ?, updated_at = ? WHERE run_id = ? AND ordinal = ?")
            .run(patch.state ?? current.state, title, this.now(), runId, Math.trunc(ordinal));
        }),
      undefined,
    );
  }

  listRunItems(
    runId: string,
    page?: { offset?: number; limit?: number },
  ): { items: RunItem[]; total: number } {
    return this.guard("listRunItems", () => {
      const offset = Math.max(0, Math.trunc(page?.offset ?? 0));
      const limit = clampLimit(page?.limit, RUN_ITEM_PAGE_DEFAULT);
      const totalRow = this.db
        .prepare("SELECT COUNT(*) AS total FROM run_items WHERE run_id = ?")
        .get(runId) as { total: number };
      const rows = this.db
        .prepare("SELECT * FROM run_items WHERE run_id = ? ORDER BY ordinal ASC LIMIT ? OFFSET ?")
        .all(runId, limit, offset) as unknown as RunItemRow[];
      return { items: rows.map((row) => this.mapRunItem(row)), total: Number(totalRow.total) };
    });
  }

  findRunItemBySource(runId: string, sourceId: string): RunItem | null {
    return this.guard("findRunItemBySource", () => {
      const row = this.db
        .prepare("SELECT * FROM run_items WHERE run_id = ? AND source_id = ? ORDER BY ordinal ASC LIMIT 1")
        .get(runId, sourceId) as RunItemRow | undefined;
      return row ? this.mapRunItem(row) : null;
    });
  }

  /* --------------------------------------------------------------- reports -- */

  createReport(report: Omit<ScanReport, "createdAt" | "updatedAt">): ScanReport {
    return this.guard(
      "createReport",
      () =>
        this.transaction("createReport", () => {
          const now = this.now();
          this.db
            .prepare(
              `INSERT INTO reports
                 (id, run_id, state, new_analyses, failed_items, pending_items, summary, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 state = CASE WHEN reports.state = 'confirmed' THEN 'confirmed' ELSE excluded.state END,
                 new_analyses = excluded.new_analyses,
                 failed_items = excluded.failed_items,
                 pending_items = excluded.pending_items,
                 summary = excluded.summary,
                 updated_at = excluded.updated_at`,
            )
            .run(
              report.id,
              report.runId,
              report.state,
              Math.trunc(report.newAnalyses),
              Math.trunc(report.failedItems),
              Math.trunc(report.pendingItems),
              report.summary,
              now,
              now,
            );
          const row = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(report.id) as unknown as ReportRow;
          return this.mapReport(row);
        }),
      undefined,
    );
  }

  getReport(reportId: string): ScanReport | null {
    return this.guard("getReport", () => {
      const row = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId) as
        | ReportRow
        | undefined;
      return row ? this.mapReport(row) : null;
    });
  }

  updateReport(reportId: string, patch: { state?: ScanReport["state"]; summary?: string }): void {
    this.guard(
      "updateReport",
      () =>
        this.transaction("updateReport", () => {
          const current = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId) as
            | ReportRow
            | undefined;
          if (!current) {
            throw new OmniWatchError("invalid_input", `raport ${reportId} nie istnieje`);
          }
          // A confirmed report is never moved back to pending by a late retry.
          const nextState =
            current.state === "confirmed" ? "confirmed" : (patch.state ?? current.state);
          const summary = patch.summary ?? current.summary;
          this.db
            .prepare("UPDATE reports SET state = ?, summary = ?, updated_at = ? WHERE id = ?")
            .run(nextState, summary, this.now(), reportId);
        }),
      undefined,
    );
  }

  listReports(filter?: { state?: ScanReport["state"]; runId?: string; limit?: number }): ScanReport[] {
    return this.guard("listReports", () => {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (filter?.state) {
        clauses.push("state = ?");
        params.push(filter.state);
      }
      if (filter?.runId) {
        clauses.push("run_id = ?");
        params.push(filter.runId);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.db
        .prepare(`SELECT * FROM reports ${where} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
        .all(...params, clampLimit(filter?.limit, DELIVERY_PAGE_DEFAULT)) as unknown as ReportRow[];
      return rows.map((row) => this.mapReport(row));
    });
  }

  /* --------------------------------------------------------------- owner ---- */

  acquireOwner(token: string, pid: number, now: string): boolean {
    return this.guard(
      "acquireOwner",
      () =>
        this.transaction("acquireOwner", () => {
          const row = this.db.prepare("SELECT * FROM runtime_owner WHERE id = 1").get() as
            | OwnerRow
            | undefined;
          if (!row) {
            this.db
              .prepare(
                "INSERT INTO runtime_owner (id, token, pid, heartbeat_at, acquired_at) VALUES (1, ?, ?, ?, ?)",
              )
              .run(token, Math.trunc(pid), now, now);
            return true;
          }
          if (row.token === token) {
            this.db
              .prepare("UPDATE runtime_owner SET pid = ?, heartbeat_at = ? WHERE id = 1")
              .run(Math.trunc(pid), now);
            return true;
          }
          if (isHeartbeatStale(row.heartbeat_at, now, this.ownerStaleAfterMs)) {
            this.db
              .prepare("UPDATE runtime_owner SET token = ?, pid = ?, heartbeat_at = ?, acquired_at = ? WHERE id = 1")
              .run(token, Math.trunc(pid), now, now);
            return true;
          }
          return false;
        }),
      undefined,
    );
  }

  heartbeat(token: string, now: string): boolean {
    return this.guard("heartbeat", () => {
      const result = this.db
        .prepare("UPDATE runtime_owner SET heartbeat_at = ? WHERE id = 1 AND token = ?")
        .run(now, token);
      return Number(result.changes) === 1;
    });
  }

  releaseOwner(token: string): void {
    this.guard(
      "releaseOwner",
      () => {
        this.db.prepare("DELETE FROM runtime_owner WHERE id = 1 AND token = ?").run(token);
      },
      undefined,
    );
  }

  getOwner(): { token: string; pid: number; heartbeatAt: string } | null {
    return this.guard("getOwner", () => {
      const row = this.db.prepare("SELECT * FROM runtime_owner WHERE id = 1").get() as
        | OwnerRow
        | undefined;
      return row ? { token: row.token, pid: Number(row.pid), heartbeatAt: row.heartbeat_at } : null;
    });
  }

  /* ---------------------------------------------------------- collections ---- */

  saveCollectionSettings(settings: ScanSettings): void {
    this.guard(
      "saveCollectionSettings",
      () =>
        this.transaction("saveCollectionSettings", () => {
          const now = this.now();
          this.db
            .prepare(
              `INSERT INTO collections (id, settings_json, created_at, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
            )
            .run(settings.collectionId, JSON.stringify(settings), now, now);
        }),
      undefined,
    );
  }

  getCollectionSettings(collectionId: string): ScanSettings | null {
    return this.guard("getCollectionSettings", () => {
      const row = this.db
        .prepare("SELECT settings_json FROM collections WHERE id = ?")
        .get(collectionId) as { settings_json?: string } | undefined;
      return row?.settings_json
        ? parseJson<ScanSettings>(row.settings_json, "collections.settings_json")
        : null;
    });
  }

  listCollectionIds(): string[] {
    return this.guard("listCollectionIds", () => {
      const rows = this.db.prepare("SELECT id FROM collections ORDER BY id ASC").all() as Array<{
        id: string;
      }>;
      return rows.map((row) => row.id);
    });
  }

  markSeenSource(
    collectionId: string,
    sourceId: string,
    mode: Mode,
    focus: string,
    question: string,
    language: string,
  ): void {
    this.guard(
      "markSeenSource",
      () =>
        this.transaction("markSeenSource", () => {
          const now = this.now();
          this.db
            .prepare(
              `INSERT INTO seen_sources
                 (collection_id, source_id, mode, focus, question, language, first_seen_at, last_seen_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(collection_id, source_id, mode, focus, question, language)
               DO UPDATE SET last_seen_at = excluded.last_seen_at`,
            )
            .run(
              collectionId,
              sourceId,
              mode,
              normalizeSeenText(focus),
              normalizeSeenText(question),
              normalizeSeenText(language).toLowerCase(),
              now,
              now,
            );
        }),
      undefined,
    );
  }

  isSourceSeen(
    collectionId: string,
    sourceId: string,
    mode: Mode,
    focus: string,
    question: string,
    language: string,
  ): boolean {
    return this.guard("isSourceSeen", () => {
      const row = this.db
        .prepare(
          `SELECT 1 AS found FROM seen_sources
            WHERE collection_id = ? AND source_id = ? AND mode = ? AND focus = ? AND question = ? AND language = ?
            LIMIT 1`,
        )
        .get(
          collectionId,
          sourceId,
          mode,
          normalizeSeenText(focus),
          normalizeSeenText(question),
          normalizeSeenText(language).toLowerCase(),
        ) as { found?: number } | undefined;
      return row !== undefined;
    });
  }
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const truncated = Math.trunc(value);
  if (truncated <= 0) return fallback;
  return Math.min(truncated, 1000);
}

/** True when the owner heartbeat is older than the takeover window (D5). */
export function isHeartbeatStale(heartbeatAt: string, now: string, staleAfterMs: number): boolean {
  const heartbeat = Date.parse(heartbeatAt);
  const reference = Date.parse(now);
  if (Number.isNaN(heartbeat) || Number.isNaN(reference)) return false;
  return reference - heartbeat > staleAfterMs;
}

/**
 * Convenience factory: opens the database and applies pending migrations in
 * one step. The port also exposes `migrate()` for callers that need to control
 * when schema work happens (D5: migrations run with stopped consumers).
 */
export function openSqliteStore(options: SqliteStoreOptions): SqliteStore {
  const store = new SqliteStore(options);
  store.migrate();
  return store;
}

export function newToken(prefix = "owner"): string {
  return `${prefix}_${randomUUID()}`;
}
