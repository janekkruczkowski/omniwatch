/**
 * Queue admission (T3, D5).
 *
 * Both the panel and Hermes admit work through this function, so a repeated click
 * and a scheduled run deduplicate to the same operation. Admission never performs
 * a paid call: it only records intent, then asks the shell to make sure a consumer
 * exists.
 */

import { buildContextFromStore, conversationIdForSource, estimateTokens } from "../analysis/context.ts";
import { DEFAULT_CONVERSATION_BUDGET_TOKENS } from "../analysis/engine.ts";
import { OmniWatchError } from "../contracts/errors.ts";
import { computeAnalysisKey } from "../contracts/keys.ts";
import type { ClaimOperationResult, StorePort } from "../contracts/ports.ts";
import type { AnalysisRequest, Operation, RunRecord, ScanReport } from "../contracts/types.ts";
import { OperationJournal } from "../storage/operations.ts";

/**
 * The key the engine will compute for this request. Claiming with the same key is
 * what makes deduplication exact instead of "looks like the same title".
 */
export function analysisKeyForRequest(store: StorePort, request: AnalysisRequest): string {
  const conversationId = request.conversationId ?? conversationIdForSource(request.sourceRef);
  const context = buildContextFromStore(
    { listTurns: (id, limit) => store.listTurns(id, limit), getTurn: (id) => store.getTurn(id) },
    {
      sourceRef: request.sourceRef,
      conversationId,
      question: request.question ?? null,
      parentTurnId: request.parentTurnId ?? null,
      budget: { inputBudgetTokens: DEFAULT_CONVERSATION_BUDGET_TOKENS, estimateTokens },
    },
  );
  return computeAnalysisKey(request, context.contextKey);
}

export interface EnqueueOptions {
  store: StorePort;
  request: AnalysisRequest;
  runId?: string | null;
  ownerToken?: string | null;
}

export interface EnqueueResult extends ClaimOperationResult {
  /** True when this call created the operation; false means it already existed. */
  created: boolean;
}

export function enqueueAnalysis(options: EnqueueOptions): EnqueueResult {
  const { store, request } = options;
  const analysisKey = analysisKeyForRequest(store, request);
  const journal = new OperationJournal({ store, ownerToken: options.ownerToken ?? null });
  const claimed = journal.claim({
    request,
    analysisKey,
    runId: options.runId ?? null,
  });
  return { operation: claimed.operation, created: claimed.created };
}

export function pauseOperation(store: StorePort, operationId: string, reason?: string): Operation {
  const operation = store.getOperation(operationId);
  if (!operation) {
    throw new OmniWatchError("invalid_input", `operacja ${operationId} nie istnieje`, { operationId });
  }
  if (operation.state === "delivered" || operation.state === "result_ready") {
    throw new OmniWatchError(
      "invalid_input",
      `operacja ${operationId} ma juz wynik; pauza nie ma zastosowania`,
      { operationId },
    );
  }
  store.setOperationState(operationId, "budget_paused", {
    errorClass: "budget_paused",
    errorMessage: reason ?? "wstrzymane przez uzytkownika; nowe platne wywolania nie startuja",
  });
  const updated = store.getOperation(operationId);
  if (!updated) throw new OmniWatchError("storage_unavailable", "operacja zniknela po wstrzymaniu", { operationId });
  return updated;
}

/**
 * Cancelling one run stops it from taking more films. Work another run needs is
 * left alone: only this operation is closed, and an already-sent call may still
 * finish and be delivered.
 */
export function cancelOperation(store: StorePort, operationId: string, reason?: string): Operation {
  const operation = store.getOperation(operationId);
  if (!operation) {
    throw new OmniWatchError("invalid_input", `operacja ${operationId} nie istnieje`, { operationId });
  }
  if (operation.state === "delivered") {
    throw new OmniWatchError("invalid_input", `operacja ${operationId} jest juz dostarczona`, { operationId });
  }
  store.setOperationState(operationId, "failed", {
    errorClass: "budget_paused",
    errorMessage: reason ?? "anulowane przez uzytkownika; juz wyslane wywolanie moze sie zakonczyc i zostanie zapisane",
  });
  const updated = store.getOperation(operationId);
  if (!updated) throw new OmniWatchError("storage_unavailable", "operacja zniknela po anulowaniu", { operationId });
  return updated;
}

export interface RuntimeStatus {
  operations: Operation[];
  owner: { token: string; pid: number; heartbeatAt: string } | null;
  runs: RunRecord[];
  reports: ScanReport[];
}

/** Read-only status for the UI and for `omniwatch status`. */
export function readStatus(store: StorePort, options: { limit?: number } = {}): RuntimeStatus {
  const limit = options.limit ?? 50;
  return {
    operations: store.listOperations({ limit }),
    owner: store.getOwner(),
    runs: [],
    reports: store.listReports({ limit }),
  };
}
