/**
 * Adapter ports (T0). The core analysis module never imports SQLite, the Vault,
 * Next.js, Hermes or film-production code; it receives these ports explicitly
 * (TECHNICAL "Granice kodu i pakowanie").
 */

import type {
  AnalysisRequest,
  AnalysisResult,
  AttemptRecord,
  ClockPort,
  ConversationTurn,
  DeliveryRecord,
  ErrorClass,
  ListingPage,
  LoggerPort,
  MediaInfo,
  MediaPart,
  MemoryRef,
  Mode,
  Operation,
  RunItem,
  RunRecord,
  ScanReport,
  ScanSettings,
  SourceCapabilities,
  SourceRef,
  Usage,
} from "./types.ts";

/* ------------------------------------------------------------------ model ---- */

export interface ModelMessage {
  role: "system" | "user";
  text: string;
}

export interface ModelCallRequest {
  operationId: string;
  attemptId: string;
  partIndex: number;
  messages: ModelMessage[];
  /** Local media the model should inspect, when the provider supports it. */
  mediaParts: MediaPart[];
  language: string;
  maxOutputTokens?: number;
  /**
   * Optional hint, called once when the provider has STARTED answering (response
   * headers). The engine no longer gates new parts on it (LF2: the gate made long
   * films serial and did not prevent the provider's ~60 s pre-header close).
   */
  onResponseStarted?: () => void;
}

export interface ModelCallResponse {
  text: string;
  usage: Usage;
  /** True only when the provider protocol completed and the end marker was seen. */
  completed: boolean;
  /** Safe transport diagnostics only; never a raw error message or request URL. */
  failureDetail?: string;
}

/**
 * Publishes attempt lifecycle events before and after a paid call (D3).
 * Implementations must persist the intent before the provider call is issued.
 */
export interface AttemptSink {
  intent(record: Omit<AttemptRecord, "createdAt">): Promise<void>;
  started(attemptId: string, meta?: Record<string, unknown>): Promise<void>;
  response(attemptId: string, response: ModelCallResponse): Promise<void>;
  /**
   * `deferOperationState` (LF2): the engine resends this call right away under its
   * bounded resend policy, or folds it into the call's own outcome (a rejected resend
   * after a pre-header close stays unknown). The attempt is journaled as usual, but the
   * OPERATION state is left to the run's final outcome - a part that answers on the
   * resend must not leave the operation stuck in outcome_unknown/failed. A crash before
   * the resend is still recovered from the journal (last attempt unknown ->
   * outcome_unknown; last attempt failed -> an unpaid retry).
   */
  unknown(attemptId: string, errorClass: ErrorClass, message: string, options?: AttemptOutcomeOptions): Promise<void>;
  failed(attemptId: string, errorClass: ErrorClass, message: string, options?: AttemptOutcomeOptions): Promise<void>;
}

export interface AttemptOutcomeOptions {
  deferOperationState?: boolean;
}

export interface ModelPort {
  readonly modelName: string;
  call(request: ModelCallRequest, sink: AttemptSink): Promise<ModelCallResponse>;
}

/* ----------------------------------------------------------------- source ---- */

export interface SourcePort {
  capabilities(source: SourceRef): SourceCapabilities;
  /** Resolve one pasted URL/local ref into a stable SourceRef. */
  resolve(input: { url: string }): Promise<SourceRef>;
  /** Prepare local media; never triggers a paid model call. */
  prepare(source: SourceRef, options?: { force?: boolean }): Promise<MediaInfo>;
  /** Split prepared media into analysable parts. */
  split(info: MediaInfo, options: { maxFramesPerPart: number }): Promise<MediaPart[]>;
  /** List an archive page. Undefined when the adapter has no listing capability. */
  list?(source: SourceRef, options: { cursor?: string | null; limit?: number }): Promise<ListingPage>;
}

/* ------------------------------------------------------------------ store ---- */

export interface ClaimOperationInput {
  request: AnalysisRequest;
  analysisKey: string;
  conversationContextKey?: string | null;
  runId?: string | null;
}

export interface ClaimOperationResult {
  operation: Operation;
  /** False when an identical operation already existed. */
  created: boolean;
}

export interface BufferPayload {
  result: AnalysisResult;
  writtenAt: string;
}

/**
 * Durable operational state (D3). Implemented with node:sqlite by T2.
 * Transactions are short: model calls and Vault writes happen outside them.
 */
export interface StorePort {
  migrate(): Promise<void> | void;
  close(): void;

  claimOperation(input: ClaimOperationInput): ClaimOperationResult;
  getOperation(operationId: string): Operation | null;
  getOperationByKey(analysisKey: string): Operation | null;
  listOperations(filter?: { state?: Operation["state"]; limit?: number }): Operation[];
  setOperationState(
    operationId: string,
    state: Operation["state"],
    patch?: { errorClass?: ErrorClass | null; errorMessage?: string | null },
  ): void;
  attachOperationToRun(operationId: string, runId: string, ordinal: number): void;

  recordAttempt(record: Omit<AttemptRecord, "createdAt">): void;
  listAttempts(operationId: string): AttemptRecord[];

