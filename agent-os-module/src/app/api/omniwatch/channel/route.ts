import { NextResponse } from "next/server";
import { startJob, getJob } from "@/lib/omniwatchJobs";
import { apiKey, fetchVideo, watch, save, logToVault, fmt, PRICE_IN, PRICE_OUT } from "@/lib/omniwatch";
import {
  listChannel, listScans, parseAccount, readScan, saveScan,
  type ChannelListing, type Limit, type Order,
} from "@/lib/omniwatchChannel";
import type { Platform } from "@/lib/omniwatchScout";
import I18N from "@/lib/omniwatchI18n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Two verbs, deliberately split, because one of them costs money and the other does not.
//
// GET lists the account. It is free — yt-dlp already knows a channel's uploads — so it
// answers inline instead of going through the job store. What it returns is what the
// tab shows you before you commit: the videos, their lengths, and the price.
//
// POST is the part that spends. It takes the videos you actually picked, watches them
// one at a time, and publishes each teardown as it lands so a scan of fifteen videos
// is readable from the first one rather than after the last.

export interface ChannelProgress {
  stage: "watching" | "logging";
  account: string;
  total: number;
  done: number;
  /** the one being watched right now */
  current?: string;
  results: ChannelResult[];
  cost: number;
}
export interface ChannelResult {
  url: string;
  title: string;
  views?: number;
  duration?: number;
  text: string;
  cost?: number;
  error?: string;
}
export interface ChannelDone extends ChannelProgress {
  vault?: string | null;
  seconds: number;
}

// ── GET: what is on this account, and what would it cost ───────────────────────

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;

  // Polling a running scan shares this verb: it is a read, and a read is what GET is
  // for. An unknown id means the dashboard restarted — the job store is in memory,
  // like the rest of Agent OS — so the tab says so plainly instead of spinning.
  const jobId = q.get("job");
  if (jobId) {
    const job = getJob<ChannelProgress, ChannelDone>(jobId);
    if (!job) return NextResponse.json({ state: "gone" }, { status: 404 });
    return NextResponse.json({
      state: job.state,
      ...(job.progress || {}),
      ...(job.result || {}),
      error: job.error,
    });
  }

  // What you have already run. Free, and read from disk rather than the job store, so
  // it survives restarts — which is the whole reason it exists.
  if (q.get("history")) return NextResponse.json({ scans: await listScans() });
  const one = q.get("scan");
  if (one) {
    const scan = await readScan(one);
    return scan
      ? NextResponse.json(scan)
      : NextResponse.json({ error: "That scan is not on disk any more." }, { status: 404 });
  }

  const raw = String(q.get("url") || "").trim();
  const hint = (["youtube", "tiktok", "instagram"] as const)
    .find((p) => p === q.get("platform")) as Platform | undefined;
  const order: Order = q.get("order") === "newest" ? "newest" : "popular";
  const limit: Limit = q.get("limit") === "all"
    ? "all"
    : Math.min(200, Math.max(1, Number(q.get("limit")) || 10));

  const acc = parseAccount(raw, hint);
  if (!acc) {
    return NextResponse.json({
      error: "That does not look like an account. Paste the channel page — "
        + "youtube.com/@name, tiktok.com/@name or instagram.com/name.",
    }, { status: 400 });
  }

  try {
    const listing = await listChannel(acc, order, limit);
    return NextResponse.json(listing);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

// ── POST: watch the ones that were picked ──────────────────────────────────────

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const urls: string[] = Array.isArray(body.urls)
    ? body.urls.map((u: unknown) => String(u)).filter((u: string) => /^https?:\/\//i.test(u))
    : [];
  const account = String(body.account || "this account");
  const topic = String(body.topic || "");
  const l = I18N[String(body.lang || "")] ? String(body.lang) : "en";

  if (!urls.length) return NextResponse.json({ error: "No videos were picked." }, { status: 400 });
  // A ceiling high enough not to be in anyone's way, and low enough that a bad request
  // cannot queue an unbounded amount of paid work. The screen already makes a large
  // scan a deliberate act; this is only the backstop behind it.
  if (urls.length > 500) {
    return NextResponse.json({ error: "500 videos in one scan is the ceiling. Split it." }, { status: 400 });
  }

  const key = await apiKey();
  if (!key) {
    return NextResponse.json({
      error: "No Qwen key yet. Add DASHSCOPE_API_KEY to ~/.hermes/.env or ~/.agentic-os/config.json.",
    }, { status: 503 });
  }

  const job = startJob<ChannelProgress, ChannelDone>(async (j) => {
    const t0 = Date.now();
    const p: ChannelProgress = {
      stage: "watching", account, total: urls.length, done: 0, results: [], cost: 0,
    };
    const push = () => { j.progress = { ...p, results: [...p.results] }; };
    push();

    for (const url of urls) {
      p.current = url;
      push();
      try {
        const { info, src } = await fetchVideo(url);
        p.current = info.title;
        push();

        const { answer, stats } = await watch(key, info, src, topic, l, "teardown");
        await save(info, url, topic, answer, l, "teardown").catch(() => {});

        const cost = Number((stats.in * PRICE_IN + stats.out * PRICE_OUT).toFixed(4));
        p.cost = Number((p.cost + cost).toFixed(4));
        p.results.push({
          url, title: info.title, duration: info.duration, text: answer, cost,
        });
      } catch (e) {
        // A channel scan is a batch, and a batch that throws away fourteen good
        // teardowns because the fifteenth video was age-gated is not worth running.
        p.results.push({
          url, title: url, text: "",
          error: e instanceof Error ? e.message : String(e),
        });
      }
      p.done++;
      p.current = undefined;
      push();
    }

    p.stage = "logging";
    push();

    // Into the vault the way every other Agent OS tab logs its work, so the agents can
    // read a channel study later and it outlives the dashboard.
    const good = p.results.filter((r) => !r.error && r.text);
    let vault: string | null = null;
    if (good.length) {
      const entries = good.map((r) =>
        `## ${r.title}\n\n${r.duration ? `${fmt(r.duration)} · ` : ""}${r.url}\n\n${r.text}\n`,
      ).join("\n");
      const failed = p.results.length - good.length;
      vault = await logToVault(
        "OmniWatch Channels",
        `### ${account} — ${good.length} video${good.length === 1 ? "" : "s"} watched`
        + `${failed ? `, ${failed} could not be` : ""} · $${p.cost.toFixed(3)}`
        + `${topic ? `\n\n_Read against: ${topic}_` : ""}\n\n${entries}`,
        "Auto-logged by OmniWatch (Agent OS) — on-demand channel scans: how each video on an account is actually made.",
      );
    }

    // Kept on disk as well as in the vault, so the tab can show you what you ran.
    // Best effort: a scan you paid for must not be reported as failed because a file
    // could not be written.
    await saveScan({
      id: j.id,
      at: new Date().toISOString(),
      account,
      videos: good.length,
      failed: p.results.length - good.length,
      cost: p.cost,
      topic: topic || undefined,
      results: p.results,
    }).catch(() => {});

    return { ...p, results: [...p.results], vault, seconds: Math.round((Date.now() - t0) / 1000) };
  });

  return NextResponse.json({ id: job.id }, { status: 202 });
}

export type { ChannelListing };
