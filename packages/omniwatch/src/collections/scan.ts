/**
 * T5 / D8 / D11: the single scan operation.
 *
 * The manual button and Hermes call exactly this function (`scan --collection <id>`),
 * so a repeated click and a cron tick cannot produce two different rules. A run
 * snapshots the collection settings, enumerates every source through the shared
 * `SourcePort.list`, selects only the material that is new *for this goal*
 * (mode/focus/question/language) and enqueues it through the one queue
 * (`enqueueAnalysis`), executing it through the one runtime (`runOperation`).
 *
 * Limits and money:
 * - a scheduled run defaults to `DEFAULT_SCHEDULED_MAX_NEW_ITEMS` new analyses;
 *   `maxNewItems: null` (a full first scan) means "no run limit";
 * - work beyond the limit is left as pending for the next run and reported, never
 *   silently dropped;
 * - a run with an accepted `budgetUsd` reserves the estimated maximum before each
 *   paid call; when the estimate is unknown or the reservation would exceed the
 *   accepted budget, the run pauses with a visible reason and spends nothing more;
 * - billed listing (X / Meta Ads / Instagram) needs `confirmPaidListing`, otherwise
 *   the scan fails before a single paid lister call.
 *
 * Failure isolation (D3): one bad item never discards the good results, and a store
 * write failure stops all further paid work immediately.
 */

import { randomUUID } from "node:crypto";

import { OmniWatchError, toOmniWatchError } from "../contracts/errors.ts";
import type { RuntimeDeps, StorePort } from "../contracts/ports.ts";
import type {
  AnalysisRequest,
  ListingCompleteness,
  ListingItem,
  Operation,
  OperationState,
  RunItemState,
  RunRecord,
  RunState,
  RunTrigger,
  ScanReport,
  ScanSettings,
  SourceRef,
} from "../contracts/types.ts";
import { ANALYSIS_VERSION } from "../contracts/types.ts";
import { analysisKeyForRequest, enqueueAnalysis } from "../runtime/queue.ts";
import { runOperation } from "../runtime/worker.ts";
import type { WorkerOperationSummary } from "../runtime/worker.ts";
import { OperationJournal } from "../storage/operations.ts";
import { enumerateListing } from "./listing.ts";
import type { EnumeratedListing, ListingMaterialize } from "./listing.ts";
import { decideRunReport, recordRunReport } from "./report.ts";
import type { RunReportDecision, RunReportSource } from "./report.ts";

export const SCAN_PROTOCOL = "omniwatch.scan.v1";

/** D11: a recurring run starts at most this many new analyses by default. */
export const DEFAULT_SCHEDULED_MAX_NEW_ITEMS = 10;

/** D11: a run summary carries at most this many detail notes. */
export const MAX_REPORT_NOTES = 20;

/** Reserved, namespaced key holding the collection's sources. */
export const COLLECTION_SOURCES_KEY = "_sources";

export interface CollectionRecord {
  collectionId: string;
  settings: ScanSettings;
  sources: SourceRef[];
}

type SettingsWithSources = ScanSettings & { [COLLECTION_SOURCES_KEY]?: SourceRef[] };

export function readCollectionSources(settings: ScanSettings): SourceRef[] {
  const stored = (settings as SettingsWithSources)[COLLECTION_SOURCES_KEY];
  if (!Array.isArray(stored)) return [];
  return stored.filter((ref) => ref && typeof ref.sourceId === "string" && typeof ref.canonicalUrl === "string");
}

/** A settings snapshot without the namespaced source list (used for runs). */
export function plainScanSettings(settings: ScanSettings): ScanSettings {
  const { collectionId, mode, focus, question, language, maxNewItems, budgetUsd } = settings;
  return { collectionId, mode, focus: focus ?? null, question: question ?? null, language, maxNewItems: maxNewItems ?? null, budgetUsd: budgetUsd ?? null };
}

export function readCollection(store: StorePort, collectionId: string): CollectionRecord | null {
  const settings = store.getCollectionSettings(collectionId);
  if (!settings) return null;
  return { collectionId, settings: plainScanSettings(settings), sources: readCollectionSources(settings) };
}

/** Creates the collection on first use and adopts the saved one afterwards. */
export function saveCollection(
  store: StorePort,
  input: { settings: ScanSettings; sources: SourceRef[] },
): CollectionRecord {
  const settings = plainScanSettings(input.settings);
  store.saveCollectionSettings(runSettingsSnapshot(store, settings.collectionId, settings, input.sources));
  return { collectionId: settings.collectionId, settings, sources: input.sources };
}

