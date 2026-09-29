/**
 * OmniWatch shared contracts (T0, frozen 2026-09-22).
 *
 * These types are the boundary between the analysis engine, the durable store,
 * the runtime, the host adapters and both delivery shells. They are versioned by
 * ANALYSIS_VERSION / CONTRACT_VERSION; a change here is a contract change that the
 * coordinator must accept before executors depend on it.
 *
 * Only erasable TypeScript syntax is used so Node 22 can execute the sources
 * directly during development and tests.
 */

export const CONTRACT_VERSION = "1.0.0";

/** Analysis contract version, included in `analysisKey`. */
export const ANALYSIS_VERSION = "analysis-v1";

/** Public analysis modes. Legacy capture modes live in the legacy adapter. */
export type Mode = "summary" | "teardown";

export type Platform = "youtube" | "tiktok" | "instagram" | "x" | "meta-ads" | "generic";

export type OperationState =
  | "pending"
  | "running"
  | "result_ready"
  | "delivered"
  | "failed"
  | "outcome_unknown"
  | "budget_paused";

export type DeliveryState = "pending" | "confirmed" | "failed" | "conflict";

export type RunState =
  | "pending"
  | "running"
  | "partial"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export type RunItemState = "pending" | "running" | "done" | "failed" | "skipped";

export type RunTrigger = "manual" | "schedule" | "cli";

export type ReportState = "pending" | "handed_off" | "confirmed" | "failed";

export type ListingCompleteness = "complete" | "partial" | "failed" | "empty";

export const ERROR_CLASSES = [
  "invalid_input",
  "missing_config",
  "source_unavailable",
  "rate_limited",
  "provider_rejected",
  "content_filtered",
  "outcome_unknown",
  "storage_unavailable",
  "delivery_conflict",
  "runtime_unavailable",
  "budget_paused",
  "incomplete_listing",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Stable identity of one analysed material. */
export interface SourceRef {
  platform: Platform;
  /** Provider id when the source exposes one, otherwise the canonical URL hash. */
  sourceId: string;
  /** Canonical URL with meaningful parameters preserved and fragments dropped. */
  canonicalUrl: string;
  /** Identifier used by the released Python beta, so old files stay addressable. */
  legacyId?: string;
}

export interface ConversationTurn {
  turnId: string;
  conversationId: string;
  parentTurnId: string | null;
  role: "user" | "assistant";
  mode: Mode;
  text: string;
  createdAt: string;
}

/**
 * One analysis request. Source and analysis parameters are immutable once the
 * operation is accepted (D3); a different focus/question is a different operation.
 */
export interface AnalysisRequest {
  sourceRef: SourceRef;
  mode: Mode;
  /** Optional subject the summary should focus on. Empty or null = general summary. */
  focus?: string | null;
  /** A concrete question. Further questions always map here with parentTurnId. */
  question?: string | null;
  language: string;
  analysisVersion: string;
  conversationId?: string | null;
  parentTurnId?: string | null;
  /** Explicit user request to recompute an already delivered analysis. */
  force?: boolean;
}

export interface Usage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Provider-reported cost when available. Never invent zero (D11). */
  costUsd?: number | null;
  costKnown: boolean;
  /**
   * Paid calls of this operation that were started but never confirmed, across all of
   * its runs (R3-03). A conscious retry reports `costKnown: true` and the cost of the
   * calls it confirmed — correct for what it bills, but it would read as the whole
   * story. When this is present the UI says "+ N calls of unknown cost" next to the
   * total, so a price is never presented as complete when an earlier run may also have
   * been charged. Absent (not 0) when there is nothing to report, so a note written
   * before this field existed serializes byte for byte as it did.
   */
  unknownCostCalls?: number;
}

export interface Highlight {
  /** Timestamp in seconds, and a human label such as "0:42". */
  seconds: number;
  label: string;
  note?: string;
}

export interface AnalysisResult {
  analysisId: string;
  analysisKey: string;
  mode: Mode;
  focus: string | null;
  question: string | null;
  language: string;
  analysisVersion: string;
  sourceRef: SourceRef;
  title: string;
  /** Markdown body of the answer. */
  content: string;
  highlights: Highlight[];
  conversationId: string;
  turnId: string;
  parentTurnId: string | null;
  parts: number;
  usage: Usage;
  createdAt: string;
  /** True when the model stream ended without a validated completion marker. */
  incomplete?: boolean;
}

