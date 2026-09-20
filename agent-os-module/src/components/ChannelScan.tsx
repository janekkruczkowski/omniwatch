"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AtSign, Loader2, Play, Search, Flame, Clock, ExternalLink, FolderOpen, AlertTriangle, History,
} from "lucide-react";
import OmniMarkdown from "./OmniMarkdown";

// The channel half of the OmniWatch tab: one account, on demand.
//
// It is built in two presses rather than one, and that is the whole point. The first
// press only lists — it is free, because yt-dlp already knows what an account has
// published — and shows you the videos with a price against each. The second press is
// the one that spends. A tool that quietly turns a pasted link into a dollar is a tool
// nobody pastes a second link into.

interface Video {
  url: string; title: string; views: number; duration?: number; postedAt?: string;
  cost?: number; atMost?: boolean;
}
interface Listing {
  platform: string; handle: string; account: string; fans: number;
  scanned: number; videos: Video[]; note?: string;
}
interface Result {
  url: string; title: string; duration?: number; text: string; cost?: number; error?: string;
}
interface Poll {
  state: string; stage?: string; account?: string; total?: number; done?: number;
  current?: string; results?: Result[]; cost?: number; vault?: string | null;
  seconds?: number; error?: string;
  /** shown from disk rather than just run — so it does not claim to have spent anything now */
  replay?: boolean;
}
interface ScanSummary {
  id: string; at: string; account: string; videos: number; failed: number;
  cost: number; topic?: string;
}

const PLATFORMS = [
  { id: "youtube", label: "YouTube" },
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
] as const;

type Limit = number | "all";
const COUNTS: Limit[] = [5, 10, 20, 30, "all"];

// Above this, watching is a decision rather than a click, so the button makes you take
// it twice. The figure is deliberately low: this tool is normally a few cents, and the
// point of the second press is to catch the moment it stops being that.
const CONFIRM_ABOVE = 2;

// Up to this many, the list arrives with everything ticked. Beyond it, nothing is.
const AUTO_PICK_UPTO = 30;
// What one scan will accept; the server refuses more. Shown before you select, not after.
const PER_SCAN_MAX = 500;

