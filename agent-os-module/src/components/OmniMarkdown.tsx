"use client";

import { useMemo } from "react";
import { Eye } from "lucide-react";

// The answers use a narrow slice of markdown (## headings, bullets, **bold**, `code`),
// and two things a general renderer makes awkward: turning every timestamp into a
// button that seeks the player, and slotting the real frame beside each bullet. So this
// is small and purpose-built rather than a library.

export const TS_RE = /`?\[(\d{1,2}(?::\d{2}){1,2})(\s*[–-]\s*\d{1,2}(?::\d{2}){1,2})?\]`?/g;

export const toSec = (t: string) => t.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);

type Block = { kind: "h2"; text: string } | { kind: "p"; text: string } | { kind: "ul"; items: string[] };

export function parseBlocks(md: string): Block[] {
  const out: Block[] = [];
  for (const raw of (md || "").split("\n")) {
    const line = raw.trimEnd();
    const h = /^##\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h) { out.push({ kind: "h2", text: h[1].trim() }); continue; }
    if (li) {
      const last = out[out.length - 1];
      if (last?.kind === "ul") last.items.push(li[1]);
      else out.push({ kind: "ul", items: [li[1]] });
      continue;
    }
    if (!line.trim()) continue;
    if (/^#{1,6}\s/.test(line)) { out.push({ kind: "p", text: line.replace(/^#+\s*/, "") }); continue; }
    const last = out[out.length - 1];
    if (last?.kind === "p") last.text += " " + line.trim();
    else out.push({ kind: "p", text: line.trim() });
  }
  return out;
}

function emphasis(text: string, key: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let i = 0, k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > i) out.push(text.slice(i, m.index));
    out.push(m[1]
      ? <strong key={`b${key}-${k++}`}>{m[1]}</strong>
      : <code key={`c${key}-${k++}`}>{m[2]}</code>);
    i = m.index + m[0].length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

/** Text with timestamps turned into seek buttons — or, with no player to seek, quiet labels. */
export function inline(raw: string, onSeek?: (s: number) => void): React.ReactNode[] {
  // A timestamp already renders as a chip, so bold around it is both redundant and
  // unparseable once the chip is split out — drop the markers first.
  const text = raw.replace(/\*\*(\s*`?\[[^\]]+\]`?\s*)\*\*/g, "$1");
  const nodes: React.ReactNode[] = [];
  let i = 0, key = 0;
  TS_RE.lastIndex = 0;
  for (let m = TS_RE.exec(text); m; m = TS_RE.exec(text)) {
    if (m.index > i) nodes.push(...emphasis(text.slice(i, m.index), key++));
    const at = toSec(m[1]);
    const label = `${m[1]}${m[2] ? m[2].replace(/\s/g, "") : ""}`;
    nodes.push(onSeek
      ? <button key={`t${key++}`} className="ow-ts" onClick={() => onSeek(at)} title="Jump to this moment">▶ {label}</button>
      : <span key={`t${key++}`} className="ow-ts">{label}</span>);
    i = m.index + m[0].length;
  }
  if (i < text.length) nodes.push(...emphasis(text.slice(i), key++));
  return nodes;
}

const firstStamp = (s: string): number | null => {
  TS_RE.lastIndex = 0;
  const m = TS_RE.exec(s);
  return m ? toSec(m[1]) : null;
};

export interface MarkdownProps {
  text: string;
  /** localized heading → key, so sections can be styled by meaning rather than position */
  sections?: Record<string, string>;
  /** with a player: timestamps seek, and evidence bullets carry the real frame */
  onSeek?: (sec: number) => void;
  frame?: (sec: number) => string;
  badges?: { frames: string; visual: string };
  /** render only this section (by key), or everything except it */
  only?: string;
  except?: string;
}

export default function OmniMarkdown({ text, sections = {}, onSeek, frame, badges, only, except }: MarkdownProps) {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  const kindOf = (heading: string) => {
    const t = heading.trim().toLowerCase();
    for (const [k, v] of Object.entries(sections)) if (String(v).toLowerCase() === t) return k;
    return "";
  };

  let current = "";
  const nodes: React.ReactNode[] = [];

  blocks.forEach((b, i) => {
    if (b.kind === "h2") current = kindOf(b.text);
    // section filters let one answer be shown in two places: the script here, the
    // analysis behind a toggle.
    if (only && current !== only) return;
    if (except && current === except) return;

    if (b.kind === "h2") { nodes.push(<h2 key={i}>{b.text}</h2>); return; }
    if (b.kind === "p") {
      nodes.push(
        <div key={i} className={current === "answer" || current === "tldr" ? "lead" : ""}>
          <p>{inline(b.text, onSeek)}</p>
        </div>,
      );
      return;
    }

    const framed = Boolean(frame) && (current === "evidence" || current === "visual");
    const thumbed = Boolean(frame) && (framed || ["timeline", "jump", "beats", "text"].includes(current));
    const lead = framed ? 2 : 1; // the model names a moment slightly before the visual peaks
    const list = (
      <ul key={i} className={thumbed && !framed ? "ow-tl" : ""}>
        {b.items.map((it, j) => {
          const at = thumbed ? firstStamp(it) : null;
          return at !== null && frame
            // eslint-disable-next-line @next/next/no-img-element
            ? <li key={j}><img src={frame(at + lead)} alt="" loading="lazy" onClick={() => onSeek?.(at)} /><div>{inline(it, onSeek)}</div></li>
            : <li key={j}>{inline(it, onSeek)}</li>;
        })}
      </ul>
    );

    if (!framed) { nodes.push(list); return; }
    nodes.push(
      <div key={i} className="ow-evidence">
        <div className="ow-badge">
          <Eye size={11} /> {current === "evidence" ? (badges?.frames || "FRAMES FROM THE VIDEO") : (badges?.visual || "ON SCREEN ONLY")}
        </div>
        {list}
      </div>,
    );
  });

  return <div className="ow-md">{nodes}</div>;
}
