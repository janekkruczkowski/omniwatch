/**
 * Durable buffer + delivery to the knowledge library (T2 / D3, D7).
 *
 *   wynik gotowy -> bufor trwaly + wiersz dostarczenia (state: pending)
 *                        |
 *                  zapis przez adapter pamieci (Vault / lokalne podsumowania)
 *                        |
 *            potwierdzenie -> referencja + operacja delivered
 *
 * - The buffer is written before delivery; the finished content stays there
 *   until the memory adapter confirms the write.
 * - A `MemoryPort` failure never discards the result: the delivery row keeps
 *   the payload and the state becomes `failed` (or `conflict`), so the next
 *   pass repeats only the write, never the model call.
 * - A retry first looks for an existing note with the same analysis id
 *   (interrupted write between note and reference) and adopts it instead of
 *   writing a second file.
 * - Content that differs from the buffered result is a human edit or a foreign
 *   note: conflict, never overwrite.
 *
 * Retention policy (D11): copies in the buffer may be pruned 24 h after the
 * delivery is confirmed. This module only records the policy; it never deletes
 * a payload, and it keeps the reference and the operation history.
 */

import { OmniWatchError, toOmniWatchError } from "../contracts/errors.ts";
import type { BufferPayload, MemoryPort, MemoryWriteResult, StorePort } from "../contracts/ports.ts";
import type { DeliveryRecord, MemoryRef } from "../contracts/types.ts";

/** D11 policy: confirmed buffer copies may be pruned after 24 h. Not enforced here. */
export const CONFIRMED_BUFFER_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface DeliveryDeps {
  store: StorePort;
  memory: MemoryPort;
  now?: () => string;
}

export interface DeliveryOutcome {
  operationId: string;
  delivery: DeliveryRecord;
  memoryRef: MemoryRef;
  /** True when an already existing note was reused or adopted. */
  reused: boolean;
}

interface DeliveryStoreExtensions {
  getDeliveryAttemptCount?(deliveryId: string): number;
  beginDeliveryAttempt?(deliveryId: string): number;
}

/** Journal the attempt before the adapter call; ignored by stores without the seam. */
function beginAttempt(store: StorePort, deliveryId: string): void {
  const extended = store as StorePort & DeliveryStoreExtensions;
  if (typeof extended.beginDeliveryAttempt !== "function") return;
  extended.beginDeliveryAttempt(deliveryId);
}

function deliveryFailureState(error: OmniWatchError): DeliveryRecord["state"] {
  return error.errorClass === "delivery_conflict" ? "conflict" : "failed";
}

/**
 * Writes one buffered result to the knowledge library and records the
 * reference only after the adapter reports success.
 */
export async function deliverOperation(
  deps: DeliveryDeps,
  operationId: string,
  options: { adoptExisting?: boolean } = {},
): Promise<DeliveryOutcome> {
  const { store, memory } = deps;
  const adoptExisting = options.adoptExisting ?? true;

  const operation = store.getOperation(operationId);
  if (!operation) {
    throw new OmniWatchError("invalid_input", `operacja ${operationId} nie istnieje w magazynie stanu`, {
      operationId,
    });
  }

  const existing = store.getDeliveryForOperation(operationId);
  if (existing && existing.state === "confirmed" && existing.memoryRef) {
    return { operationId, delivery: existing, memoryRef: existing.memoryRef, reused: true };
  }

  const buffer = store.getBuffer(operationId);
  if (!buffer) {
    throw new OmniWatchError(
      "storage_unavailable",
      `brak utrwalonego wyniku operacji ${operationId}; nie powtarzamy modelu, wymagane jest ponowne przeliczenie z jawnej decyzji`,
      { operationId, action: { label: "sprawdz operacje", kind: "check_operation" } },
    );
  }

  const delivery =
    existing ??
    store.createDelivery({
      id: deliveryIdForBuffer(buffer),
      operationId,
      analysisId: buffer.result.analysisId,
      state: "pending",
      memoryRef: null,
      errorMessage: null,
      payloadPath: null,
    });

  // Durable attempt marker *before* the write: a process crash inside the
  // adapter call still lets the next attempt adopt the existing note.
  beginAttempt(store, delivery.id);

  // Adopt a note that already exists for this analysis id (a previous attempt
  // may have written it and crashed before the reference was stored). A note
  // with different content is a conflict, never an overwrite.
  if (adoptExisting) {
    const adopted = await tryAdoptExistingNote(deps, delivery, buffer);
    if (adopted) return adopted;
  }

  let write: MemoryWriteResult;
  try {
    write = await memory.writeAnalysis(buffer.result);
  } catch (error) {
    const failure = toOmniWatchError(error, "storage_unavailable");
    store.updateDelivery(delivery.id, {
      state: deliveryFailureState(failure),
      errorMessage: failure.message,
    });
    throw failure;
  }

  store.updateDelivery(delivery.id, {
    state: "confirmed",
    memoryRef: write.memoryRef,
    errorMessage: null,
  });
  const confirmed = store.getDelivery(delivery.id);
  if (!confirmed) {
    throw new OmniWatchError(
      "storage_unavailable",
      `potwierdzenie dostarczenia ${delivery.id} zniknelo z magazynu stanu`,
      { operationId },
    );
  }
  return { operationId, delivery: confirmed, memoryRef: write.memoryRef, reused: write.reused };
}