/**
 * The settings snapshot of a run, as stored on the run and mirrored into the
 * collection row by `createRun`. It carries the declared settings plus the two
 * namespaced keys the scan layer owns: the source list and the listing cursors.
 * Declared fields win, so a caller can change the goal without losing progress.
 */
function runSettingsSnapshot(
  store: StorePort,
  collectionId: string,
  settings: ScanSettings,
  sources: SourceRef[],
): SettingsWithSources {
  const raw = store.getCollectionSettings(collectionId) as Record<string, unknown> | null;
  return { ...(raw ?? {}), ...settings, [COLLECTION_SOURCES_KEY]: sources };
}

export interface ScanRequest {
  /** Hermes passes the collection id, never a prompt (D5). */
  collectionId: string;
  trigger?: RunTrigger;
  /** Overrides merged over the saved settings; omitted values are adopted. */
  settings?: Partial<Omit<ScanSettings, "collectionId">> | null;
  /** Sources to save/adopt; omitted = the collection's saved sources. */
  sources?: SourceRef[] | null;
  /** Required for billed listing (X / Meta Ads / Instagram). */
  confirmPaidListing?: boolean;
  /** Explicit run id (tests, resumed launchers); default is generated. */
  runId?: string;
  pageSize?: number;
  /** Per-call page bound; null = enumerate each source until it ends. */
  maxPagesPerSource?: number | null;
  /** Allows paid work when the cost estimate is unknown; off by default. */
  allowUnknownCost?: boolean;
}

/** Estimated maximum cost of one analysis; `null` = not credible (D11). */
export type AnalysisCostEstimator = (request: AnalysisRequest) => number | null;

export interface ScanProgress {
  runId: string;
  stage: "listing" | "admission" | "analysis" | "report";
  sourceId?: string | null;
  message?: string | null;
  newItems?: number;
  admitted?: number;
  analysed?: number;
  pending?: number;
}

export interface ScanOptions {
  deps: RuntimeDeps;
  request: ScanRequest;
  estimator?: AnalysisCostEstimator;
  onProgress?: (event: ScanProgress) => void;
  shouldStop?: () => boolean;
  ownerToken?: string | null;
  now?: () => string;
  idFactory?: (prefix: string) => string;
}

export interface ScanSourceSummary {
  sourceId: string;
  platform: string;
  completeness: ListingCompleteness;
  scope: EnumeratedListing["scope"];
  scopeNote: string | null;
  fullChannel: boolean;
  pagesRead: number;
  newItems: number;
  analysed: number;
  failed: number;
  pending: number;
  errors: string[];
}

export interface ScanOperationSummary {
  operationId: string;
  sourceId: string;
  state: OperationState;
  analysisId?: string | null;
  modelCalls: number;
}

export interface ScanOutcome {
  protocol: string;
  runId: string;
  collectionId: string;
  trigger: RunTrigger;
  state: RunState;
  settings: ScanSettings;
  /** Effective run limit: a number, or null for "no run limit". */
  maxNewItems: number | null;
  budgetUsd: number | null;
  sources: ScanSourceSummary[];
  listingCompleteness: ListingCompleteness;
  fullChannel: boolean;
  newItems: number;
  analysed: number;
  failedItems: number;
  pendingItems: number;
  blockedItems: number;
  duplicates: number;
  modelCalls: number;
  reservedCostUsd: number;
  spentCostUsd: number | null;
  costKnown: boolean;
  pausedReason: string | null;
  errorClass: string | null;
  errorMessage: string | null;
  notes: string[];
  /** Canonical links to the material analysed in this run (same list as the report). */
  links: string[];
  operations: ScanOperationSummary[];
  report: ScanReport | null;
  reportDecision: RunReportDecision;
}

/* ------------------------------------------------------------------ plan --- */

export type ScanPlanReason = "new" | "seen" | "failed" | "blocked" | "in_flight";

export interface ScanPlanItem {
  sourceRef: SourceRef;
  title: string | null;
  reason: ScanPlanReason;
  operationId: string | null;
  operationState: OperationState | null;
}

export interface ScanPlan {
  collectionId: string;
  settings: ScanSettings;
  items: ScanPlanItem[];
  newItems: ScanPlanItem[];
}

