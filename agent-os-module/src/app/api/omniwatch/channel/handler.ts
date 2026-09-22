/**
 * GET/POST /api/omniwatch/channel — the archive scan (T6 / D8 / D11 / T12).
 *
 * Split out of `route.ts` so the listing gate, the paging and the resume can be
 * exercised offline with injected ports. There is no second scan here: the manual
 * button and Hermes both go through the shared `runScan` (collections/scan.ts).
 *
 * The rules this file exists to keep:
 *   * looking is free to ask about and priced before anything is spent — the listing
 *     answers with the source's honest scope (`full` / `limited`) and a per-video cost;
 *   * a billed listing (X, Meta Ads, Instagram) runs ZERO lister calls until the caller
 *     confirms it explicitly;
 *   * results move in pages of at most 50 metadata rows; the analysis text is fetched
 *     one item at a time, only when it is opened;
 *   * `all` never pretends one batch is the whole archive — it says how much is left;
 *   * an interrupted scan is resumed by its run id, with the saved listing checkpoint.
 */

import { OmniWatchError } from "../../../../../../packages/omniwatch/src/contracts/errors.ts";
import type {
  ListingCompleteness,
  RunItem,
  RunRecord,
  ScanSettings,
  SourceCapabilities,
  SourceRef,
} from "../../../../../../packages/omniwatch/src/contracts/types.ts";
import type { MemoryPort, StorePort } from "../../../../../../packages/omniwatch/src/contracts/ports.ts";

export const CHANNEL_PROTOCOL = "omniwatch.channel.v1";

/** D11: metadata pages are at most this large, whatever the caller asks for. */
export const CHANNEL_PAGE_SIZE = 50;

export interface ChannelAccount {
  platform: string;
  handle: string;
}

export interface ScanStartInput {
  runId: string;
  collectionId: string;
  settings: ScanSettings;
  sources: SourceRef[];
  confirmPaidListing: boolean;
  trigger: "manual" | "cli";
}

