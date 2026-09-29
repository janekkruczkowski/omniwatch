/**
 * R5: the card's progress comes from what really happened, never from the clock.
 *
 * The panel used to derive its stage from the operation state alone: any `running`
 * operation was "watching the film" (even while yt-dlp was still failing to download
 * it) and a `failed` one was drawn as "writing the answer". This module maps the
 * engine's real progress events (and, when no live event is available, the durable
 * journal) to the four steps the card draws, and says nothing it cannot back up:
 *
 *   queued   admitted, no consumer has started it yet (no step is lit)
 *   download preflight / prepare / source_wait (a rate-limited download waiting)
 *   upload   the film is prepared and split; the next thing is the upload
 *   watch    a model call has started (journaled attempt or `call` event)
 *   answer   merge / result
 *   failed   terminal failure: the card stops the steps and shows the error
 *
 * Plain functions over plain data: the jobs handler and the runtime's sync reader
 * both use it, and the offline tests drive it without Next.
 */

/** The last real progress event of one operation, as the in-process consumer saw it. */
export interface LiveProgress {
  stage: string;
  /** Wall clock (ms) when the event arrived; used to count a wait down. */
  at: number;
  itemIndex?: number | null;
  itemCount?: number | null;
  waitSeconds?: number | null;
  reason?: string | null;
}

export type CardStage = "queued" | "download" | "upload" | "watch" | "answer" | "failed";

export function stageForEvent(stage: string): CardStage | null {
  switch (stage) {
    case "preflight":
    case "prepare":
    case "source_wait":
      return "download";
    case "split":
      return "upload";
    case "call":
    case "call_reused":
    case "part_done":
    case "part_retry":
    case "part_fallback":
    case "part_unknown":
      return "watch";
    case "merge":
    case "result":
      return "answer";
    default:
      return null;
  }
}

export interface CardProgressInput {
  /** Durable operation state. */
  state: string;
  /** Journaled model attempts that started (a paid call was at least begun). */
  startedAttempts: number;
  live?: LiveProgress | null;
  now?: number;
}

export interface CardProgress {
  stage: CardStage;
  /** Present only while a rate-limited download is actually waiting to retry. */
  wait?: { reason: string; seconds: number; remainingSeconds: number };
}

/**
 * The step the card may light. A live event wins; without one, only the durable
 * journal counts: a started attempt means the model is watching, anything earlier is
 * the download. `pending` lights nothing - admitted work is not a download.
 */
export function cardProgress(input: CardProgressInput): CardProgress {
  const { state } = input;
  if (state === "failed" || state === "outcome_unknown" || state === "budget_paused") return { stage: "failed" };
  if (state === "delivered" || state === "result_ready") return { stage: "answer" };
  if (state === "pending") return { stage: "queued" };

  const live = input.live ?? null;
  const fromEvent = live ? stageForEvent(live.stage) : null;
  if (live && fromEvent) {
    if (live.stage === "source_wait" && typeof live.waitSeconds === "number") {
      const now = input.now ?? Date.now();
      const remaining = Math.ceil((live.at + live.waitSeconds * 1000 - now) / 1000);
      if (remaining > 0) {
        return {
          stage: "download",
          wait: { reason: live.reason ?? "rate_limited", seconds: live.waitSeconds, remainingSeconds: remaining },
        };
      }
    }
    return { stage: fromEvent };
  }
  return { stage: input.startedAttempts > 0 ? "watch" : "download" };
}
