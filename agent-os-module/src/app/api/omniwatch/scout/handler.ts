/**
 * GET/POST /api/omniwatch/scout — the scheduled/manual sweep (T6 / D8 / T13).
 *
 * SPEC: Scout is the SAME OmniWatch channel scan, run periodically. Each watched
 * channel carries its goal (summary by default, a topic-focused summary, or a
 * teardown only when the user picks it), its language, its batch size and cost
 * ceiling. Those settings are saved on the channel's collection, so the Hermes cron
 * (`omniwatch scan --collection <id>`) and "Run now" read exactly the same goal and
 * only pay for videos not yet analysed for that goal (F6). No ranking, no popularity.
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

import type { ScanReport, ScanSettings, SourceRef } from "../../../../../../packages/omniwatch/src/contracts/types.ts";
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

/**
 * One watched channel (SPEC F2–F10): the same OmniWatch channel scan, saved with its
 * goal so the manual button and the Hermes cron run exactly the same thing.
 *
 *   goal      summary (default) | topic (summary narrowed to `topic`, F14) | teardown
 *             — teardown only when the user picks it; Scout never forces it (F7).
 *   firstRun  "new": the current archive is marked as already seen for this goal, so
 *             only videos published later are analysed; "all": the whole archive is
 *             worked through in batches of `batch` (F3), newest first.
 */
export type ScoutGoal = "summary" | "topic" | "teardown";
export type ScoutSchedule = "off" | "daily" | "weekly";

export interface ScoutChannel {
  id: string;
  platform: string;
  handle: string;
  goal: ScoutGoal;
  topic?: string;
  language?: string;
  firstRun?: "new" | "all";
  schedule?: ScoutSchedule;
  /** Videos per run (one batch). */
  batch?: number | null;
  /** Cost ceiling per run, USD (F10); null = no ceiling beyond the batch size. */
  budgetUsd?: number | null;
  /** Filled by the panel: the collection the cron script scans. */
  collectionId?: string;
  /** Goal key the "new videos only" baseline was taken for. */
  baseline?: string | null;
}

export interface ScoutConfig {
  collectionId?: string;
  channels?: ScoutChannel[];
  /** Legacy (competitor-ranking Scout); ignored by the scan. */
  sources?: ScoutSourceConfig[];
  topic?: string;
  teardowns?: number;
  days?: number;
  maxMinutes?: number;
}

export const DEFAULT_BATCH = 10;

