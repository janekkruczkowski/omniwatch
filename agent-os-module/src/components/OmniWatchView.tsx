"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, Wrench, Link2, Loader2, Play, KeyRound, TerminalSquare, ArrowRight, Users, Clapperboard } from "lucide-react";
import OmniMarkdown, { TS_RE, toSec } from "./OmniMarkdown";
import ChannelScan from "./ChannelScan";
import "./OmniWatch.css";

// OmniWatch — paste a link, Qwen Omni watches the video (picture AND sound) and
// answers with timestamps plus the real frames as evidence.
//
// Ask mode answers a question about the video. Teardown mode explains how the video
// is MADE — hook, beat by beat, editing, on-screen text, CTA. Teardown is the one you
// point at a competitor.
//
// Channel mode is the same teardown aimed at a whole account instead of one link: it
// lists what the account published, prices it, and watches the ones you pick. It lives
// here rather than in a tab of its own because it is the same question — how is this
// made — asked of more than one video, and because a scan you trigger yourself belongs
// where you are already standing. Scans that run on a schedule belong to Hermes, which
// is where the scheduler is.

interface Status {
  ready: boolean; key: boolean; ytDlp: boolean; ffmpeg: boolean;
  defaultLang: string; langs: { code: string; name: string }[];
}
interface Meta { id: string; title: string; channel: string; duration: string; seconds: number; strip: number[] }
/** What one poll of a job returns while it is still running. */
interface Progress {
  stage?: string; meta?: Meta; parts?: number; partsDone?: number;
  fps?: number; reused?: boolean; text?: string;
}
interface Stats { seconds: number; tokens: number; parts: number; reused: boolean; cost: number }
interface Card { id: number; q: string; mode: "ask" | "teardown"; text: string; stats?: Stats; error?: string }
/** What the tab is doing. The first two are jobs the engine understands; "channel" is
 *  this tab pointed at an account, and never reaches the single-video job. */
type UiMode = "ask" | "teardown" | "channel";

type Locale = { name: string; sections: Record<string, string>; ui: Record<string, string | string[]> };

const STEPS = ["download", "upload", "watch", "answer"] as const;

const fmt = (s: number) => {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
};

