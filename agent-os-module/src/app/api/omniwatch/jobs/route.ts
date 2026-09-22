import { DEFAULT_LANG } from "@/lib/omniwatch";
import I18N from "@/lib/omniwatchI18n";
import { createLegacyFilmPortFromOmniWatch } from "@/lib/omniwatchLegacyAdapter";
import type { LegacyFilmMode } from "@/lib/omniwatchLegacyAdapter";
import { getPanelRuntime } from "@/lib/omniwatchPanelRuntime";
import { enqueueAnalysis } from "../../../../../../packages/omniwatch/src/runtime/queue.ts";
import { createJobsHandler } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Watching a video is minutes of work: download, upload, then the model. So this never
// holds a request open — POST admits the work and answers 202 with an id, and the tab
// polls GET for the stage and the answer as it is written. The id is a *durable*
// operation id, so closing the card (or the whole panel) stops the polling and nothing
// else. The behaviour lives in `./handler.ts`, which the offline tests drive directly.

/** What one poll returns while the job is still running (kept for existing callers). */
export interface Progress {
  stage?: "download" | "upload" | "watch" | "merge" | "answer";
  meta?: { id: string; title: string; channel: string; duration: string; seconds: number; strip: number[] };
  parts?: number;
  partsDone?: number;
  fps?: number;
  reused?: boolean;
  text?: string;
}

export interface Result extends Progress {
  text: string;
  seconds: number;
  tokens: number;
  parts: number;
  reused: boolean;
  cost: number;
}

type JobsHandler = ReturnType<typeof createJobsHandler>;

let handlerPromise: Promise<JobsHandler> | null = null;

function handler(): Promise<JobsHandler> {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const panel = getPanelRuntime();
      const film = createLegacyFilmPortFromOmniWatch();
      return createJobsHandler({
        store: panel.store,
        memory: panel.memory,
        resolveSource: (input) => panel.resolveSource(input),
        isCached: (id) => panel.isCached(id),
        enqueue: (request) => enqueueAnalysis({ store: panel.store, request }),
        ensureWorker: (id) => panel.ensureWorker(id),
        lookupMedia: (ref) => panel.lookupMedia(ref),
        // The film modes keep their own implementation; only the id resolution is shared.
        legacyFilm: {
          async dispatch({ url, sourceId, mode, q, lang }) {
            const ref = await panel.resolveSource({ url, sourceId });
            return film.watch({
              sourceId: ref.legacyId ?? ref.sourceId,
              mode: mode as LegacyFilmMode,
              question: q,
              lang,
            });
          },
        },
        defaultLanguage: DEFAULT_LANG,
        languages: Object.keys(I18N),
      });
    })();
  }
  return handlerPromise;
}

export async function POST(req: Request): Promise<Response> {
  return (await handler()).POST(req);
}

export async function GET(req: Request): Promise<Response> {
  return (await handler()).GET(req);
}