export function channelCollectionId(channel: Pick<ScoutChannel, "platform" | "handle">): string {
  const handle = channel.handle.replace(/^[@#]/, "").replace(/[^\w.-]/g, "_").slice(0, 64) || "channel";
  return `scout_${channel.platform || "youtube"}_${handle}`;
}

/** Normalises what the panel sent: summary is the default goal, teardown is opt-in. */
export function normaliseChannel(raw: Partial<ScoutChannel>): ScoutChannel | null {
  const handle = String(raw.handle ?? "").replace(/^[@#]/, "").trim();
  if (!handle) return null;
  const platform = String(raw.platform ?? "youtube") || "youtube";
  const goal: ScoutGoal = raw.goal === "teardown" ? "teardown" : raw.goal === "topic" ? "topic" : "summary";
  const topic = String(raw.topic ?? "").trim();
  const batch = Number.isInteger(raw.batch) && (raw.batch as number) > 0 ? (raw.batch as number) : DEFAULT_BATCH;
  const budget = typeof raw.budgetUsd === "number" && raw.budgetUsd > 0 ? raw.budgetUsd : null;
  const channel: ScoutChannel = {
    id: String(raw.id ?? "") || channelCollectionId({ platform, handle }),
    platform,
    handle,
    goal: goal === "topic" && !topic ? "summary" : goal,
    topic: goal === "topic" ? topic : "",
    language: String(raw.language ?? "") || "en",
    firstRun: raw.firstRun === "all" ? "all" : "new",
    schedule: raw.schedule === "daily" || raw.schedule === "weekly" ? raw.schedule : "off",
    batch,
    budgetUsd: budget,
    baseline: raw.baseline ?? null,
  };
  channel.collectionId = channelCollectionId(channel);
  return channel;
}

/** The scan settings a channel's goal stands for — identical for manual and cron runs. */
export function channelSettings(channel: ScoutChannel): ScanSettings {
  return {
    collectionId: channel.collectionId ?? channelCollectionId(channel),
    mode: channel.goal === "teardown" ? "teardown" : "summary",
    focus: channel.goal === "topic" && channel.topic ? channel.topic : null,
    question: null,
    language: channel.language || "en",
    maxNewItems: channel.batch ?? DEFAULT_BATCH,
    budgetUsd: channel.budgetUsd ?? null,
  };
}

/** Identity of a goal for the "already seen" ledger (mode, focus, question, language). */
export function goalKey(settings: ScanSettings): string {
  return [settings.mode, settings.focus ?? "", settings.question ?? "", settings.language].join("|");
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
  readLatest?(): Promise<unknown>;
  toolsPresent(): Promise<{ ytDlp: boolean; ffmpeg: boolean }>;
  apiKeyPresent(): Promise<boolean>;
  /** Legacy, unused: Scout no longer scrapes through Apify. */
  apifyReady?(): Promise<{ hermes?: boolean; apify?: boolean }>;
  needsApify?(sources: ScoutSourceConfig[]): boolean;
  /** Saves the collection (sources + the goal's settings) the scan and the cron read. */
  saveCollection(input: { collectionId: string; sources: SourceRef[]; settings?: ScanSettings }): void;
  /** Lists every video id the channel currently has (for the "new videos only" baseline). */
  listChannel?(source: SourceRef): Promise<string[]>;
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
export function runView(store: StorePort, outcome: ScoutScanOutcome): Record<string, unknown> {
  const items = outcome.runId ? store.listRunItems(outcome.runId, { limit: 500 }).items : [];
  const analyses = items
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
    at: new Date().toISOString(),
    sources: outcome.sources?.length ?? 0,
    scanned: outcome.newItems,
    analyses,
    note: outcome.notes.length > 0 ? outcome.notes.join(" · ") : undefined,
  };
}

export interface ScoutHandler {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
}

export interface ScoutResultItem {
  runId: string;
  ordinal: number;
  title: string | null;
  url: string;
  state: string;
  at: string;
}

/**
 * New analyses per channel, newest first, read from the durable runs — so what the
 * Hermes cron produced shows up next to what "Run now" produced. A run with nothing
 * new has no report (D8) and therefore adds nothing here.
 */
export function channelResults(store: StorePort, collectionIds: string[], perChannel = 30): Record<string, ScoutResultItem[]> {
  const wanted = new Set(collectionIds);
  const out: Record<string, ScoutResultItem[]> = {};
  for (const id of collectionIds) out[id] = [];
  const seenRuns = new Set<string>();
  for (const report of store.listReports({ limit: 200 })) {
    if (seenRuns.has(report.runId)) continue;
    seenRuns.add(report.runId);
    const run = store.getRun(report.runId);
    if (!run || !wanted.has(run.collectionId)) continue;
    const bucket = out[run.collectionId];
    if (bucket.length >= perChannel) continue;
    for (const item of store.listRunItems(run.id, { limit: 200 }).items) {
      if (item.state !== "done") continue;
      bucket.push({
        runId: run.id,
        ordinal: item.ordinal,
        title: item.title ?? null,
        url: item.sourceRef.canonicalUrl,
        state: item.state,
        at: item.updatedAt ?? report.updatedAt,
      });
      if (bucket.length >= perChannel) break;
    }
  }
  return out;
}

export function createScoutHandler(deps: ScoutHandlerDeps): ScoutHandler {
  function channelsOf(config: ScoutConfig): ScoutChannel[] {
    return (config.channels ?? [])
      .map((channel) => normaliseChannel(channel))
      .filter((channel): channel is ScoutChannel => channel !== null);
  }

  /** Saves the channel's collection with its goal; takes the baseline when asked for. */
  async function prepareChannel(channel: ScoutChannel): Promise<{ channel: ScoutChannel; note?: string }> {
    const settings = channelSettings(channel);
    const source = deps.accountRef(channel.platform, channel.handle);
    deps.saveCollection({ collectionId: settings.collectionId, sources: [source], settings });
    const key = goalKey(settings);
    if (channel.firstRun !== "new" || channel.baseline === key || !deps.listChannel) {
      return { channel };
    }
    try {
      const ids = await deps.listChannel(source);
      for (const id of ids) {
        deps.store.markSeenSource(settings.collectionId, id, settings.mode, settings.focus ?? "", settings.question ?? "", settings.language);
      }
      return { channel: { ...channel, baseline: key } };
    } catch (error) {
      return { channel, note: `${channel.handle}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

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
      const job = getJob<{ stage?: string }, { outcomes: ScoutScanOutcome[]; outcome: ScoutScanOutcome | null; run: Record<string, unknown> | null }>(jobId);
      if (!job) return json({ state: "gone" }, 404);
      const result = job.result ?? null;
      return json({
        protocol: SCOUT_PROTOCOL,
        state: job.state,
        ...(job.progress ?? {}),
        run: result?.run ?? null,
        outcome: result?.outcome ?? null,
        outcomes: result?.outcomes ?? [],
        error: job.error,
      });
    }

    const [config, tools, key] = await Promise.all([
      deps.readConfig(),
      deps.toolsPresent(),
      deps.apiKeyPresent(),
    ]);
    const channels = channelsOf(config);
    return json({
      config: { channels },
      results: channelResults(deps.store, channels.map((channel) => channel.collectionId as string)),
      ready: { key, ytDlp: tools.ytDlp, ffmpeg: tools.ffmpeg },
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
      const incoming = body.config as ScoutConfig | undefined;
      if (!incoming || !Array.isArray(incoming.channels)) return json({ error: "bad config" }, 400);
      const notes: string[] = [];
      const channels: ScoutChannel[] = [];
      for (const raw of incoming.channels) {
        const channel = normaliseChannel(raw);
        if (!channel) continue;
        const prepared = await prepareChannel(channel);
        if (prepared.note) notes.push(prepared.note);
        channels.push(prepared.channel);
      }
      const saved: ScoutConfig = { ...(await deps.readConfig()), channels, sources: [] };
      if (deps.writeConfig) await deps.writeConfig(saved);
      return json({ config: { channels }, notes });
    }

    if (action !== "scan") return json({ error: "unknown action" }, 400);

    const config = await deps.readConfig();
    const explicitCollection = typeof body.collectionId === "string" ? body.collectionId.trim() : "";

    // Hermes (or a caller) names a collection: scan exactly that, with its saved goal.
    // The panel names a channel, or presses "run all".
    let targets: { collectionId: string }[];
    if (explicitCollection) {
      targets = [{ collectionId: explicitCollection }];
    } else {
      const wanted = typeof body.channelId === "string" ? body.channelId : "";
      const channels = channelsOf(config).filter((channel) => !wanted || channel.id === wanted);
      if (channels.length === 0) {
        return json({ error: "Add a channel to watch first." }, 400);
      }
      targets = [];
      const updated = new Map<string, ScoutChannel>();
      for (const channel of channels) {
        // The saved goal decides the scan; nothing here defaults to teardown.
        const prepared = await prepareChannel(channel);
        if (prepared.channel.baseline !== channel.baseline) updated.set(channel.id, prepared.channel);
        targets.push({ collectionId: prepared.channel.collectionId as string });
      }
      if (updated.size > 0 && deps.writeConfig) {
        const all = channelsOf(config).map((channel) => updated.get(channel.id) ?? channel);
        await deps.writeConfig({ ...config, channels: all });
      }
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
    const job = startJob<{ stage?: string }, { outcomes: ScoutScanOutcome[]; outcome: ScoutScanOutcome | null; run: Record<string, unknown> | null }>(
      async (current) => {
        const outcomes: ScoutScanOutcome[] = [];
        for (const target of targets) {
          current.progress = { stage: "scanning", collectionId: target.collectionId } as { stage?: string };
          const outcome = await deps.runScan({
            collectionId: target.collectionId,
            trigger,
            confirmPaidListing: body.confirmPaidListing === true,
            onProgress: (event) => {
              current.progress = {
                stage: event.stage,
                collectionId: target.collectionId,
                ...(typeof event.newItems === "number" ? { scanned: event.newItems } : {}),
              } as { stage?: string };
            },
          });
          outcomes.push(outcome);
        }
        current.progress = { stage: "report" };
        const last = outcomes[outcomes.length - 1] ?? null;
        return { outcomes, outcome: last, run: last ? runView(deps.store, last) : null };
      },
      { kind: "scout" },
    );

    return json({ id: job.id, runId: null, collectionIds: targets.map((target) => target.collectionId), handedOff }, 202);
  }

  return { GET, POST };
}

export type { Job };
export { accountSourceRef };