const fmt = (s?: number) => {
  if (!s) return "—";
  const m = Math.floor(s / 60), x = String(Math.floor(s % 60)).padStart(2, "0");
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${x}` : `${m}:${x}`;
};
const short = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n || 0);

export default function ChannelScan({ lang }: { lang: string }) {
  const [account, setAccount] = useState("");
  const [platform, setPlatform] = useState<string>("youtube");
  const [order, setOrder] = useState<"popular" | "newest">("popular");
  const [limit, setLimit] = useState<Limit>(10);
  const [armed, setArmed] = useState(false);
  const [topic, setTopic] = useState("");

  const [finding, setFinding] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  const [running, setRunning] = useState(false);
  const [poll, setPoll] = useState<Poll | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [history, setHistory] = useState<ScanSummary[]>([]);
  const loadHistory = useCallback(() => {
    fetch("/api/omniwatch/channel?history=1", { cache: "no-store" })
      .then((r) => r.json()).then((d) => setHistory(d.scans || [])).catch(() => {});
  }, []);
  useEffect(loadHistory, [loadHistory]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  /** Re-open a finished scan. It comes off disk, so looking again costs nothing. */
  const open = useCallback(async (id: string) => {
    if (running) return;
    try {
      const r = await fetch(`/api/omniwatch/channel?scan=${id}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) { setError(d.error || "Could not open that scan"); return; }
      setListing(null);
      setPoll({
        state: "done", account: d.account, total: d.results.length, done: d.results.length,
        results: d.results, cost: d.cost, seconds: 0, vault: null, replay: true,
      });
    } catch {
      setError("Could not reach the server");
    }
  }, [running]);

  const find = useCallback(async () => {
    // Not while a scan is running. Without this, the new listing renders and then the
    // still-live poll fires a tick later, hides it again (the listing only shows when
    // `poll` is null) and leaves `running` true — a tab that looks alive and does
    // nothing. The scan itself is unaffected; it is the screen that would get lost.
    if (!account.trim() || finding || running) return;
    setFinding(true); setError(""); setListing(null); setPicked(new Set()); setPoll(null); setArmed(false);
    try {
      const q = new URLSearchParams({ url: account.trim(), platform, order, limit: String(limit) });
      const r = await fetch(`/api/omniwatch/channel?${q}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) { setError(d.error || `Could not read that account (HTTP ${r.status})`); return; }
      setListing(d);
      // Pre-ticking every row is a kindness at ten videos and a trap at seven thousand:
      // the screen would open with hundreds of dollars already selected. Past a handful
      // the list arrives empty and you say what you want.
      const all = d.videos as Video[];
      setPicked(new Set(all.length <= AUTO_PICK_UPTO ? all.map((v) => v.url) : []));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the server");
    } finally {
      setFinding(false);
    }
  }, [account, platform, order, limit, finding, running]);

  const start = useCallback(async () => {
    if (!listing || running || !picked.size) return;
    setRunning(true); setError("");
    const urls = listing.videos.filter((v) => picked.has(v.url)).map((v) => v.url);

    let id = "";
    try {
      const r = await fetch("/api/omniwatch/channel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ urls, account: listing.account, topic: topic.trim(), lang }),
      });
      const d = await r.json();
      if (!r.ok || !d.id) { setError(d.error || `Could not start (HTTP ${r.status})`); setRunning(false); return; }
      id = d.id;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the server");
      setRunning(false);
      return;
    }

    setPoll({ state: "running", total: urls.length, done: 0, results: [] });
    pollRef.current = setInterval(async () => {
      let d: Poll;
      try {
        const r = await fetch(`/api/omniwatch/channel?job=${id}`, { cache: "no-store" });
        if (r.status === 404) {
          clearInterval(pollRef.current!); pollRef.current = null; setRunning(false);
          setError("The dashboard restarted while this was running. The videos already watched are in your vault.");
          return;
        }
        d = await r.json();
      } catch { return; } // a dropped poll is not a failed scan; the next tick retries
      setPoll(d);
      if (d.state === "done" || d.state === "error") {
        clearInterval(pollRef.current!); pollRef.current = null;
        setRunning(false);
        loadHistory(); // it is on disk now, so the list of past scans has one more
        if (d.state === "error") setError(d.error || "The scan failed");
      }
    }, 1200);
  }, [listing, picked, topic, lang, running, loadHistory]);

  // Changing the selection disarms the confirmation: the figure you agreed to is no
  // longer the figure on the button.
  const toggle = (url: string) => {
    setArmed(false);
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  };

  const chosen = listing ? listing.videos.filter((v) => picked.has(v.url)) : [];
  const priced = chosen.filter((v) => typeof v.cost === "number");
  const total = priced.reduce((a, v) => a + (v.cost || 0), 0);
  const unpriced = chosen.length - priced.length;
  // An unknown price counts as needing confirmation too: not knowing what it costs is
  // not the same as knowing it is small.
  const needsConfirm = total > CONFIRM_ABOVE || unpriced > 0;

  return (
    <div className="space-y-5">
      {/* ── which account ───────────────────────────────────────────────────── */}
      <div className="panel p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPlatform(p.id)}
              className={`pill ${platform === p.id ? "pill-warn" : ""}`}
              style={{ cursor: "pointer" }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 pb-3 mb-3" style={{ borderBottom: "1px solid var(--line-soft)" }}>
          <AtSign size={15} style={{ color: "var(--cream-mute)", flex: "none" }} />
          <input
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !running) { e.preventDefault(); find(); } }}
            placeholder={
              platform === "youtube" ? "youtube.com/@handle — or just the handle"
                : platform === "tiktok" ? "tiktok.com/@handle — or just the handle"
                  : "instagram.com/handle — or just the handle"
            }
            className="flex-1 bg-transparent outline-none text-sm min-w-0"
            style={{ color: "var(--cream)" }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setOrder("popular")}
            className={`pill ${order === "popular" ? "pill-warn" : ""} flex items-center gap-1.5`}
            style={{ cursor: "pointer" }}>
            <Flame size={12} /> Most popular
          </button>
          <button onClick={() => setOrder("newest")}
            className={`pill ${order === "newest" ? "pill-warn" : ""} flex items-center gap-1.5`}
            style={{ cursor: "pointer" }}>
            <Clock size={12} /> Newest
          </button>

          <span className="mx-1" style={{ color: "var(--line-soft)" }}>|</span>
          {COUNTS.map((n) => (
            <button key={String(n)} onClick={() => setLimit(n)}
              className={`pill ${limit === n ? "pill-warn" : ""}`} style={{ cursor: "pointer" }}
              title={n === "all" ? "Every video the account has published" : undefined}>
              {n === "all" ? "ALL" : n}
            </button>
          ))}

          <button
            onClick={find}
            disabled={finding || running || !account.trim()}
            title={running ? "A scan is running — let it finish first" : undefined}
            className="pill pill-warn flex items-center gap-1.5 disabled:opacity-40 ml-auto"
            style={{ cursor: finding || running || !account.trim() ? "default" : "pointer" }}
          >
            {finding ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
            Find the videos
          </button>
        </div>

        {/* The free-listing promise is true for YouTube and TikTok, where yt-dlp reads
            the account locally. It is NOT true for Instagram: yt-dlp cannot read an
            Instagram profile, so that one goes through Hermes' Apify plugin, which is
            an agent run plus billed actors — before you have picked anything. Saying
            "free" on that screen would be a lie told right before a charge. */}
        <p className="text-xs mt-3" style={{ color: "var(--cream-mute)" }}>
          {platform === "instagram"
            ? "Instagram cannot be read locally, so this listing goes through Hermes' Apify plugin — that call itself costs, before you pick anything. YouTube and TikTok are free to list."
            : "Listing an account is free — nothing is watched until you say so on the next screen."}
        </p>
        {limit === "all" && platform !== "instagram" && (
          <p className="text-xs mt-2" style={{ color: "var(--gold-soft)" }}>
            ALL reads the entire account, however many that is — the listing itself is still free and can
            take a few minutes on a big channel. The total on the next screen is the number to look at:
            a hundred long videos is real money, not cents.
          </p>
        )}
      </div>

      {error && (
        <div className="panel p-4 flex gap-3 items-start text-sm" style={{ color: "var(--plum)" }}>
          <AlertTriangle size={16} className="flex-none mt-0.5" />
          <span style={{ whiteSpace: "pre-wrap" }}>{error}</span>
        </div>
      )}

      {/* ── what is on it, and what it costs ─────────────────────────────────── */}
      {listing && !poll && (
        <div className="panel p-4 md:p-5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-1">
            <h2 className="text-base font-semibold" style={{ color: "var(--cream)" }}>{listing.account}</h2>
            {listing.fans > 0 && (
              <span className="metric text-xs" style={{ color: "var(--cream-dim)" }}>{short(listing.fans)} followers</span>
            )}
          </div>
          {/* "of the N it listed" would overstate what was read: N is how deep the
              listing went, not how much the account has published. */}
          <div className="text-xs mb-4" style={{ color: "var(--cream-mute)" }}>
            {order === "popular" ? "Most watched" : "Most recent"} {listing.videos.length}, out of {listing.scanned} read from the account
            {order === "newest" && listing.platform === "youtube" && (
              <> · uploads and shorts interleaved, because YouTube&apos;s listing carries no dates</>
            )}
            {listing.note ? ` · ${listing.note}` : ""}
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <button className="pill" style={{ cursor: "pointer" }}
              onClick={() => { setArmed(false); setPicked(new Set(listing.videos.slice(0, PER_SCAN_MAX).map((v) => v.url))); }}>
              Select {listing.videos.length > PER_SCAN_MAX ? `first ${PER_SCAN_MAX}` : "all"}
            </button>
            <button className="pill" style={{ cursor: "pointer" }}
              onClick={() => { setArmed(false); setPicked(new Set()); }}>
              Select none
            </button>
            {listing.videos.length > PER_SCAN_MAX && (
              <span className="text-xs" style={{ color: "var(--cream-mute)" }}>
                {listing.videos.length} listed · one scan takes {PER_SCAN_MAX} at a time
              </span>
            )}
          </div>

          {/* A whole channel can be thousands of rows, and putting all of them in the
              DOM makes the page crawl for no gain — they are sorted, so what matters is
              at the top. The rest are listed, counted and priced, just not drawn. */}
          <div className="ow-rows">
            {listing.videos.slice(0, PER_SCAN_MAX).map((v) => (
              <label key={v.url} className={`ow-row ${picked.has(v.url) ? "on" : ""}`}>
                <input type="checkbox" checked={picked.has(v.url)} onChange={() => toggle(v.url)} />
                <span className="ow-row-title">{v.title}</span>
                <span className="metric ow-row-dur">{v.atMost ? "short" : fmt(v.duration)}</span>
                <span className="metric ow-row-views">{short(v.views)}</span>
                <span className="metric ow-row-cost"
                  title={v.atMost ? "The shorts listing gives no length, so this is the ceiling for a 3-minute short" : undefined}>
                  {typeof v.cost === "number" ? `${v.atMost ? "≤" : ""}$${v.cost.toFixed(3)}` : "?"}
                </span>
              </label>
            ))}
          </div>

          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            rows={2}
            placeholder="What you are about to film (optional) — each teardown then says what transfers to it and what does not"
            className="w-full bg-transparent outline-none resize-none text-sm mt-4 pt-3"
            style={{ color: "var(--cream)", borderTop: "1px solid var(--line-soft)" }}
          />

          <div className="flex flex-wrap items-center justify-between gap-3 mt-3">
            {/* When some of the picked videos have no length, there is no total to
                show. Printing "$0.00" next to them and putting the caveat in grey is
                how a quote becomes a lie: the eye reads the number, not the footnote.
                So the number is withheld entirely rather than shown too low. */}
            <span className="text-sm" style={{ color: "var(--cream-soft)" }}>
              <b style={{ color: "var(--cream)" }}>{chosen.length}</b> picked ·{" "}
              {unpriced > 0 ? (
                <span style={{ color: "var(--plum)" }}>
                  {priced.length > 0
                    ? <>over <b>${total.toFixed(2)}</b> — {unpriced} of these came with no length, so the real total is higher by an unknown amount</>
                    : <><b>price unknown</b> — none of these came with a length</>}
                </span>
              ) : (
                <>
                  <b style={{ color: "var(--gold)" }}>
                    {chosen.some((v) => v.atMost) ? "at most " : "~"}${total.toFixed(2)}
                  </b> estimated
                </>
              )}
            </span>
            {/* Past a couple of dollars the button asks twice. Removing the ceiling on
                how many videos you may scan is only honest if the size of the bill has
                to be acknowledged — otherwise "ALL" on a large account is one stray
                click away from real money. */}
            <button
              onClick={() => (needsConfirm && !armed ? setArmed(true) : start())}
              disabled={running || !chosen.length}
              className="pill pill-warn flex items-center gap-1.5 disabled:opacity-40"
              style={{ cursor: running || !chosen.length ? "default" : "pointer" }}
            >
              {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              {needsConfirm && armed
                ? `Yes — spend ${unpriced > 0 ? "over " : ""}$${total.toFixed(2)} →`
                : `Watch ${chosen.length} video${chosen.length === 1 ? "" : "s"} →`}
            </button>
          </div>
        </div>
      )}

      {/* ── what you have already run ────────────────────────────────────────── */}
      {history.length > 0 && !listing && !poll && (
        <div className="panel p-4 md:p-5">
          <div className="sidebar-section-label mb-3">Scans you have run</div>
          <div className="ow-rows">
            {history.map((h) => (
              <button key={h.id} className="ow-row ow-row-past" onClick={() => open(h.id)}>
                <History size={13} style={{ color: "var(--cream-mute)" }} />
                <span className="ow-row-title">
                  {h.account}
                  {h.topic && <span style={{ color: "var(--cream-mute)" }}> · {h.topic}</span>}
                </span>
                <span className="metric ow-row-dur">
                  {h.videos} video{h.videos === 1 ? "" : "s"}{h.failed ? ` +${h.failed} failed` : ""}
                </span>
                <span className="metric ow-row-views">{new Date(h.at).toLocaleDateString()}</span>
                <span className="metric ow-row-cost">${h.cost.toFixed(3)}</span>
              </button>
            ))}
          </div>
          <p className="text-xs mt-3" style={{ color: "var(--cream-mute)" }}>
            Opening one is free — it is read back from disk, not watched again. Each is also in your
            Obsidian vault under <code>OmniWatch Channels</code>, which is where the agents read it from.
          </p>
        </div>
      )}

      {/* ── the scan itself ──────────────────────────────────────────────────── */}
      {poll && (
        <>
          <ScanProgress poll={poll} />
          {poll.state === "done" && (
            <button className="pill" style={{ cursor: "pointer" }}
              onClick={() => { setPoll(null); setListing(null); loadHistory(); }}>
              ← back
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ScanProgress({ poll }: { poll: Poll }) {
  const total = poll.total || 0;
  const done = poll.done || 0;
  const results = poll.results || [];
  const finished = poll.state === "done";

  return (
    <div className="space-y-4">
      <div className="panel p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="sidebar-section-label" style={{ margin: 0 }}>
            {finished ? "Scan finished" : poll.stage === "logging" ? "Writing to the vault" : "Watching"}
          </span>
          <span className="metric" style={{ color: "var(--gold-soft)" }}>
            {done}/{total}{typeof poll.cost === "number" ? ` · $${poll.cost.toFixed(3)}` : ""}
          </span>
        </div>

        <div className="ow-parts">
          {Array.from({ length: total }, (_, i) => (
            <i key={i} className={i < done ? "ok" : i === done && !finished ? "on" : ""} />
          ))}
        </div>

        {poll.current && (
          <div className="flex items-center gap-2 text-sm mt-3" style={{ color: "var(--cream-dim)" }}>
            <Loader2 size={13} className="animate-spin" /> {poll.current}
          </div>
        )}

        {finished && (
          <div className="flex flex-wrap gap-4 mt-3 metric" style={{ color: "var(--cream-dim)" }}>
            {/* A scan read back from disk must not claim to have spent anything now —
                the money was spent when it ran, and saying so again would double-count
                it in the only place anyone checks. */}
            {!poll.replay && <span>⏱ {poll.seconds}s</span>}
            <span>💰 ${(poll.cost || 0).toFixed(3)} {poll.replay ? "spent when this ran" : "actually spent"}</span>
            {poll.vault && (
              <span className="flex items-center gap-1.5" style={{ color: "var(--emerald)" }}>
                <FolderOpen size={12} /> saved to your vault
              </span>
            )}
          </div>
        )}
      </div>

      {results.map((r) => (
        <div key={r.url} className="panel p-4 md:p-5">
          <div className="flex gap-3 items-start pb-3 mb-4" style={{ borderBottom: "1px solid var(--line-soft)" }}>
            <h3 className="text-base font-semibold leading-snug flex-1 min-w-0" style={{ color: "var(--cream)" }}>
              {r.title}
            </h3>
            <a href={r.url} target="_blank" rel="noreferrer" className="pill flex-none flex items-center gap-1.5">
              <ExternalLink size={11} /> open
            </a>
          </div>
          {r.error
            ? <div className="text-sm" style={{ color: "var(--plum)" }}>⚠ {r.error}</div>
            : <OmniMarkdown text={r.text} />}
          {typeof r.cost === "number" && (
            <div className="metric mt-4 pt-3" style={{ borderTop: "1px solid var(--line-soft)", color: "var(--cream-dim)" }}>
              💰 ${r.cost.toFixed(3)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