/**
 * The selection policy, on its own: a material is "new" when it was not analysed
 * for this exact goal. The same saved settings therefore produce the same plan for
 * a manual click and a cron tick.
 */
export function classifyScanItem(
  store: StorePort,
  collectionId: string,
  settings: ScanSettings,
  item: ListingItem,
): { plan: ScanPlanItem; operation: Operation | null; needsWork: boolean } {
  const focus = settings.focus ?? "";
  const question = settings.question ?? "";
  const request = buildGoalRequest(settings, item.sourceRef);
  const operation = store.getOperationByKey(analysisKeyForRequest(store, request));
  const seen = store.isSourceSeen(collectionId, item.sourceRef.sourceId, settings.mode, focus, question, settings.language);

  if (seen || operation?.state === "delivered") {
    return {
      plan: { sourceRef: item.sourceRef, title: item.title ?? null, reason: "seen", operationId: operation?.id ?? null, operationState: operation?.state ?? null },
      operation,
      needsWork: false,
    };
  }
  if (operation?.state === "failed") {
    // A failed analysis is never "already watched" (SPEC) and is never retried
    // automatically; the user retries it explicitly.
    return {
      plan: { sourceRef: item.sourceRef, title: item.title ?? null, reason: "failed", operationId: operation.id, operationState: operation.state },
      operation,
      needsWork: false,
    };
  }
  if (operation?.state === "outcome_unknown") {
    return {
      plan: { sourceRef: item.sourceRef, title: item.title ?? null, reason: "blocked", operationId: operation.id, operationState: operation.state },
      operation,
      needsWork: false,
    };
  }
  if (operation?.state === "running") {
    return {
      plan: { sourceRef: item.sourceRef, title: item.title ?? null, reason: "in_flight", operationId: operation.id, operationState: operation.state },
      operation,
      needsWork: false,
    };
  }
  return {
    plan: { sourceRef: item.sourceRef, title: item.title ?? null, reason: "new", operationId: operation?.id ?? null, operationState: operation?.state ?? null },
    operation,
    needsWork: true,
  };
}

export function planScanItems(
  store: StorePort,
  collectionId: string,
  settings: ScanSettings,
  items: ListingItem[],
): ScanPlan {
  const planned: ScanPlanItem[] = [];
  const newItems: ScanPlanItem[] = [];
  for (const item of items) {
    const { plan } = classifyScanItem(store, collectionId, settings, item);
    planned.push(plan);
    if (plan.reason === "new") newItems.push(plan);
  }
  return { collectionId, settings: plainScanSettings(settings), items: planned, newItems };
}

function buildGoalRequest(settings: ScanSettings, sourceRef: SourceRef): AnalysisRequest {
  return {
    sourceRef,
    mode: settings.mode,
    focus: settings.focus ?? null,
    question: settings.question ?? null,
    language: settings.language,
    analysisVersion: ANALYSIS_VERSION,
    conversationId: null,
    parentTurnId: null,
  };
}

function sameGoal(request: AnalysisRequest, settings: ScanSettings): boolean {
  return (
    request.mode === settings.mode &&
    (request.focus ?? null) === (settings.focus ?? null) &&
    (request.question ?? null) === (settings.question ?? null) &&
    request.language === settings.language &&
    (request.parentTurnId ?? null) === null &&
    (request.conversationId ?? null) === null
  );
}

/* ------------------------------------------------------------------ scan --- */

interface ScanCandidate {
  sourceRef: SourceRef;
  canonicalUrl: string;
  title: string | null;
  ordinal: number | null;
  operationId: string;
  operationState: OperationState;
  needsWork: boolean;
  fromBacklog: boolean;
  createdAt: string;
}

