/**
 * Durable scan reports (T2 / D8).
 *
 * The final report of a run is a permanent `reports` row with the stable run
 * id and a state: pending / handed_off / confirmed / failed.
 *
 * - The next cron run first delivers reports that are not confirmed yet
 *   (`listUndeliveredReports`), then requests new work.
 * - `report --run <id>` re-reads or re-sends only the report
 *   (`readReportsForRun`); it never triggers analysis.
 * - Repeating a hand-off is safe: the report identity is the run id, so a
 *   crash between hand-off and marking may repeat the message but never the
 *   analysis.
 */

import { OmniWatchError } from "../contracts/errors.ts";
import type { StorePort } from "../contracts/ports.ts";
import type { ScanReport } from "../contracts/types.ts";

export const UNDELIVERED_REPORT_STATES: ReadonlyArray<ScanReport["state"]> = [
  "pending",
  "handed_off",
  "failed",
];

/** One stable report identity per run: repeating a hand-off cannot duplicate it. */
export function reportIdForRun(runId: string): string {
  return `rpt_${runId}`;
}

export interface RunReportInput {
  runId: string;
  summary: string;
  newAnalyses?: number;
  failedItems?: number;
  pendingItems?: number;
  reportId?: string;
}

/** Creates (or refreshes) the durable report of one run. Never calls a model. */
export function ensureRunReport(store: StorePort, input: RunReportInput): ScanReport {
  return store.createReport({
    id: input.reportId ?? reportIdForRun(input.runId),
    runId: input.runId,
    state: "pending",
    newAnalyses: input.newAnalyses ?? 0,
    failedItems: input.failedItems ?? 0,
    pendingItems: input.pendingItems ?? 0,
    summary: input.summary,
  });
}

/** Reports the next cron run must deliver first: everything not confirmed. */
export function listUndeliveredReports(store: StorePort, limit = 50): ScanReport[] {
  const collected: ScanReport[] = [];
  for (const state of UNDELIVERED_REPORT_STATES) {
    collected.push(...store.listReports({ state, limit }));
  }
  collected.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));
  return collected.slice(0, Math.max(1, Math.trunc(limit)));
}

/** `report --run <id>`: read only, no new analysis. */
export function readReportsForRun(store: StorePort, runId: string): ScanReport[] {
  return store.listReports({ runId });
}

export function markReportHandedOff(store: StorePort, reportId: string, summary?: string): ScanReport {
  return transitionReport(store, reportId, "handed_off", summary);
}

export function confirmReport(store: StorePort, reportId: string, summary?: string): ScanReport {
  return transitionReport(store, reportId, "confirmed", summary);
}

/**
 * A hand-off error is recorded as `failed`; `listUndeliveredReports` still
 * returns it, so the next run retries the same report (stable run id) before
 * requesting new work.
 */
export function failReport(store: StorePort, reportId: string, summary?: string): ScanReport {
  return transitionReport(store, reportId, "failed", summary);
}

function transitionReport(
  store: StorePort,
  reportId: string,
  state: ScanReport["state"],
  summary?: string,
): ScanReport {
  const current = store.getReport(reportId);
  if (!current) {
    throw new OmniWatchError("invalid_input", `raport ${reportId} nie istnieje`);
  }
  store.updateReport(reportId, summary === undefined ? { state } : { state, summary });
  const updated = store.getReport(reportId);
  if (!updated) {
    throw new OmniWatchError(
      "storage_unavailable",
      `raport ${reportId} zniknal z magazynu stanu po zapisie`,
    );
  }
  return updated;
}

/** Short, non-decorative summary the UI/Hermes can show. */
export function describeReport(report: ScanReport): string {
  return `${report.newAnalyses} nowych analiz, ${report.failedItems} bledow, ${report.pendingItems} oczekuje (run ${report.runId}, raport ${report.id})`;
}