export default function OmniWatchView() {
  const [status, setStatus] = useState<Status | null>(null);
  const [i18n, setI18n] = useState<Record<string, Locale> | null>(null);
  const [lang, setLang] = useState("en");
  const [mode, setMode] = useState<UiMode>("teardown");
  const [url, setUrl] = useState("");
  const [question, setQuestion] = useState("");
  const [followUp, setFollowUp] = useState("");

  const [running, setRunning] = useState(false);
  const [step, setStep] = useState<string>("");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [fps, setFps] = useState(0);
  const [parts, setParts] = useState(0);
  const [partsDone, setPartsDone] = useState(0);
  const [reused, setReused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [cards, setCards] = useState<Card[]>([]);
  const [hits, setHits] = useState<number[]>([]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cardId = useRef(0);

  const T = useMemo(() => (i18n ? (i18n[lang] || i18n.en) : null), [i18n, lang]);

  useEffect(() => {
    // Agent OS is an English dashboard, so there is no language picker here. The
    // answers follow OMNI_LANG if someone sets it; the translations still drive the
    // section headings the prompt asks for and the styling keys off.
    fetch("/api/omniwatch/status").then((r) => r.json()).then((s: Status) => {
      setStatus(s);
      setLang(s.defaultLang || "en");
    }).catch(() => setStatus({ ready: false, key: false, ytDlp: false, ffmpeg: false, defaultLang: "en", langs: [] }));
    fetch("/api/omniwatch/i18n").then((r) => r.json()).then(setI18n).catch(() => {});
  }, []);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  const frame = useCallback((sec: number) => meta ? `/api/omniwatch/media/frame/${meta.id}/${Math.max(0, Math.floor(sec))}` : "", [meta]);

  const seek = useCallback((sec: number) => {
    const p = playerRef.current;
    if (!p) return;
    p.currentTime = sec;
    p.play().catch(() => {});
    p.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  // Start the job, then poll it. Nothing holds an HTTP request open for the minutes
  // this takes, so reloading the tab mid-run does not kill the work.
  const ask = useCallback(async (q: string, target?: string, force?: "ask" | "teardown") => {
    const link = (target ?? url).trim();
    if (!link || pollRef.current) return;
    // Follow-ups are always questions. `force` exists for callers that cannot wait for
    // setMode to land — the deep link from Astros arrives and runs in the same tick.
    const runMode: "ask" | "teardown" =
      force ?? (cards.length > 0 ? "ask" : mode === "teardown" ? "teardown" : "ask");
    const id = ++cardId.current;
    setCards((c) => [{ id, q: q.trim(), mode: runMode, text: "" }, ...c]);
    setRunning(true); setStep("download"); setParts(0); setPartsDone(0); setReused(false); setHits([]); setFollowUp("");

    const t0 = Date.now();
    setElapsed(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setElapsed((Date.now() - t0) / 1000), 100);

    const patch = (fn: (c: Card) => Card) => setCards((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));
    const finish = () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setRunning(false);
    };
    const fail = (message: string) => { finish(); patch((c) => ({ ...c, error: message })); };

    let started: { id: string };
    try {
      const res = await fetch("/api/omniwatch/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: link, q: q.trim(), lang, mode: runMode }),
      });
      const body = await res.json();
      if (!res.ok || !body.id) return fail(body.error || `Could not start (HTTP ${res.status})`);
      started = body;
    } catch (e) {
      return fail(e instanceof Error ? e.message : "Could not reach the server");
    }

    pollRef.current = setInterval(async () => {
      let d: Progress & { state: string; error?: string } & Partial<Stats>;
      try {
        const r = await fetch(`/api/omniwatch/jobs?id=${started.id}`, { cache: "no-store" });
        if (r.status === 404) return fail("The dashboard restarted while this was running. Ask again — the video is cached, so it will be quick.");
        d = await r.json();
      } catch { return; } // a dropped poll is not a failed job; the next tick retries
      if (d.meta) setMeta(d.meta);
      if (d.stage) setStep(d.stage === "merge" ? "watch" : d.stage);
      if (d.fps) setFps(d.fps);
      if (typeof d.parts === "number") setParts(d.parts);
      if (typeof d.partsDone === "number") setPartsDone(d.partsDone);
      if (typeof d.reused === "boolean") setReused(d.reused);
      if (d.text) patch((c) => ({ ...c, text: d.text as string }));

      if (d.state === "done") {
        finish(); setStep("end");
        setHits([...(d.text || "").matchAll(TS_RE)].map((m) => toSec(m[1])));
        patch((c) => ({ ...c, stats: d as Stats }));
      } else if (d.state === "error") {
        fail(d.error || "The run failed");
      }
    }, 700);
  }, [url, mode, lang, cards.length]);

  // ── handed a video by another tab ────────────────────────────────────────────
  // Astros finds what competitors published but works from titles, so its row of
  // actions ends with a chip that sends the video here: /omniwatch?url=…
  // Clicking that chip already means "watch it", so this starts on arrival rather
  // than leaving a filled-in box and a second button to press. The parameter is
  // dropped from the address afterwards: a reload would otherwise pay for the same
  // run again, and the cache only saves the upload, not the answer.
  const handedOver = useRef(false);
  useEffect(() => {
    if (handedOver.current || !status?.ready) return;
    const link = (new URLSearchParams(window.location.search).get("url") || "").trim();
    if (!/^https?:\/\//i.test(link)) return;
    handedOver.current = true;
    setUrl(link);
    setMode("teardown");
    window.history.replaceState(null, "", window.location.pathname);
    // Forced, because setMode above has not landed yet and the chip means "take this
    // one apart" — not whatever mode the tab happened to be left in.
    ask("", link, "teardown");
  }, [status, ask]);

  // ── onboarding ───────────────────────────────────────────────────────────────
  if (status && !status.ready) return <Onboarding status={status} />;

  const started = cards.length > 0 || running;
  const ui = T?.ui as Record<string, string> | undefined;
  const examples = (T?.ui.examples as string[]) || [];

  const modes = (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={() => setMode("teardown")}
        className={`pill ${mode === "teardown" ? "pill-warn" : ""} flex items-center gap-1.5`}
      >
        <Wrench size={12} /> {ui?.modeTeardown || "Teardown"}
      </button>
      <button
        onClick={() => setMode("ask")}
        className={`pill ${mode === "ask" ? "pill-warn" : ""} flex items-center gap-1.5`}
      >
        <Eye size={12} /> {ui?.modeAsk || "Ask"}
      </button>
      <button
        onClick={() => setMode("channel")}
        className={`pill ${mode === "channel" ? "pill-warn" : ""} flex items-center gap-1.5`}
        title="Point it at a whole account instead of one video"
      >
        <Users size={12} /> {ui?.modeChannel || "Whole channel"}
      </button>
    </div>
  );

  // Same tab, aimed at an account rather than a link. The mode row stays put so it is
  // one switch away from the single-video box, not a different place to go.
  if (mode === "channel") {
    return (
      <div className="space-y-5">
        <div className="panel p-4 md:p-5">{modes}</div>
        <ChannelScan lang={lang} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* the ask box */}
      <div className="panel p-4 md:p-5">
        <div className="mb-3">{modes}</div>

        <div className="flex items-center gap-2 pb-3 mb-3" style={{ borderBottom: "1px solid var(--line-soft)" }}>
          <Link2 size={15} style={{ color: "var(--cream-mute)", flex: "none" }} />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={ui?.urlPlaceholder || "YouTube, TikTok, Instagram, Facebook, X…"}
            className="flex-1 bg-transparent outline-none text-sm min-w-0"
            style={{ color: "var(--cream)" }}
          />
        </div>

        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(question); } }}
          rows={2}
          placeholder={mode === "teardown"
            ? (ui?.teardownPlaceholder || "What you are about to film (optional) — what transfers, what does not")
            : (ui?.questionPlaceholder || "What do you want to ask this video?")}
          className="w-full bg-transparent outline-none resize-none text-base font-medium"
          style={{ color: "var(--cream)" }}
        />

        <div className="flex items-center justify-between gap-3 mt-2">
          <span className="text-xs" style={{ color: "var(--cream-mute)" }}>
            {mode === "teardown"
              ? "Any video whose format you want to reproduce · topic optional · ⌘↵ to send"
              : (ui?.hint || "Empty question = full summary · ⌘↵ to send")}
          </span>
          <button
            onClick={() => ask(question)}
            disabled={running || !url.trim()}
            className="pill pill-warn flex items-center gap-1.5 disabled:opacity-40"
            style={{ cursor: running || !url.trim() ? "default" : "pointer" }}
          >
            {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            {mode === "teardown" ? (ui?.teardownSubmit || "Take it apart →") : (ui?.submit || "Watch it & answer →")}
          </button>
        </div>

        {!started && mode === "ask" && examples.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {examples.map((ex) => (
              <button key={ex} onClick={() => setQuestion(ex)} className="pill" style={{ cursor: "pointer" }}>{ex}</button>
            ))}
          </div>
        )}
      </div>

      {started && (
        <div className="grid gap-5" style={{ gridTemplateColumns: "minmax(0,380px) minmax(0,1fr)" }}>
          <div className="space-y-4">
            {meta && (
              <div className="panel p-3">
                <video
                  ref={playerRef}
                  src={`/api/omniwatch/media/video/${meta.id}`}
                  controls preload="metadata" playsInline
                  className="w-full rounded-lg bg-black"
                  style={{ aspectRatio: "16/9" }}
                />
                <h2 className="text-sm mt-3 mb-1 leading-snug" style={{ color: "var(--cream)" }}>{meta.title}</h2>
                <div className="text-xs" style={{ color: "var(--cream-dim)" }}>{meta.channel} · {meta.duration}</div>
              </div>
            )}

            <div className="panel p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="sidebar-section-label">{ui?.progress || "Progress"}</span>
                <span className="metric" style={{ color: "var(--gold-soft)" }}>{elapsed.toFixed(1)}s</span>
              </div>
              <div className="ow-steps">
                {STEPS.map((s) => {
                  const cur = step === "end" ? 99 : STEPS.indexOf(step as typeof STEPS[number]);
                  const i = STEPS.indexOf(s);
                  const cls = i < cur ? "done" : i === cur ? "active" : "";
                  const label =
                    s === "download" ? (ui?.stepDownload || "Downloading (yt-dlp)")
                      : s === "upload" ? (ui?.stepUpload || "Sending to Qwen")
                        : s === "watch" ? (parts > 1
                          ? (ui?.stepWatchMany || "Omni watches {n} parts").replace("{n}", String(parts))
                          : (ui?.stepWatchOne || "Omni watches the whole video"))
                          : (ui?.stepAnswer || "Writing the answer");
                  const note =
                    s === "upload" && reused ? (ui?.cached || "cached")
                      : s === "watch" && fps ? `${fps} fps`
                        : s === "watch" && parts > 1 ? `${partsDone}/${parts}` : "";
                  return <div key={s} className={`ow-step ${cls}`}><i />{label}<small>{note}</small></div>;
                })}
              </div>
              {parts > 1 && (
                <div className="ow-parts">
                  {Array.from({ length: parts }, (_, i) => <i key={i} className={i < partsDone ? "ok" : "on"} />)}
                </div>
              )}
            </div>

            {meta && meta.strip?.length > 0 && (
              <div className="panel p-4">
                <div className="sidebar-section-label mb-3">{ui?.filmstrip || "Video timeline"}</div>
                <div className={`ow-strip ${step === "watch" ? "scanning" : ""}`}>
                  {meta.strip.map((t, i) => {
                    const span = meta.seconds / meta.strip.length;
                    const hit = hits.find((h) => h >= i * span && h < (i + 1) * span);
                    const at = hit ?? t;
                    return (
                      <div key={i} className={`ow-clip ${hit !== undefined ? "hit" : ""}`} onClick={() => seek(at)}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={frame(hit !== undefined ? at + 1 : t)} alt="" loading="lazy" />
                        <span>{fmt(at)}</span>
                      </div>
                    );
                  })}
                </div>
                {hits.length > 0 && (
                  <div className="text-xs mt-3" style={{ color: "var(--cream-mute)" }}>
                    <b style={{ color: "var(--gold)" }}>★</b> moments the answer cites · click to jump
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-4 min-w-0">
            {cards.length > 0 && !running && (
              <div className="panel p-4">
                <div className="sidebar-section-label mb-2">{ui?.followTitle || "Ask something else about this video"}</div>
                <div className="flex gap-2 items-end">
                  <textarea
                    value={followUp}
                    onChange={(e) => setFollowUp(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(followUp); } }}
                    rows={1}
                    placeholder={ui?.followPlaceholder || "Next question…"}
                    className="flex-1 bg-transparent outline-none resize-none text-sm"
                    style={{ color: "var(--cream)" }}
                  />
                  <button onClick={() => ask(followUp)} className="pill pill-warn" style={{ cursor: "pointer" }}>
                    {ui?.followSubmit || "Ask →"}
                  </button>
                </div>
              </div>
            )}

            {cards.map((c) => (
              <Answer
                key={c.id} card={c} locale={T} onSeek={seek} frame={frame}
                running={running && c.id === cardId.current}
                source={meta ? { url, title: meta.title, seconds: meta.seconds, lang } : null}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── one question and its answer ────────────────────────────────────────────────
function Answer({ card, locale, onSeek, frame, running, source }: {
  card: Card; locale: Locale | null; onSeek: (s: number) => void; frame: (s: number) => string; running: boolean;
  /** what was watched — needed to build a brief from this answer, absent while a job is
   *  still finding out what the video even is */
  source: { url: string; title: string; seconds: number; lang: string } | null;
}) {
  const sec = locale?.sections || {};
  const ui = (locale?.ui || {}) as Record<string, string>;

  const title = card.mode === "teardown"
    ? `${ui.teardownCard || "Teardown: how this video is made"}${card.q ? ` — ${card.q}` : ""}`
    : card.q || (ui.summaryCard || "Full summary of the video");

  return (
    <div className="panel p-4 md:p-5">
      <div className="flex gap-3 items-start pb-3 mb-4" style={{ borderBottom: "1px solid var(--line-soft)" }}>
        <span className="pill pill-warn flex-none">{card.mode === "teardown" ? <Wrench size={12} /> : <Eye size={12} />}</span>
        <h2 className="text-base font-semibold leading-snug" style={{ color: "var(--cream)" }}>{title}</h2>
      </div>

      {card.error ? (
        <div className="text-sm" style={{ color: "var(--plum)", whiteSpace: "pre-wrap" }}>⚠ {card.error}</div>
      ) : !card.text ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: "var(--cream-dim)" }}>
          <Loader2 size={14} className="animate-spin" /> {ui.pendingDownload || "Downloading the video…"}
        </div>
      ) : (
        <>
          <OmniMarkdown
            text={card.text}
            sections={sec}
            onSeek={onSeek}
            frame={frame}
            badges={{ frames: ui.badgeFrames || "FRAMES FROM THE VIDEO", visual: ui.badgeVisual || "ON SCREEN ONLY" }}
          />
          {running && <Loader2 size={13} className="animate-spin inline-block mt-2" style={{ color: "var(--gold)" }} />}
        </>
      )}

      {card.stats && (
        <div className="flex flex-wrap gap-4 mt-4 pt-3 metric" style={{ borderTop: "1px solid var(--line-soft)", color: "var(--cream-dim)" }}>
          <span>⏱ {card.stats.seconds}s</span>
          {card.stats.parts > 1 && <span>🎞 {card.stats.parts} parts</span>}
          <span>💰 ${card.stats.cost.toFixed(3)} · {(card.stats.tokens / 1000).toFixed(0)}k tokens</span>
          {card.stats.reused && <span>♻️ video already at Qwen</span>}
        </div>
      )}

      {/* Only under a teardown: a summary tells you what a video says, and you cannot
          rebuild the shape of something from what it says. */}
      {card.text && !card.error && card.mode === "teardown" && source && (
        <MakeSimilar card={card} source={source} ui={ui} />
      )}
    </div>
  );
}

// ── from watching to building ──────────────────────────────────────────────────
//
// The point where the two halves of the product finally touch. What it hands over is
// the RHYTHM — how many shots, how long each holds — and nothing else. The subject is
// typed here, by the person, and the box will not submit without it: a brief with no
// subject of its own is the other person's video with the serial numbers filed off,
// and the "Your version" section was deleted from this module for being exactly that.
function MakeSimilar({ card, source, ui }: {
  card: Card;
  source: { url: string; title: string; seconds: number; lang: string };
  ui: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<"avatar" | "voiceover">("avatar");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const go = async () => {
    if (!topic.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/omniwatch/recreate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: source.url, title: source.title, seconds: source.seconds,
          text: card.text, topic, mode, lang: source.lang,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.next) throw new Error(j.error || "Could not build the brief.");
      window.location.href = j.next;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="pill pill-warn mt-4"
        style={{ cursor: "pointer" }}
      >
        <Clapperboard size={12} /> {ui.makeSimilar || "Make one like this →"}
      </button>
    );
  }

  return (
    <div className="mt-4 pt-4 space-y-3" style={{ borderTop: "1px solid var(--line-soft)" }}>
      <div className="text-sm" style={{ color: "var(--cream-dim)" }}>
        {ui.makeSimilarWhat || "What is YOUR video about? The pacing is copied from this one; every word is yours."}
      </div>
      <input
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") go(); }}
        placeholder={ui.makeSimilarHint || "e.g. why most cold emails get deleted in three seconds"}
        className="w-full bg-transparent outline-none text-sm p-2 rounded"
        style={{ color: "var(--cream)", border: "1px solid var(--line-soft)" }}
      />
      <div className="flex flex-wrap gap-2 items-center">
        {(["avatar", "voiceover"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`pill ${mode === m ? "pill-warn" : ""}`}
            style={{ cursor: "pointer" }}
          >
            {m === "avatar" ? (ui.modeAvatar || "On camera (HeyGen)") : (ui.modeVoiceover || "Voiceover")}
          </button>
        ))}
        <button onClick={go} disabled={!topic.trim() || busy} className="pill pill-warn" style={{ cursor: topic.trim() ? "pointer" : "default" }}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
          {ui.makeSimilarGo || "Build it in the Video tab"}
        </button>
      </div>
      {err && <div className="text-sm" style={{ color: "var(--plum)" }}>⚠ {err}</div>}
    </div>
  );
}

// ── the screen a member sees before anything is configured ─────────────────────
function Onboarding({ status }: { status: Status }) {
  const missingTools = !status.ytDlp || !status.ffmpeg;
  return (
    <div className="space-y-5 max-w-3xl">
      <div className="panel p-5">
        <p className="text-base leading-relaxed mb-4" style={{ color: "var(--cream)" }}>
          Paste a link. <b>Qwen Omni watches the video for you</b> — every frame and every word, not a transcript.
          So it catches the slides, the demo on screen, the code and the captions.
        </p>

        <div className="space-y-2 mb-4">
          <div className="flex gap-3 items-baseline text-sm">
            <span className="pill pill-warn flex-none" style={{ minWidth: 84, justifyContent: "center" }}>Ask</span>
            <span style={{ color: "var(--cream-soft)" }}>
              A question about a video you have no time to watch — answered with timestamps and the real frames as proof.
            </span>
          </div>
          <div className="flex gap-3 items-baseline text-sm">
            <span className="pill pill-warn flex-none" style={{ minWidth: 84, justifyContent: "center" }}>Teardown</span>
            <span style={{ color: "var(--cream-soft)" }}>
              How a video is <i>made</i> — hook, beat by beat, editing, on-screen text, sound, CTA — and
              what transfers to the thing you are about to film.
            </span>
          </div>
          <div className="flex gap-3 items-baseline text-sm">
            <span className="pill pill-warn flex-none" style={{ minWidth: 84, justifyContent: "center" }}>Channel</span>
            <span style={{ color: "var(--cream-soft)" }}>
              The same teardown aimed at a whole account. It lists what they published and prices it first,
              so you see the bill before anything is watched.
            </span>
          </div>
        </div>

        <p className="text-xs" style={{ color: "var(--cream-mute)" }}>
          Works with anything yt-dlp reaches: YouTube, TikTok, Instagram, Facebook, X, Reels, Shorts.
          About 3 cents per 10-minute video.
        </p>
      </div>

      {!status.key && (
        <div className="panel p-5">
          <div className="flex items-center gap-2 mb-3">
            <KeyRound size={15} style={{ color: "var(--gold)" }} />
            <span className="sidebar-section-label" style={{ margin: 0 }}>Step 1 — your Qwen key</span>
          </div>
          <ol className="text-sm space-y-2 list-decimal pl-5" style={{ color: "var(--cream-soft)" }}>
            <li>
              Open <a href="https://modelstudio.console.alibabacloud.com" target="_blank" rel="noreferrer"
                style={{ color: "var(--gold)" }}>Alibaba Model Studio</a> and create an API key.
              New accounts get free credits.
            </li>
            <li>Add it to <code>~/.hermes/.env</code> as <code>DASHSCOPE_API_KEY=sk-…</code></li>
            <li>Reload this tab.</li>
          </ol>
          <p className="text-xs mt-3" style={{ color: "var(--cream-mute)" }}>
            The key stays on your machine. Outside Singapore, also set <code>DASHSCOPE_API</code> to your region&apos;s endpoint.
          </p>
        </div>
      )}

      {missingTools && (
        <div className="panel p-5">
          <div className="flex items-center gap-2 mb-3">
            <TerminalSquare size={15} style={{ color: "var(--gold)" }} />
            <span className="sidebar-section-label" style={{ margin: 0 }}>
              Step {status.key ? 1 : 2} — two command-line tools
            </span>
          </div>
          <div className="flex gap-4 mb-3 text-sm">
            <span><span className={`status-dot ${status.ytDlp ? "ok" : "err"}`} /> yt-dlp</span>
            <span><span className={`status-dot ${status.ffmpeg ? "ok" : "err"}`} /> ffmpeg</span>
          </div>
          <p className="text-sm mb-2" style={{ color: "var(--cream-soft)" }}>
            yt-dlp fetches the video, ffmpeg cuts the frames. In a terminal:
          </p>
          <pre className="text-xs p-3 rounded-lg overflow-x-auto" style={{ background: "var(--bg-elev)", color: "var(--gold-soft)" }}>
{!status.ffmpeg ? "brew install ffmpeg\n" : ""}{!status.ytDlp ? "uv tool install yt-dlp   # or: brew install yt-dlp" : ""}
          </pre>
        </div>
      )}

      <div className="text-sm flex items-center gap-2" style={{ color: "var(--cream-dim)" }}>
        <ArrowRight size={14} /> Once that is done, this tab turns into the ask box.
      </div>
    </div>
  );
}
