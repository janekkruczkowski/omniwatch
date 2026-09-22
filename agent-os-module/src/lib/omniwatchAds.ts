// Meta (Facebook/Instagram) Ads Library as a source — one more "point it at something"
// origin next to a channel (YouTube/TikTok/Instagram, `omniwatchChannel.ts`) and X
// (`omniwatchX.ts`). The difference from all of those: this is the one source where
// *listing* itself is billed, not just the teardown that follows it.
//
// Every other source lists for free — yt-dlp already knows a channel's uploads, and
// Scout's own scraping is metadata Hermes already pays for on a schedule. The Ad
// Library has no free local reader: the only way to see what an advertiser is running
// is to ask Apify, and Apify charges per result. So the promise this whole tool leads
// with ("see what it costs before anything is downloaded, and the looking is free")
// only half holds here. The UI has to say so, the same way it already flags Instagram's
// 25-video ceiling — `ADS_LISTING_NOTICE` and `estimateListCost` below are what it says
// it with. Wiring that into the tab is someone else's file to touch, not this one's.
//
// Actor: igolaizola/facebook-ad-library-scraper. No login, filters to `mediaType:
// "video"`, and returns direct CDN media URLs that go straight into the engine's
// yt-dlp → oss:// pipeline exactly like every other source — verified live on a
// clothing ad with the "clothing and colour" preset: $0.0103, full answer with
// timestamps, on 2026-09-20.

import { runActor, apifyToken, APIFY_SETUP_HINT } from "@/lib/apify";
import type { ChannelVideo } from "@/lib/omniwatchChannel";

const ACTOR_ID = "igolaizola/facebook-ad-library-scraper";

// ── what this actor actually takes and returns ──────────────────────────────────
//
// Verified against the actor's public input schema and README on apify.com
// (api.apify.com/v2/acts/igolaizola~facebook-ad-library-scraper, read 2026-09-20 — no
// Apify token on this machine, so this is read from the published schema and the
// README's example output, never exercised against a live run). Field names below are
// copied, not guessed:
//
//   maxItems      number,  required. Ads to pull, minimum 1.
//   query         string,  required by the schema's `required` list — but the README
//                 says a `pageId` alone lists a page's ads "without a query". Untested
//                 without a token which one wins, so when only a pageId is given this
//                 still sends `query: ""` rather than omitting the field.
//   pageId        string,  optional — a single advertiser's Facebook Page ID.
//   advertisers   string[], optional — filter to a set of Page IDs (not used here).
//   country       string,  optional ISO-3166 code, e.g. "US". Default: all countries.
//   category      string,  optional. enum incl. "all" (default).
//   mediaType     string,  optional. enum ["all","image","meme","image_and_meme",
//                 "video","none"] — the UI-facing names ("Videos" etc.) are display
//                 titles for these; the wire values are lowercase. "video" is what
//                 this module always sends.
//   sortBy        string,  optional. enum ["mostRecent","impressions"]. Default
//                 "mostRecent".
//   activeStatus  string,  optional. enum ["active","inactive","all"]. Default
//                 "active" — kept as the default here too: an ad Meta already pulled
//                 down is more likely to have a dead CDN link, and a dead link is
//                 exactly what this module exists to avoid handing the engine.
//   minDate/maxDate  string, optional "YYYY-MM-DD".
//   fetchDetails  boolean, optional. Extra request per ad, extra charge — left off.
//
// Output: one object per ad. The fields this module reads:
//   ad_archive_id, page_id, start_date/end_date (unix seconds), publisher_platform[],
//   snapshot.title, snapshot.page_name, snapshot.body.text, snapshot.display_format,
//   snapshot.videos[] (single-video ads), snapshot.cards[] (carousel ads — each card
//   carries the same video_* fields as a `videos[]` entry).
// Confirmed field NAMES from the README's example output: `video_hd_url`,
// `video_sd_url`, `video_preview_image_url` inside both `snapshot.videos[]` and
// `snapshot.cards[]`. The one example the README ships happens to be an image ad, so
// every video field in it is `null` — the names are attested, a populated value was
// not seen without running the actor. Flagged here rather than silently assumed past
// that point.
//
// Not modeled and not needed: `snapshot.extra_videos[]` (README does not document
// when this is used instead of `videos[]`; if it turns out to carry results the two
// arrays above miss, this is the first place to look).

