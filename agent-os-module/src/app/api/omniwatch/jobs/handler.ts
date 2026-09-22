/**
 * POST/GET /api/omniwatch/jobs — the single-video card (T6 / D5 / D9).
 *
 * Split out of `route.ts` so the whole behaviour can be exercised offline with
 * injected ports: no Next, no React, no browser. The route file only builds the real
 * dependencies and re-exports these two functions.
 *
 * The contract kept from the released module:
 *   POST { url | sourceId, q, mode, lang } -> 202 { id }, then GET ?id=… polls.
 *   `both` / `blueprint` / `screentext` still go to the film-production adapter, and
 *   their in-RAM job stays readable through the same GET.
 *
 * The contract added for the new core:
 *   * default mode is `summary` (A0) — a bare URL is enough;
 *   * `focus` narrows a summary and is a separate field from `question`;
 *   * a follow-up sends `conversationId` + `parent`, and the answer carries the
 *     `conversationId` / `turnId` the next question needs (F16, D9);
 *   * the work is admitted as a durable operation and executed by the on-demand
 *     worker, so dropping the poll (closing the card) never cancels it (D5).
 */

import { OmniWatchError } from "../../../../../../packages/omniwatch/src/contracts/errors.ts";
import { ANALYSIS_VERSION } from "../../../../../../packages/omniwatch/src/contracts/types.ts";
import type {
  AnalysisRequest,
  Mode,
  Operation,
  SourceRef,
} from "../../../../../../packages/omniwatch/src/contracts/types.ts";
import type { MemoryPort, StorePort } from "../../../../../../packages/omniwatch/src/contracts/ports.ts";
// Relative imports on purpose: this module is loaded directly by `node --test`, which
// does not resolve the host's `@/` alias. Next resolves relative paths just as well.
import { getJob, startJob } from "../../../../lib/omniwatchJobs.ts";
import type { Job } from "../../../../lib/omniwatchJobs.ts";

/** Modes the released endpoint accepted. */
export const LEGACY_MODES = ["ask", "summary", "teardown", "both", "blueprint", "screentext"] as const;
export type LegacyMode = (typeof LEGACY_MODES)[number];

/** Modes that stay on the film-production implementation. */
export const FILM_MODES = ["both", "blueprint", "screentext"] as const;

export interface JobMeta {
  id: string;
  title: string;
  channel: string;
  duration: string;
  seconds: number;
  strip: number[];
}

export interface JobsRequest {
  url?: string | null;
  sourceId?: string | null;
  mode?: string | null;
  q?: string | null;
  question?: string | null;
  focus?: string | null;
  lang?: string | null;
  conversationId?: string | null;
  parent?: string | null;
  parentTurnId?: string | null;
  force?: boolean;
}

/** The film-production adapter, as the jobs endpoint uses it. */
export interface LegacyFilmDispatcher {
  dispatch(request: {
    url?: string | null;
    sourceId?: string | null;
    mode: string;
    q: string;
    lang: string;
  }): Promise<{ answer: string; stats: unknown }>;
}

