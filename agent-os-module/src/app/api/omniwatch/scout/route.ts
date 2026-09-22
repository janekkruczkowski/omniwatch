import { NextResponse } from "next/server";
import { startJob, getJob } from "@/lib/omniwatchJobs";
import { apiKey, fetchVideo, watch, save, toolsPresent, logToVault, PRICE_IN, PRICE_OUT } from "@/lib/omniwatch";
import {
  readConfig, writeConfig, readLatest, saveRun, seenUrls, scrape, rank, apifyReady, needsApify,
  type ScoutConfig, type ScoutRun, type Candidate, type Teardown, type SourceKind, type Source,
} from "@/lib/omniwatchScout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  /api/omniwatch/scout            → config, last run, and what still needs setting up
// GET  /api/omniwatch/scout?job=<id>   → poll a scan
// POST /api/omniwatch/scout            → {action:"config"|"scan"}
//
// A scan is minutes of work (scraping, then a teardown per winner), so it answers 202
// and is polled — the same job store the manual tab uses. That is also what lets a
// Hermes cron fire a scan at 6am with nothing holding a connection open.

export interface ScanProgress { stage: string; scanned?: number; done?: number; total?: number }

export async function GET(req: Request) {
  const jobId = new URL(req.url).searchParams.get("job");
  if (jobId) {
    const job = getJob<ScanProgress, ScoutRun>(jobId);
    if (!job) return NextResponse.json({ state: "gone" }, { status: 404 });
    return NextResponse.json({ state: job.state, ...(job.progress || {}), run: job.result, error: job.error });
  }

  const [config, latest, tools, plugins, key] = await Promise.all([
    readConfig(), readLatest(), toolsPresent(), apifyReady(), apiKey(),
  ]);
  return NextResponse.json({
    config,
    latest,
    ready: {
      key: Boolean(key), ytDlp: tools.ytDlp, ffmpeg: tools.ffmpeg, ...plugins,
      // YouTube runs on yt-dlp alone, so a YouTube-only watchlist never needs Apify.
      apifyNeeded: needsApify(config.sources),
    },
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  if (body.action === "config") {
    const c = body.config as ScoutConfig;
    if (!c || !Array.isArray(c.sources)) return NextResponse.json({ error: "bad config" }, { status: 400 });
    const clean: ScoutConfig = {
      sources: c.sources.slice(0, 40).map((s): Source => ({
        id: String(s.id || Math.random().toString(36).slice(2, 9)),
        kind: s.kind === "hashtag" ? "hashtag" : "account",
        platform: (["tiktok", "instagram", "youtube", "x"] as const).includes(s.platform) ? s.platform : "tiktok",
        handle: String(s.handle || "").replace(/^[@#]/, "").trim(),
      })).filter((s) => s.handle),
      topic: String(c.topic || "").slice(0, 200),
      teardowns: Math.min(Math.max(Number(c.teardowns) || 3, 1), 8),
      days: Math.min(Math.max(Number(c.days) || 14, 1), 90),
      maxMinutes: Math.min(Math.max(Number(c.maxMinutes) || 10, 1), 120),
    };
    await writeConfig(clean);
    return NextResponse.json({ config: clean });
  }

  // A teardown started from a row here is just as real as one the scan produced, so it
  // is stored the same way. Without this it would live only in React state and vanish
  // on the next reload.
  if (body.action === "remember") {
    const url = String(body.url || "");
    const text = String(body.text || "");
    if (!/^https?:\/\//i.test(url) || !text) return NextResponse.json({ error: "url and text required" }, { status: 400 });
    const run = (await readLatest()) || {
      at: new Date().toISOString(), sources: 0, scanned: 0, candidates: [], teardowns: [],
    };
    run.teardowns = [
      { url, title: String(body.title || ""), videoId: String(body.videoId || ""), text },
      ...run.teardowns.filter((t) => t.url !== url),
    ];
    await saveRun(run);
    return NextResponse.json({ ok: true });
  }

  if (body.action !== "scan") return NextResponse.json({ error: "unknown action" }, { status: 400 });

  const config = await readConfig();

  // The subject is the axis: you are about to film something and want to know how the
  // videos that worked on it were made. A saved watchlist just narrows the search.
  const subject = String(body.subject || "").trim().slice(0, 120);
  const sources: Source[] = subject
    ? [
        { id: "subject", kind: "hashtag", platform: "youtube", handle: subject },
        ...config.sources.filter((s) => s.platform !== "youtube" || s.kind !== "hashtag"),
      ]
    : config.sources;

  if (!sources.length) {
    return NextResponse.json({
      error: "Say what you are making a video about, or add an account to watch.",
    }, { status: 400 });
  }
  const key = await apiKey();
  if (!key) return NextResponse.json({ error: "No Qwen key — see the OmniWatch tab." }, { status: 503 });

  const job = startJob<ScanProgress, ScoutRun>(async (j) => {
    j.progress = { stage: "scraping" };

    const rows = await scrape(sources, config.days);
    j.progress = { stage: "ranking", scanned: rows.length };

    const kinds = new Map<string, SourceKind>();
    for (const s of sources) { kinds.set(s.handle, s.kind); kinds.set(s.handle.toLowerCase(), s.kind); }
    const ranked = rank(rows, kinds);

    // never pay twice for the same video across nightly runs
    const seen = await seenUrls();
    const cap = config.maxMinutes * 60;
    const fresh = ranked.filter((c) =>
      !seen.has(c.url) && (!c.duration || c.duration <= cap));
    const winners = fresh.slice(0, config.teardowns);

    const teardowns: Teardown[] = [];
    for (const [i, c] of winners.entries()) {
      j.progress = { stage: "watching", scanned: rows.length, done: i, total: winners.length };
      try {
        const { info, src } = await fetchVideo(c.url);
        const { answer, stats } = await watch(key, info, src, config.topic || subject, "en", "teardown");
        await save(info, c.url, config.topic || subject, answer, "en", "teardown").catch(() => {});
        teardowns.push({
          url: c.url, title: info.title, videoId: info.id, text: answer,
          cost: Number((stats.in * PRICE_IN + stats.out * PRICE_OUT).toFixed(4)),
        });
      } catch (e) {
        // one unavailable video must not lose the whole run
        teardowns.push({ url: c.url, text: `Could not watch this one: ${e instanceof Error ? e.message : String(e)}` });
      }
    }

    const run: ScoutRun = {
      subject: subject || undefined,
      at: new Date().toISOString(),
      sources: sources.length,
      scanned: rows.length,
      candidates: ranked.slice(0, 40),
      teardowns,
      note: fresh.length < ranked.length ? `${ranked.length - fresh.length} already torn down in an earlier run` : undefined,
    };
    await saveRun(run);

    // Log it the way every other Agent OS tab logs its work.
    if (teardowns.length) {
      const entries = teardowns.map((t) => {
        const c = ranked.find((x) => x.url === t.url);
        return `## ${t.title || t.url}\n\n${c ? `${c.why} · @${c.author}\n\n` : ""}${t.url}\n\n${t.text}\n`;
      }).join("\n");
      await logToVault(
        "OmniWatch Scout",
        `### Scan ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} — `
        + `${run.scanned} videos, ${teardowns.length} torn down\n\n${entries}`,
        "Auto-logged by OmniWatch Scout (Agent OS) — competitor videos that beat their own baseline, and the formula behind each one.",
      );
    }
    return run;
  });

  return NextResponse.json({ id: job.id }, { status: 202 });
}

export type { Candidate };