interface RawVideoLike {
  video_hd_url?: string | null;
  video_sd_url?: string | null;
}
interface RawAd {
  ad_archive_id?: string;
  page_id?: string;
  start_date?: number;
  snapshot?: {
    title?: string | null;
    page_name?: string | null;
    body?: { text?: string | null } | null;
    videos?: RawVideoLike[] | null;
    cards?: RawVideoLike[] | null;
  } | null;
}

/** Every playable video on one ad — a single-video ad has one entry in `videos[]`; a
 *  carousel has one per card, and each is a distinct clip worth its own row. HD first,
 *  falling back to SD, because the engine downloads whichever URL it is given and the
 *  larger file is the better source when both exist. */
function videosOf(ad: RawAd): string[] {
  const pool = [...(ad.snapshot?.videos || []), ...(ad.snapshot?.cards || [])];
  return pool
    .map((v) => v.video_hd_url || v.video_sd_url || "")
    .filter((u) => u.startsWith("http"));
}

function toChannelVideos(ad: RawAd): ChannelVideo[] {
  const urls = videosOf(ad);
  if (!urls.length) return [];
  const page = ad.snapshot?.page_name || `page ${ad.page_id || "?"}`;
  const text = ad.snapshot?.title || ad.snapshot?.body?.text || "";
  const base = (text ? `${page} — ${text}` : page).slice(0, 160);
  const postedAt = ad.start_date ? new Date(ad.start_date * 1000).toISOString() : undefined;
  return urls.map((url, i) => ({
    url,
    title: urls.length > 1 ? `${base} (${i + 1}/${urls.length})` : base,
    // The Ad Library does not publish view/play counts the way a feed does —
    // impressions only ever come back as a vague text bucket ("1K–5K"), and only with
    // `fetchDetails` on, which doubles the bill. 0 here means "not offered", the same
    // meaning `views: 0` already carries for a TikTok row the platform under-reported.
    views: 0,
    postedAt,
    // Duration is deliberately absent, not merely unset. yt-dlp never touches these
    // URLs at list time (no download happens here at all, only Apify's metadata call),
    // so there is nothing to probe yet. S1's `probeDuration(file)` in
    // `omniwatchCuts.ts` exists for exactly this gap, but it operates on an already
    // downloaded file — it cannot help before that download happens, so importing it
    // here would buy nothing. Duration and cost show up once a chosen ad is actually
    // watched, same as this tool's own Instagram rows, which carry the same absence
    // for a related reason (rough platform data rather than no data at all).
  }));
}

// ── what the listing itself costs ────────────────────────────────────────────────
//
// Pulled from the actor's own pricing (api.apify.com/v2/acts/.../, `pricingInfos`,
// read 2026-09-20): PAY_PER_EVENT, one charge per dataset item plus a one-time
// actor-start charge. The per-item price is tiered by Apify plan: $0.00075 on the
// free plan down to $0.0003 on Gold/Platinum/Diamond. $0.0003 × 1000 = $0.30 — which
// is where the plan's "$0.30 per 1000" figure comes from; it assumes a paid Apify
// plan, not the free one. Both figures are shown below rather than picking one,
// because which applies depends on an account this module has no way to inspect.
const PRICE_PER_AD_PAID = 0.0003; // Gold/Platinum/Diamond
const PRICE_PER_AD_FREE = 0.00075; // free Apify plan
const ACTOR_START = 0.003; // one-time per run, paid-tier figure; ~0.0075 on free

/** What listing `maxItems` ads is expected to cost, in dollars, at the cheaper
 *  (paid-plan) rate — shown before the request runs, the way a channel scan shows a
 *  price before it downloads anything. Free-plan accounts pay roughly 2.5× this. */
