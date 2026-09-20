// Scout — the automatic half of OmniWatch.
//
// You name the accounts and hashtags worth watching in your niche. Hermes scrapes
// them through its Apify plugin, Scout ranks what actually outperformed, and the
// winners get a full OmniWatch teardown. So instead of "this video has 800k views"
// you get "this one beat its own account by 6×, and here is the formula".
//
// Why Hermes does the scraping: it already runs 24/7 with cron, and the Apify plugin
// (`pip install apify-hermes-agent-plugin`, `hermes plugins enable apify`) gives it
// apify_discover / apify_start / apify_collect. We shell out to it the same way the
// Radar tab shells out for its X search.
//
// Why only metadata comes from Apify: the TikTok actor bills about $1.70 per 1000
// results for metadata, while downloading the video files is a charged add-on plus
// storage. So Apify finds the candidates, and yt-dlp fetches only the three or four
// winners we actually watch.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { run, OMNI_ROOT } from "@/lib/omniwatch";

export const SCOUT_ROOT = path.join(OMNI_ROOT, "scout");
const CONFIG = path.join(SCOUT_ROOT, "config.json");
const LATEST = path.join(SCOUT_ROOT, "latest.json");
const HISTORY = path.join(SCOUT_ROOT, "history");

export type Platform = "tiktok" | "instagram" | "youtube" | "x";
export type SourceKind = "account" | "hashtag";

export interface Source {
  id: string;
  kind: SourceKind;
  platform: Platform;
  /** handle without @, or hashtag without # */
  handle: string;
}

export interface ScoutConfig {
  sources: Source[];
  /** what your own videos are about — used for the adapted script in each teardown */
  topic: string;
  /** how many winners get a full teardown per run; each one costs a few cents */
  teardowns: number;
  /** only consider videos posted in the last N days */
  days: number;
  /** skip anything longer than this — Scout is about short-form formulas, and a
   *  one-hour course would cost dollars to tear down instead of cents */
  maxMinutes: number;
}

export interface Candidate {
  url: string;
  platform: Platform;
  author: string;
  fans: number;
  plays: number;
  likes: number;
  comments: number;
  shares: number;
  postedAt?: string;
  caption?: string;
  /** seconds; used to skip anything too long (and costly) to tear down */
  duration?: number;
  /** how far it beat its baseline — the number the ranking sorts on */
  score: number;
  /** plain English for why it is here, shown on the card */
  why: string;
  engagement: number;
  source: string;
}

export interface Teardown { url: string; title?: string; videoId?: string; text: string; cost?: number }

export interface ScoutRun {
  /** what the run was about, when it was driven by a subject rather than the watchlist */
  subject?: string;
  at: string;
  sources: number;
  scanned: number;
  candidates: Candidate[];
  teardowns: Teardown[];
  note?: string;
}

export const DEFAULT_CONFIG: ScoutConfig = { sources: [], topic: "", teardowns: 3, days: 14, maxMinutes: 10 };

export async function readConfig(): Promise<ScoutConfig> {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(CONFIG, "utf8")) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}

export async function writeConfig(c: ScoutConfig): Promise<void> {
  await mkdir(SCOUT_ROOT, { recursive: true });
  await writeFile(CONFIG, JSON.stringify(c, null, 2));
}

export async function readLatest(): Promise<ScoutRun | null> {
  try { return JSON.parse(await readFile(LATEST, "utf8")); } catch { return null; }
}

export async function saveRun(r: ScoutRun): Promise<void> {
  await mkdir(HISTORY, { recursive: true });
  await writeFile(LATEST, JSON.stringify(r, null, 2));
  await writeFile(path.join(HISTORY, `${r.at.slice(0, 10)}.json`), JSON.stringify(r, null, 2));
}

/** Videos already torn down, so a nightly run never pays for the same one twice. */
export async function seenUrls(): Promise<Set<string>> {
  const seen = new Set<string>();
  const latest = await readLatest();
  for (const t of latest?.teardowns || []) seen.add(t.url);
  try {
    const { readdir } = await import("node:fs/promises");
    for (const f of (await readdir(HISTORY)).slice(-30)) {
      const r: ScoutRun = JSON.parse(await readFile(path.join(HISTORY, f), "utf8"));
      for (const t of r.teardowns || []) seen.add(t.url);
    }
  } catch { /* no history yet */ }
  return seen;
}

// ── asking Hermes to scrape ────────────────────────────────────────────────────

// YouTube is deliberately absent: yt-dlp already lists a channel's recent videos with
// view counts and the channel's subscriber count, locally and for free. Paying Apify
// per result for something the tool on disk gives away would be silly, and it means
// someone who only tracks YouTube needs no Apify account at all.
const ACTORS: Partial<Record<Platform, string>> = {
  tiktok: "clockworks~tiktok-scraper",
  instagram: "apify~instagram-scraper",
  x: "apidojo~tweet-scraper",
};

