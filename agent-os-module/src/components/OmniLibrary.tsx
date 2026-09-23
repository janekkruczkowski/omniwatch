"use client";

import { useEffect, useState } from "react";
import { BookOpen, Loader2, Search, MessageSquare } from "lucide-react";

// The OmniWatch library (F5, D7): search the saved analyses in the host Vault and ask a
// question answered only from them, with references to the notes. There is no second
// knowledge base behind this box — it calls /api/omniwatch/library, which goes through
// the host memory adapter confined to the OmniWatch directory of the configured Vault.
//
// Everything a note says is rendered as plain text: note bodies and model answers are
// data, so nothing here turns them into links, HTML or actions.

interface LibraryInfo { vaultRoot: string; analysesDir: string; answerModel: boolean }
interface Hit { analysisId: string; title: string; excerpt: string; relativePath: string }
interface Ref { analysisId: string; relativePath: string }
interface Answer { question: string; text: string; refs: Ref[]; notFound: boolean }

/** Splits a grounded answer from its "Źródła:" footer so references render as a list. */
export function splitSources(text: string): { body: string; sources: string[] } {
  const at = text.lastIndexOf("\nŹródła:\n");
  if (at < 0) return { body: text, sources: [] };
  const sources = text
    .slice(at + "\nŹródła:\n".length)
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter(Boolean);
  return { body: text.slice(0, at).trim(), sources };
}

export default function OmniLibrary() {
  const [info, setInfo] = useState<LibraryInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<"search" | "ask" | null>(null);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/omniwatch/library", { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.message || j.error || `HTTP ${r.status}`);
        setInfo(j as LibraryInfo);
      })
      .catch((e) => setInfoError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function search() {
    const text = q.trim();
    if (!text || busy) return;
    setBusy("search"); setError(null); setAnswer(null);
    try {
      const r = await fetch(`/api/omniwatch/library?q=${encodeURIComponent(text)}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || `HTTP ${r.status}`);
      setHits(j.hits ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function askLibrary() {
    const text = q.trim();
    if (!text || busy) return;
    setBusy("ask"); setError(null); setHits(null);
    try {
      const r = await fetch("/api/omniwatch/library", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || `HTTP ${r.status}`);
      setAnswer(j as Answer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const parts = answer && !answer.notFound ? splitSources(answer.text) : null;

  return (
    <div className="panel p-4 md:p-5" data-omniwatch-library>
      <div className="flex items-center justify-between gap-3 mb-3">
        <span className="sidebar-section-label flex items-center gap-1.5"><BookOpen size={12} /> Library — saved analyses</span>
        <span className="text-[11px] truncate" style={{ color: "var(--cream-mute)" }} title={info ? `${info.vaultRoot}/${info.analysesDir}` : ""}>
          {info ? <>Vault: <code>{info.vaultRoot}</code> · {info.analysesDir}</> : infoError ? `Vault unavailable: ${infoError}` : "…"}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Search size={14} style={{ color: "var(--cream-mute)", flex: "none" }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (e.metaKey || e.ctrlKey) askLibrary(); else search(); } }}
          maxLength={500}
          placeholder="Search your analyses, or ask a question about them…"
          className="flex-1 bg-transparent outline-none text-sm min-w-0"
          style={{ color: "var(--cream)" }}
          aria-label="Search or ask the OmniWatch library"
        />
        <button onClick={search} disabled={!q.trim() || !!busy} className="pill flex items-center gap-1.5 disabled:opacity-40" style={{ cursor: "pointer" }}>
          {busy === "search" ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Search
        </button>
        <button
          onClick={askLibrary}
          disabled={!q.trim() || !!busy || (info !== null && !info.answerModel)}
          title={info && !info.answerModel ? "No host model key configured — search still works" : "Answer only from the saved analyses (⌘↵)"}
          className="pill pill-warn flex items-center gap-1.5 disabled:opacity-40"
          style={{ cursor: "pointer" }}
        >
          {busy === "ask" ? <Loader2 size={12} className="animate-spin" /> : <MessageSquare size={12} />} Ask
        </button>
      </div>

      {error && <div className="text-sm mt-3" style={{ color: "var(--plum)", whiteSpace: "pre-wrap" }}>⚠ {error}</div>}

      {hits && (
        <div className="mt-3 space-y-2" data-omniwatch-library-hits={hits.length}>
          {hits.length === 0 ? (
            <div className="text-sm" style={{ color: "var(--cream-dim)" }}>No saved analysis matches these words.</div>
          ) : hits.map((hit) => (
            <div key={hit.analysisId} className="text-sm" style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 8 }}>
              <div style={{ color: "var(--cream)" }}>{hit.title || hit.analysisId}</div>
              <div className="text-xs" style={{ color: "var(--cream-mute)" }}><code>{hit.relativePath}</code></div>
              <div className="text-xs mt-1" style={{ color: "var(--cream-dim)", whiteSpace: "pre-wrap" }}>{hit.excerpt}</div>
            </div>
          ))}
        </div>
      )}

      {answer && (
        <div className="mt-3 text-sm" data-omniwatch-library-answer={answer.notFound ? "not-found" : "grounded"}>
          {answer.notFound ? (
            <div style={{ color: "var(--cream-dim)" }}>{answer.text}</div>
          ) : (
            <>
              <div style={{ color: "var(--cream)", whiteSpace: "pre-wrap" }}>{parts?.body}</div>
              {parts && parts.sources.length > 0 && (
                <div className="mt-3 pt-2" style={{ borderTop: "1px solid var(--line-soft)" }}>
                  <div className="sidebar-section-label mb-1">Sources</div>
                  <ul className="text-xs space-y-1" style={{ color: "var(--cream-dim)" }}>
                    {parts.sources.map((line) => <li key={line} style={{ whiteSpace: "pre-wrap" }}>{line}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
