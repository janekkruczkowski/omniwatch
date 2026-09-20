// What you are scanning FOR — a small library rather than two hardcoded modes.
//
// The tab began with exactly two ideas about why anyone watches a video: what it says,
// and how it was built. That was too narrow the moment a real reason turned up that was
// neither. Someone selling clothes wants to know which brands and colours appear on
// screen across a competitor's whole account. Someone else wants the cars. Neither is a
// summary and neither is a teardown, and both are perfectly ordinary things to want.
//
// So the two structural modes stay, and everything else is a canned question routed
// through the ask path — the engine already answers questions about a video with
// timestamps and real frames, so a preset needs no new machinery at all. The last entry
// is an empty box, because the list will never cover what someone actually wants.
//
// One line is appended to every preset question: keep the field names the same for every
// video. The model still decides its own shape per video, which is what was asked for,
// but nudging it to reuse the shape costs nothing and is the difference between thirty
// answers you can stack and thirty you cannot.

import type { Mode } from "@/lib/omniwatch";

export interface Preset {
  id: string;
  /** shown on the chip */
  label: string;
  /** shown on hover — says who this is for, not what it does */
  hint: string;
  /** which engine path answers it */
  mode: Mode;
  /** for the question presets: what is actually asked of every video */
  ask?: string;
}

/** Appended to every canned question. Free, and recovers some comparability. */
export const SAME_SHAPE =
  "\nAnswer with short labelled lines, one fact per line, each with its timestamp. "
  + "Use the SAME labels for every video you are asked about, so the answers can be "
  + "read side by side. If something is not in this video, say so rather than guessing.";

export const PRESETS: Preset[] = [
  {
    id: "both",
    label: "What they say + how it's made",
    hint: "The full picture. One request, so it costs a fraction of a cent more than either alone.",
    mode: "both",
  },
  {
    id: "content",
    label: "What they say",
    hint: "For a channel you want the knowledge out of — a course, a fitness channel, a conference talk.",
    mode: "ask",
  },
  {
    id: "craft",
    label: "How they are made",
    hint: "For a channel you mean to compete with — hook, pacing, captions, CTA, as a comparable card.",
    mode: "teardown",
  },
  {
    id: "brands",
    label: "Products & brands on screen",
    hint: "Every product, brand and logo that appears — what a transcript will never tell you.",
    mode: "ask",
    ask: "List every product, brand, logo and piece of packaging VISIBLE on screen, whether or not it is "
      + "mentioned out loud. For each: what it is, where it appears, and whether it is shown deliberately "
      + "or incidentally.",
  },
  {
    id: "wardrobe",
    label: "Clothing & colour",
    hint: "Garments, colours and combinations — built for anyone selling or studying fashion.",
    mode: "ask",
    ask: "List the clothing worn or shown: the garment, its colour, the fabric if you can tell, and what it "
      + "is paired with. Note which colour combinations recur, and the overall palette of the video itself "
      + "(background, grade, on-screen text colours).",
  },
  {
    id: "claims",
    label: "Claims & numbers",
    hint: "Every figure, promise and piece of proof — and whether anything backs it up.",
    mode: "ask",
    ask: "List every factual claim, number, price, statistic and promise made — said out loud OR shown on "
      + "screen. For each, say what evidence is offered for it, and mark clearly when none is.",
  },
  {
    id: "setting",
    label: "Setting & production",
    hint: "Where it was shot and with what — useful when deciding what you could actually reproduce.",
    mode: "ask",
    ask: "Describe where this was shot and with what: location, background, lighting, camera position and "
      + "movement, microphone if visible, and anything else that would have to be arranged to film it again. "
      + "Say what the minimum realistic setup would be.",
  },
  {
    id: "custom",
    label: "Something else…",
    hint: "Say what you want pulled out of every video, in your own words.",
    mode: "ask",
  },
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id);

/** What the scan actually sends per video: the engine path, and the question if any. */
export function resolvePreset(id: string, custom: string): { mode: Mode; ask: string } {
  const p = presetById(id) || PRESETS[0];
  if (p.id === "custom") {
    const q = custom.trim();
    return { mode: "ask", ask: q ? q + SAME_SHAPE : "" };
  }
  return { mode: p.mode, ask: p.ask ? p.ask + SAME_SHAPE : "" };
}