function mergeScanSettings(
  collectionId: string,
  existing: ScanSettings | null,
  patch: Partial<Omit<ScanSettings, "collectionId">> | null,
): ScanSettings {
  const base: ScanSettings = existing ?? {
    collectionId,
    mode: "summary",
    focus: null,
    question: null,
    language: "pl",
    maxNewItems: null,
    budgetUsd: null,
  };
  const merged: ScanSettings = plainScanSettings({ ...base, ...(patch ?? {}), collectionId });
  if (merged.mode !== "summary" && merged.mode !== "teardown") {
    throw new OmniWatchError("invalid_input", `Nieznany tryb analizy "${String(merged.mode)}" w ustawieniach kolekcji.`);
  }
  if (typeof merged.language !== "string" || merged.language.trim() === "") {
    throw new OmniWatchError("invalid_input", "Ustawienia kolekcji wymagaja jezyka analizy.");
  }
  const maxNewItems = merged.maxNewItems ?? null;
  const budgetUsd = merged.budgetUsd ?? null;
  if (maxNewItems !== null && (!Number.isFinite(maxNewItems) || maxNewItems < 0)) {
    throw new OmniWatchError("invalid_input", "maxNewItems musi byc nieujemna liczba lub null (bez limitu przebiegu).");
  }
  if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
    throw new OmniWatchError("invalid_input", "budgetUsd musi byc nieujemna liczba lub null.");
  }
  return { ...merged, maxNewItems, budgetUsd };
}

export function decideRunState(input: {
  hardFailure: boolean;
  paused: boolean;
  listing: ListingCompleteness;
  failedItems: number;
  pendingItems: number;
  stopped: boolean;
}): RunState {
  if (input.hardFailure) return "failed";
  if (input.paused) return "paused";
  if (
    input.stopped ||
    input.failedItems > 0 ||
    input.pendingItems > 0 ||
    input.listing === "partial" ||
    input.listing === "failed"
  ) {
    return "partial";
  }
  return "completed";
}

export function aggregateListingCompleteness(listings: EnumeratedListing[]): ListingCompleteness {
  if (listings.length === 0) return "failed";
  if (listings.some((listing) => listing.completeness === "failed")) return "failed";
  if (listings.some((listing) => listing.completeness === "partial")) return "partial";
  if (listings.every((listing) => listing.completeness === "empty")) return "empty";
  return "complete";
}

/**
 * Runs one scan. Never throws for a user-facing refusal (paid listing without
 * confirmation, budget pause, listing error): those come back as a run state with
 * a visible reason. Programming errors (unknown collection, bad settings) throw.
 */
