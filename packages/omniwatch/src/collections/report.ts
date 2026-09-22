/**
 * T5 / D8: the durable per-run scan report.
 *
 * One run produces at most one report, keyed by the run id (`rpt_<runId>`), so a
 * repeated hand-off can duplicate the message but never the analysis. The report
 * carries what Hermes and the Agent OS UI need: how many analyses are new, which
 * sources were listed and with which honest scope, the links to the new material,
 * and how many items failed or are still waiting for the next run.
 *
 * Rules:
 * - zero new material and no failure and no deferred work produces **no** report
 *   and therefore no notification (`report: false`);
 * - an error, a budget pause, an incomplete listing or deferred work is reported
 *   explicitly instead of being dropped;
 * - `report --run <id>` is a pure read; a retry re-sends the stored report and
 *   never triggers an analysis.
 */

import type { StorePort } from "../contracts/ports.ts";
import type { ListingCompleteness, RunState, ScanReport } from "../contracts/types.ts";
import {
  confirmReport,
  describeReport,
  ensureRunReport,
  failReport,
  listUndeliveredReports,
  markReportHandedOff,
  readReportsForRun,
  reportIdForRun,
} from "../storage/reports.ts";

export const REPORT_PROTOCOL = "omniwatch.report.v1";

export {
  confirmReport,
  describeReport,
  ensureRunReport,
  failReport,
  listUndeliveredReports,
  markReportHandedOff,
  readReportsForRun,
  reportIdForRun,
};

export interface RunReportDecision {
  /** True when Hermes/the UI must be told about this run. */
  report: boolean;
  reason: string;
}

export interface RunReportCounts {
  state: RunState;
  newAnalyses: number;
  failedItems: number;
  pendingItems: number;
}

/**
 * The single rule for "does this run deserve a message?".
 *
 * A quiet, fully enumerated run with nothing new stays quiet (A6/F8). Everything
 * the user must act on — failures, a budget pause, a listing that could not be
 * completed, or material deferred to the next run — is reported.
 */
export function decideRunReport(counts: RunReportCounts): RunReportDecision {
  if (counts.newAnalyses > 0) {
    return { report: true, reason: `${counts.newAnalyses} nowych analiz` };
  }
  if (counts.failedItems > 0) {
    return { report: true, reason: `${counts.failedItems} pozycji z bledem` };
  }
  switch (counts.state) {
    case "failed":
      return { report: true, reason: "przebieg zakonczony bledem" };
    case "paused":
      return { report: true, reason: "przebieg wstrzymany (np. budzet lub decyzja uzytkownika)" };
    case "partial":
      return { report: true, reason: `${counts.pendingItems} pozycji czeka na nastepny przebieg` };
    default:
      return { report: false, reason: "brak nowych materialow; cisza zgodnie z D8" };
  }
}

export interface RunReportSource {
  sourceId: string;
  platform: string;
  completeness: ListingCompleteness;
  scopeNote: string | null;
  newItems: number;
  analysed: number;
  failed: number;
  pending: number;
}

export interface CollectionRunReportInput {
  runId: string;
  collectionId: string;
  state: RunState;
  newAnalyses: number;
  failedItems: number;
  pendingItems: number;
  sources: RunReportSource[];
  /** Canonical links to the material analysed in this run. */
  links: string[];
  /** Extra honest notes: budget pause, incomplete listing, unknown outcomes. */
  notes?: string[];
  reportId?: string;
}

export interface RunReportRecord {
  report: ScanReport | null;
  decision: RunReportDecision;
  summary: string;
}

/** Compact, non-decorative summary the UI and Hermes can show verbatim. */
export function buildRunReportSummary(input: CollectionRunReportInput): string {
  const parts: string[] = [];
  parts.push(
    `${input.newAnalyses} nowych analiz, ${input.failedItems} bledow, ${input.pendingItems} oczekuje`,
  );
  if (input.sources.length > 0) {
    const sources = input.sources
      .map((source) => {
        const scope = source.scopeNote ? `${source.completeness}, ${source.scopeNote}` : source.completeness;
        return `${source.sourceId} (${source.platform}, ${scope}, nowe ${source.newItems})`;
      })
      .join("; ");
    parts.push(`zrodla: ${sources}`);
  }
  if (input.links.length > 0) {
    parts.push(`odsylacze: ${input.links.slice(0, 20).join(" ")}`);
  }
  if (input.notes && input.notes.length > 0) {
    parts.push(`uwagi: ${input.notes.join("; ")}`);
  }
  return parts.join(" | ");
}

/**
 * Persists the report of one run — or deliberately persists nothing.
 *
 * Returns the durable row plus the decision, so the caller can tell the
 * difference between "nothing to say" and "said it".
 */
export function recordRunReport(store: StorePort, input: CollectionRunReportInput): RunReportRecord {
  const decision = decideRunReport({
    state: input.state,
    newAnalyses: input.newAnalyses,
    failedItems: input.failedItems,
    pendingItems: input.pendingItems,
  });
  const summary = buildRunReportSummary(input);
  if (!decision.report) return { report: null, decision, summary };
  const report = ensureRunReport(store, {
    runId: input.runId,
    reportId: input.reportId ?? reportIdForRun(input.runId),
    summary,
    newAnalyses: input.newAnalyses,
    failedItems: input.failedItems,
    pendingItems: input.pendingItems,
  });
  return { report, decision, summary };
}

/** `report --run <id>`: reads the stored report(s). Never starts any work. */
export function readRunReport(store: StorePort, runId: string): ScanReport[] {
  return readReportsForRun(store, runId);
}

/**
 * Reports a previous run must deliver before requesting new work (D8). Called by
 * the next cron run, so a report finished after a launcher timeout still arrives.
 */
export function reportsToHandOff(store: StorePort, limit = 50): ScanReport[] {
  return listUndeliveredReports(store, limit);
}

/**
 * A successful write to stdout only means "handed to Hermes". The adapter reads
 * the acknowledgement; until then the UI shows "przekazano Hermesowi" and the
 * report stays deliverable, so a crash between the two repeats a message but
 * never an analysis.
 */
export function handOffRunReport(store: StorePort, reportId: string, note?: string): ScanReport {
  return markReportHandedOff(store, reportId, note);
}

/** Explicit confirmation from the adapter; closes the report. */
export function confirmRunReport(store: StorePort, reportId: string, note?: string): ScanReport {
  return confirmReport(store, reportId, note);
}

/**
 * A failed hand-off keeps the report undelivered (`failed` is still returned by
 * `reportsToHandOff`), so the next run retries the same run id.
 */
export function failRunReport(store: StorePort, reportId: string, note?: string): ScanReport {
  return failReport(store, reportId, note);
}

/** JSON-safe payload for the UI / Hermes (`omniwatch.report.v1`). */
export function reportPayload(report: ScanReport): Record<string, unknown> {
  return {
    protocol: REPORT_PROTOCOL,
    reportId: report.id,
    runId: report.runId,
    state: report.state,
    newAnalyses: report.newAnalyses,
    failedItems: report.failedItems,
    pendingItems: report.pendingItems,
    summary: report.summary,
    updatedAt: report.updatedAt,
  };
}
