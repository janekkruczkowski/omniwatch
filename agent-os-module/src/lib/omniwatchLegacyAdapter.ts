// OmniWatch legacy entrypoint adapter (T1, D9).
//
// The released Agent OS module accepted `ask`/`summary`, `teardown` and the film
// production modes `both`/`blueprint`/`screentext`, plus a `sourceId` cache lookup.
// That surface is kept; only the two analysis modes are routed to the new core.
//
// The adapter is dependency-injected on purpose:
//   - `analyze` + `analysisDeps` come from `@omniwatch/core` (the built package, or a
//     relative path in this repo during development);
//   - `legacyFilm` is the existing `@/lib/omniwatch` implementation, untouched;
//   - `resolveSource` is the host's URL/cache-id resolver.
//
// Nothing here is imported by `omniwatch.ts`, so every existing export and every
// film-production import keeps working unchanged.

import { ANALYSIS_VERSION, OmniWatchError } from "../../../packages/omniwatch/src/contracts/index.ts";
import type {
  AnalysisRequest,
  AnalysisResult,
  ErrorClass,
  SourceRef,
} from "../../../packages/omniwatch/src/contracts/types.ts";
import type { AnalysisDeps } from "../../../packages/omniwatch/src/analysis/engine.ts";

/** Modes the legacy endpoint accepted. */
export const LEGACY_MODES = ["ask", "summary", "teardown", "both", "blueprint", "screentext"] as const;
export type LegacyMode = (typeof LEGACY_MODES)[number];

/** Modes handled by the new core. */
export const CORE_MODES = ["summary", "teardown"] as const;

/** Modes that stay on the film-production implementation path. */
export const LEGACY_FILM_MODES = ["both", "blueprint", "screentext"] as const;
export type LegacyFilmMode = (typeof LEGACY_FILM_MODES)[number];

/**
 * Exports of `@/lib/omniwatch` the film project and the routes rely on. This list is
 * documentation for the release manifest and for the compatibility test; none of them
 * is renamed or removed by this extraction.
 */
export const KEPT_OMNIWATCH_EXPORTS = [
  "OMNI_ROOT",
  "CACHE_ROOT",
  "OUT_ROOT",
  "DEFAULT_LANG",
  "STRIP",
  "PRICE_IN",
  "PRICE_OUT",
  "BIN_PATH",
  "run",
  "toolsPresent",
  "apiKey",
  "cleanup",
  "cacheKey",
  "videoDir",
  "fpsFor",
  "fmt",
  "probeDuration",
  "fetchVideo",
  "cachedVideo",
  "splitParts",
  "frameJpeg",
  "upload",
  "shiftTimestamps",
  "trimRunOn",
  "watch",
  "vaultRoot",
  "logToVault",
  "save",
  "lang",
  "Mode",
  "VideoInfo",
  "WatchStats",
  "WatchEvents",
] as const;

/** Shape the legacy HTTP endpoint and the CLI already send. */
export interface LegacyRequest {
  mode?: string | null;
  url?: string | null;
  /** The legacy question parameter. */
  q?: string | null;
  /** Cached-video lookup used by the old jobs endpoint. */
  sourceId?: string | null;
  lang?: string | null;
  focus?: string | null;
  conversationId?: string | null;
  parentTurnId?: string | null;
  force?: boolean;
}

export interface LegacyFilmPort {
  watch(input: {
    sourceId: string;
    mode: LegacyFilmMode;
    question: string;
    lang: string;
  }): Promise<{ answer: string; stats: unknown }>;
}

export interface LegacyAdapterDeps {
  /** Core analysis entry point (`analyze` from @omniwatch/core). */
  analyze: (request: AnalysisRequest, deps: AnalysisDeps) => Promise<AnalysisResult>;
  /** Ports the core needs; the host supplies clock, store, source, model, memory. */
  analysisDeps: AnalysisDeps;
  /** URL or cached-video-id resolution, including `sourceId` lookups. */
  resolveSource: (input: { url?: string | null; sourceId?: string | null }) => Promise<SourceRef>;
  /** The existing implementation, kept for both/blueprint/screentext. */
  legacyFilm?: LegacyFilmPort;
  defaultLanguage?: string;
}

export type LegacyDispatchResult =
  | { kind: "analysis"; mode: "summary" | "teardown"; result: AnalysisResult }
  | { kind: "legacy-film"; mode: LegacyFilmMode; answer: string; stats: unknown };

export function normalizeLegacyMode(value: string | null | undefined): LegacyMode {
  const mode = (value ?? "ask").trim().toLowerCase();
  if ((LEGACY_MODES as readonly string[]).includes(mode)) return mode as LegacyMode;
  throw new OmniWatchError("invalid_input", `Nieznany tryb: ${mode}.`, {
    action: { label: "wybierz summary albo teardown", kind: "none" },
  });
}

export function isLegacyFilmMode(mode: string): mode is LegacyFilmMode {
  return (LEGACY_FILM_MODES as readonly string[]).includes(mode);
}

