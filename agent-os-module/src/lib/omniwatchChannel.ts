// Channel scan — one account, on demand.
//
// The difference from Scout is the trigger, not the size. Scout is a watchlist you
// set up once and Hermes runs on a schedule; this is "here is an account, show me how
// it works" typed into the tab and answered now. So it lives in the OmniWatch tab
// next to the single-video box, shares its engine, and keeps no configuration.
//
// Two things it does that Scout does not:
//
//   It lists before it spends. You see the videos, their lengths and what each one
//   will cost before anything is downloaded, because a channel is the first time this
//   tool asks for more than a couple of cents and a number you did not expect is how
//   a tool loses someone's trust.
//
//   It bills nothing for the listing. yt-dlp already knows a channel's uploads, their
//   view counts and their durations, so YouTube and TikTok cost zero to enumerate.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { run, fpsFor, OMNI_ROOT, PRICE_IN, PRICE_OUT } from "@/lib/omniwatch";
import { scrape, type Platform } from "@/lib/omniwatchScout";

export type Order = "popular" | "newest";

export interface ChannelVideo {
  url: string;
  title: string;
  views: number;
  /** seconds; absent when the platform did not say */
  duration?: number;
  postedAt?: string;
  /** what this one will cost to tear down, in dollars — absent when the platform did
   *  not give a duration, because a price guessed from nothing is worse than none */
  cost?: number;
  /** the cost above is a ceiling, not a figure: the length is unknown but bounded */
  atMost?: boolean;
}

export interface ChannelListing {
  platform: Platform;
  handle: string;
  account: string;
  fans: number;
  /** how many the account listed before any cut — so "top 5 of 47" is honest */
  scanned: number;
  videos: ChannelVideo[];
  note?: string;
}

export interface Account { platform: Platform; handle: string }

// ── keeping what you did ───────────────────────────────────────────────────────
//
// The vault copy is for the agents: it is prose in a dated file, good for an agent to
// read later and wrong for a person who wants to see what they ran last week. So every
// scan is also kept here, whole, and the tab lists them. Without this the tool has no
// memory of itself — you pay for a channel study and then have to go hunting through
// Obsidian to find out what you already know.

export const SCANS_ROOT = path.join(OMNI_ROOT, "channels");

export interface ScanSummary {
  id: string;
  at: string;
  account: string;
  platform?: string;
  videos: number;
  failed: number;
  cost: number;
  topic?: string;
}
export interface SavedScan extends ScanSummary {
  results: { url: string; title: string; duration?: number; text: string; cost?: number; error?: string }[];
}

export async function saveScan(scan: SavedScan): Promise<void> {
  await mkdir(SCANS_ROOT, { recursive: true });
  await writeFile(path.join(SCANS_ROOT, `${scan.id}.json`), JSON.stringify(scan, null, 2));
}

/** Newest first, headers only — the list must stay cheap however many scans pile up. */
export async function listScans(limit = 40): Promise<ScanSummary[]> {
  let files: string[];
  try { files = (await readdir(SCANS_ROOT)).filter((f) => f.endsWith(".json")); }
  catch { return []; }
  const out: ScanSummary[] = [];
  for (const f of files.sort().reverse().slice(0, limit)) {
    try {
      const s: SavedScan = JSON.parse(await readFile(path.join(SCANS_ROOT, f), "utf8"));
      const { results: _r, ...head } = s;
      out.push(head);
    } catch { /* a half-written file must not break the list */ }
  }
  return out;
}

export async function readScan(id: string): Promise<SavedScan | null> {
  if (!/^[\w-]{1,64}$/.test(id)) return null;
  try { return JSON.parse(await readFile(path.join(SCANS_ROOT, `${id}.json`), "utf8")); }
  catch { return null; }
}

// ── what to point it at ────────────────────────────────────────────────────────

