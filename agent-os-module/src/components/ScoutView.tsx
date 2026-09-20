"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Radar, Plus, X, Loader2, TrendingUp, Wrench, Clock, ArrowUpRight, Eye } from "lucide-react";
import OmniMarkdown from "./OmniMarkdown";
import "./OmniWatch.css";

// Scout — competitor research for the platforms Agent OS cannot see, plus the one
// thing nothing else here does: opening the video.
//
// Hermes Astros already sweeps YouTube, but it works from titles and view counts, and
// it is YouTube-only. TikTok, Reels, Instagram and X are invisible to all of it — which
// is the format this community actually posts. So Scout watches those platforms, and on
// YouTube it picks up where Astros stops: Astros says which video is hot, Scout opens it
// and comes back with the hook, the beats and a script for your own topic.

type Platform = "tiktok" | "instagram" | "x" | "youtube";
type SourceKind = "account" | "hashtag";
interface Source { id: string; kind: SourceKind; platform: Platform; handle: string }
interface Config { sources: Source[]; topic: string; teardowns: number; days: number; maxMinutes: number }
interface Candidate {
  url: string; platform: Platform; author: string; fans: number; plays: number;
  likes: number; comments: number; shares: number; postedAt?: string; caption?: string;
  score: number; why: string; engagement: number; source: string; duration?: number;
}
interface Teardown { url: string; title?: string; videoId?: string; text: string; cost?: number }
interface Run { subject?: string; at: string; sources: number; scanned: number; candidates: Candidate[]; teardowns: Teardown[]; note?: string }
interface Ready { key: boolean; ytDlp: boolean; ffmpeg: boolean; hermes: boolean; apify: boolean; apifyNeeded: boolean }
interface AstroTopic {
  topic: string; whyHot: string; heat: number | null; channel: string;
  title: string; url: string; views: string; age: string; watched: boolean;
}
/** One video Omni has watched on demand. */
interface Watched { url: string; title?: string; videoId?: string; text: string; running: boolean; error?: string }

const PLATFORMS: { value: Platform; label: string; tag: string; note?: string }[] = [
  { value: "tiktok", label: "TikTok", tag: "TT" },
  { value: "instagram", label: "Instagram", tag: "IG" },
  { value: "x", label: "X", tag: "X" },
  { value: "youtube", label: "YouTube", tag: "YT", note: "Astros already sweeps YouTube topics" },
];
const tagOf = (p: Platform) => PLATFORMS.find((x) => x.value === p)?.tag || p;

// The headings the teardown prompt asks for, so the script can be shown apart from the
// analysis. Scout always runs in English, which is why these are not read from i18n.
const SECTIONS: Record<string, string> = {
  hook: "The hook (first 3 seconds)",
  beats: "Beat by beat",
  edit: "Editing & pacing",
  text: "On-screen text",
  audio: "Sound & voice",
  cta: "Call to action",
  adapt: "Your version",
};

const short = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);

