/**
 * GET/POST /api/omniwatch/scout — the scheduled/manual sweep (T6 / D8 / T13).
 *
 * Hermes no longer talks to this route: it runs the shared CLI (`scan --collection
 * <id>` / `report --run <id>`), which is the same `runScan` used here. The route is
 * what the Scout tab presses, so the manual button and the cron provably share one
 * implementation.
 *
 * Rules kept from D8:
 *   * the caller passes a collection id, never a prompt;
 *   * zero new material and no failure produces no report and no notification;
 *   * a report finished after the launcher gave up is delivered by the NEXT run,
 *     before that run requests any new work;
 *   * `?report=<runId>` is a pure read — it re-sends the stored report and never
 *     triggers an analysis.
 */

import type { ScanReport, SourceRef } from "../../../../../../packages/omniwatch/src/contracts/types.ts";
import type { StorePort } from "../../../../../../packages/omniwatch/src/contracts/ports.ts";
import { getJob, startJob } from "../../../../lib/omniwatchJobs.ts";
import type { Job } from "../../../../lib/omniwatchJobs.ts";
import { accountSourceRef } from "../channel/handler.ts";

export const SCOUT_PROTOCOL = "omniwatch.scout.v1";

export interface ScoutSourceConfig {
  id?: string;
  kind?: string;
  platform?: string;
  handle?: string;
}

export interface ScoutConfig {
  collectionId?: string;
  sources?: ScoutSourceConfig[];
  topic?: string;
  teardowns?: number;
  days?: number;
  maxMinutes?: number;
}

export interface ScoutScanOutcome {
  protocol: string;
  runId: string;
  collectionId: string;
  state: string;
  analysed: number;
  failedItems: number;
  pendingItems: number;
  newItems: number;
  modelCalls: number;
  /** Per-source honest scope, as reported by the shared scan. */
  sources?: { sourceId: string; completeness?: string }[];
  report: ScanReport | null;
  reportDecision: { report: boolean; reason: string };
  links: string[];
  notes: string[];
}