/** A channel URL, or @handle when the platform is already chosen in the UI. */
/** A suffix test would let notyoutube.com through. Nothing downstream trusts the host —
 *  ytBase() rebuilds the URL from the handle alone — but reading someone's typo as a
 *  YouTube handle and silently listing a different channel is its own kind of wrong. */
const isHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function parseAccount(input: string, hint?: Platform): Account | null {
  // A cap before any regex touches it. The slash-trimming below backtracks on a long
  // run of slashes, and 120k of them measured as 25 seconds of blocked event loop.
  // No real account URL is anywhere near this long.
  if (input.length > 300) return null;

  // Nobody types the scheme. Copying a channel out of the address bar keeps it, but
  // typing it from memory — which is how a handle usually arrives — does not, and
  // rejecting `youtube.com/@name` for the want of five characters is a bad first
  // impression from a box that is asking you to paste something.
  const s = input.trim().replace(/^(?:https?:\/\/)?(?=(?:www\.|m\.)?[\w-]+\.[a-z]{2,}\/)/i, "https://");
  if (!s) return null;

  const m = s.match(/^https?:\/\/(?:www\.|m\.)?([^/]+)\/(.+)$/i);
  if (m) {
    const host = m[1].toLowerCase();
    const rest = m[2].replace(/[?#].*$/, "").replace(/\/+$/, "");
    const first = rest.split("/")[0];
    if (isHost(host, "youtube.com")) {
      // /@handle, /c/name and /user/name all list uploads; /channel/UC… does too, and
      // yt-dlp takes the channel id verbatim, so it is kept as-is rather than guessed at.
      if (first.startsWith("@")) return { platform: "youtube", handle: first.slice(1) };
      const seg = rest.split("/");
      if (["c", "user", "channel"].includes(seg[0]) && seg[1]) {
        return { platform: "youtube", handle: `${seg[0]}/${seg[1]}` };
      }
      return null;
    }
    if (isHost(host, "tiktok.com") && first.startsWith("@")) {
      return { platform: "tiktok", handle: first.slice(1) };
    }
    if (isHost(host, "instagram.com") && first && !["p", "reel", "reels", "tv"].includes(first)) {
      return { platform: "instagram", handle: first };
    }
    return null;
  }

  const bare = s.replace(/^@/, "");
  if (hint && /^[\w.\-]{1,64}$/.test(bare)) return { platform: hint, handle: bare };
  return null;
}

/** The URL yt-dlp is given. A YouTube handle that already carries its own prefix
 *  (channel/UC…, c/name) must not get a second @. */
const ytBase = (handle: string) =>
  handle.includes("/") ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/@${handle}`;

// ── what a teardown will cost ──────────────────────────────────────────────────

// Measured, not derived. The model is billed on what it takes in, which for a video is
// the frames *and* the audio track, so the per-frame figure here is higher than the
// ~120 tokens a frame costs on its own. 170 is what reproduces the runs we actually
// paid for: a 30-second TikTok at 10 fps lands near a cent, and a 65-minute course at
// 2 fps near twenty — both of which is what the bill said.
const TOKENS_PER_FRAME = 170;
// A teardown answers in six sections and runs about this long; per part, because a
// video split into parts is answered once per part and then merged.
const TOKENS_OUT = 1400;
/** YouTube's own cap on a short, used as the length when the shorts tab reports none. */
const SHORT_CEILING = 180;

/** Mirrors SHORT_MAX in the engine: below it the sampling rate is 10 fps, above it 2. */
const FPS_CLIFF = 180;

/** What one video costs to tear down, in dollars. An estimate, and labelled as one in
 *  the UI — the real figure comes back with the answer. */
export function estimate(seconds: number): number {
  // The length in the listing and the length the engine measures after downloading are
  // not the same number — one is the platform's, the other is ffmpeg's, and they differ
  // by a second either way. That is harmless everywhere except at the three-minute line,
  // where the sampling rate drops from 10 fps to 2 and the real cost swings about
  // fivefold. A video listed at 181s that measures 180s would be quoted at the cheap
  // rate and billed at the expensive one. So anything within a few seconds of the line
  // is priced on the expensive side of it: this tool may only ever overquote.
  const s = Math.abs(seconds - FPS_CLIFF) <= 5 ? Math.min(seconds, FPS_CLIFF) : seconds;
  const frames = Math.max(1, Math.round(s * fpsFor(s)));
  const parts = Math.max(1, Math.ceil(frames / 2400));
  return frames * TOKENS_PER_FRAME * PRICE_IN + parts * TOKENS_OUT * PRICE_OUT;
}

// ── listing an account ─────────────────────────────────────────────────────────

interface FlatEntry {
  id?: string; title?: string; url?: string; webpage_url?: string;
  view_count?: number; duration?: number; timestamp?: number;
}

/** One yt-dlp listing. Failures return nothing rather than throwing: a channel with no
 *  shorts tab is normal, and it must not sink the uploads tab next to it. */
async function flat(target: string, depth: number | null): Promise<{
  account?: string; fans?: number; rows: { e: FlatEntry; ord: number }[];
}> {
  try {
    const data = JSON.parse(await run(
      "yt-dlp",
      // No --playlist-end at all when reading the whole account, and a longer leash to
      // go with it: a channel with a thousand uploads takes minutes to enumerate, and
      // being cut off halfway would silently present a partial account as the whole one.
      ["-J", "--flat-playlist", ...(depth === null ? [] : ["--playlist-end", String(depth)]), target],
      depth === null ? 900_000 : 300_000,
    )) as { channel?: string; title?: string; channel_follower_count?: number; entries?: FlatEntry[] };
    return {
      account: data.channel || data.title,
      fans: data.channel_follower_count || 0,
      rows: (data.entries || []).map((e, ord) => ({ e, ord })),
    };
  } catch {
    return { rows: [] };
  }
}

/** How deep to read before sorting. "Newest" only needs the head of the list, but
 *  "most popular" is meaningless unless it can see past the last few uploads — the
 *  listing is free, so it reads wide and then cuts.
 *
 *  `limit: "all"` means all of it, with no cap at any layer: the mode is called whole
 *  channel, and a whole channel that quietly stops at thirty is just a lie with a
 *  smaller number in it. What protects someone from a large account is the price at
 *  the bottom of the list and the confirmation it demands — not a ceiling we picked
 *  for them. */
const depthFor = (order: Order, limit: Limit): number | null =>
  limit === "all" ? null : order === "popular" ? 60 : Math.min(60, Math.max(limit + 4, 12));

export type Limit = number | "all";

export async function listChannel(acc: Account, order: Order, limit: Limit): Promise<ChannelListing> {
  const depth = depthFor(order, limit);
  let account = acc.handle, fans = 0;
  const note: string | undefined = undefined;
  let rows: { e: FlatEntry; ord: number; shorts?: boolean }[] = [];

  if (acc.platform === "youtube") {
    // A channel keeps shorts on a tab of their own. For "how does this account work"
    // both halves matter, so both are read and then merged.
    for (const tab of ["videos", "shorts"]) {
      const r = await flat(`${ytBase(acc.handle)}/${tab}`, depth);
      if (r.account) account = r.account;
      if (r.fans) fans = r.fans;
      // The shorts listing reports no duration at all, and shorts are exactly the
      // material this tool reads best — so they must not all show up unpriced. A short
      // is capped by YouTube at three minutes, so the tab itself is the bound, and the
      // price is shown as a ceiling rather than a figure. Erring upwards is the only
      // safe direction: nobody minds a bill smaller than the one they agreed to.
      for (const row of r.rows) rows.push({ ...row, shorts: tab === "shorts" });
    }
  } else if (acc.platform === "tiktok") {
    const r = await flat(`https://www.tiktok.com/@${acc.handle}`, depth);
    if (r.account) account = r.account;
    rows = r.rows;
  } else {
    // yt-dlp marks its Instagram profile extractor broken, and it is: it cannot read a
    // profile without cookies. Rather than ship something that fails for half the
    // people who try it, Instagram goes down the path Scout already uses.
    const raw = await scrape([{ id: "scan", kind: "account", platform: "instagram", handle: acc.handle }], 3650)
      .catch((e: Error) => { throw new Error(`${e.message} (Instagram needs it — YouTube and TikTok do not.)`); });
    const videos = raw
      .map((r) => ({
        url: String(r.url || ""),
        title: String(r.caption || "").slice(0, 160) || String(r.url || ""),
        views: Number(r.plays) || 0,
        duration: typeof r.duration === "number" ? r.duration : undefined,
        postedAt: r.postedAt ? String(r.postedAt) : undefined,
      }))
      .filter((v) => v.url.startsWith("http"));
    for (const r of raw) if (r.author) { account = String(r.author); break; }
    for (const r of raw) if (Number(r.fans)) { fans = Number(r.fans); break; }
    return finish({ platform: "instagram", handle: acc.handle, account, fans, videos }, order, limit,
      "Instagram was read through Hermes' Apify plugin — the durations it reports can be rough.");
  }

  if (!rows.length) {
    throw new Error(
      acc.platform === "youtube"
        ? `No videos came back for @${acc.handle}. Check the handle — it is the name after the @ on the channel page.`
        : `No videos came back for @${acc.handle}. TikTok hides some accounts from anonymous listing.`,
    );
  }

  const videos = rows
    .map(({ e, ord, shorts }) => ({
      url: e.url || e.webpage_url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : ""),
      title: e.title || e.id || "",
      views: typeof e.view_count === "number" ? e.view_count : 0,
      duration: typeof e.duration === "number" ? e.duration : undefined,
      postedAt: e.timestamp ? new Date(e.timestamp * 1000).toISOString() : undefined,
      ord,
      shorts,
    }))
    .filter((v) => v.url.startsWith("http"));

  return finish({ platform: acc.platform, handle: acc.handle, account, fans, videos }, order, limit, note);
}