export interface ChannelHandlerDeps {
  store: StorePort;
  memory: MemoryPort;
  source: {
    capabilities(source: SourceRef): SourceCapabilities;
    resolve(input: { url: string }): Promise<SourceRef>;
    list?(source: SourceRef, options: { cursor?: string | null; limit?: number }): Promise<{
      items: {
        sourceRef: SourceRef;
        title: string;
        durationSeconds?: number | null;
        publishedAt?: string | null;
        private?: boolean;
      }[];
      cursor?: string | null;
      completeness: ListingCompleteness;
      note?: string | null;
    }>;
  };
  /** Account parsing stays with the host adapter (`@/lib/omniwatchChannel`). */
  parseAccount(input: string, hint?: string): ChannelAccount | null;
  /** Estimated maximum cost of watching one video; null = not credible (D11). */
  estimateCost(seconds: number | null | undefined): number | null;
  /**
   * Turns the UI's preset choice into the analysis goal (T1 owns the preset library).
   * Omitted in tests that only exercise the listing and the paging.
   */
  resolvePreset?(preset: string, custom: string): { mode: "summary" | "teardown"; ask: string };
  /** Saves the collection (settings + sources) so the scan has durable inputs. */
  saveCollection(input: { settings: ScanSettings; sources: SourceRef[] }): { collectionId: string };
  /**
   * Admits the shared scan and returns as soon as it is admitted — the caller is not
   * held open for minutes. Production spawns the worker process; tests run the real
   * `runScan` with the given run id.
   */
  startScan(input: ScanStartInput): Promise<void> | void;
  /** The released on-disk scan history, kept readable next to the durable runs. */
  listSavedScans(): Promise<unknown[]>;
  readSavedScan(id: string): Promise<unknown | null>;
  defaultLanguage: string;
  languages: string[];
  now?(): number;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clampLimit(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return CHANNEL_PAGE_SIZE;
  return Math.min(Math.trunc(parsed), CHANNEL_PAGE_SIZE);
}

function languageOf(deps: ChannelHandlerDeps, value: string | null | undefined): string {
  const requested = String(value ?? "").trim();
  if (requested && deps.languages.includes(requested)) return requested;
  return deps.defaultLanguage;
}

/** A channel/account is not a video: the identity is the handle, not a video id. */
export function accountSourceRef(account: ChannelAccount): SourceRef {
  const handle = account.handle.replace(/^[@#]/, "");
  const canonical =
    account.platform === "youtube" ? `https://www.youtube.com/@${handle}`
      : account.platform === "tiktok" ? `https://www.tiktok.com/@${handle}`
        : account.platform === "instagram" ? `https://www.instagram.com/${handle}`
          : account.platform === "x" ? `https://x.com/${handle}`
            : `https://www.facebook.com/${handle}`;
  const platform = (["youtube", "tiktok", "instagram", "x", "meta-ads"] as const)
    .find((candidate) => candidate === account.platform) ?? "generic";
  return { platform, sourceId: handle, canonicalUrl: canonical };
}

export interface ListingItemView {
  url: string;
  title: string;
  platform: string;
  duration?: number | null;
  publishedAt?: string | null;
  cost?: number | null;
  atMost?: boolean;
  isPrivate?: boolean;
}

export interface ListingView {
  protocol: string;
  platform: string;
  handle: string;
  account: string;
  scope: SourceCapabilities["listing"];
  scopeNote: string | null;
  listingCost: SourceCapabilities["listingCost"];
  /** True when the caller must confirm before a single lister call is made. */
  needsConfirmation: boolean;
  requiresConfig: string[];
  /** Metadata rows in one batch (D11). */
  batchSize: number;
  videos: ListingItemView[];
  scanned: number;
  nextCursor: string | null;
  hasMore: boolean;
  /** Honest verdict of the enumeration so far. */
  completeness: ListingCompleteness | null;
  cost: number;
  unpriced: number;
  note?: string;
}

/**
 * The listing half: what is on the account, its honest scope, and what watching it
 * would cost. Never watches anything, and never lists a billed source unconfirmed.
 */
async function listAccount(deps: ChannelHandlerDeps, url: URL): Promise<Response> {
  const raw = String(url.searchParams.get("url") ?? "").trim();
  const hint = url.searchParams.get("platform") ?? undefined;
  const confirm = url.searchParams.get("confirm") === "1";
  const account = deps.parseAccount(raw, hint);
  if (!account) {
    return json(
      {
        error: "That does not look like an account. Paste the channel page — "
          + "youtube.com/@name, tiktok.com/@name, instagram.com/name or x.com/name.",
      },
      400,
    );
  }

  const ref = accountSourceRef(account);
  const capabilities = deps.source.capabilities(ref);
  const wantsAll = url.searchParams.get("limit") === "all";

  const base = {
    protocol: CHANNEL_PROTOCOL,
    platform: account.platform,
    handle: account.handle,
    account: account.handle,
    scope: capabilities.listing,
    scopeNote: capabilities.listingScopeNote ?? null,
    listingCost: capabilities.listingCost,
    requiresConfig: capabilities.requiresConfig,
    batchSize: CHANNEL_PAGE_SIZE,
  };

  if (capabilities.listing === "none") {
    return json(
      {
        ...base,
        error: `Zrodlo ${capabilities.platform} nie potrafi listowac archiwum; wklej pojedynczy URL materialu.`,
        needsConfirmation: false,
        videos: [],
        scanned: 0,
        nextCursor: null,
        hasMore: false,
        completeness: null,
        cost: 0,
        unpriced: 0,
      },
      400,
    );
  }

  // Billed (or unknown-cost) listing needs an explicit start: this branch makes ZERO
  // lister calls, so refusing can never spend money (T12).
  if (capabilities.listingCost !== "free" && !confirm) {
    return json({
      ...base,
      needsConfirmation: true,
      videos: [],
      scanned: 0,
      nextCursor: null,
      hasMore: false,
      completeness: null,
      cost: 0,
      unpriced: 0,
      note: capabilities.listingCost === "paid"
        ? `Listowanie ${capabilities.platform} jest platne (${capabilities.listingScopeNote ?? "zakres zalezy od dostawcy"}). `
          + "Potwierdz je jawnie, zanim wykonamy pierwsze platne wywolanie."
        : `Koszt listowania ${capabilities.platform} nie jest znany; start wymaga jawnego potwierdzenia.`,
    });
  }

  if (typeof deps.source.list !== "function") {
    return json({ ...base, error: `Adapter ${account.platform} nie udostepnia listowania.` }, 400);
  }

  const cursor = url.searchParams.get("cursor");
  let page;
  try {
    page = await deps.source.list.call(deps.source, ref, { cursor, limit: CHANNEL_PAGE_SIZE });
  } catch (error) {
    const failure = error instanceof OmniWatchError ? error : null;
    return json({ ...base, error: failure?.message ?? String(error) }, 502);
  }

  let cost = 0;
  let unpriced = 0;
  const videos: ListingItemView[] = page.items.map((item) => {
    const price = deps.estimateCost(item.durationSeconds);
    if (price === null) unpriced += 1;
    else cost += price;
    return {
      url: item.sourceRef.canonicalUrl,
      title: item.title,
      platform: item.sourceRef.platform,
      duration: item.durationSeconds ?? null,
      publishedAt: item.publishedAt ?? null,
      cost: price,
      atMost: item.durationSeconds === null || item.durationSeconds === undefined ? true : undefined,
      isPrivate: item.private === true,
    };
  });

  const hasMore = Boolean(page.cursor) || page.completeness === "partial";
  const notes: string[] = [];
  if (page.note) notes.push(page.note);
  if (capabilities.listing === "limited") {
    notes.push(`zakres ograniczony: ${capabilities.listingScopeNote ?? "zgodnie z mozliwosciami zrodla"}; to nie jest caly kanal`);
  }
  if (wantsAll && hasMore) {
    notes.push(
      `ALL nie miesci sie w jednej partii: ta odpowiedz to ${videos.length} metadanych, `
      + "a zrodlo ma wiecej — kolejne partie sa czescia tego samego przebiegu, nie calej listy.",
    );
  }
  if (unpriced > 0) {
    notes.push(`${unpriced} pozycji nie ma dlugosci, wiec koszt jest nieznany (nie pokazujemy zera jako ceny)`);
  }

  return json({
    ...base,
    needsConfirmation: false,
    videos,
    scanned: videos.length,
    nextCursor: page.cursor ?? null,
    hasMore,
    completeness: page.completeness,
    cost: Number(cost.toFixed(6)),
    unpriced,
    ...(notes.length > 0 ? { note: notes.join(" · ") } : {}),
  });
}

function itemView(item: RunItem): Record<string, unknown> {
  return {
    ordinal: item.ordinal,
    url: item.sourceRef.canonicalUrl,
    sourceId: item.sourceRef.sourceId,
    platform: item.sourceRef.platform,
    title: item.title ?? null,
    state: item.state,
    operationId: item.operationId,
  };
}

/** Progress of one durable run: metadata rows only, content on open (D11). */
function runView(
  deps: ChannelHandlerDeps,
  run: RunRecord,
  page: { items: RunItem[]; total: number },
  offset: number,
  limit: number,
): Record<string, unknown> {
  return {
    protocol: CHANNEL_PROTOCOL,
    runId: run.id,
    collectionId: run.collectionId,
    state: run.state,
    trigger: run.trigger,
    settings: {
      mode: run.settings.mode,
      focus: run.settings.focus ?? null,
      question: run.settings.question ?? null,
      language: run.settings.language,
      maxNewItems: run.settings.maxNewItems ?? null,
      budgetUsd: run.settings.budgetUsd ?? null,
    },
    offset,
    limit,
    total: page.total,
    hasMore: offset + page.items.length < page.total,
    // Never the analysis text: a scan of 7000 videos must not ship 7000 answers.
    items: page.items.map(itemView),
    reports: deps.store.listReports({ runId: run.id, limit: 5 }).map((report) => ({
      id: report.id,
      state: report.state,
      summary: report.summary,
      newAnalyses: report.newAnalyses,
      failedItems: report.failedItems,
      pendingItems: report.pendingItems,
    })),
  };
}

async function openRunItem(deps: ChannelHandlerDeps, runId: string, ordinal: number): Promise<Response> {
  const run = deps.store.getRun(runId);
  if (!run) return json({ error: "invalid_input", message: `Przebieg ${runId} nie istnieje.` }, 404);

  // `findRunItemBySource` is keyed by source id, not ordinal, so read the page that
  // holds the requested ordinal.
  let offset = 0;
  let item: RunItem | null = null;
  for (;;) {
    const page = deps.store.listRunItems(runId, { offset, limit: 500 });
    item = page.items.find((candidate) => candidate.ordinal === ordinal) ?? null;
    offset += page.items.length;
    if (item || page.items.length === 0 || offset >= page.total) break;
  }
  if (!item) return json({ error: "invalid_input", message: `Pozycja ${ordinal} nie istnieje w przebiegu.` }, 404);

  const buffer = deps.store.getBuffer(item.operationId)?.result ?? null;
  const delivery = deps.store.getDeliveryForOperation(item.operationId);
  const analysisId = buffer?.analysisId ?? delivery?.analysisId ?? null;
  let text = buffer?.content ?? null;
  if (text === null && analysisId) {
    const note = await deps.memory.readAnalysis(analysisId);
    text = note?.result.content ?? null;
  }

  return json({
    protocol: CHANNEL_PROTOCOL,
    runId,
    ordinal,
    sourceId: item.sourceRef.sourceId,
    url: item.sourceRef.canonicalUrl,
    title: item.title ?? buffer?.title ?? null,
    state: item.state,
    operationId: item.operationId,
    analysisId,
    text,
    memoryRef: delivery?.memoryRef ?? null,
    usage: buffer?.usage ?? null,
    incomplete: buffer?.incomplete === true,
  });
}

export interface ChannelHandler {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
}

export function createChannelHandler(deps: ChannelHandlerDeps): ChannelHandler {
  const now = deps.now ?? (() => Date.now());

  async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Progress polling for a durable run (the job id *is* the run id).
    const runId = url.searchParams.get("run") ?? url.searchParams.get("job");
    if (runId) {
      const run = deps.store.getRun(runId);
      if (!run) return json({ state: "gone" }, 404);
      const openRaw = url.searchParams.get("open");
      if (openRaw !== null) {
        const ordinal = Number(openRaw);
        if (!Number.isInteger(ordinal) || ordinal < 0) {
          return json({ error: "invalid_input", message: "Parametr open wymaga numeru pozycji." }, 400);
        }
        return openRunItem(deps, runId, ordinal);
      }
      const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0));
      const limit = clampLimit(url.searchParams.get("limit"));
      const page = deps.store.listRunItems(runId, { offset, limit });
      return json(runView(deps, run, page, offset, limit));
    }

    if (url.searchParams.get("history")) {
      return json({ scans: await deps.listSavedScans() });
    }
    const one = url.searchParams.get("scan");
    if (one) {
      const scan = await deps.readSavedScan(one);
      return scan ? json(scan) : json({ error: "That scan is not on disk any more." }, 404);
    }

    return listAccount(deps, url);
  }