export interface ScoutHandlerDeps {
  store: StorePort;
  /** The one shared scan (collections/scan.ts) — never a second engine. */
  runScan(input: {
    collectionId: string;
    trigger: "manual" | "schedule" | "cli";
    runId?: string;
    sources?: SourceRef[];
    confirmPaidListing?: boolean;
    maxNewItems?: number | null;
    onProgress?: (event: { stage: string; sourceId?: string | null; message?: string | null; newItems?: number }) => void;
  }): Promise<ScoutScanOutcome>;
  /** Reports of earlier runs that were never confirmed (D8). */
  reportsToHandOff(limit?: number): ScanReport[];
  handOffRunReport(reportId: string, note?: string): ScanReport;
  /** `report --run <id>`: read-only, no analysis. */
  readRunReport(runId: string): ScanReport[];
  readConfig(): Promise<ScoutConfig>;
  writeConfig?(config: ScoutConfig): Promise<void>;
  readLatest(): Promise<unknown>;
  toolsPresent(): Promise<{ ytDlp: boolean; ffmpeg: boolean }>;
  apiKeyPresent(): Promise<boolean>;
  apifyReady(): Promise<{ hermes?: boolean; apify?: boolean }>;
  needsApify(sources: ScoutSourceConfig[]): boolean;
  /** Saves the resolved collection sources before the scan. */
  saveCollection(input: { collectionId: string; sources: SourceRef[] }): void;
  /** Resolve an account handle into a channel SourceRef. */
  accountRef(platform: string, handle: string): SourceRef;
  saveRun?(run: unknown): Promise<void>;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function reportView(report: ScanReport): Record<string, unknown> {
  return {
    protocol: "omniwatch.report.v1",
    reportId: report.id,
    runId: report.runId,
    state: report.state,
    newAnalyses: report.newAnalyses,
    failedItems: report.failedItems,
    pendingItems: report.pendingItems,
    summary: report.summary,
    updatedAt: report.updatedAt,
  };
}

/**
 * The Scout tab's "latest run" shape, rebuilt from the durable run: the individual
 * answers live in the knowledge library and in the run's items, so the panel can still
 * show what the sweep watched without keeping a second copy of the results.
 */
export function legacyRunView(store: StorePort, outcome: ScoutScanOutcome): Record<string, unknown> {
  const items = outcome.runId ? store.listRunItems(outcome.runId, { limit: 500 }).items : [];
  const teardowns = items
    .map((item) => {
      const buffer = store.getBuffer(item.operationId)?.result ?? null;
      if (!buffer || !buffer.content) return null;
      return {
        url: item.sourceRef.canonicalUrl,
        title: item.title ?? buffer.title,
        videoId: item.sourceRef.legacyId ?? item.sourceRef.sourceId,
        text: buffer.content,
        cost: buffer.usage?.costKnown === true ? buffer.usage.costUsd ?? undefined : undefined,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return {
    subject: undefined,
    at: new Date().toISOString(),
    sources: outcome.sources?.length ?? 0,
    scanned: outcome.newItems,
    candidates: [],
    teardowns,
    note: outcome.notes.length > 0 ? outcome.notes.join(" · ") : undefined,
  };
}

export interface ScoutHandler {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
}

export function createScoutHandler(deps: ScoutHandlerDeps): ScoutHandler {
  async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // `report --run <id>`, over HTTP: a pure read of the durable report.
    const reportRun = url.searchParams.get("report");
    if (reportRun) {
      return json({
        protocol: SCOUT_PROTOCOL,
        runId: reportRun,
        reports: deps.readRunReport(reportRun).map(reportView),
      });
    }

    const jobId = url.searchParams.get("job");
    if (jobId) {
      const job = getJob<{ stage?: string }, { outcome: ScoutScanOutcome; run: Record<string, unknown> }>(jobId);
      if (!job) return json({ state: "gone" }, 404);
      const result = job.result ?? null;
      return json({
        protocol: SCOUT_PROTOCOL,
        state: job.state,
        ...(job.progress ?? {}),
        // `run` keeps the shape the Scout tab already renders; `outcome` is the durable
        // summary (state, counts, report, links).
        run: result?.run ?? null,
        outcome: result?.outcome ?? null,
        error: job.error,
      });
    }

    const [config, latest, tools, plugins, key] = await Promise.all([
      deps.readConfig(),
      deps.readLatest(),
      deps.toolsPresent(),
      deps.apifyReady(),
      deps.apiKeyPresent(),
    ]);
    const sources = config.sources ?? [];
    return json({
      config,
      latest,
      ready: {
        key,
        ytDlp: tools.ytDlp,
        ffmpeg: tools.ffmpeg,
        ...plugins,
        apifyNeeded: deps.needsApify(sources),
      },
    });
  }

  async function POST(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid_input", message: "Niepoprawne cialo zadania." }, 400);
    }

    const action = String(body.action ?? "scan");

    if (action === "config") {
      const config = body.config as ScoutConfig | undefined;
      if (!config || !Array.isArray(config.sources)) return json({ error: "bad config" }, 400);
      if (deps.writeConfig) await deps.writeConfig(config);
      return json({ config });
    }

    if (action === "remember") {
      const url = String(body.url ?? "");
      const text = String(body.text ?? "");
      if (!/^https?:\/\//i.test(url) || !text) return json({ error: "url and text required" }, 400);
      const latest = (await deps.readLatest()) as Record<string, unknown> | null;
      const run = latest ?? { at: new Date().toISOString(), sources: 0, scanned: 0, candidates: [], teardowns: [] };
      const teardowns = Array.isArray(run.teardowns) ? (run.teardowns as unknown[]) : [];
      run.teardowns = [
        { url, title: String(body.title ?? ""), videoId: String(body.videoId ?? ""), text },
        ...teardowns.filter((entry) => (entry as { url?: string }).url !== url),
      ];
      if (deps.saveRun) await deps.saveRun(run);
      return json({ ok: true });
    }

    if (action !== "scan") return json({ error: "unknown action" }, 400);

    const config = await deps.readConfig();
    const explicitCollection = typeof body.collectionId === "string" ? body.collectionId.trim() : "";
    const collectionId = explicitCollection || config.collectionId || "scout";

    // Hermes passes the collection id; the manual button relies on the saved config.
    let sources: SourceRef[] | undefined;
    if (!explicitCollection) {
      const configured = (config.sources ?? []).filter((source) => source && source.handle);
      if (configured.length === 0) {
        return json(
          { error: "Say what you are making a video about, or add an account to watch." },
          400,
        );
      }
      sources = configured.map((source) => deps.accountRef(source.platform ?? "youtube", String(source.handle)));
      deps.saveCollection({ collectionId, sources });
    }

    // D8: deliver what earlier runs produced before asking for new work, so a report
    // finished after the launcher timed out still arrives on the next run.
    const pending = deps.reportsToHandOff(20);
    const handedOff = pending.map((report) => {
      try {
        return reportView(deps.handOffRunReport(report.id, "przekazano Hermesowi przy kolejnym uruchomieniu"));
      } catch {
        return reportView(report);
      }
    });

    const key = await deps.apiKeyPresent();
    if (!key) return json({ error: "No Qwen key — see the OmniWatch tab." }, 503);

    const trigger = body.trigger === "schedule" ? "schedule" : "manual";
    const job = startJob<{ stage?: string }, { outcome: ScoutScanOutcome; run: Record<string, unknown> }>(
      async (current) => {
        current.progress = { stage: "scanning" };
        const outcome = await deps.runScan({
          collectionId,
          trigger,
          ...(sources ? { sources } : {}),
          confirmPaidListing: body.confirmPaidListing === true,
          onProgress: (event) => {
            current.progress = {
              stage: event.stage,
              ...(typeof event.newItems === "number" ? { scanned: event.newItems } : {}),
            };
          },
        });
        current.progress = { stage: "report" };
        return { outcome, run: legacyRunView(deps.store, outcome) };
      },
      { kind: "scout" },
    );

    return json({ id: job.id, runId: null, collectionId, handedOff }, 202);
  }

  return { GET, POST };
}

export type { Job };
export { accountSourceRef };