  saveBuffer(operationId: string, payload: BufferPayload): void;
  getBuffer(operationId: string): BufferPayload | null;
  clearBuffer(operationId: string): void;

  createDelivery(record: Omit<DeliveryRecord, "createdAt" | "updatedAt">): DeliveryRecord;
  getDelivery(deliveryId: string): DeliveryRecord | null;
  getDeliveryForOperation(operationId: string): DeliveryRecord | null;
  updateDelivery(
    deliveryId: string,
    patch: { state?: DeliveryRecord["state"]; memoryRef?: MemoryRef | null; errorMessage?: string | null },
  ): void;
  listPendingDeliveries(limit?: number): DeliveryRecord[];

  appendTurn(turn: ConversationTurn): void;
  listTurns(conversationId: string, limit?: number): ConversationTurn[];
  getTurn(turnId: string): ConversationTurn | null;
  ensureConversation(conversationId: string, sourceRef: SourceRef): void;

  createRun(run: Omit<RunRecord, "createdAt" | "updatedAt">): RunRecord;
  getRun(runId: string): RunRecord | null;
  updateRun(runId: string, patch: { state?: RunRecord["state"]; completedAt?: string | null }): void;
  addRunItem(item: Omit<RunItem, "updatedAt">): void;
  updateRunItem(runId: string, ordinal: number, patch: { state?: RunItem["state"]; title?: string | null }): void;
  /** Paginated read; never returns the whole archive at once (D11). */
  listRunItems(runId: string, page?: { offset?: number; limit?: number }): { items: RunItem[]; total: number };
  findRunItemBySource(runId: string, sourceId: string): RunItem | null;

  createReport(report: Omit<ScanReport, "createdAt" | "updatedAt">): ScanReport;
  getReport(reportId: string): ScanReport | null;
  updateReport(reportId: string, patch: { state?: ScanReport["state"]; summary?: string }): void;
  listReports(filter?: { state?: ScanReport["state"]; runId?: string; limit?: number }): ScanReport[];

  /** Single-consumer ownership of a data directory (D5). */
  acquireOwner(token: string, pid: number, now: string): boolean;
  heartbeat(token: string, now: string): boolean;
  releaseOwner(token: string): void;
  getOwner(): { token: string; pid: number; heartbeatAt: string } | null;

  /** Settings snapshot for a collection; used by manual scans and Hermes. */
  saveCollectionSettings(settings: ScanSettings): void;
  getCollectionSettings(collectionId: string): ScanSettings | null;
  listCollectionIds(): string[];
  markSeenSource(collectionId: string, sourceId: string, mode: Mode, focus: string, question: string, language: string): void;
  isSourceSeen(collectionId: string, sourceId: string, mode: Mode, focus: string, question: string, language: string): boolean;
}

/* ----------------------------------------------------------------- memory ---- */

export interface MemoryWriteResult {
  memoryRef: MemoryRef;
  /** True when an identical note already existed (idempotent re-delivery). */
  reused: boolean;
}

export interface MemorySearchHit {
  analysisId: string;
  title: string;
  excerpt: string;
  relativePath: string;
}

export interface MemoryAnswer {
  text: string;
  refs: MemoryRef[];
  /** True when the answer states that nothing was found. */
  notFound: boolean;
}

/**
 * Host knowledge library (D7). Agent OS implements this over the configured
 * Obsidian Vault; standalone implements it over the existing local summaries.
 */
export interface MemoryPort {
  writeAnalysis(result: AnalysisResult): Promise<MemoryWriteResult>;
  readAnalysis(analysisId: string): Promise<{ result: AnalysisResult; memoryRef: MemoryRef } | null>;
  searchAnalyses(query: string, limit?: number): Promise<MemorySearchHit[]>;
  answerFromAnalyses(question: string, options?: { limit?: number }): Promise<MemoryAnswer>;
}

/* ------------------------------------------------------------------ config --- */

export interface ConfigPort {
  /** Local data directory holding state.sqlite and cache (outside the Vault). */
  dataDir: string;
  /** Knowledge library root: Vault for Agent OS, local summaries for standalone. */
  memoryRoot: string;
  language: string;
  modelName: string;
  /** Resolved only inside the process; never written to argv or SQLite. */
  apiKey(): string | null;
  apiBaseUrl(): string | null;
  maxFramesPerPart(): number;
  /** Parts of one film in flight at once (default DEFAULT_PART_CONCURRENCY). */
  partConcurrency?(): number;
  /**
   * Automatic resends of a call the provider closed before any response header
   * (default DEFAULT_PRE_HEADER_RETRIES = 2, capped at 3; 0 restores the strict
   * no-resend policy). Each resend is journaled as its own attempt.
   */
  preHeaderRetries?(): number;
  cacheHours(): number;
  /** Config location for spawned workers; non-secret. */
  configPath?: string;
}

export interface RuntimeDeps {
  clock: ClockPort;
  logger: LoggerPort;
  config: ConfigPort;
  store: StorePort;
  source: SourcePort;
  model: ModelPort;
  memory: MemoryPort;
}

export type { ClockPort, LoggerPort, Usage, SourceCapabilities, ListingPage, MediaInfo, MediaPart };
