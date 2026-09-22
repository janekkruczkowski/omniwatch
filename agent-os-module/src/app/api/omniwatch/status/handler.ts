/**
 * GET /api/omniwatch/status — what the tab needs before it can run anything, plus the
 * durable progress read (T6 / D5).
 *
 * The original fields (`ready`, `key`, `ytDlp`, `ffmpeg`, `defaultLang`, `langs`) are
 * unchanged so the existing UI keeps working. The additions describe the shared
 * runtime: whether a worker owns the data directory, what it is working on, and the
 * latest reports — read from SQLite, so they survive a panel restart.
 */

import type { Operation, ScanReport } from "../../../../../../packages/omniwatch/src/contracts/types.ts";
import type { StorePort } from "../../../../../../packages/omniwatch/src/contracts/ports.ts";

export interface StatusHandlerDeps {
  store: StorePort;
  apiKeyPresent(): Promise<boolean>;
  toolsPresent(): Promise<{ ytDlp: boolean; ffmpeg: boolean }>;
  /** Opportunistic cache cleanup; never awaited by the request. */
  cleanup?(): Promise<unknown>;
  defaultLang: string;
  langs: { code: string; name: string }[];
  operationLimit?: number;
}

function operationView(operation: Operation): Record<string, unknown> {
  return {
    id: operation.id,
    state: operation.state,
    mode: operation.request.mode,
    sourceId: operation.request.sourceRef.sourceId,
    url: operation.request.sourceRef.canonicalUrl,
    runId: operation.runId ?? null,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    errorClass: operation.errorClass ?? null,
    errorMessage: operation.errorMessage ?? null,
  };
}

export function createStatusHandler(deps: StatusHandlerDeps) {
  return {
    async GET(): Promise<Response> {
      const [key, tools] = await Promise.all([deps.apiKeyPresent(), deps.toolsPresent()]);
      // Opportunistic and best effort: a cache sweep must never fail the status call.
      void deps.cleanup?.().catch(() => {});

      const limit = deps.operationLimit ?? 50;
      const operations = deps.store.listOperations({ limit });
      const owner = deps.store.getOwner();
      const reports: ScanReport[] = deps.store.listReports({ limit: 10 });

      return new Response(
        JSON.stringify({
          ready: Boolean(key) && tools.ytDlp && tools.ffmpeg,
          key: Boolean(key),
          ytDlp: tools.ytDlp,
          ffmpeg: tools.ffmpeg,
          defaultLang: deps.defaultLang,
          langs: deps.langs,
          // Additive: the durable view of the shared runtime.
          owner: owner ? { pid: owner.pid, heartbeatAt: owner.heartbeatAt } : null,
          operations: operations.map(operationView),
          reports: reports.map((report) => ({
            id: report.id,
            runId: report.runId,
            state: report.state,
            summary: report.summary,
            newAnalyses: report.newAnalyses,
            updatedAt: report.updatedAt,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
}