export async function runScan(options: ScanOptions): Promise<ScanOutcome> {
  const { deps } = options;
  const store = deps.store;
  const now = options.now ?? (() => deps.clock.now().toISOString());
  const request = options.request;
  const trigger: RunTrigger = request.trigger ?? "manual";
  const collectionId = request.collectionId?.trim();
  if (!collectionId) {
    throw new OmniWatchError(
      "invalid_input",
      "Skan wymaga identyfikatora kolekcji: Hermes przekazuje ID kolekcji, nie prompt.",
    );
  }

  const existing = readCollection(store, collectionId);
  const settings = mergeScanSettings(collectionId, existing?.settings ?? null, request.settings ?? null);
  const sources = request.sources && request.sources.length > 0 ? request.sources : (existing?.sources ?? []);
  if (sources.length === 0) {
    throw new OmniWatchError(
      "invalid_input",
      `Kolekcja ${collectionId} nie ma zapisanych zrodel; dodaj co najmniej jedno zrodlo przed skanem.`,
    );
  }

  const runId = request.runId?.trim() || (options.idFactory ? options.idFactory("run") : `run_${randomUUID()}`);
  // `createRun` also mirrors this snapshot into the collection row, so the saved
  // settings (and the listing cursors) survive for the next manual or cron run.
  store.createRun({
    id: runId,
    collectionId,
    trigger,
    state: "running",
    settings: runSettingsSnapshot(store, collectionId, settings, sources),
    completedAt: null,
  });

  const effectiveMaxNewItems =
    settings.maxNewItems ?? (trigger === "schedule" ? DEFAULT_SCHEDULED_MAX_NEW_ITEMS : null);
  const budgetUsd = settings.budgetUsd ?? null;
  const estimator = options.estimator ?? (() => null);
  const emit = (event: ScanProgress): void => options.onProgress?.(event);

  const candidates: ScanCandidate[] = [];
  const listings: EnumeratedListing[] = [];
  const notes: string[] = [];
  // The report stays bounded: detail notes are capped, the rest is summarised.
  let omittedNotes = 0;
  const pushNote = (note: string): void => {
    if (notes.length < MAX_REPORT_NOTES) notes.push(note);
    else omittedNotes += 1;
  };
  const links: string[] = [];
  const operations: ScanOperationSummary[] = [];
  const analysedBySource = new Map<string, number>();
  const failedBySource = new Map<string, number>();
  let duplicates = 0;
  let analysed = 0;
  let failedItems = 0;
  let blockedItems = 0;
  let modelCalls = 0;
  let reservedCostUsd = 0;
  let pausedReason: string | null = null;
  let hardFailure: OmniWatchError | null = null;
  let stopped = false;

  const materialize: ListingMaterialize = (item, ordinal) => {
    const { plan, operation } = classifyScanItem(store, collectionId, settings, item);
    let resolved = operation;
    let runItemState: RunItemState;
    let needsWork = false;

    if (plan.reason === "seen") {
      if (!resolved) return null;
      runItemState = "skipped";
    } else if (plan.reason === "failed") {
      runItemState = "failed";
    } else if (plan.reason === "blocked") {
      runItemState = "pending";
    } else if (plan.reason === "in_flight") {
      runItemState = "running";
    } else {
      const enqueued = enqueueAnalysis({
        store,
        request: buildGoalRequest(settings, item.sourceRef),
        runId,
        ownerToken: options.ownerToken ?? null,
      });
      resolved = enqueued.operation;
      runItemState = "pending";
      needsWork = true;
    }

    if (!resolved) return null;
    const candidate: ScanCandidate = {
      sourceRef: item.sourceRef,
      canonicalUrl: item.sourceRef.canonicalUrl,
      title: item.title ?? null,
      ordinal,
      operationId: resolved.id,
      operationState: resolved.state,
      needsWork,
      fromBacklog: false,
      createdAt: resolved.createdAt,
    };
    candidates.push(candidate);
    return { operationId: resolved.id, state: runItemState };
  };

  try {
    for (const sourceRef of sources) {
      const listing = await enumerateListing({
        store,
        port: deps.source,
        sourceRef,
        runId,
        materialize,
        confirmPaidListing: request.confirmPaidListing,
        pageSize: request.pageSize,
        maxPages: request.maxPagesPerSource ?? null,
        shouldStop: options.shouldStop,
        now,
        onPage: (event) => {
          emit({
            runId,
            stage: "listing",
            sourceId: sourceRef.sourceId,
            message: `strona ${event.page}: ${event.recorded} nowych, ${event.duplicates} duplikatow`,
            newItems: event.recorded,
          });
        },
      });
      listings.push(listing);
      duplicates += listing.duplicates;
      for (const error of listing.errors) pushNote(`listowanie ${error}`);
      if (listing.scope === "limited" && listing.scopeNote) {
        pushNote(`zakres ${sourceRef.sourceId}: ${listing.scopeNote} (nie caly kanal)`);
      }
      if (listing.completeness === "partial" || listing.completeness === "failed") {
        pushNote(`listowanie ${sourceRef.sourceId}: ${listing.completeness} po ${listing.pagesRead} stronach`);
      }
      if (options.shouldStop?.()) {
        stopped = true;
        break;
      }
    }
  } catch (error) {
    const failure = toOmniWatchError(error, "storage_unavailable");
    // A paid listing refusal is a policy outcome, not a crash: report it honestly
    // as a failed run with zero paid calls.
    hardFailure = failure;
  }

  if (!hardFailure) {
    // Materials an earlier run left pending (D11: "następne uruchomienie wybiera
    // także wcześniejsze, jeszcze nieprzetworzone ID").
    try {
      const backlog = collectBacklog(store, collectionId, settings, candidates);
      for (const candidate of backlog) {
        const ordinal = store.listRunItems(runId, { limit: 1 }).total;
        store.addRunItem({
          runId,
          ordinal,
          sourceRef: candidate.sourceRef,
          operationId: candidate.operationId,
          state: "pending",
          title: candidate.title,
        });
        candidate.ordinal = ordinal;
        candidates.push(candidate);
      }
      for (const candidate of candidates) {
        if (candidate.ordinal === null) {
          const ordinal = store.listRunItems(runId, { limit: 1 }).total;
          store.addRunItem({
            runId,
            ordinal,
            sourceRef: candidate.sourceRef,
            operationId: candidate.operationId,
            state: candidate.needsWork ? "pending" : candidate.operationState === "failed" ? "failed" : "skipped",
            title: candidate.title,
          });
          candidate.ordinal = ordinal;
        }
      }
    } catch (error) {
      hardFailure = toOmniWatchError(error, "storage_unavailable");
    }
  }

  const ordered = candidates
    .slice()
    .sort((a, b) => (a.fromBacklog === b.fromBacklog ? a.createdAt.localeCompare(b.createdAt) : a.fromBacklog ? -1 : 1));
  const admitted: ScanCandidate[] = [];
  const deferred: ScanCandidate[] = [];
  const admittedIds = new Set<string>();
  const deferredIds = new Set<string>();
  const defer = (candidate: ScanCandidate): void => {
    if (deferredIds.has(candidate.operationId)) return;
    deferredIds.add(candidate.operationId);
    deferred.push(candidate);
  };

  if (!hardFailure) {
    for (const candidate of ordered) {
      if (!candidate.needsWork) continue;
      if (effectiveMaxNewItems !== null && admitted.length >= effectiveMaxNewItems) {
        defer(candidate);
        continue;
      }
      if (budgetUsd !== null) {
        const estimate = estimator(buildGoalRequest(settings, candidate.sourceRef));
        if (estimate === null || !Number.isFinite(estimate)) {
          if (request.allowUnknownCost !== true) {
            pausedReason = `Szacunek kosztu dla ${candidate.sourceRef.sourceId} nie jest wiarygodny, a przebieg ma zaakceptowany budzet ${budgetUsd} USD; wstrzymuje nowe platne wywolania do decyzji uzytkownika.`;
            break;
          }
        } else if (estimate < 0) {
          pausedReason = `Szacunek kosztu dla ${candidate.sourceRef.sourceId} jest niepoprawny (${estimate}); wstrzymuje nowe platne wywolania.`;
          break;
        } else if (reservedCostUsd + estimate > budgetUsd) {
          pausedReason = `Zaakceptowany budzet ${budgetUsd} USD nie pokrywa kolejnej analizy (zarezerwowano ${Number(reservedCostUsd.toFixed(4))} USD, kolejny szacunek ${Number(estimate.toFixed(4))} USD); pozostale materialy czekaja na nastepny przebieg.`;
          break;
        } else {
          reservedCostUsd += estimate;
        }
      }
      admitted.push(candidate);
      admittedIds.add(candidate.operationId);
    }
    for (const candidate of ordered) {
      if (!candidate.needsWork || admittedIds.has(candidate.operationId)) continue;
      defer(candidate);
    }
    emit({
      runId,
      stage: "admission",
      admitted: admitted.length,
      pending: deferred.length,
      newItems: candidates.filter((candidate) => candidate.needsWork).length,
      message: `przyjeto ${admitted.length}, oczekuje ${deferred.length}`,
    });
  }

  const journal = new OperationJournal({ store, ownerToken: options.ownerToken ?? null, now });
  if (!hardFailure && admitted.length > 0) {
    for (const candidate of admitted) {
      if (options.shouldStop?.()) {
        stopped = true;
        defer(candidate);
        continue;
      }
      let summary: WorkerOperationSummary;
      try {
        summary = await runOperation(deps, journal, candidate.operationId, {
          onProgress: (event) =>
            emit({
              runId,
              stage: "analysis",
              sourceId: candidate.sourceRef.sourceId,
              message: event.message ?? event.stage,
            }),
        });
      } catch (error) {
        const failure = toOmniWatchError(error, "storage_unavailable");
        if (failure.errorClass === "invalid_input") {
          // Nothing to do for this operation; the rest of the run keeps moving.
          safeUpdateRunItem(store, runId, candidate, "skipped");
          continue;
        }
        hardFailure = failure;
        break;
      }

      modelCalls += summary.modelCalls;
      operations.push({
        operationId: summary.operationId,
        sourceId: candidate.sourceRef.sourceId,
        state: summary.state,
        analysisId: summary.analysisId ?? null,
        modelCalls: summary.modelCalls,
      });

      try {
        const markItem = (state: RunItemState): void => {
          if (candidate.ordinal === null) return;
          store.updateRunItem(runId, candidate.ordinal, { state });
        };
        if (summary.state === "delivered") {
          markItem("done");
          store.markSeenSource(
            collectionId,
            candidate.sourceRef.sourceId,
            settings.mode,
            settings.focus ?? "",
            settings.question ?? "",
            settings.language,
          );
          analysed += 1;
          analysedBySource.set(candidate.sourceRef.sourceId, (analysedBySource.get(candidate.sourceRef.sourceId) ?? 0) + 1);
          if (!links.includes(candidate.canonicalUrl)) links.push(candidate.canonicalUrl);
        } else if (summary.state === "failed") {
          markItem("failed");
          failedItems += 1;
          failedBySource.set(candidate.sourceRef.sourceId, (failedBySource.get(candidate.sourceRef.sourceId) ?? 0) + 1);
          pushNote(`${candidate.sourceRef.sourceId}: ${summary.message ?? "blad analizy"}`);
        } else if (summary.state === "budget_paused") {
          markItem("pending");
          pausedReason = summary.message ?? "wstrzymane limitem kosztu";
          defer(candidate);
          break;
        } else if (summary.state === "outcome_unknown") {
          markItem("pending");
          blockedItems += 1;
          defer(candidate);
          pushNote(`${candidate.sourceRef.sourceId}: wynik wywolania nieznany; wymaga decyzji uzytkownika`);
        } else {
          markItem("pending");
          defer(candidate);
        }
      } catch (error) {
        hardFailure = toOmniWatchError(error, "storage_unavailable");
        break;
      }
    }
  }

  const pendingItems = deferred.length;
  const listingCompleteness = aggregateListingCompleteness(listings);
  const state = decideRunState({
    hardFailure: hardFailure !== null,
    paused: pausedReason !== null && hardFailure === null,
    listing: listingCompleteness,
    failedItems,
    pendingItems,
    stopped,
  });

  try {
    store.updateRun(runId, { state, completedAt: now() });
  } catch (error) {
    if (!hardFailure) hardFailure = toOmniWatchError(error, "storage_unavailable");
  }

  const sourceSummaries: ScanSourceSummary[] = listings.map((listing) => ({
    sourceId: listing.sourceRef.sourceId,
    platform: listing.sourceRef.platform,
    completeness: listing.completeness,
    scope: listing.scope,
    scopeNote: listing.scopeNote,
    fullChannel: listing.fullChannel,
    pagesRead: listing.pagesRead,
    newItems: candidates.filter(
      (candidate) => candidate.sourceRef.sourceId === listing.sourceRef.sourceId && candidate.needsWork,
    ).length,
    analysed: analysedBySource.get(listing.sourceRef.sourceId) ?? 0,
    failed: failedBySource.get(listing.sourceRef.sourceId) ?? 0,
    pending: deferred.filter((candidate) => candidate.sourceRef.sourceId === listing.sourceRef.sourceId).length,
    errors: listing.errors,
  }));
  const spent = readSpentCost(store, operations);
  if (spent.unknown) {
    pushNote("koszt dostawcy nie zostal zaraportowany dla czesci wywolan; nie zapisuje zera jako kosztu");
  }
  if (hardFailure) pushNote(`przebieg przerwany: ${hardFailure.message}`);
  if (pausedReason) pushNote(`pauza: ${pausedReason}`);
  if (omittedNotes > 0) notes.push(`${omittedNotes} dalszych uwag pominietych w raporcie; pelna lista jest w statusie przebiegu`);

  const reportInput = {
    runId,
    collectionId,
    state,
    newAnalyses: analysed,
    failedItems,
    pendingItems,
    sources: sourceSummaries.map(
      (summary): RunReportSource => ({
        sourceId: summary.sourceId,
        platform: summary.platform,
        completeness: summary.completeness,
        scopeNote: summary.scopeNote,
        newItems: summary.newItems,
        analysed: summary.analysed,
        failed: summary.failed,
        pending: summary.pending,
      }),
    ),
    links,
    notes,
  };

  let report: ScanReport | null = null;
  let reportDecision = decideRunReport({ state, newAnalyses: analysed, failedItems, pendingItems });
  try {
    const recorded = recordRunReport(store, reportInput);
    report = recorded.report;
    reportDecision = recorded.decision;
    emit({ runId, stage: "report", message: reportDecision.reason, analysed, pending: pendingItems });
  } catch (error) {
    const failure = toOmniWatchError(error, "storage_unavailable");
    if (!hardFailure) hardFailure = failure;
    pushNote(`raport nie zostal zapisany: ${failure.message}`);
  }

  return {
    protocol: SCAN_PROTOCOL,
    runId,
    collectionId,
    trigger,
    state: hardFailure ? "failed" : state,
    settings,
    maxNewItems: effectiveMaxNewItems,
    budgetUsd,
    sources: sourceSummaries,
    listingCompleteness,
    fullChannel: sourceSummaries.length > 0 && sourceSummaries.every((summary) => summary.fullChannel),
    newItems: candidates.filter((candidate) => candidate.needsWork).length,
    analysed,
    failedItems,
    pendingItems,
    blockedItems,
    duplicates,
    modelCalls,
    reservedCostUsd: Number(reservedCostUsd.toFixed(6)),
    spentCostUsd: spent.unknown ? null : Number(spent.total.toFixed(6)),
    costKnown: !spent.unknown,
    pausedReason,
    errorClass: hardFailure?.errorClass ?? null,
    errorMessage: hardFailure?.message ?? null,
    notes,
    links,
    operations,
    report,
    reportDecision,
  };
}