/** Sources that need a scraping service. YouTube-only setups skip Apify entirely. */
export const needsApify = (sources: Source[]) => sources.some((s) => s.platform !== "youtube");

function scanPrompt(sources: Source[], days: number): string {
  const byPlatform = (p: Platform, k: SourceKind) =>
    sources.filter((s) => s.platform === p && s.kind === k).map((s) => s.handle);
  const lines: string[] = [];
  for (const p of Object.keys(ACTORS) as Platform[]) {
    const accounts = byPlatform(p, "account"), tags = byPlatform(p, "hashtag");
    if (!accounts.length && !tags.length) continue;
    lines.push(`- ${p} (actor \`${ACTORS[p]}\`):`
      + (accounts.length ? ` profiles ${accounts.map((a) => `"${a}"`).join(", ")};` : "")
      + (tags.length ? ` hashtags ${tags.map((t) => `"${t}"`).join(", ")};` : ""));
  }

  return `Collect recent short-form videos for a competitor study. Use ONLY the apify tools.

Sources:
${lines.join("\n")}

Steps, in order:
1. Call apify_discover on each actor id above to read its input schema. Do not guess field names.
2. Call apify_start once with all the runs. Ask each actor for the most recent 25 videos per
   profile and 40 per hashtag, posted within the last ${days} days. Do NOT enable any video,
   subtitle or thumbnail download option — metadata only, downloads cost extra.
3. Call apify_collect until every run has finished, then read the datasets.

Then return ONLY a JSON array, no prose and no code fence, with one object per video:
{"url": "...", "platform": "tiktok"|"instagram", "author": "handle without @",
 "fans": <author follower count>, "plays": <views>, "likes": <n>, "comments": <n>,
 "shares": <n>, "postedAt": "ISO date", "caption": "first 120 chars",
 "source": "the profile or hashtag it came from"}

Rules: use the real numbers from the dataset and never invent any. Omit a video if it has no
view count. If a field is genuinely missing use 0. Return [] if the actors returned nothing.`;
}

// ── YouTube, without Apify ─────────────────────────────────────────────────────
// `yt-dlp -J --flat-playlist` on a channel returns its recent uploads with a view
// count each, plus the channel's subscriber count — everything the ranking needs,
// for free, from a tool the module already requires.

interface YtEntry {
  id?: string; title?: string; url?: string; view_count?: number;
  duration?: number; timestamp?: number; channel?: string;
}

async function scrapeYouTube(sources: Source[], days: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const cutoff = Date.now() - days * 86_400_000;

  for (const src of sources) {
    // A handle lists that channel's uploads; a hashtag or keyword goes through search,
    // where the author's own subscriber count is what we compare a video against.
    // A channel keeps its shorts on a separate tab from its long uploads, and for a
    // competitor study the shorts are usually the point — so read both.
    const targets = src.kind === "account"
      ? [`https://www.youtube.com/@${src.handle}/shorts`, `https://www.youtube.com/@${src.handle}/videos`]
      : [`ytsearch40:${src.handle}`];
    for (const target of targets) {
    let data: { channel?: string; channel_follower_count?: number; entries?: YtEntry[] };
    try {
      data = JSON.parse(await run(
        "yt-dlp",
        ["-J", "--flat-playlist", "--playlist-end", src.kind === "account" ? "25" : "40", target],
        300_000,
      ));
    } catch {
      continue; // one unreachable tab must not sink the whole scan
    }
    const fans = data.channel_follower_count || 0;
    for (const e of data.entries || []) {
      if (!e.id || typeof e.view_count !== "number") continue;
      if (e.timestamp && e.timestamp * 1000 < cutoff) continue;
      out.push({
        url: `https://www.youtube.com/watch?v=${e.id}`,
        platform: "youtube",
        author: e.channel || data.channel || src.handle,
        fans,
        plays: e.view_count,
        // The flat listing carries no engagement counts; that is fine, because the
        // ranking only needs views against a baseline.
        likes: 0, comments: 0, shares: 0,
        postedAt: e.timestamp ? new Date(e.timestamp * 1000).toISOString() : undefined,
        caption: (e.title || "").slice(0, 160),
        duration: e.duration,
        source: src.handle,
      });
    }
    }
  }
  return out;
}

/** Collects candidates from every configured source: YouTube locally through yt-dlp,
 *  everything else through Hermes' Apify plugin. */