  async function POST(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid_input", message: "Niepoprawne cialo zadania." }, 400);
    }

    const rawUrls = Array.isArray(body.urls) ? (body.urls as unknown[]) : [];
    const urls = rawUrls.map((value) => String(value)).filter((value) => /^https?:\/\//i.test(value));
    const account = String(body.account ?? "this account");
    const topic = String(body.topic ?? "").trim();
    const question = String(body.question ?? "").trim();
    const language = languageOf(deps, typeof body.lang === "string" ? body.lang : null);
    const confirmPaidListing = body.confirmPaidListing === true || body.confirm === true;
    const resumeRunId = typeof body.resume === "string" ? body.resume.trim() : "";
    const requestedRunId = typeof body.runId === "string" ? body.runId.trim() : "";

    // A resume of a known run re-uses its saved settings and sources; the listing
    // checkpoint in the collection settings makes it continue instead of re-reading.
    if (resumeRunId && !urls.length) {
      const run = deps.store.getRun(resumeRunId);
      if (!run) return json({ error: "invalid_input", message: `Przebieg ${resumeRunId} nie istnieje.` }, 404);
      if (run.state === "running" || run.state === "pending") {
        return json({ id: run.id, runId: run.id, state: run.state, resumed: true }, 202);
      }
      try {
        await deps.startScan({
          runId: run.id,
          collectionId: run.collectionId,
          settings: run.settings,
          sources: [],
          confirmPaidListing,
          trigger: "manual",
        });
      } catch (error) {
        return json(
          { error: "runtime_unavailable", message: error instanceof Error ? error.message : String(error) },
          503,
        );
      }
      return json({ id: run.id, runId: run.id, state: "running", resumed: true }, 202);
    }

    if (!urls.length) return json({ error: "No videos were picked." }, 400);
    if (urls.length > 500) return json({ error: "500 videos in one scan is the ceiling. Split it." }, 400);

    let sources: SourceRef[];
    try {
      sources = [];
      for (const url of urls) sources.push(await deps.source.resolve({ url }));
    } catch (error) {
      const failure = error instanceof OmniWatchError ? error : null;
      return json({ error: failure?.errorClass ?? "invalid_input", message: failure?.message ?? "bad url" }, 400);
    }

    const collectionId = typeof body.collectionId === "string" && body.collectionId.trim()
      ? body.collectionId.trim()
      : `ch_${account.replace(/[^\w.-]/g, "_").slice(0, 64) || "account"}`;
    // A preset question replaces the topic as what is asked of each video; for the two
    // structural modes there is no question and the topic keeps its old meaning.
    const preset = deps.resolvePreset
      ? deps.resolvePreset(String(body.preset ?? "both"), String(body.custom ?? ""))
      : null;
    const mode = preset?.mode ?? (body.mode === "teardown" ? "teardown" : "summary");
    const goalQuestion = preset?.ask || question;
    const settings: ScanSettings = {
      collectionId,
      mode,
      focus: topic || null,
      question: goalQuestion || null,
      language,
      maxNewItems: Number.isInteger(body.maxNewItems) ? (body.maxNewItems as number) : null,
      budgetUsd: typeof body.budgetUsd === "number" ? body.budgetUsd : null,
    };

    deps.saveCollection({ settings, sources });
    const runId = requestedRunId || `run_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      await deps.startScan({ runId, collectionId, settings, sources, confirmPaidListing, trigger: "manual" });
    } catch (error) {
      const failure = error instanceof OmniWatchError ? error : null;
      return json(
        {
          error: failure?.errorClass ?? "runtime_unavailable",
          message: failure?.message ?? String(error),
          id: runId,
          runId,
        },
        failure?.errorClass === "invalid_input" ? 400 : 503,
      );
    }

    return json({ id: runId, runId, collectionId, state: "running" }, 202);
  }

  return { GET, POST };
}
