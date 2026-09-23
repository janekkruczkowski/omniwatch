"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Radar, Plus, X, Loader2, Play, ArrowUpRight, Save } from "lucide-react";
import OmniMarkdown from "./OmniMarkdown";
import I18N from "@/lib/omniwatchI18n";
import "./OmniWatch.css";

// Scout — the same OmniWatch channel scan, run for you on a schedule (SPEC F2–F11).
//
// You add the channels you want to follow. Each one keeps its goal (a summary by
// default, a topic-focused summary, or a teardown only if you pick it), its language,
// whether the first run takes only new videos or works through the whole archive in
// batches, a cost ceiling and a schedule. Hermes cron runs the saved channels; "Run now"
// runs the very same scan. Results are the new analyses, openable one by one.

export type Goal = "summary" | "topic" | "teardown";
export type Schedule = "off" | "daily" | "weekly";

export interface Channel {
  id: string;
  platform: string;
  handle: string;
  goal: Goal;
  topic?: string;
  language?: string;
  firstRun?: "new" | "all";
  schedule?: Schedule;
  batch?: number | null;
  budgetUsd?: number | null;
  collectionId?: string;
  baseline?: string | null;
}

interface ResultItem { runId: string; ordinal: number; title: string | null; url: string; state: string; at: string }
interface Estimate { text: string; error?: string }
interface Opened { key: string; text: string | null; loading: boolean; error?: string }

/** A channel URL or @handle → platform + handle. YouTube when nothing else matches. */
export function parseChannelInput(input: string): { platform: string; handle: string } | null {
  const raw = input.trim();
  if (!raw) return null;
  const platform = /tiktok\.com/i.test(raw) ? "tiktok"
    : /instagram\.com/i.test(raw) ? "instagram"
      : /(?:^|\/\/|\.)(?:x|twitter)\.com/i.test(raw) ? "x"
        : "youtube";
  let handle = raw;
  const at = raw.match(/@([\w.-]+)/);
  if (at) handle = at[1];
  else if (/^https?:\/\//i.test(raw)) {
    try {
      const parts = new URL(raw).pathname.split("/").filter(Boolean);
      handle = (parts[0] === "c" || parts[0] === "user" || parts[0] === "channel" ? parts[1] : parts[0]) || "";
    } catch { return null; }
  }
  handle = handle.replace(/^[@#]/, "").trim();
  return handle ? { platform, handle } : null;
}

/** A new channel starts as a plain summary of new videos, not scheduled — never a teardown. */
export function newChannel(platform: string, handle: string, language = "en"): Channel {
  return {
    id: `${platform}_${handle}`.replace(/[^\w.-]/g, "_"),
    platform, handle,
    goal: "summary", topic: "", language,
    firstRun: "new", schedule: "off", batch: 10, budgetUsd: null,
  };
}

/** The one Hermes job runs daily whenever any channel is scheduled; weekly ones skip days. */
export function scheduleEvery(channels: Channel[]): "24" | "off" {
  return channels.some((c) => c.schedule === "daily" || c.schedule === "weekly") ? "24" : "off";
}

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));

const canonical = (c: Channel) =>
  c.platform === "tiktok" ? `https://www.tiktok.com/@${c.handle}`
    : c.platform === "instagram" ? `https://www.instagram.com/${c.handle}`
      : c.platform === "x" ? `https://x.com/${c.handle}`
        : `https://www.youtube.com/@${c.handle}`;