const ago = (iso: string) => {
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export default function ScoutView() {
  const [config, setConfig] = useState<Config | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [latest, setLatest] = useState<Run | null>(null);
  const [astros, setAstros] = useState<{ available: boolean; topics: AstroTopic[] } | null>(null);

  const [scanning, setScanning] = useState(false);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState<{ done?: number; total?: number; scanned?: number }>({});
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [watched, setWatched] = useState<Watched[]>([]);

  const [kind, setKind] = useState<SourceKind>("account");
  const [platform, setPlatform] = useState<Platform>("tiktok");
  const [handle, setHandle] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/omniwatch/scout", { cache: "no-store" }).then((x) => x.json());
    setConfig(r.config); setReady(r.ready); setLatest(r.latest);
  }, []);

  useEffect(() => {
    load();
    fetch("/api/omniwatch/scout/astros", { cache: "no-store" }).then((r) => r.json()).then(setAstros).catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  const saveConfig = useCallback(async (next: Config) => {
    setConfig(next);
    await fetch("/api/omniwatch/scout", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "config", config: next }),
    });
  }, []);

  const addSource = () => {
    if (!config || !handle.trim()) return;
    saveConfig({
      ...config,
      sources: [...config.sources, {
        id: Math.random().toString(36).slice(2, 9), kind, platform,
        handle: handle.replace(/^[@#]/, "").trim(),
      }],
    });
    setHandle("");
  };

  // Deliberately not called "watch": in Astros, WATCH opens the video for *you*. Here
  // the agent does the watching, so the label has to name who is doing it.
  const omniWatch = useCallback(async (url: string, title?: string) => {
    setWatched((w) => [{ url, title, text: "", running: true }, ...w.filter((x) => x.url !== url)]);
    const patch = (fn: (w: Watched) => Watched) =>
      setWatched((ws) => ws.map((w) => (w.url === url ? fn(w) : w)));

    let jobId = "";
    try {
      const res = await fetch("/api/omniwatch/jobs", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, q: config?.topic || "", mode: "teardown" }),
      });
      const body = await res.json();
      if (!res.ok || !body.id) { patch((w) => ({ ...w, running: false, error: body.error || "Could not start" })); return; }
      jobId = body.id;
    } catch {
      patch((w) => ({ ...w, running: false, error: "Could not reach the server" }));
      return;
    }

    const timer = setInterval(async () => {
      try {
        const r = await fetch(`/api/omniwatch/jobs?id=${jobId}`, { cache: "no-store" });
        if (r.status === 404) {
          clearInterval(timer);
          patch((w) => ({ ...w, running: false, error: "The dashboard restarted mid-run." }));
          return;
        }
        const d = await r.json();
        patch((w) => ({
          ...w,
          text: d.text || w.text,
          videoId: d.meta?.id || w.videoId,
          title: w.title || d.meta?.title,
        }));
        if (d.state === "done") {
          clearInterval(timer);
          patch((w) => ({ ...w, running: false }));
          // keep it: otherwise the result is gone on the next reload
          fetch("/api/omniwatch/scout", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "remember", url, title: title || d.meta?.title, videoId: d.meta?.id, text: d.text }),
          }).then(load).catch(() => {});
        }
        if (d.state === "error") { clearInterval(timer); patch((w) => ({ ...w, running: false, error: d.error })); }
      } catch { /* a dropped poll is not a failed job */ }
    }, 900);
  }, [config?.topic, load]);

  const scan = useCallback(async () => {
    if (scanning) return;
    setErr(null); setScanning(true); setStage("scraping"); setProgress({});
    const res = await fetch("/api/omniwatch/scout", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "scan" }),
    });
    const body = await res.json();
    if (!res.ok || !body.id) { setScanning(false); setErr(body.error || `Could not start (HTTP ${res.status})`); return; }

    pollRef.current = setInterval(async () => {
      const r = await fetch(`/api/omniwatch/scout?job=${body.id}`, { cache: "no-store" });
      if (r.status === 404) {
        if (pollRef.current) clearInterval(pollRef.current);
        setScanning(false); setErr("The dashboard restarted while the scan was running.");
        return;
      }
      const d = await r.json();
      if (d.stage) setStage(d.stage);
      setProgress({ done: d.done, total: d.total, scanned: d.scanned });
      if (d.state === "done" || d.state === "error") {
        if (pollRef.current) clearInterval(pollRef.current);
        setScanning(false);
        if (d.state === "error") setErr(d.error || "The scan failed");
        else { setLatest(d.run); load(); }
      }
    }, 1500);
  }, [scanning, load]);

  if (!config || !ready) {
    return <div className="flex items-center gap-2 text-sm" style={{ color: "var(--cream-dim)" }}>
      <Loader2 size={14} className="animate-spin" /> Loading…
    </div>;
  }

  // YouTube needs only yt-dlp, so Apify is demanded solely when the watchlist uses it.
  const blocked = !ready.key || (ready.apifyNeeded && (!ready.hermes || !ready.apify));
  const platformNote = PLATFORMS.find((p) => p.value === platform)?.note;

  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed" style={{ color: "var(--cream-soft)" }}>
        <b style={{ color: "var(--cream)" }}>Astros reads YouTube titles. This opens the video.</b>{" "}
        Point it at the accounts and hashtags winning in your niche — including TikTok, Reels and X, which
        nothing else here can see — and Omni watches what outperformed: the hook, the beats, the editing and
        the on-screen text, written back as a script for your own topic.
      </p>

      {blocked && <Setup ready={ready} onDone={load} />}

      {astros?.available && astros.topics.length > 0 && (
        <div className="panel p-4 md:p-5">
          <div className="sidebar-section-label mb-1">From Hermes Astros</div>
          <p className="text-xs mb-3" style={{ color: "var(--cream-mute)" }}>
            Astros found these on YouTube from their titles and view counts. It cannot open a video — that is
            this part.
          </p>
          <div className="space-y-1">
            {astros.topics.slice(0, 6).map((t) => (
              <div key={t.url} className="flex flex-wrap gap-3 items-center py-2" style={{ borderBottom: "1px solid var(--line-deep)" }}>
                <div className="min-w-0 flex-1">
                  <div className="text-sm" style={{ color: "var(--cream)" }}>{t.title || t.topic}</div>
                  <div className="text-xs" style={{ color: "var(--cream-mute)" }}>
                    {[t.channel, t.views, t.age].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <a href={t.url} target="_blank" rel="noreferrer" className="pill flex items-center gap-1 flex-none"
                  title="Opens YouTube so you can watch it yourself">
                  you watch it <ArrowUpRight size={10} />
                </a>
                <button
                  onClick={() => omniWatch(t.url, t.title)}
                  disabled={blocked}
                  className="pill pill-warn flex items-center gap-1 flex-none disabled:opacity-40"
                  style={{ cursor: blocked ? "default" : "pointer" }}
                  title="Omni watches every frame and writes the formula"
                >
                  <Eye size={11} /> Omni watches it
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="panel p-4 md:p-5">
        <div className="flex items-center justify-between mb-1">
          <span className="sidebar-section-label" style={{ margin: 0 }}>Who you are watching</span>
          <button
            onClick={scan}
            disabled={scanning || blocked || !config.sources.length}
            className="pill pill-warn flex items-center gap-1.5 disabled:opacity-40"
            style={{ cursor: scanning || blocked || !config.sources.length ? "default" : "pointer" }}
          >
            {scanning ? <Loader2 size={12} className="animate-spin" /> : <Radar size={12} />}
            {scanning ? stageLabel(stage, progress) : "Scan now"}
          </button>
        </div>
        <p className="text-xs mb-3" style={{ color: "var(--cream-mute)" }}>
          TikTok, Instagram and X are invisible to the rest of Agent OS — this is the only place they are watched.
        </p>

        <div className="flex flex-wrap gap-2 mb-3">
          {config.sources.map((s) => (
            <span key={s.id} className="pill flex items-center gap-1.5">
              <span style={{ color: "var(--cream-mute)" }}>{tagOf(s.platform)}</span>
              {s.kind === "hashtag" ? "#" : "@"}{s.handle}
              <X size={11} style={{ cursor: "pointer" }}
                onClick={() => saveConfig({ ...config, sources: config.sources.filter((x) => x.id !== s.id) })} />
            </span>
          ))}
          {!config.sources.length && (
            <span className="text-sm" style={{ color: "var(--cream-mute)" }}>
              Nothing yet. Add the accounts that keep beating you, and a hashtag or two from your niche.
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)} className="pill bg-transparent outline-none cursor-pointer">
            {PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <select value={kind} onChange={(e) => setKind(e.target.value as SourceKind)} className="pill bg-transparent outline-none cursor-pointer">
            <option value="account">account</option>
            <option value="hashtag">hashtag</option>
          </select>
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addSource(); }}
            placeholder={kind === "account" ? "handle, without @" : "hashtag or subject"}
            className="bg-transparent outline-none text-sm flex-1 px-2 py-1"
            style={{ color: "var(--cream)", borderBottom: "1px solid var(--line-soft)", minWidth: 140 }}
          />
          <button onClick={addSource} className="pill flex items-center gap-1" style={{ cursor: "pointer" }}>
            <Plus size={11} /> add
          </button>
        </div>
        {platformNote && (
          <p className="text-xs mt-2" style={{ color: "var(--cream-mute)" }}>
            {platformNote} — adding it here costs nothing and gets the video opened.
          </p>
        )}

        <div className="mt-4 pt-3" style={{ borderTop: "1px solid var(--line-soft)" }}>
          <label className="block text-xs mb-1" style={{ color: "var(--cream-dim)" }}>
            What <b style={{ color: "var(--cream)" }}>your</b> videos are about
          </label>
          <input
            value={config.topic}
            onChange={(e) => setConfig({ ...config, topic: e.target.value })}
            onBlur={() => saveConfig(config)}
            placeholder="e.g. AI automation for plumbers, faceless finance shorts, agency lead gen…"
            className="bg-transparent outline-none text-sm px-2 py-1.5 w-full"
            style={{ color: "var(--cream)", borderBottom: "1px solid var(--line-soft)" }}
          />
          <p className="text-xs mt-1" style={{ color: "var(--cream-mute)" }}>
            Every script comes back rewritten for this. Leave it empty and you only get the analysis.
          </p>
        </div>

        <div className="flex flex-wrap gap-4 items-center mt-3 pt-3 text-xs" style={{ borderTop: "1px solid var(--line-soft)", color: "var(--cream-dim)" }}>
          <label className="flex items-center gap-2">
            write
            <Num value={config.teardowns} min={1} max={8} onChange={(v) => setConfig({ ...config, teardowns: v })} onBlur={() => saveConfig(config)} />
            scripts per scan
          </label>
          <label className="flex items-center gap-2">
            skip over
            <Num value={config.maxMinutes} min={1} max={120} onChange={(v) => setConfig({ ...config, maxMinutes: v })} onBlur={() => saveConfig(config)} />
            min long
          </label>
          <label className="flex items-center gap-2">
            last
            <Num value={config.days} min={1} max={90} onChange={(v) => setConfig({ ...config, days: v })} onBlur={() => saveConfig(config)} />
            days
          </label>
        </div>
      </div>

      {err && <div className="panel p-4 text-sm" style={{ color: "var(--plum)" }}>⚠ {err}</div>}

      {/* Once a result is stored it renders from `latest` below, so drop the local copy. */}
      {watched.filter((w) => w.running || w.error || !latest?.teardowns.some((t) => t.url === w.url)).map((w) => (
        <Result key={`w-${w.url}`} url={w.url} title={w.title} videoId={w.videoId} text={w.text}
          running={w.running} error={w.error} why="" open={open === w.url}
          onToggle={() => setOpen(open === w.url ? null : w.url)} />
      ))}

      {latest && (
        <>
          <div className="flex flex-wrap items-center gap-4 text-xs" style={{ color: "var(--cream-dim)" }}>
            <span className="flex items-center gap-1.5"><Clock size={12} /> last scan {ago(latest.at)}</span>
            <span>{latest.scanned} videos looked at</span>
            <span>{latest.teardowns.length} torn down</span>
            {latest.note && <span style={{ color: "var(--cream-mute)" }}>{latest.note}</span>}
          </div>

          {latest.teardowns.map((t) => {
            const c = latest.candidates.find((x) => x.url === t.url);
            return (
              <Result key={t.url} url={t.url} title={t.title} videoId={t.videoId} text={t.text}
                running={false} why={c ? `${c.why} · @${c.author}` : ""} open={open === t.url}
                onToggle={() => setOpen(open === t.url ? null : t.url)} />
            );
          })}

          {latest.candidates.length > 0 && (
            <div className="panel p-4 md:p-5">
              <div className="sidebar-section-label mb-1">Also outperformed</div>
              <p className="text-xs mb-3" style={{ color: "var(--cream-mute)" }}>
                These beat their baseline too. Nothing has opened them yet — pick any one.
              </p>
              <div className="space-y-1">
                {latest.candidates
                  .filter((c) => !latest.teardowns.some((t) => t.url === c.url))
                  .slice(0, 15)
                  .map((c) => (
                    <div key={c.url} className="flex flex-wrap gap-3 items-center py-1.5 text-sm" style={{ borderBottom: "1px solid var(--line-deep)" }}>
                      <span className="metric flex-none" style={{ color: "var(--gold)", minWidth: 50 }}>
                        {c.score >= 1 ? `${c.score.toFixed(1)}×` : `${(c.score * 100).toFixed(0)}%`}
                      </span>
                      <div className="min-w-0 flex-1">
                        <a href={c.url} target="_blank" rel="noreferrer" style={{ color: "var(--cream)" }}>@{c.author}</a>
                        <span style={{ color: "var(--cream-mute)" }}> · {c.why}</span>
                        {c.caption && <div className="text-xs truncate" style={{ color: "var(--cream-dim)" }}>{c.caption}</div>}
                      </div>
                      <span className="metric flex-none" style={{ color: "var(--cream-dim)" }}>
                        <TrendingUp size={10} className="inline" /> {short(c.plays)}
                      </span>
                      <button
                        onClick={() => omniWatch(c.url, c.caption)}
                        className="pill flex items-center gap-1 flex-none"
                        style={{ cursor: "pointer" }}
                        title="Omni watches every frame and writes the formula"
                      >
                        <Eye size={11} /> Omni watches it
                      </button>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}

      {!latest && !watched.length && !blocked && (
        <div className="panel p-5 text-sm" style={{ color: "var(--cream-soft)" }}>
          Nothing watched yet. Add the accounts that keep beating you, say what your own videos are about, and
          press <b style={{ color: "var(--cream)" }}>Scan now</b> — or pick any video above and let Omni watch it.
          YouTube costs nothing to scan; TikTok, Instagram and X go through Apify at roughly 34 cents per 200 videos.
        </div>
      )}

      <Cron enabled={!blocked} />
    </div>
  );
}

function Num({ value, min, max, onChange, onBlur }: {
  value: number; min: number; max: number; onChange: (v: number) => void; onBlur: () => void;
}) {
  return (
    <input
      type="number" min={min} max={max} value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      onBlur={onBlur}
      className="bg-transparent outline-none text-xs w-12 px-1"
      style={{ color: "var(--cream)", borderBottom: "1px solid var(--line-soft)" }}
    />
  );
}

/** One watched video: the player, the script, and the analysis behind a toggle. */
function Result({ url, title, videoId, text, running, error, why, open, onToggle }: {
  url: string; title?: string; videoId?: string; text: string; running: boolean;
  error?: string; why: string; open: boolean; onToggle: () => void;
}) {
  return (
    <div className="panel p-4 md:p-5">
      <div className="flex gap-3 items-start mb-3">
        <span className="pill pill-warn flex-none"><Wrench size={12} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold" style={{ color: "var(--cream)" }}>{title || url}</div>
          {why && <div className="text-xs mt-0.5" style={{ color: "var(--gold)" }}>{why}</div>}
          <a href={url} target="_blank" rel="noreferrer" className="text-xs flex items-center gap-1 mt-0.5" style={{ color: "var(--cream-mute)" }}>
            you watch it <ArrowUpRight size={10} />
          </a>
        </div>
        {running && <Loader2 size={14} className="animate-spin flex-none" style={{ color: "var(--gold)" }} />}
      </div>

      {videoId && (
        <video
          src={`/api/omniwatch/media/video/${videoId}`}
          controls preload="metadata" playsInline
          className="w-full rounded-lg bg-black mb-3"
          style={{ maxWidth: 340, aspectRatio: "16/9" }}
        />
      )}

      {error ? (
        <div className="text-sm" style={{ color: "var(--plum)" }}>⚠ {error}</div>
      ) : !text ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: "var(--cream-dim)" }}>
          <Loader2 size={13} className="animate-spin" /> Omni is watching it…
        </div>
      ) : (
        // The headline used to be a "FILM THIS" script for your own topic. That section is
        // gone from the prompt — it was a beat-for-beat rewrite of someone else's video —
        // so what is left is the thing worth reading: how theirs is built.
        <>
          <button onClick={onToggle} className="pill" style={{ cursor: "pointer" }}>
            {open ? "hide how it is made" : "how it is made"}
          </button>
          {open && (
            <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--line-soft)" }}>
              <OmniMarkdown text={text} sections={SECTIONS} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function stageLabel(stage: string, p: { done?: number; total?: number }) {
  if (stage === "scraping") return "Scraping…";
  if (stage === "ranking") return "Ranking…";
  if (stage === "watching") return `Watching ${(p.done ?? 0) + 1}/${p.total ?? "?"}…`;
  return "Working…";
}

function Setup({ ready, onDone }: { ready: Ready; onDone: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const install = async () => {
    setBusy(true); setProblem(null);
    try {
      const r = await fetch("/api/omniwatch/scout/setup", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) setProblem(d.error || "Setup did not finish.");
      else { setToken(""); onDone(); }
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Could not reach the server");
    } finally { setBusy(false); }
  };

  return (
    <div className="panel p-5">
      <div className="flex flex-wrap gap-4 text-sm mb-4">
        <span><span className={`status-dot ${ready.key ? "ok" : "err"}`} /> Qwen key</span>
        <span><span className={`status-dot ${ready.hermes ? "ok" : "err"}`} /> Hermes</span>
        <span><span className={`status-dot ${ready.apify ? "ok" : "err"}`} /> Apify</span>
      </div>

      {!ready.key && (
        <p className="text-sm mb-3" style={{ color: "var(--cream-soft)" }}>
          The Qwen key is the same one the OmniWatch tab uses — set it up there first.
        </p>
      )}

      {!ready.hermes && (
        <p className="text-sm" style={{ color: "var(--cream-soft)" }}>
          Hermes is not on this machine. Scout needs it for TikTok, Instagram and X — it is the agent that does
          the scraping. YouTube works without it.
        </p>
      )}

      {ready.hermes && !ready.apify && (
        <>
          <p className="text-sm mb-3" style={{ color: "var(--cream-soft)" }}>
            TikTok, Instagram and X are read through <b style={{ color: "var(--cream)" }}>Apify</b>. Make a free
            account at <a href="https://apify.com" target="_blank" rel="noreferrer" style={{ color: "var(--gold)" }}>apify.com</a>,
            open <b style={{ color: "var(--cream)" }}>Settings → API &amp; Integrations</b>, copy the token and
            paste it here. Everything else is handled for you.
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <input
              type="password" value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && token.trim()) install(); }}
              placeholder="apify_api_…"
              className="bg-transparent outline-none text-sm px-2 py-1.5 flex-1"
              style={{ color: "var(--cream)", borderBottom: "1px solid var(--line-soft)", minWidth: 240 }}
            />
            <button onClick={install} disabled={busy || !token.trim()}
              className="pill pill-warn flex items-center gap-1.5 disabled:opacity-40"
              style={{ cursor: busy || !token.trim() ? "default" : "pointer" }}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              {busy ? "Setting it up…" : "Connect Apify"}
            </button>
          </div>
          {problem && <p className="text-sm mt-3" style={{ color: "var(--plum)" }}>⚠ {problem}</p>}
          <p className="text-xs mt-3" style={{ color: "var(--cream-mute)" }}>
            The token stays on this machine. Finding videos costs about $1.70 per 1000 on Apify — Scout only ever
            reads their numbers, never the paid video downloads.
          </p>
        </>
      )}
    </div>
  );
}

interface Schedule {
  scheduled: boolean; every: string; display?: string;
  lastRun?: string | null; nextRun?: string | null; deliver?: string | null;
  presets: { every: string; label: string }[];
}

/** The schedule as a control: nobody should have to know what a cron expression is. */
function Cron({ enabled }: { enabled: boolean }) {
  const [s, setS] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/omniwatch/scout/schedule", { cache: "no-store" })
      .then((r) => r.json()).then(setS).catch(() => {});
  }, []);

  const change = async (every: string, deliver?: string) => {
    setBusy(true); setProblem(null);
    try {
      const r = await fetch("/api/omniwatch/scout/schedule", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ every, deliver: deliver ?? s?.deliver ?? "local" }),
      });
      const d = await r.json();
      if (!r.ok) setProblem(d.error || "Could not change the schedule.");
      else setS(d);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Could not reach the server");
    } finally { setBusy(false); }
  };

  if (!s) return null;
  const current = s.presets.find((p) => p.every === s.every)?.label || s.display;

  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2 mb-3">
        <Clock size={14} style={{ color: "var(--gold)" }} />
        <span className="sidebar-section-label" style={{ margin: 0 }}>Scan on its own</span>
        {busy && <Loader2 size={12} className="animate-spin" style={{ color: "var(--gold)" }} />}
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <button onClick={() => change("off")} disabled={busy}
          className={`pill ${!s.scheduled ? "pill-warn" : ""}`}
          style={{ cursor: busy ? "default" : "pointer" }}>off</button>
        {s.presets.map((p) => (
          <button key={p.every} onClick={() => change(p.every)} disabled={busy || !enabled}
            className={`pill ${s.scheduled && s.every === p.every ? "pill-warn" : ""} disabled:opacity-40`}
            style={{ cursor: busy || !enabled ? "default" : "pointer" }}>{p.label}</button>
        ))}
        {s.scheduled && (
          <select value={s.deliver || "local"} onChange={(e) => change(s.every, e.target.value)} disabled={busy}
            className="pill bg-transparent outline-none cursor-pointer ml-auto" title="Where the digest goes">
            <option value="local">keep it here</option>
            <option value="telegram">send to Telegram</option>
            <option value="discord">send to Discord</option>
            <option value="signal">send to Signal</option>
          </select>
        )}
      </div>

      {problem && <p className="text-sm mt-3" style={{ color: "var(--plum)" }}>⚠ {problem}</p>}

      <p className="text-xs mt-3" style={{ color: "var(--cream-mute)" }}>
        {s.scheduled
          ? `Hermes runs it ${current}. You only hear from it when something actually beat its baseline.`
          : enabled
            ? "Scout only runs when you press Scan. Pick an interval and Hermes will do it without you."
            : "Finish the setup above, then Scout can run on its own."}
      </p>
    </div>
  );
}