/** The same video appears on both YouTube tabs under two spellings — the uploads tab
 *  calls it watch?v=ID and the shorts tab calls it shorts/ID. Comparing raw URLs misses
 *  that, and the cost of missing it is watching the video twice: the download and the
 *  upload are cached, but the model is asked again, and asking again is the part that
 *  is billed. */
function dedupKey(url: string): string {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? `yt:${m[1]}` : url;
}

function finish(
  base: { platform: Platform; handle: string; account: string; fans: number;
          videos: (Omit<ChannelVideo, "cost" | "atMost"> & { ord?: number; shorts?: boolean })[] },
  order: Order, limit: Limit, note?: string,
): ChannelListing {
  const seen = new Set<string>();
  const unique = base.videos.filter((v) => {
    const k = dedupKey(v.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Newest sorts on a real date when the platform gave one. YouTube's flat listing
  // usually does not, and there the tab's own order already is newest-first — so the
  // position it came back in is the honest fallback, not a date we would have to invent.
  const sorted = [...unique].sort((a, b) => {
    if (order === "popular") return b.views - a.views;
    if (a.postedAt && b.postedAt) return a.postedAt < b.postedAt ? 1 : -1;
    return (a.ord ?? 0) - (b.ord ?? 0);
  });

  return {
    platform: base.platform, handle: base.handle, account: base.account, fans: base.fans,
    scanned: unique.length,
    note,
    videos: (limit === "all" ? sorted : sorted.slice(0, limit)).map(({ ord: _ord, shorts, ...v }) => {
      const seconds = v.duration || (shorts ? SHORT_CEILING : 0);
      return {
        ...v,
        cost: seconds ? Number(estimate(seconds).toFixed(4)) : undefined,
        atMost: !v.duration && Boolean(shorts),
      };
    }),
  };
}
