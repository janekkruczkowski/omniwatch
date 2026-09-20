// ── auto/script graphics support — the DEPLOYED half of the OmniWatch bridge ──────
//
// Nothing imports this file. It is the canonical, reviewable copy of the change that is
// live in the Agent OS installation at
//
//   <agent-os>/source/src/app/api/video/auto/script/route.ts
//
// kept here because that file is Agent OS's, not ours: an Agent OS update overwrites it,
// and the only way this half comes back is a guarded patch. The installer lives in
// `agent-os-module/patch-director.py` (`patch_script_graphics`, sentinel `omni-graphic-v2`)
// and applies exactly the four insertions below.
//
// What it does: the script model may mark a scene as a CARD instead of footage, writing
// the card's data from the person's OWN topic and narration. Nothing about the video that
// was watched is copied into it, and no field of the OmniWatch brief is forwarded by this
// change — that is a separate, still-unauthorised proposal (see `flash-author-proposal.patch`
// in the Codex workspace).
//
// INSERTION 1 — the scene type carries an optional card:
//
//   interface Scene { caption: string; narration_line: string; broll_prompt: string; graphic?: SceneGraphic }
//
// INSERTION 2 — inside authorSystem's JSON shape, directly after the "broll_prompt" line:
//
//       "graphic": {"kind": "stat", "value": "12", "caption": "the one number that matters"}
//
// INSERTION 3 — one extra rule, inserted immediately BEFORE the "- Be accurate." rule:
//
//   - A beat is sometimes better shown as a CARD than as footage — a ranked list, one big
//     number, a comparison, a held quote. For those scenes ONLY, add "graphic" with kind
//     "ranking" | "stat" | "compare" | "quote" and the data it needs, written from THIS topic
//     and THIS script's own narration. Every other scene gets no "graphic" key at all.
//
// INSERTION 4 — this validator before `export async function POST`, plus one line in
// extractJson's scene normaliser: `graphic: sanGraphic(s.graphic),`

// A card is only a card if it has the shape the assembler draws. The model writes this
// from the person's own topic and narration; anything malformed is dropped rather than
// guessed, and a scene without one is simply footage.
export type SceneGraphic =
  | { kind: "ranking"; title?: string; items: { label: string; value?: string }[] }
  | { kind: "stat"; title?: string; value: string; caption?: string }
  | { kind: "compare"; title?: string; left: { label: string; items: string[] }; right: { label: string; items: string[] } }
  | { kind: "quote"; text: string; attribution?: string };

export function sanGraphic(g: unknown): SceneGraphic | undefined {
  if (!g || typeof g !== "object") return undefined;
  const o = g as Record<string, unknown>;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const list = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => str(x, n)).filter(Boolean).slice(0, 8) : []);
  switch (o.kind) {
    case "stat": {
      const value = str(o.value, 40);
      return value ? { kind: "stat", title: str(o.title, 60) || undefined, value, caption: str(o.caption, 120) || undefined } : undefined;
    }
    case "ranking": {
      const items = Array.isArray(o.items)
        ? o.items.map((it) => {
            const r = (it ?? {}) as Record<string, unknown>;
            return { label: str(r.label, 60), value: str(r.value, 24) || undefined };
          }).filter((it) => it.label).slice(0, 8)
        : [];
      return items.length >= 2 ? { kind: "ranking", title: str(o.title, 60) || undefined, items } : undefined;
    }
    case "compare": {
      const side = (v: unknown) => {
        const r = (v ?? {}) as Record<string, unknown>;
        return { label: str(r.label, 40), items: list(r.items, 70) };
      };
      const left = side(o.left), right = side(o.right);
      return left.items.length && right.items.length ? { kind: "compare", title: str(o.title, 60) || undefined, left, right } : undefined;
    }
    case "quote": {
      const text = str(o.text, 200);
      return text ? { kind: "quote", text, attribution: str(o.attribution, 60) || undefined } : undefined;
    }
    default: return undefined;
  }
}

// The limits are the assembler's, not invented here: its ranking card fits 8 rows legibly
// on a 1920x1080 frame (`RANKING_ROW_CAP` in auto/assemble/route.ts), so a longer list is
// refused rather than shrunk below readable size. The caps sit on the way in because this
// text comes from a model and ends up inside the composition's HTML: the assembler escapes
// everything it renders, and this file keeps the payload to the shapes that route draws,
// so a malformed or oversized card never reaches it in the first place.