/**
 * Retry path for a crash between "note written" and "reference written":
 * look the note up by the stable analysis id and adopt it. A different body is
 * a conflict (human edit or foreign note) and is never overwritten.
 */
async function tryAdoptExistingNote(
  deps: DeliveryDeps,
  delivery: DeliveryRecord,
  buffer: BufferPayload,
): Promise<DeliveryOutcome | null> {
  let found: Awaited<ReturnType<MemoryPort["readAnalysis"]>>;
  try {
    found = await deps.memory.readAnalysis(buffer.result.analysisId);
  } catch (error) {
    const failure = toOmniWatchError(error, "storage_unavailable");
    deps.store.updateDelivery(delivery.id, {
      state: deliveryFailureState(failure),
      errorMessage: failure.message,
    });
    throw failure;
  }
  if (!found) return null;

  if (
    found.result.analysisKey !== buffer.result.analysisKey ||
    found.result.content !== buffer.result.content
  ) {
    const conflict = new OmniWatchError(
      "delivery_conflict",
      `Notatka ${buffer.result.analysisId} istnieje z inna trescia (zmiana poza OmniWatchem); nie nadpisujemy pliku`,
      {
        operationId: delivery.operationId,
        action: { label: "rozwiaz konflikt notatki", kind: "check_operation" },
      },
    );
    deps.store.updateDelivery(delivery.id, {
      state: "conflict",
      errorMessage: conflict.message,
    });
    throw conflict;
  }

  deps.store.updateDelivery(delivery.id, {
    state: "confirmed",
    memoryRef: found.memoryRef,
    errorMessage: null,
  });
  const confirmed = deps.store.getDelivery(delivery.id);
  if (!confirmed) {
    throw new OmniWatchError(
      "storage_unavailable",
      `potwierdzenie dostarczenia ${delivery.id} zniknelo z magazynu stanu`,
      { operationId: delivery.operationId },
    );
  }
  return {
    operationId: delivery.operationId,
    delivery: confirmed,
    memoryRef: found.memoryRef,
    reused: true,
  };
}

/**
 * Delivers every pending buffer, oldest first. A failure stops the batch and
 * is rethrown (with the delivery row already marked), so the caller can gate
 * new paid work instead of silently skipping the result.
 */
export async function deliverPending(
  deps: DeliveryDeps,
  options: { limit?: number } = {},
): Promise<DeliveryOutcome[]> {
  const pending = deps.store.listPendingDeliveries(options.limit);
  const outcomes: DeliveryOutcome[] = [];
  for (const delivery of pending) {
    outcomes.push(await deliverOperation(deps, delivery.operationId));
  }
  return outcomes;
}

/**
 * True while a finished result waits for a confirmed write; the runner must
 * deliver it before starting another paid call (D3, D11).
 */
export function isDeliveryBlocking(store: StorePort, operationId: string): boolean {
  const operation = store.getOperation(operationId);
  if (!operation) return false;
  return operation.state === "result_ready";
}

function deliveryIdForBuffer(buffer: BufferPayload): string {
  return `dlv_${buffer.result.analysisKey.slice(0, 24)}`;
}