export interface MemoryRef {
  analysisId: string;
  adapter: string;
  /** Path relative to the configured knowledge root; never a browser-supplied path. */
  relativePath: string;
  anchor?: string | null;
  fingerprint: string;
}

export interface Operation {
  id: string;
  analysisKey: string;
  request: AnalysisRequest;
  state: OperationState;
  errorClass?: ErrorClass | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  runId?: string | null;
}

export type AttemptPhase = "intent" | "started" | "response" | "unknown" | "failed";

export interface AttemptRecord {
  id: string;
  operationId: string;
  phase: AttemptPhase;
  partIndex: number;
  model?: string | null;
  /** Serialized request snapshot; never contains API keys. */
  requestSummary?: string | null;
  responseSummary?: string | null;
  usage?: Usage | null;
  createdAt: string;
}

export interface DeliveryRecord {
  id: string;
  operationId: string;
  analysisId: string;
  state: DeliveryState;
  payloadPath?: string | null;
  memoryRef?: MemoryRef | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceCapabilities {
  platform: Platform;
  /** Single video URLs are always expected to work when the platform is supported. */
  singleVideo: boolean;
  /** Archive listing support and its honest scope. */
  listing: "full" | "limited" | "none";
  /** Human-readable limit, e.g. "25 ostatnich" for Instagram. */
  listingScopeNote?: string | null;
  pagination: boolean;
  /** Whether listing itself costs money and needs explicit confirmation. */
  listingCost: "free" | "paid" | "unknown";
  requiresConfig: string[];
}

export interface MediaInfo {
  sourceRef: SourceRef;
  title: string;
  channel: string | null;
  durationSeconds: number;
  extractor: string;
  publishedAt?: string | null;
  /** Local path to a downloaded file or stream, when media preparation succeeded. */
  localPath?: string | null;
  uploadedUrl?: string | null;
  reusedUpload?: boolean;
}

export interface MediaPart {
  index: number;
  /**
   * Where the part's FILE starts in the full video. A stream-copy cut begins on the
   * keyframe at or before the planned start, so this can be earlier than the plan;
   * clip-relative timestamps are shifted by this value (M19).
   */
  startSeconds: number;
  endSeconds: number;
  localPath: string;
  /**
   * Sampling rate for the whole film, fixed at split time. A part's own end is not
   * the film's length: the first 2 minutes of a 5-minute film must not be sampled at
   * the short-form 10 fps.
   */
  fps?: number;
}

export interface ListingItem {
  sourceRef: SourceRef;
  title: string;
  durationSeconds?: number | null;
  publishedAt?: string | null;
  private?: boolean;
}

export interface ListingPage {
  items: ListingItem[];
  cursor?: string | null;
  completeness: ListingCompleteness;
  note?: string | null;
}

export interface ScanSettings {
  collectionId: string;
  mode: Mode;
  focus?: string | null;
  question?: string | null;
  language: string;
  /** Maximum new analyses this run may start. `null` = no run limit (full first scan). */
  maxNewItems?: number | null;
  /** Estimated maximum cost the user accepted for this run, when known. */
  budgetUsd?: number | null;
}

export interface RunRecord {
  id: string;
  collectionId: string;
  trigger: RunTrigger;
  state: RunState;
  settings: ScanSettings;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface RunItem {
  runId: string;
  ordinal: number;
  sourceRef: SourceRef;
  operationId: string;
  state: RunItemState;
  title?: string | null;
  updatedAt: string;
}

export interface ScanReport {
  id: string;
  runId: string;
  state: ReportState;
  newAnalyses: number;
  failedItems: number;
  pendingItems: number;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProgressEvent {
  /** Monotonic per operation; consumers ignore lower versions. */
  version: number;
  operationId: string;
  state: OperationState;
  stage: string;
  itemIndex?: number | null;
  itemCount?: number | null;
  message?: string | null;
  errorClass?: ErrorClass | null;
  partialText?: string | null;
  usage?: Usage | null;
  /** R5 `source_wait`: seconds until the single retry of a rate-limited download. */
  waitSeconds?: number | null;
  /** R5 `source_wait`: the classified reason of the wait (e.g. `rate_limited_by_youtube`). */
  reason?: string | null;
}

export interface ClockPort {
  now(): Date;
  /** Injectable in tests (D11: timeouts tested with an injected clock). */
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LoggerPort {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