export default function ScoutView() {
  const [lang, setLang] = useState("en");
  const [langs, setLangs] = useState<string[]>(["en", "pl"]);
  const ui = useMemo(() => {
    const base = (I18N.en?.ui || {}) as Record<string, string>;
    const own = (I18N[lang]?.ui || {}) as Record<string, string>;
    return (k: string) => own[k] ?? base[k] ?? k;
  }, [lang]);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [results, setResults] = useState<Record<string, ResultItem[]>>({});
  const [ready, setReady] = useState<{ key: boolean } | null>(null);
  const [scheduled, setScheduled] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [estimates, setEstimates] = useState<Record<string, Estimate>>({});
  const [opened, setOpened] = useState<Opened | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/omniwatch/scout", { cache: "no-store" }).then((x) => x.json());
    setChannels(r.config?.channels || []);
    setResults(r.results || {});
    setReady(r.ready || null);
  }, []);

  useEffect(() => {
    load().catch(() => setErr("Could not reach the server"));
    fetch("/api/omniwatch/status").then((r) => r.json()).then((s) => {
      if (s.defaultLang) setLang(s.defaultLang);
      if (Array.isArray(s.langs) && s.langs.length) setLangs(s.langs);
    }).catch(() => {});
    fetch("/api/omniwatch/scout/schedule", { cache: "no-store" }).then((r) => r.json())
      .then((s) => setScheduled(Boolean(s.scheduled))).catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  const patch = (id: string, change: Partial<Channel>) => {
    setChannels((cs) => cs.map((c) => (c.id === id ? { ...c, ...change } : c)));
    setDirty(true);
  };

  const save = useCallback(async (next: Channel[]) => {
    setSaving(true); setErr(null);
    try {
      const res = await fetch("/api/omniwatch/scout", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "config", config: { channels: next } }),
      });
      const body = await res.json();
      if (!res.ok) { setErr(body.error || "Could not save"); return; }
      setChannels(body.config?.channels || next);
      if (Array.isArray(body.notes) && body.notes.length) setNote(body.notes.join(" · "));
      setDirty(false);
      // Hermes owns the clock: one daily job whenever any channel is scheduled.
      const every = scheduleEvery(next);
      if (scheduled === null || (every !== "off") !== scheduled) {
        const s = await fetch("/api/omniwatch/scout/schedule", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ every }),
        }).then((r) => r.json()).catch(() => ({ error: "schedule" }));
        if (s.error) setErr(String(s.error));
        else setScheduled(every !== "off");
      }
    } finally { setSaving(false); }
  }, [scheduled]);

  const add = () => {
    const parsed = parseChannelInput(input);
    if (!parsed) return;
    const channel = newChannel(parsed.platform, parsed.handle, lang);
    if (channels.some((c) => c.id === channel.id)) { setInput(""); return; }
    const next = [...channels, channel];
    setChannels(next); setInput("");
    save(next);
  };

  const remove = (id: string) => {
    const next = channels.filter((c) => c.id !== id);
    setChannels(next);
    save(next);
  };

  const estimate = async (c: Channel) => {
    setEstimates((e) => ({ ...e, [c.id]: { text: "…" } }));
    try {
      const q = new URLSearchParams({ url: canonical(c), platform: c.platform });
      const r = await fetch(`/api/omniwatch/channel?${q}`, { cache: "no-store" }).then((x) => x.json());
      if (r.error || r.needsConfirmation) {
        setEstimates((e) => ({ ...e, [c.id]: { text: "", error: r.error || r.message || r.note || "?" } }));
        return;
      }
      const videos = Array.isArray(r.videos) ? r.videos : [];
      const priced = videos.filter((v: { cost?: number | null }) => typeof v.cost === "number");
      const cost = Number(r.cost || 0);
      const avg = priced.length ? cost / priced.length : 0;
      let text = c.firstRun === "all"
        ? fill(ui("scoutEstimateAll"), {
          cost: cost.toFixed(2), n: videos.length,
          more: r.hasMore ? ui("scoutEstimateMore") : "", batch: c.batch || 10,
        })
        : fill(ui("scoutEstimateNew"), { avg: avg.toFixed(3), n: priced.length });
      if (r.unpriced) text += " " + fill(ui("scoutEstimateUnknown"), { n: r.unpriced });
      setEstimates((e) => ({ ...e, [c.id]: { text } }));
    } catch {
      setEstimates((e) => ({ ...e, [c.id]: { text: "", error: "Could not reach the server" } }));
    }
  };

  const runNow = async (c: Channel) => {
    if (dirty) await save(channels);
    setRunning(c.id); setErr(null); setNote(null);
    try {
      const res = await fetch("/api/omniwatch/scout", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "scan", channelId: c.id }),
      });
      const body = await res.json();
      if (!res.ok || !body.id) { setErr(body.error || "Could not start"); setRunning(null); return; }
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        const v = await fetch(`/api/omniwatch/scout?job=${body.id}`, { cache: "no-store" }).then((x) => x.json()).catch(() => null);
        if (!v || v.state === "running") return;
        if (pollRef.current) clearInterval(pollRef.current);
        setRunning(null);
        if (v.state === "error" || v.state === "gone") { setErr(v.error || "Scan failed"); return; }
        const n = Number(v.outcome?.analysed || 0);
        setNote(n > 0 ? fill(ui("scoutDone"), { n }) : ui("scoutNothingNew"));
        load();
      }, 3000);
    } catch {
      setErr("Could not reach the server"); setRunning(null);
    }
  };

  const open = async (item: ResultItem) => {
    const key = `${item.runId}:${item.ordinal}`;
    if (opened?.key === key) { setOpened(null); return; }
    setOpened({ key, text: null, loading: true });
    try {
      const r = await fetch(`/api/omniwatch/channel?run=${encodeURIComponent(item.runId)}&open=${item.ordinal}`, { cache: "no-store" }).then((x) => x.json());
      setOpened({ key, text: r.text ?? null, loading: false, error: r.error ? String(r.message || r.error) : undefined });
    } catch {
      setOpened({ key, text: null, loading: false, error: "Could not reach the server" });
    }
  };

  const sections = (I18N[lang]?.sections || I18N.en.sections) as Record<string, string>;

  return (
    <div className="space-y-5">
      <div className="panel p-4 md:p-5">
        <div className="flex items-center gap-2">
          <Radar size={16} />
          <div className="text-sm font-semibold">{ui("scoutTitle")}</div>
        </div>
        <div className="text-sm mt-2">{ui("scoutLead")}</div>
        {ready && !ready.key && <div className="text-xs mt-2 pill pill-warn">{ui("scoutNoKey")}</div>}
        <div className="flex flex-wrap gap-2 items-center mt-3">
          <input
            className="pill flex-1 min-w-0 bg-transparent outline-none"
            value={input}
            placeholder={ui("scoutAddPlaceholder")}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          />
          <button className="pill flex items-center gap-1.5" onClick={add} disabled={!input.trim() || saving}>
            <Plus size={14} /> {ui("scoutAdd")}
          </button>
        </div>
        {err && <div className="text-xs mt-2 pill pill-warn">{err}</div>}
        {note && <div className="text-xs mt-2">{note}</div>}
      </div>

      {channels.length === 0 && <div className="panel p-4 text-sm">{ui("scoutEmpty")}</div>}

      {channels.map((c) => {
        const items = results[c.collectionId || ""] || [];
        const est = estimates[c.id];
        return (
          <div key={c.id} className="panel p-4 md:p-5" data-channel={c.id}>
            <div className="flex items-center gap-2">
              <span className="pill flex-none">{c.platform}</span>
              <a className="text-sm font-semibold min-w-0 flex-1 truncate" href={canonical(c)} target="_blank" rel="noreferrer">@{c.handle}</a>
              <button className="pill flex items-center gap-1 flex-none" onClick={() => remove(c.id)} title={ui("scoutRemove")}>
                <X size={12} />
              </button>
            </div>

            <div className="flex flex-wrap gap-2 items-center mt-3 text-xs">
              <label className="flex items-center gap-2">{ui("scoutGoal")}
                <select className="pill bg-transparent outline-none cursor-pointer" value={c.goal}
                  onChange={(e) => patch(c.id, { goal: e.target.value as Goal })}>
                  <option value="summary">{ui("scoutGoalSummary")}</option>
                  <option value="topic">{ui("scoutGoalTopic")}</option>
                  <option value="teardown">{ui("scoutGoalTeardown")}</option>
                </select>
              </label>
              {c.goal === "topic" && (
                <input className="pill flex-1 min-w-0 bg-transparent outline-none" value={c.topic || ""}
                  placeholder={ui("scoutTopicPlaceholder")} onChange={(e) => patch(c.id, { topic: e.target.value })} />
              )}
              <label className="flex items-center gap-2">{ui("scoutLanguage")}
                <select className="pill bg-transparent outline-none cursor-pointer" value={c.language || "en"}
                  onChange={(e) => patch(c.id, { language: e.target.value })}>
                  {langs.map((l) => <option key={l} value={l}>{I18N[l]?.name || l}</option>)}
                </select>
              </label>
            </div>

            <div className="flex flex-wrap gap-2 items-center mt-2 text-xs">
              <label className="flex items-center gap-2">{ui("scoutFirstRun")}
                <select className="pill bg-transparent outline-none cursor-pointer" value={c.firstRun || "new"}
                  onChange={(e) => patch(c.id, { firstRun: e.target.value === "all" ? "all" : "new" })}>
                  <option value="new">{ui("scoutFirstNew")}</option>
                  <option value="all">{ui("scoutFirstAll")}</option>
                </select>
              </label>
              <label className="flex items-center gap-2">{ui("scoutBatch")}
                <input type="number" min={1} max={200} className="pill w-20 bg-transparent outline-none" value={c.batch ?? 10}
                  onChange={(e) => patch(c.id, { batch: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })} />
              </label>
              <label className="flex items-center gap-2">{ui("scoutBudget")}
                <input type="number" min={0} step={0.1} className="pill w-24 bg-transparent outline-none" value={c.budgetUsd ?? ""}
                  onChange={(e) => patch(c.id, { budgetUsd: e.target.value === "" ? null : Number(e.target.value) })} />
              </label>
              <label className="flex items-center gap-2">{ui("scoutSchedule")}
                <select className="pill bg-transparent outline-none cursor-pointer" value={c.schedule || "off"}
                  onChange={(e) => patch(c.id, { schedule: e.target.value as Schedule })}>
                  <option value="off">{ui("scoutScheduleOff")}</option>
                  <option value="daily">{ui("scoutScheduleDaily")}</option>
                  <option value="weekly">{ui("scoutScheduleWeekly")}</option>
                </select>
              </label>
              {c.schedule && c.schedule !== "off" && <span className="text-xs">{ui("scoutScheduleNote")}</span>}
            </div>

            <div className="flex flex-wrap gap-2 items-center mt-3">
              <button className="pill flex items-center gap-1.5" onClick={() => estimate(c)}>{ui("scoutEstimate")}</button>
              {dirty && (
                <button className="pill flex items-center gap-1.5" onClick={() => save(channels)} disabled={saving}>
                  <Save size={14} /> {ui("scoutSave")}
                </button>
              )}
              <button className="pill pill-warn flex items-center gap-1.5 disabled:opacity-40" onClick={() => runNow(c)}
                disabled={Boolean(running) || (ready ? !ready.key : false)}>
                {running === c.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {running === c.id ? ui("scoutRunning") : ui("scoutRunNow")}
              </button>
            </div>
            {est && <div className="text-xs mt-2">{est.error ? est.error : est.text}</div>}

            <div className="mt-4 pt-3">
              <div className="sidebar-section-label mb-1">{ui("scoutResults")}</div>
              {items.length === 0 && <div className="text-xs">{ui("scoutNoResults")}</div>}
              <div className="space-y-1">
                {items.map((item) => {
                  const key = `${item.runId}:${item.ordinal}`;
                  return (
                    <div key={key}>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">{item.title || item.url}</span>
                        <a className="text-xs flex items-center gap-1" href={item.url} target="_blank" rel="noreferrer">
                          {ui("scoutVideo")} <ArrowUpRight size={12} />
                        </a>
                        <button className="pill flex items-center gap-1 flex-none" onClick={() => open(item)}>
                          {opened?.key === key ? ui("scoutClose") : ui("scoutOpen")}
                        </button>
                      </div>
                      {opened?.key === key && (
                        <div className="panel p-4 mt-2 text-sm">
                          {opened.loading ? <Loader2 size={14} className="animate-spin" />
                            : opened.error ? <div className="text-xs">{opened.error}</div>
                              : <OmniMarkdown text={opened.text || ""} sections={sections} />}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