export interface MappedLegacyInput {
  coreMode: "summary" | "teardown";
  focus: string | null;
  question: string | null;
}

/**
 * Legacy `q` mapping (D9): the first question targets a summary (`focus`) or a
 * teardown (`question`); any further question is always a `question` bound to
 * `parentTurnId`. Intent is never guessed from the text.
 */
export function mapLegacyInput(mode: LegacyMode, request: LegacyRequest): MappedLegacyInput {
  const q = (request.q ?? "").trim();
  const explicitFocus = (request.focus ?? "").trim();
  const coreMode: "summary" | "teardown" = mode === "teardown" || mode === "both" ? "teardown" : "summary";

  if (mode === "teardown") {
    return {
      coreMode: "teardown",
      focus: explicitFocus || null,
      question: q || null,
    };
  }
  // ask and summary
  if (request.parentTurnId) {
    return { coreMode: "summary", focus: explicitFocus || null, question: q || null };
  }
  return { coreMode: "summary", focus: q || explicitFocus || null, question: null };
}

export interface LegacyAdapter {
  readonly modes: readonly string[];
  dispatch(request: LegacyRequest): Promise<LegacyDispatchResult>;
}

/**
 * Build the dispatcher. Both delivery shells (Agent OS route and the standalone
 * launcher) call this with their own ports, which is why a stub run through either
 * shell produces the same AnalysisResult.
 */
export function createLegacyAdapter(deps: LegacyAdapterDeps): LegacyAdapter {
  return {
    modes: LEGACY_MODES,
    async dispatch(request: LegacyRequest): Promise<LegacyDispatchResult> {
      const mode = normalizeLegacyMode(request.mode);
      const language = (request.lang || deps.defaultLanguage || "en").trim() || "en";

      if (isLegacyFilmMode(mode)) {
        if (!deps.legacyFilm) {
          throw new OmniWatchError(
            "invalid_input",
            `Tryb ${mode} nalezy do sciezki produkcji filmowej, ktora nie jest podlaczona.`,
            { action: { label: "uzyj summary albo teardown", kind: "none" } },
          );
        }
        const source = await deps.resolveSource({ url: request.url, sourceId: request.sourceId });
        const film = await deps.legacyFilm.watch({
          sourceId: source.legacyId ?? source.sourceId,
          mode,
          question: (request.q ?? "").trim(),
          lang: language,
        });
        return { kind: "legacy-film", mode, answer: film.answer, stats: film.stats };
      }

      const mapped = mapLegacyInput(mode, request);
      const sourceRef = await deps.resolveSource({ url: request.url, sourceId: request.sourceId });
      const analysisRequest: AnalysisRequest = {
        sourceRef,
        mode: mapped.coreMode,
        focus: mapped.focus,
        question: mapped.question,
        language,
        analysisVersion: ANALYSIS_VERSION,
        conversationId: request.conversationId ?? null,
        parentTurnId: request.parentTurnId ?? null,
        force: request.force === true,
      };
      const result = await deps.analyze(analysisRequest, deps.analysisDeps);
      return { kind: "analysis", mode: mapped.coreMode, result };
    },
  };
}

/** Machine class for adapters that need to classify a thrown legacy error. */
export function errorClassOf(error: unknown): ErrorClass {
  if (error instanceof OmniWatchError) return error.errorClass;
  return "runtime_unavailable";
}

/**
 * The film-production path, unchanged: it reads the video from the legacy cache and
 * calls the legacy `watch`. Dynamic import keeps this module loadable by plain Node
 * (the compatibility tests import it) without pulling `@/lib/omniwatch` - and with it
 * the film blueprint - into the core.
 */
export function createLegacyFilmPortFromOmniWatch(): LegacyFilmPort {
  return {
    async watch({ sourceId, mode, question, lang }) {
      const legacy = await import("@/lib/omniwatch");
      const cached = await legacy.cachedVideo(sourceId);
      if (!cached) {
        throw new OmniWatchError("source_unavailable", "Material nie jest w cache.", {
          action: { label: "pobierz material", kind: "none" },
        });
      }
      const key = await legacy.apiKey();
      if (!key) {
        throw new OmniWatchError("missing_config", "Brak klucza API dla sciezki filmowej.", {
          action: { label: "ustaw klucz API", kind: "fix_config" },
        });
      }
      const watched = await legacy.watch(key, cached.info, cached.src, question, lang, mode);
      return { answer: watched.answer, stats: watched.stats };
    },
  };
}

/**
 * Convenience wrapper for the Agent OS route: the host passes the already-built core
 * wiring (`analyze` + `analysisDeps` from the runtime) and gets the legacy film modes
 * for free. Nothing is stubbed here, so a missing core wiring is a type error at the
 * call site rather than a silent failure at runtime.
 */
export function createAgentOsLegacyAdapter(
  deps: Omit<LegacyAdapterDeps, "legacyFilm"> & { legacyFilm?: LegacyFilmPort },
): LegacyAdapter {
  return createLegacyAdapter({ ...deps, legacyFilm: deps.legacyFilm ?? createLegacyFilmPortFromOmniWatch() });
}