export interface JobsHandlerDeps {
  store: StorePort;
  memory: MemoryPort;
  /** Resolve a pasted URL or a cached-video id into the stable source identity. */
  resolveSource(input: { url?: string | null; sourceId?: string | null }): Promise<SourceRef>;
  /** True when `sourceId` is a video this machine already has cached. */
  isCached(sourceId: string): Promise<boolean>;
  /** Admit the analysis into the durable store. Never performs a paid call. */
  enqueue(request: AnalysisRequest): { operation: Operation; created: boolean };
  /** Make sure a consumer exists for this operation (spawn/verify the worker). */
  ensureWorker(operationId: string): Promise<void>;
  /** Free, cache-only metadata for the card; null when the video is not local yet. */
  lookupMedia(sourceRef: SourceRef): Promise<JobMeta | null>;
  /** The film modes keep their own path (no second analysis engine here). */
  legacyFilm: LegacyFilmDispatcher;
  defaultLanguage: string;
  languages: string[];
  /** Injectable for tests; defaults to the real clock. */
  now?(): number;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function normalizeMode(value: string | null | undefined): LegacyMode {
  const mode = (value ?? "summary").trim().toLowerCase();
  if (mode === "") return "summary";
  if ((LEGACY_MODES as readonly string[]).includes(mode)) return mode as LegacyMode;
  throw new OmniWatchError("invalid_input", `Nieznany tryb: ${mode}.`, {
    action: { label: "wybierz summary albo teardown", kind: "none" },
  });
}

export function isFilmMode(mode: string): boolean {
  return (FILM_MODES as readonly string[]).includes(mode);
}

/**
 * The one place legacy `q` becomes focus/question (D9). Intent is never guessed from
 * the text: a first question about a summary is its focus, a teardown question is a
 * question, and anything with a parent is always a question bound to that answer.
 */
export function mapLegacyInput(
  mode: LegacyMode,
  body: JobsRequest,
): { mode: Mode; focus: string | null; question: string | null } {
  const q = (body.q ?? "").trim();
  const explicitFocus = (body.focus ?? "").trim();
  const explicitQuestion = (body.question ?? "").trim();
  const hasParent = Boolean((body.parent ?? body.parentTurnId ?? "").trim());

  if (mode === "teardown") {
    return { mode: "teardown", focus: explicitFocus || null, question: explicitQuestion || q || null };
  }
  // ask / summary
  if (hasParent || explicitQuestion) {
    return {
      mode: "summary",
      focus: explicitFocus || null,
      question: explicitQuestion || q || null,
    };
  }
  return { mode: "summary", focus: explicitFocus || q || null, question: null };
}

/** Durable read side: operation + buffered result -> the poll shape the UI expects. */
export interface DurableJobView extends Job {
  operationId: string;
  analysisId?: string | null;
  conversationId?: string | null;
  turnId?: string | null;
  parentTurnId?: string | null;
  errorClass?: string | null;
  costKnown?: boolean;
}

function stageFor(operation: Operation): string {
  switch (operation.state) {
    case "pending":
      return "download";
    case "running":
      return "watch";
    case "result_ready":
      return "answer";
    default:
      return "answer";
  }
}

function stateFor(operation: Operation): Job["state"] {
  if (operation.state === "delivered" || operation.state === "result_ready") return "done";
  if (operation.state === "failed" || operation.state === "outcome_unknown" || operation.state === "budget_paused") {
    return "error";
  }
  return "running";
}

function stripFor(seconds: number, count = 16): number[] {
  if (!Number.isFinite(seconds) || seconds <= 0) return [];
  return Array.from({ length: count }, (_, i) => Math.round((seconds * (i + 0.5)) / count));
}

/** How the durable operation looks while it is still queued or running. */
function runningView(deps: JobsHandlerDeps, operation: Operation): DurableJobView {
  const attempts = deps.store.listAttempts(operation.id);
  const started = attempts.filter((attempt) => attempt.phase === "started" || attempt.phase === "response").length;
  return {
    id: operation.id,
    operationId: operation.id,
    kind: "analysis",
    state: "running",
    startedAt: Date.parse(operation.createdAt) || Date.now(),
    progress: { stage: stageFor(operation), parts: started, partsDone: Math.max(0, started - 1) },
  };
}

/**
 * The durable poll. Reads the operation, then the buffered/delivered answer, then the
 * media metadata — in that order, so a card re-opened by id shows the progress of work
 * that outlived the tab instead of "gone".
 */
export async function readDurableJob(
  deps: JobsHandlerDeps,
  id: string,
): Promise<DurableJobView | null> {
  const operation = deps.store.getOperation(id);
  if (!operation) return null;

  const state = stateFor(operation);
  if (state === "running") return runningView(deps, operation);

  const buffer = deps.store.getBuffer(operation.id)?.result ?? null;
  const delivery = deps.store.getDeliveryForOperation(operation.id);
  const analysisId = buffer?.analysisId ?? delivery?.analysisId ?? null;
  let content = buffer?.content ?? null;
  if (content === null && analysisId) {
    // The delivery buffer is dropped once the note is confirmed; the knowledge library
    // is then the source of the text (D7).
    const found = await deps.memory.readAnalysis(analysisId);
    content = found?.result.content ?? null;
  }

  const meta = await deps.lookupMedia(operation.request.sourceRef);
  const seconds = meta?.seconds ?? 0;
  const media: JobMeta = meta ?? {
    id: operation.request.sourceRef.legacyId ?? operation.request.sourceRef.sourceId,
    title: buffer?.title ?? "",
    channel: "",
    duration: "",
    seconds: 0,
    strip: [],
  };

  const attempts = deps.store.listAttempts(operation.id);
  const parts = buffer?.parts ?? attempts.filter((attempt) => attempt.phase === "started").length;

  return {
    id: operation.id,
    operationId: operation.id,
    kind: "analysis",
    state,
    startedAt: Date.parse(operation.createdAt) || Date.now(),
    finishedAt: Date.parse(operation.updatedAt) || undefined,
    error: operation.errorMessage ?? undefined,
    errorClass: operation.errorClass ?? null,
    analysisId,
    conversationId: buffer?.conversationId ?? null,
    turnId: buffer?.turnId ?? null,
    parentTurnId: buffer?.parentTurnId ?? null,
    costKnown: buffer?.usage?.costKnown ?? false,
    progress: {
      stage: "answer",
      meta: { ...media, seconds, strip: media.strip.length > 0 ? media.strip : stripFor(seconds) },
      parts,
      partsDone: parts,
      text: content ?? undefined,
    },
    result:
      state === "done"
        ? {
            text: content ?? "",
            seconds: 0,
            tokens: (buffer?.usage?.inputTokens ?? 0) + (buffer?.usage?.outputTokens ?? 0),
            parts,
            reused: delivery?.state === "confirmed",
            cost: buffer?.usage?.costKnown === true ? (buffer.usage.costUsd ?? 0) : 0,
          }
        : undefined,
  };
}

function languageOf(deps: JobsHandlerDeps, value: string | null | undefined): string {
  const requested = String(value ?? "").trim();
  if (requested && deps.languages.includes(requested)) return requested;
  return deps.defaultLanguage;
}

export interface JobsHandler {
  POST(request: Request): Promise<Response>;
  GET(request: Request): Promise<Response>;
}

export function createJobsHandler(deps: JobsHandlerDeps): JobsHandler {
  const now = deps.now ?? (() => Date.now());

  async function POST(request: Request): Promise<Response> {
    let body: JobsRequest;
    try {
      body = (await request.json()) as JobsRequest;
    } catch {
      return json({ error: "invalid_input", message: "Niepoprawne cialo zadania." }, 400);
    }

    const url = String(body.url ?? "").trim();
    const sourceId = String(body.sourceId ?? "").trim();
    if (!sourceId && !/^https?:\/\//i.test(url)) {
      return json({ error: "a http(s) link or a sourceId is required" }, 400);
    }
    if (sourceId && !(await deps.isCached(sourceId))) {
      return json({ error: "that video is not in the cache" }, 404);
    }

    let mode: LegacyMode;
    try {
      mode = normalizeMode(body.mode);
    } catch (error) {
      const failure = error instanceof OmniWatchError ? error : null;
      return json({ error: failure?.errorClass ?? "invalid_input", message: failure?.message ?? "bad mode" }, 400);
    }

    const lang = languageOf(deps, body.lang);

    // The film-production modes keep their own path, unchanged, but still answer 202 +
    // id and are still readable through the same GET.
    if (isFilmMode(mode)) {
      const job = startJob<Record<string, unknown>, { text: string; stats: unknown }>(
        async (j) => {
          j.progress = { stage: "watch" };
          const watched = await deps.legacyFilm.dispatch({
            url: url || null,
            sourceId: sourceId || null,
            mode,
            q: String(body.q ?? ""),
            lang,
          });
          // The legacy poll shape carries the answer as `text`; keep it.
          return { text: watched.answer, stats: watched.stats };
        },
        { kind: "legacy-film" },
      );
      return json({ id: job.id, state: "running", mode }, 202);
    }

    let sourceRef: SourceRef;
    try {
      sourceRef = await deps.resolveSource({ url: url || null, sourceId: sourceId || null });
    } catch (error) {
      const failure = error instanceof OmniWatchError ? error : null;
      return json(
        { error: failure?.errorClass ?? "invalid_input", message: failure?.message ?? "could not resolve that source" },
        failure?.errorClass === "missing_config" ? 503 : 400,
      );
    }

    const mapped = mapLegacyInput(mode, body);
    const parentTurnId = (body.parent ?? body.parentTurnId ?? "").trim() || null;
    // A follow-up without an explicit conversation belongs to the answer it replies to.
    const conversationId =
      (body.conversationId ?? "").trim() ||
      (parentTurnId ? (deps.store.getTurn(parentTurnId)?.conversationId ?? null) : null);

    const analysisRequest: AnalysisRequest = {
      sourceRef,
      mode: mapped.mode,
      focus: mapped.focus,
      question: mapped.question,
      language: lang,
      analysisVersion: ANALYSIS_VERSION,
      conversationId,
      parentTurnId,
      force: body.force === true,
    };

    let enqueued: { operation: Operation; created: boolean };
    try {
      enqueued = deps.enqueue(analysisRequest);
    } catch (error) {
      const failure = error instanceof OmniWatchError ? error : null;
      return json(
        { error: failure?.errorClass ?? "storage_unavailable", message: failure?.message ?? "could not admit the work" },
        503,
      );
    }

    try {
      // Admission never runs the analysis; it only makes sure a consumer exists (D5).
      await deps.ensureWorker(enqueued.operation.id);
    } catch (error) {
      // A worker that could not be started leaves the operation pending with a visible
      // reason — never a fake "running" (D5).
      return json(
        {
          error: "runtime_unavailable",
          message: error instanceof Error ? error.message : String(error),
          id: enqueued.operation.id,
        },
        503,
      );
    }

    return json(
      {
        id: enqueued.operation.id,
        operationId: enqueued.operation.id,
        state: enqueued.operation.state === "pending" ? "running" : enqueued.operation.state,
        created: enqueued.created,
        mode: mapped.mode,
        startedAt: now(),
      },
      202,
    );
  }

  async function GET(request: Request): Promise<Response> {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!id) return json({ error: "invalid_input", message: "Brak parametru id." }, 400);

    const ram = getJob<Record<string, unknown>, unknown>(id);
    if (ram && !ram.operationId) {
      return json({ state: ram.state, ...(ram.progress ?? {}), ...(ram.result ?? {}), error: ram.error });
    }

    const durable = await readDurableJob(deps, id);
    if (!durable) return json({ state: "gone" }, 404);
    return json({
      state: durable.state,
      ...(durable.progress ?? {}),
      ...(durable.result ?? {}),
      operationId: durable.operationId,
      analysisId: durable.analysisId ?? null,
      conversationId: durable.conversationId ?? null,
      turnId: durable.turnId ?? null,
      parentTurnId: durable.parentTurnId ?? null,
      errorClass: durable.errorClass ?? null,
      error: durable.error,
    });
  }

  return { POST, GET };
}
