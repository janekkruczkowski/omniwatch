/**
 * GET/POST /api/omniwatch/library — the analysis library in the host Vault (F5, D7).
 *
 *   GET                 -> { vaultRoot, analysesDir, answerModel } (what the panel shows)
 *   GET ?q=<words>      -> { hits: [{ analysisId, title, excerpt, relativePath }] }
 *   POST { question }   -> { text, refs, notFound }
 *
 * No second knowledge base: search and answers go through the host memory adapter
 * (`omniwatchMemory.ts`), confined to the OmniWatch directory of the configured Vault.
 * Answers rest on note bodies, carry explicit [[path|title]] references, and say
 * NOT_FOUND_TEXT plainly when the library holds no evidence. Note text reaches the host
 * model as data only; the adapter gives the model no tools.
 *
 * Kept free of Next and host imports so `node --test` drives it offline.
 */

import { OmniWatchError } from "../../../../../../packages/omniwatch/src/contracts/errors.ts";
import type { MemoryPort } from "../../../../../../packages/omniwatch/src/contracts/ports.ts";

export const MAX_QUERY_CHARS = 500;
export const MAX_SEARCH_LIMIT = 50;

export interface LibraryInfo {
  vaultRoot: string;
  analysesDir: string;
  /** True when a host model is configured, i.e. questions can be answered. */
  answerModel: boolean;
}

export interface LibraryHandlerDeps {
  /** Resolves the library lazily; a misconfigured Vault throws and becomes a 503. */
  library(): { memory: MemoryPort; info: LibraryInfo };
  /** The host's own configured Vault, for display; optional. */
  hostVaultRoot?(): Promise<string | null>;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function failure(error: unknown, fallbackStatus = 500): Response {
  if (error instanceof OmniWatchError) {
    const status =
      error.errorClass === "invalid_input"
        ? 400
        : error.errorClass === "missing_config" || error.errorClass === "storage_unavailable"
          ? 503
          : error.errorClass === "runtime_unavailable"
            ? 502
            : fallbackStatus;
    return json({ error: error.errorClass, message: error.message }, status);
  }
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: "runtime_unavailable", message }, fallbackStatus);
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
}

export function createLibraryHandler(deps: LibraryHandlerDeps) {
  async function GET(request: Request): Promise<Response> {
    let library: ReturnType<LibraryHandlerDeps["library"]>;
    try {
      library = deps.library();
    } catch (error) {
      return failure(error, 503);
    }
    const params = new URL(request.url).searchParams;
    const q = cleanText(params.get("q"));
    if (q === null) {
      const hostVaultRoot = deps.hostVaultRoot ? await deps.hostVaultRoot().catch(() => null) : null;
      return json({ ...library.info, hostVaultRoot });
    }
    if (q.length > MAX_QUERY_CHARS) {
      return json({ error: "invalid_input", message: `Zapytanie jest dluzsze niz ${MAX_QUERY_CHARS} znakow.` }, 400);
    }
    const requested = Number(params.get("limit") ?? "");
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_SEARCH_LIMIT) : 20;
    try {
      const hits = await library.memory.searchAnalyses(q, limit);
      return json({ query: q, hits, ...library.info });
    } catch (error) {
      return failure(error);
    }
  }

  async function POST(request: Request): Promise<Response> {
    let body: { question?: unknown; limit?: unknown };
    try {
      body = (await request.json()) as { question?: unknown; limit?: unknown };
    } catch {
      return json({ error: "invalid_input", message: "Niepoprawne cialo zadania." }, 400);
    }
    const question = cleanText(body?.question);
    if (question === null) return json({ error: "invalid_input", message: "Brak pytania." }, 400);
    if (question.length > MAX_QUERY_CHARS) {
      return json({ error: "invalid_input", message: `Pytanie jest dluzsze niz ${MAX_QUERY_CHARS} znakow.` }, 400);
    }
    const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(Math.floor(body.limit), 10) : undefined;

    let library: ReturnType<LibraryHandlerDeps["library"]>;
    try {
      library = deps.library();
    } catch (error) {
      return failure(error, 503);
    }
    try {
      const answer = await library.memory.answerFromAnalyses(question, limit ? { limit } : undefined);
      return json({ question, ...answer });
    } catch (error) {
      return failure(error, 502);
    }
  }

  return { GET, POST };
}