export async function scrape(sources: Source[], days: number): Promise<Record<string, unknown>[]> {
  const yt = sources.filter((s) => s.platform === "youtube");
  const viaApify = sources.filter((s) => s.platform !== "youtube");

  const local = yt.length ? await scrapeYouTube(yt, days) : [];
  if (!viaApify.length) return local;

  const raw = await run(
    "hermes",
    ["-t", "apify", "-z", scanPrompt(viaApify, days)],
    900_000,
  ).catch((e: Error) => { throw hermesHint(e); });

  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("["), b = s.lastIndexOf("]");
  if (a === -1 || b === -1 || b < a) {
    // If YouTube already produced candidates, a failed Apify leg should not throw all
    // of them away — a partial scan still beats no scan.
    if (local.length) return local;
    throw new Error("Hermes did not return a usable list of videos. Check that the Apify plugin is connected.");
  }
  try {
    const arr = JSON.parse(s.slice(a, b + 1));
    return [...local, ...(Array.isArray(arr) ? arr : [])];
  } catch {
    throw new Error("Hermes returned a malformed list. Try scanning again.");
  }
}

function hermesHint(e: Error): Error {
  const m = e.message.toLowerCase();
  if (m.includes("could not start") || m.includes("enoent")) {
    return new Error("Hermes is not on PATH. Install it, or run the scan from the machine Hermes lives on.");
  }
  if (m.includes("apify")) {
    return new Error("Hermes has no Apify plugin yet. Run: pip install apify-hermes-agent-plugin && hermes plugins enable apify && hermes apify-setup");
  }
  return e;
}

/** Is the Apify plugin actually enabled? Drives the Scout onboarding screen. */
export async function apifyReady(): Promise<{ hermes: boolean; apify: boolean }> {
  let out = "";
  try { out = await run("hermes", ["plugins", "list"], 30_000); }
  catch { return { hermes: false, apify: false }; }
  const line = out.split("\n").find((l) => /\bapify\b/i.test(l)) || "";
  return { hermes: true, apify: /enabled/i.test(line) && !/not enabled/i.test(line) };
}

// ── ranking ────────────────────────────────────────────────────────────────────

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "0").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
};

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Two different questions, so two different baselines.
 *
 *  For an account you track, the honest baseline is that account's own median: a video
 *  that beat it did something different from what that creator normally does.
 *
 *  For a hashtag there is no such baseline — the platform already handed back its most
 *  popular results, so ranking them by views just re-reads the platform's own sorting.
 *  What matters there is whether a video went far beyond the audience it started with,
 *  so we compare views to the author's follower count. Two million views from ten
 *  thousand followers is a formula; the same number from five million followers is
 *  just reach. */
export function rank(rows: Record<string, unknown>[], kinds: Map<string, SourceKind>): Candidate[] {
  const items = rows.map((r) => ({
    url: String(r.url || ""),
    platform: (r.platform === "instagram" ? "instagram" : "tiktok") as Platform,
    author: String(r.author || "").replace(/^@/, ""),
    fans: num(r.fans),
    plays: num(r.plays),
    likes: num(r.likes),
    comments: num(r.comments),
    shares: num(r.shares),
    postedAt: r.postedAt ? String(r.postedAt) : undefined,
    caption: r.caption ? String(r.caption).slice(0, 160) : undefined,
    duration: typeof r.duration === "number" ? r.duration : undefined,
    source: String(r.source || ""),
  })).filter((r) => r.url.startsWith("http") && r.plays > 0);

  const byAuthor = new Map<string, number[]>();
  for (const r of items) {
    if (!byAuthor.has(r.author)) byAuthor.set(r.author, []);
    byAuthor.get(r.author)!.push(r.plays);
  }

  const out: Candidate[] = items.map((r) => {
    const engagement = (r.likes + r.comments + r.shares) / Math.max(r.plays, 1);
    const fromAccount = kinds.get(r.source) === "account" || kinds.get(r.author) === "account";
    const plays = byAuthor.get(r.author) || [];

    if (fromAccount && plays.length >= 4) {
      const base = median(plays) || 1;
      return {
        ...r, engagement,
        score: r.plays / base,
        why: `${(r.plays / base).toFixed(1)}× this account's median (${short(base)} views)`,
      };
    }
    // discovery: compare to the audience the author already had. The floor keeps a
    // brand-new account with 12 followers from topping the list on arithmetic alone.
    const base = Math.max(r.fans, 1000);
    return {
      ...r, engagement,
      score: r.plays / base,
      why: r.fans
        ? `${(r.plays / base).toFixed(1)}× its own follower count (${short(r.fans)} followers)`
        : `${short(r.plays)} views, ${(engagement * 100).toFixed(1)}% engagement`,
    };
  });

  return out.sort((a, b) => b.score - a.score);
}

const short = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);