function safeUpdateRunItem(
  store: StorePort,
  runId: string,
  candidate: ScanCandidate,
  state: RunItemState,
): void {
  if (candidate.ordinal === null) return;
  try {
    store.updateRunItem(runId, candidate.ordinal, { state });
  } catch {
    // The run is already aborting; a secondary bookkeeping failure must not hide
    // the original error.
  }
}

function collectBacklog(
  store: StorePort,
  collectionId: string,
  settings: ScanSettings,
  known: ScanCandidate[],
): ScanCandidate[] {
  const knownOperations = new Set(known.map((candidate) => candidate.operationId));
  const found: ScanCandidate[] = [];
  for (const state of ["pending", "budget_paused"] as const) {
    for (const operation of store.listOperations({ state, limit: 1000 })) {
      if (knownOperations.has(operation.id)) continue;
      if (!operation.runId) continue;
      const operationRun = store.getRun(operation.runId);
      if (!operationRun || operationRun.collectionId !== collectionId) continue;
      if (!sameGoal(operation.request, settings)) continue;
      found.push({
        sourceRef: operation.request.sourceRef,
        canonicalUrl: operation.request.sourceRef.canonicalUrl,
        title: null,
        ordinal: null,
        operationId: operation.id,
        operationState: operation.state,
        needsWork: true,
        fromBacklog: true,
        createdAt: operation.createdAt,
      });
      knownOperations.add(operation.id);
    }
  }
  return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function readSpentCost(
  store: StorePort,
  operations: ScanOperationSummary[],
): { total: number; unknown: boolean } {
  let total = 0;
  let unknown = false;
  for (const operation of operations) {
    for (const attempt of store.listAttempts(operation.operationId)) {
      if (!attempt.usage) continue;
      if (attempt.usage.costKnown !== true || typeof attempt.usage.costUsd !== "number") {
        unknown = true;
        continue;
      }
      total += attempt.usage.costUsd;
    }
  }
  return { total, unknown };
}

/** Short, honest one-liner for the UI and the Hermes report. */
export function describeScan(outcome: ScanOutcome): string {
  const parts = [
    `run ${outcome.runId}`,
    `${outcome.state}`,
    `${outcome.analysed} nowych analiz`,
    `${outcome.failedItems} bledow`,
    `${outcome.pendingItems} oczekuje`,
  ];
  if (outcome.pausedReason) parts.push(`pauza: ${outcome.pausedReason}`);
  if (outcome.errorMessage) parts.push(`blad: ${outcome.errorMessage}`);
  return parts.join(", ");
}

/** JSON-safe payload for Hermes / the Agent OS UI (`omniwatch.scan.v1`). */
export function scanPayload(outcome: ScanOutcome): Record<string, unknown> {
  return {
    protocol: SCAN_PROTOCOL,
    runId: outcome.runId,
    collectionId: outcome.collectionId,
    trigger: outcome.trigger,
    state: outcome.state,
    analysed: outcome.analysed,
    failedItems: outcome.failedItems,
    pendingItems: outcome.pendingItems,
    newItems: outcome.newItems,
    modelCalls: outcome.modelCalls,
    budgetUsd: outcome.budgetUsd,
    reservedCostUsd: outcome.reservedCostUsd,
    spentCostUsd: outcome.spentCostUsd,
    costKnown: outcome.costKnown,
    pausedReason: outcome.pausedReason,
    errorClass: outcome.errorClass,
    errorMessage: outcome.errorMessage,
    sources: outcome.sources,
    report: outcome.report ? { id: outcome.report.id, state: outcome.report.state, summary: outcome.report.summary } : null,
    reportDecision: outcome.reportDecision,
    links: outcome.links,
    notes: outcome.notes,
  };
}

/** Re-exported so a caller does not need to import the listing module directly. */
export type { EnumeratedListing, RunRecord };