export function estimateListCost(maxItems: number): number {
  const n = Math.max(1, Math.round(maxItems));
  return Number((n * PRICE_PER_AD_PAID + ACTOR_START).toFixed(4));
}

/** For the tab to show before a query runs. Every other source in this tool lists for
 *  free; this is the one exception, and the interface needs to say so up front the way
 *  it already does for Instagram's 25-result ceiling — this module owns the wording,
 *  not the component that renders it. */
export const ADS_LISTING_NOTICE =
  "Listing Meta ads costs money — this is the only source here where browsing itself is billed. " +
  "Roughly $0.30 per 1,000 results on a paid Apify plan, more (~$0.75/1,000) on the free one, " +
  "plus a small per-run charge. Everywhere else in this tool, looking is free.";

// ── running the actor ────────────────────────────────────────────────────────────

export interface AdsQuery {
  /** free-text search term, e.g. a brand or product name */
  query?: string;
  /** a specific advertiser's Facebook Page ID — lists that page's ads with no query */
  pageId?: string;
  /** ISO-3166 country code; omitted means every country */
  country?: string;
  /** how many ads to pull. This is what gets billed, so it is not defaulted high. */
  limit?: number;
  /** include ads Meta has already taken down, not just ones still running */
  includeInactive?: boolean;
}

export interface AdsListing {
  query: string;
  pageId?: string;
  /** how many ads the actor returned before the no-video ones were dropped */
  scanned: number;
  videos: ChannelVideo[];
  /** what this specific run is estimated to have cost — paid-plan rate, see above */
  listCost: number;
  note: string;
}

export async function listAds(q: AdsQuery): Promise<AdsListing> {
  const query = (q.query || "").trim();
  const pageId = (q.pageId || "").trim();
  if (!query && !pageId) throw new Error("Give either a search term or a Facebook Page ID.");

  const limit = Math.max(1, Math.min(500, Math.round(q.limit || 30)));

  const input: Record<string, unknown> = {
    maxItems: limit,
    // The one field this module cannot afford to get wrong: everything downstream
    // assumes a video. Confirmed wire value "video" (not "Videos" — that is only the
    // UI-facing enum title) from the actor's raw input schema.
    mediaType: "video",
    sortBy: "mostRecent",
    activeStatus: q.includeInactive ? "all" : "active",
    // `query` is in the schema's `required` list; sent as "" rather than omitted when
    // only a pageId is given, since the README's claim that pageId alone is enough was
    // never exercised against a live run on this machine.
    query: query || "",
  };
  if (pageId) input.pageId = pageId;
  if (q.country) input.country = q.country.toUpperCase();

  let raw: RawAd[];
  try {
    raw = await runActor<RawAd>(ACTOR_ID, input, { timeoutMs: 180_000, limit });
  } catch (e) {
    // apify.ts (S0) already turns a missing token into an actionable message; this
    // only adds a second, cheaper check first, since a plain truthiness read on the
    // token is faster than letting a whole actor call fail to discover the same thing.
    const hasToken = await apifyToken().catch(() => null);
    if (!hasToken) throw new Error(`Meta ads need an Apify token to list, and this is the one source where that listing itself is billed. ${APIFY_SETUP_HINT}`);
    throw e;
  }

  const videos = raw.flatMap(toChannelVideos);
  const dropped = raw.length - raw.filter((a) => videosOf(a).length).length;
  const listCost = estimateListCost(raw.length || limit);
  const listCostFree = Number((raw.length * PRICE_PER_AD_FREE + ACTOR_START * 2.5).toFixed(4));

  return {
    query: query || `page:${pageId}`,
    pageId: pageId || undefined,
    scanned: raw.length,
    videos,
    listCost,
    note:
      `~$${listCost.toFixed(4)} to list ${raw.length} result${raw.length === 1 ? "" : "s"} ` +
      `(paid-plan rate; ~$${listCostFree.toFixed(4)} on the free Apify plan). ` +
      (dropped ? `${dropped} of ${raw.length} had no playable video and ${dropped === 1 ? "was" : "were"} dropped. ` : "") +
      `Meta does not publish view counts for ads, so these rows carry none.`,
  };
}
