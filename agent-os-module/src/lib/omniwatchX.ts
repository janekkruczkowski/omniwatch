// X (Twitter) as a channel source.
//
// Same shape as listChannel — a handle in, ChannelVideo[] out — but a different
// honesty problem. YouTube and TikTok are enumerated by yt-dlp for free; X has no
// such door, so this goes through Apify's `apidojo~tweet-scraper` and every listing
// has a real bill attached, even before anything is torn down. That is new for this
// tool (Instagram is Apify too, but Scout already eats that cost on a schedule — this
// is the on-demand "type a handle, see the videos" path), so the cost note below is
// exported for the UI to show up front, the same way it already does for Instagram.
//
// Why only video posts: this tool tears down video, and a feed is mostly text and
// photos. The actor's own `onlyVideo` filter does the trimming server-side, which
// means we are not billed for text tweets we would throw away anyway.
//
// X video URLs are handled by yt-dlp — that part is verified, not assumed: an earlier
// demo ran a Qwen teardown from a twitter.com/.../status/... link and it worked. So
// what this file hands back is the tweet URL itself, never a raw media/CDN URL — the
// engine already knows what to do with a status link.

import { runActor } from "@/lib/apify";
import type { ChannelVideo, Limit, Order } from "@/lib/omniwatchChannel";

const ACTOR_ID = "apidojo~tweet-scraper";

// ── cost, said plainly ───────────────────────────────────────────────────────────
//
// Listing YouTube and TikTok costs nothing because yt-dlp reads them directly. X has
// no equivalent — Apify is the only door — so *listing itself* is billed here, not
// just the teardown that follows. That is the one honesty promise this tool makes
// elsewhere ("see it before you spend") that X cannot keep in the same way, and the
// UI needs to say so rather than let someone assume X is as free as the other two.
export const X_LISTING_IS_FREE = false;
export const X_LISTING_COST_NOTE =
  "Listing X costs money too — apidojo/tweet-scraper bills per tweet read (about $0.40 per 1,000), " +
  "not just the teardown afterwards. YouTube and TikTok listing is free; this one is not.";

// ── the actor's contract ─────────────────────────────────────────────────────────
//
// Verified against https://apify.com/apidojo/tweet-scraper's own input/output schema
// pages (fetched 2026-09-20, no live run — no Apify token was reachable from this
// machine, see report):
//   input:  twitterHandles (string[]), maxItems (number), sort ("Latest" | "Top" |
//           "Latest + Top"), onlyVideo (boolean), start/end (date strings).
//   output: url, text, createdAt (classic Twitter format, e.g.
//           "Fri Nov 24 17:49:36 +0000 2023" — Node's Date parses it natively, checked
//           locally), likeCount, retweetCount, author.userName, author.followers.
//
// ASSUMED, not verified — the actor's own docs mention "views" in prose but no fetched
// schema page showed the dataset field name in an example row:
//   viewCount — used if present, defaulted to 0 if not. If this is wrong the field is
//   simply always 0, which fails safe (never invents a number) rather than throwing.
//
// ASSUMED — media/video detail fields. Nothing fetched showed a confirmed shape for
// `extendedEntities.media` or `media` on this actor's output, so hasVideo() below
// treats their *absence* as "can't tell" rather than "no video" and defers to the
// actor's own `onlyVideo` input filter as the real gate. If the actor does expose one
// of these fields, hasVideo() uses it as a second check for free.
interface RawAuthor { userName?: string; followers?: number }
interface RawMedia { type?: string }
interface RawTweet {
  url?: string;
  text?: string;
  createdAt?: string;
  viewCount?: number; // assumed field name — see note above
  likeCount?: number;
  retweetCount?: number;
  author?: RawAuthor;
  extendedEntities?: { media?: RawMedia[] }; // assumed shape
  media?: RawMedia[]; // assumed shape
}

function parseTwitterDate(s?: string): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Defensive second check on top of the actor's own `onlyVideo` filter. When neither
 *  guessed media field is present at all, there is nothing to check against — so this
 *  says yes rather than silently dropping every row over an unverified field name. */
function hasVideo(t: RawTweet): boolean {
  const media = t.extendedEntities?.media ?? t.media;
  if (!media) return true;
  return media.some((m) => m.type === "video" || m.type === "animated_gif");
}

// The actor bills per tweet read, and its own docs describe a per-query minimum around
// 50 — so a request for "top 5" still reads (and pays for) a proper page, the same way
// depthFor() in omniwatchChannel reads wider than the limit before cutting. Requesting
// fewer than that would not make it cheaper, only give the popularity sort less to
// choose from.
const MIN_READ = 50;
// "all" has no yt-dlp-style free enumeration to fall back on here, so it is capped
// rather than left open — an unbounded X read is an unbounded bill, and nothing else
// in this file can warn about that once the request is already in flight.
const ALL_CAP = 200;

function readSize(limit: Limit): number {
  if (limit === "all") return ALL_CAP;
  return Math.max(MIN_READ, limit);
}

/** handle → video posts only, newest or most-viewed first. Matches listChannel's
 *  ChannelVideo shape; cost/atMost are left for the caller to fill in, same as there —
 *  this file has no opinion on teardown pricing, only on what got listed and what it
 *  cost to list it (see X_LISTING_COST_NOTE, which the caller is expected to surface).
 *
 *  An account with no video posts is a normal outcome on X, not a broken handle — so
 *  this returns an empty array rather than throwing, unlike listChannel's YouTube/
 *  TikTok paths where zero rows usually means a typo. Only a real fetch failure
 *  (missing token, actor error, network) throws, via runActor. */
export async function listX(handle: string, limit: Limit, order: Order): Promise<ChannelVideo[]> {
  const clean = handle.trim().replace(/^@/, "");
  if (!clean) return [];

  const rows = await runActor<RawTweet>(ACTOR_ID, {
    twitterHandles: [clean],
    maxItems: readSize(limit),
    onlyVideo: true,
    sort: order === "popular" ? "Top" : "Latest",
  });

  const videos: ChannelVideo[] = rows
    .filter(hasVideo)
    .map((t) => ({
      url: t.url || "",
      title: (t.text || "").slice(0, 160) || t.url || "",
      views: typeof t.viewCount === "number" ? t.viewCount : 0,
      postedAt: parseTwitterDate(t.createdAt),
    }))
    .filter((v) => v.url.startsWith("http"));

  if (order === "popular") videos.sort((a, b) => b.views - a.views);
  else videos.sort((a, b) => ((a.postedAt || "") < (b.postedAt || "") ? 1 : -1));

  return limit === "all" ? videos : videos.slice(0, limit);
}
