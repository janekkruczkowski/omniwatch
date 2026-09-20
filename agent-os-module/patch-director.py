#!/usr/bin/env python3
"""Teach the Video Director to accept a brief from OmniWatch.

    python3 patch-director.py <agent-os>/source

A few small insertions into files that are not ours, each guarded by a sentinel so a
second run changes nothing. This is the same contract as register-nav.py: Agent OS
owns these files, we only ever add to them, and an Agent OS update that overwrites
them is repaired by running the installer again.

Why a separate script rather than another function in register-nav.py: that file was
being edited for the scene-duration change at the same time as this one was written,
and two people editing one file is how a module ends up merged by hand. install.sh
calls both.

What they do, together:

  1. The Director reads ?brief=<id> on load and fills its own first stage from it —
     the topic the person typed in the OmniWatch tab, whether they want a presenter or
     a voiceover, and how long the thing should run.
  2. It asks the script writer for exactly as many scenes as the watched video had
     ideas, so the writing is shaped by the rhythm instead of being cut to fit it
     afterwards.
  3. It hands those durations to the assembler, which honours them instead of
     guessing each scene's length from its word count.
  4. Where the watched video held a text card rather than footage, it asks the
     assembler to draw a card instead of playing a clip.

Without the third one the first two are decoration: the plan would say 1.4 seconds and
the edit would still hold for four.
"""
import sys

src = sys.argv[1] if len(sys.argv) > 1 else "."
director = f"{src}/src/components/VideoDirector.tsx"
script_route = f"{src}/src/app/api/video/auto/script/route.ts"


def read(p):
    return open(p, encoding="utf-8").read()


def write(p, s):
    open(p, "w", encoding="utf-8").write(s)


def sub1(s, old, new):
    """Replace once, and only when the anchor is unambiguous.

    Every caller treats a miss as "Agent OS has changed shape here" and stops without
    writing, so the second half of this return value is the point of the function. It was
    called before it existed, which is a NameError on a fresh install — the patch ran on a
    file that was already patched (so every anchor hit) and the bug stayed hidden.

    An anchor that appears more than once is the same news as a miss: this is not the file
    the patch was written against, and replacing the first of several would be a guess."""
    if s.count(old) != 1:
        return s, False
    return s.replace(old, new, 1), True


# ── 1. read the brief on load ──────────────────────────────────────────────────
#
# The parameter is removed from the address bar once it has been read. Leaving it
# there means every reload overwrites whatever the person has since typed, which is
# the same bug the OmniWatch deep link had and fixed for the same reason.
BRIDGE = '''
  // ── OmniWatch bridge (sentinel: omni-brief) ─────────────────────────────────
  // A teardown in the OmniWatch tab ends in "make one like this". That stores a brief
  // and sends the person here with ?brief=<id>. The brief carries RHYTHM — one entry
  // per idea and the seconds it holds — and deliberately carries no words: the pacing
  // is copied from the video that was watched, the script is written from scratch for
  // the topic typed by the person.
  const [omniSeconds, setOmniSeconds] = useState<number[]>([]);
  const [omniGraphic, setOmniGraphic] = useState<boolean[]>([]);
  const [omniSource, setOmniSource] = useState<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("brief");
    if (!id) return;
    fetch(`/api/omniwatch/recreate?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => {
        const b = j?.brief;
        if (!b || !Array.isArray(b.scenes) || !b.scenes.length) return;
        const secs: number[] = b.scenes.map((s: { seconds: number }) => Number(s.seconds) || 0).filter((n: number) => n > 0);
        if (!secs.length) return;
        setOmniSeconds(secs);
        setOmniGraphic(b.scenes.map((s: { visual?: { kind?: string } }) => s.visual?.kind === "graphic"));
        setOmniSource(b.source?.title || b.source?.url || null);
        setRun((r) => ({
          ...r,
          topic: b.topic || r.topic,
          mode: b.mode === "voiceover" ? "voiceover" : "avatar",
          durationSec: Math.max(15, Math.min(600, Math.round(secs.reduce((a: number, n: number) => a + n, 0)))),
        }));
      })
      .catch(() => {});
    window.history.replaceState({}, "", window.location.pathname);
  }, []);
'''

BANNER = '''
      {omniSeconds.length > 0 && (
        <div className="text-xs mb-3 px-3 py-2 rounded" style={{ border: "1px solid rgba(197,139,255,.4)", color: "#c58bff" }}>
          Pacing copied from {omniSource ?? "a video you watched"} — {omniSeconds.length} shots,
          {" "}{Math.round(omniSeconds.reduce((a, n) => a + n, 0))}s. The words are yours; only the timing came across.
        </div>
      )}
'''


def patch_director():
    try:
        s = read(director)
    except OSError:
        return None
    if "omni-brief" in s:
        return "already patched"

    anchor = '  const [err, setErr] = useState<string | null>(null);'
    if anchor not in s:
        return None
    s = s.replace(anchor, anchor + "\n" + BRIDGE, 1)

    # Ask for one scene per idea. The route clamps this itself, so a wild number here
    # cannot break anything downstream — it just stops being honoured.
    old_script = 'body: JSON.stringify({ topic: run.topic, durationSec: run.durationSec }),'
    new_script = ('body: JSON.stringify({ topic: run.topic, durationSec: run.durationSec, '
                  '...(omniSeconds.length ? { sceneCount: omniSeconds.length } : {}) }),')
    if old_script not in s:
        return None
    s = s.replace(old_script, new_script, 1)

    # Carry the durations into the edit. Absent them, assemble falls back to weighting
    # scenes by word count — a fine default and the exact opposite of what a copied
    # rhythm needs.
    # The graphic scenes, too. Where the watched video held a text card rather than
    # footage, the brief says so, and the assembler draws a card instead of playing a
    # clip — which is both cheaper (no generated b-roll for that scene) and closer to
    # what was actually on screen.
    #
    # The card shows the scene's own caption, written by the script for the person's
    # own topic. A ranked list or a comparison would be a better card, but it needs
    # data the script route does not produce today — it writes prose and a caption,
    # not tables. Worth doing when it does; guessing a ranking out of a caption would
    # be inventing numbers.
    old_scenes = ('const scenes = run.script.scenes.map((s, i) => ({ caption: s.caption, '
                  'narration_line: s.narration_line, brollUrl: run.broll[i]?.url }));')
    new_scenes = ('const scenes = run.script.scenes.map((s, i) => ({ caption: s.caption, '
                  'narration_line: s.narration_line, brollUrl: run.broll[i]?.url, '
                  '...(omniSeconds[i] ? { seconds: omniSeconds[i] } : {}), '
                  '...(omniGraphic[i] && s.caption ? { graphic: { kind: "stat", value: s.caption } } : {}) }));')
    if old_scenes not in s:
        return None
    s = s.replace(old_scenes, new_scenes, 1)

    # Say on screen where the pacing came from. A number that arrived from somewhere
    # the person cannot see is a number they cannot trust.
    # As a SIBLING in the children list, above the error line — not inside the
    # `{run.stage === "brief" && (…)}` expression, which holds exactly one element and
    # turns into a syntax error the moment a second one is pushed in beside it. (Tried
    # that first; tsc said so in four places.)
    banner_anchor = '      <Stepper stage={run.stage} />\n'
    if banner_anchor in s and "Pacing copied from" not in s:
        s = s.replace(banner_anchor, banner_anchor + BANNER, 1)

    write(director, s)
    return "patched"


# ── 2. stop the script route throwing scenes away ──────────────────────────────
#
# The route accepts sceneCount up to 24 and then slices the result to 12, so asking
# for more than twelve scenes silently loses the rest. That ceiling is invisible from
# the caller's side: the request succeeds and the plan comes back short.
def patch_script_cap():
    try:
        s = read(script_route)
    except OSError:
        return None
    if "omni-scene-cap" in s:
        return "already patched"
    old = "j.scenes = j.scenes.slice(0, 12)"
    if old not in s:
        return None
    s = s.replace(old, "j.scenes = j.scenes.slice(0, 60) /* omni-scene-cap: a copied rhythm can have fifty-odd scenes */", 1)
    # The clamp on the requested count has to move with it, or asking for 30 still
    # yields 24.
    s = s.replace("Math.min(24, Number(body.sceneCount)", "Math.min(60, Number(body.sceneCount)", 1)
    write(script_route, s)
    return "patched"


# ── 3. the cards the script may put on screen ──────────────────────────────────
#
# The script model is allowed to mark a scene as a card instead of footage and to write
# that card's data from the person's OWN topic and narration. Nothing from the watched
# video is copied, and no field of the OmniWatch brief is forwarded by this change — the
# angle/structure forwarding is a separate proposal that has not been authorised.
#
# The canonical copy of this half lives in patches/auto-script-graphics.ts, so it can be
# read without opening Agent OS's file. This function is what puts it back after an Agent
# OS update overwrites the route.
GRAPHIC_TYPE_OLD = 'interface Scene { caption: string; narration_line: string; broll_prompt: string }'
GRAPHIC_TYPE_NEW = 'interface Scene { caption: string; narration_line: string; broll_prompt: string; graphic?: SceneGraphic }'

GRAPHIC_PROMPT_OLD = '      "broll_prompt": "a vivid, concrete prompt for an AI video generator to make 6s of cinematic b-roll for this beat — describe subject, motion, setting, lighting, camera move. No text overlays, no people speaking."'
GRAPHIC_PROMPT_NEW = GRAPHIC_PROMPT_OLD + ''',
      "graphic": {"kind": "stat", "value": "12", "caption": "the one number that matters"}'''

GRAPHIC_RULE_OLD = '- Be accurate. If you used web research, reflect real current facts in research_notes. Never invent statistics.'
GRAPHIC_RULE_NEW = '''- A beat is sometimes better shown as a CARD than as footage — a ranked list, one big number, a comparison, a held quote. For those scenes ONLY, add "graphic" with kind "ranking" | "stat" | "compare" | "quote" and the data it needs, written from THIS topic and THIS script's own narration. Every other scene gets no "graphic" key at all.
- Be accurate. If you used web research, reflect real current facts in research_notes. Never invent statistics.'''

GRAPHIC_NORMALISE_OLD = '      broll_prompt: String(s.broll_prompt ?? "").slice(0, 600),'
GRAPHIC_NORMALISE_NEW = GRAPHIC_NORMALISE_OLD + '\n      graphic: sanGraphic(s.graphic),'

GRAPHIC_HELPERS = '''
// ── the card a scene may carry (sentinel: omni-graphic-v2) ────────────────────
// A card is only a card if it has the shape the assembler draws. The model writes this
// from the person's own topic and narration; anything malformed is dropped rather than
// guessed, and a scene without one is simply footage.
type SceneGraphic =
  | { kind: "ranking"; title?: string; items: { label: string; value?: string }[] }
  | { kind: "stat"; title?: string; value: string; caption?: string }
  | { kind: "compare"; title?: string; left: { label: string; items: string[] }; right: { label: string; items: string[] } }
  | { kind: "quote"; text: string; attribution?: string };

function sanGraphic(g: unknown): SceneGraphic | undefined {
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
'''


def patch_script_graphics():
    try:
        s = read(script_route)
    except OSError:
        return None
    if "omni-graphic-v2" in s:
        return "already patched"

    s, hit = sub1(s, GRAPHIC_TYPE_OLD, GRAPHIC_TYPE_NEW)
    if not hit:
        return None
    s, hit = sub1(s, "export async function POST(req: Request) {",
                  GRAPHIC_HELPERS + "\nexport async function POST(req: Request) {")
    if not hit:
        return None
    s, hit = sub1(s, GRAPHIC_PROMPT_OLD, GRAPHIC_PROMPT_NEW)
    if not hit:
        return None
    s, hit = sub1(s, GRAPHIC_RULE_OLD, GRAPHIC_RULE_NEW)
    if not hit:
        return None
    s, hit = sub1(s, GRAPHIC_NORMALISE_OLD, GRAPHIC_NORMALISE_NEW)
    if not hit:
        return None

    write(script_route, s)
    return "patched"


# ── 4. stop, rather than ignore, a request that carries a brief ────────────────
#
# The Director can send the brief's angle and per-scene visual hints. The author that
# would honour them is not authorised or set up here, and the legacy author would write a
# script that silently ignores both while looking like it used them. This guard is the
# honest answer until that author exists: a clear 503 before any provider is called.
#
# It also refuses a scene count above the ceiling instead of trimming it, and answers a
# body that is not an object with a 400 instead of throwing.
#
# Sentinel: omni-author-pending. Re-running is a no-op, and a request that carries neither
# field keeps the old behaviour exactly.
PENDING_OLD = '''export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const topic = String(body.topic ?? "").trim();'''

PENDING_NEW = '''// sentinel: omni-author-pending — re-running patch-director.py is a no-op.
const hasOwn = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export async function POST(req: Request) {
  const parsed: unknown = await req.json().catch(() => null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return NextResponse.json({ error: "Send a JSON object with a topic." }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;

  // A brief arriving is the presence of the field, not the truthiness of its value: an
  // empty angle or an all-b-roll hint list is still a brief we cannot author.
  if (hasOwn(body, "angle") || hasOwn(body, "sceneHints")) {
    return NextResponse.json({
      error: "OmniWatch script authoring is pending authorization/setup on this machine. "
        + "This request carries a brief (angle/sceneHints); the legacy author ignores those fields, "
        + "so nothing was written.",
      pending: "omniwatch-script-author",
    }, { status: 503 });
  }

  const topic = String(body.topic ?? "").trim();'''

CAP_OLD = '  const sceneCount = Math.max(3, Math.min(60, Number(body.sceneCount) || Math.round(durationSec / 22)));'
CAP_NEW = '''  const wanted = Math.max(1, Number(body.sceneCount) || Math.round(durationSec / 22));
  if (wanted > 60) {
    return NextResponse.json({ error: `sceneCount ${wanted} is above the 60-scene ceiling — split the brief.` }, { status: 413 });
  }
  const sceneCount = Math.max(3, Math.min(60, wanted));'''


# ── 4. the OmniWatch author: Flash through the model-only loopback transport ────
#
# Superseded by this step: the earlier "pending guard" that answered 503 for any request
# carrying a brief. The user has explicitly approved sending the brief's topic, angle and
# scene structure to DeepSeek V4.1 Flash through the local codex-router, so the guard is
# gone and the brief is authored. The transport is one plain HTTP request to the router's
# pinned loopback Responses endpoint with NO `tools` field — the router's own caller-auth
# documentation describes exactly that ("a bearer sent to the plain loopback Responses
# endpoint"). Nothing here starts an agent, and no other provider ever receives the brief:
# if Flash cannot answer, the request fails with the reason instead of falling through.
FLASH_SENTINEL = "omni-author-flash-v3"

FLASH_IMPORT_OLD = 'import { spawn } from "node:child_process";'
FLASH_IMPORT_NEW = 'import { spawn } from "node:child_process";\nimport { readFileSync } from "node:fs";\nimport os from "node:os";'

FLASH_PENDING_OLD = '''  // ── the OmniWatch brief is not authorised here yet (sentinel: omni-author-pending) ──
  // A request that carries a brief — an angle, or per-scene visual hints, even an empty
  // angle or an all-b-roll hint list — is asking for a script written *to* that brief.
  // The author that would do that is not authorised or set up on this machine, and the
  // legacy path would write a script that ignores both fields while looking as if it
  // honoured them. So it stops here, before any provider is called.
  if (hasOwn(body, "angle") || hasOwn(body, "sceneHints")) {
    return NextResponse.json({
      error: "OmniWatch script authoring is pending authorization/setup on this machine. "
        + "This request carries a brief (angle/sceneHints); the legacy author ignores those fields, "
        + "so nothing was written.",
      pending: "omniwatch-script-author",
    }, { status: 503 });
  }
'''

FLASH_PENDING_NEW = '''  // The brief author is now live and authorised (sentinel: omni-author-flash-v3): a request
  // carrying `angle` or `sceneHints` — even an empty angle or an all-b-roll hint list — is
  // written by Flash through the model-only loopback transport below, never by the legacy
  // authors, which would ignore those fields while looking as if they honoured them.
'''

FLASH_SCENECOUNT_OLD = '  const sceneCount = Math.max(3, Math.min(60, wanted));'
FLASH_SCENECOUNT_NEW = '''  // An explicit count is honoured exactly, including 1 and 2 — a copied rhythm that asked
  // for two scenes must not silently become three. Without one, the old floor stands.
  const explicitCount = hasOwn(body, "sceneCount") && Number.isFinite(Number(body.sceneCount)) && Number(body.sceneCount) >= 1;
  const sceneCount = explicitCount ? Math.round(Number(body.sceneCount)) : Math.max(3, Math.min(60, wanted));'''

FLASH_SYSTEM_OLD = '  const system = authorSystem(durationSec, sceneCount, tone);'
FLASH_SYSTEM_NEW = '''  const brief = planAuthorship(body, sceneCount);
  const system = authorSystem(durationSec, sceneCount, tone) + brief.structureNote +
    `\\n\\n- Write the narration in the language of the topic above. If the topic is in English, write English. Never mix languages.` +
    (brief.briefDriven ? `\\n- You have no web access in this run. Do not claim research and do not cite sources you could not verify.` : "");'''

FLASH_ENGINE_OLD = '  let engine: "grok" | "claude" | "local" = "grok";'
FLASH_ENGINE_NEW = '  let engine: "grok" | "claude" | "local" | "codex" = "grok";'

FLASH_GROK_OLD = '''  const g = await authorWithGrok(system, topic);
  if (g) script = extractJson(g);
'''
FLASH_GROK_NEW = '''  // A brief goes to ONE engine, explicitly: Flash via the local codex-router, model-only.
  // If it cannot run, the request fails with a readable reason instead of falling through to
  // Grok or Claude with a payload they were never authorised to receive.
  if (brief.briefDriven) {
    const flash = await authorWithFlash(system, brief.angle ? `${topic}\\n\\nTHE PERSON'S OWN ANGLE: ${brief.angle}` : topic);
    if (flash.ok) script = extractJson(flash.text);
    if (script) engine = "codex";
    if (!script) {
      return NextResponse.json({
        error: "Could not author the script from your OmniWatch brief.",
        detail: flash.ok
          ? "The Flash author returned something that is not a usable script. Nothing was sent to Grok or Claude."
          : `${flash.error} Nothing was sent to Grok or Claude.`,
      }, { status: 502 });
    }
  }

  if (!script) {
    const g = await authorWithGrok(system, topic);
    if (g) script = extractJson(g);
  }
'''

FLASH_RETURN_OLD = '  return NextResponse.json({ ok: true, script, engine });'
FLASH_RETURN_NEW = '''  // The count is only enforced when the caller asked for one: a copied rhythm is only copied
  // if it lands on the same number of scenes, and 1 or 2 are legitimate answers. The legacy
  // path keeps its old behaviour, where the model is free to return fewer.
  if (script.scenes.length > 60) {
    return NextResponse.json({
      ok: false,
      error: `Script came back with ${script.scenes.length} scenes, over the 60-scene ceiling.`,
      detail: "Nothing was trimmed silently — retry, or ask for a shorter plan.",
      script,
    }, { status: 502 });
  }
  if (explicitCount && script.scenes.length !== sceneCount) {
    return NextResponse.json({
      ok: false,
      error: `Script came back with ${script.scenes.length} scenes, not the ${sceneCount} this rhythm needs.`,
      detail: "A copied rhythm is only copied when the scene count matches. Retry, or ask for a different length.",
      script,
    }, { status: 502 });
  }
  // Captions are driven by the per-scene narration_line, so the parts have to add up to the
  // whole. A script whose parts do not match drifts out of sync on screen.
  if (explicitCount) {
    const parts = script.scenes.map((s) => s.narration_line.trim()).join(" ").replace(/\\s+/g, " ").trim();
    const whole = script.narration.replace(/\\s+/g, " ").trim();
    if (parts !== whole) {
      return NextResponse.json({
        ok: false,
        error: "The scenes' narration does not add up to the full narration.",
        detail: "Captions follow the per-scene lines, so a mismatch would drift the whole video out of sync. Retry.",
        script,
      }, { status: 502 });
    }
  }
  // A card slot the script left empty is an incomplete answer, and it is reported as one.
  // Nothing is invented to fill it: a card is drawn from the script's own data, so faking one
  // from the caption would put a made-up ranking or number on screen and call it real.
  if (brief.cardSlots.length) {
    const missing = brief.cardSlots.filter((n) => !script!.scenes[n - 1]?.graphic);
    if (missing.length) {
      return NextResponse.json({
        ok: false,
        incomplete: "graphic-slots",
        error: `The plan held a card at scene${missing.length === 1 ? " " : "s "}${missing.join(", ")}, and the script came back without a graphic for ${missing.length === 1 ? "it" : "them"}.`,
        detail: "A card is drawn from the script's own data, so an empty slot is reported rather than faked from its caption. Retry.",
        script,
      }, { status: 502 });
    }
  }
  return NextResponse.json({ ok: true, script, engine });'''

FLASH_SLICE_OLD = '    j.scenes = j.scenes.slice(0, 60) /* omni-scene-cap: a copied rhythm can have fifty-odd scenes */.map((s: Record<string, unknown>) => ({'
FLASH_SLICE_NEW = '''    // No slice here (omni-scene-cap): the count is validated in POST before anything is
    // trimmed, so an over-long answer is reported instead of quietly cut to the ceiling.
    j.scenes = j.scenes.map((s: Record<string, unknown>) => ({'''

FLASH_GRAPHIC_SHAPE_OLD = '      "graphic": {"kind": "stat", "value": "12", "caption": "the one number that matters"}'
FLASH_GRAPHIC_SHAPE_NEW = '      "graphic": {"kind": "ranking", "title": "short card title", "items": [{"label": "first item", "value": "optional"}]}'

FLASH_GRAPHIC_RULE_OLD = '- A beat is sometimes better shown as a CARD than as footage — a ranked list, one big number, a comparison, a held quote. For those scenes ONLY, add "graphic" with kind "ranking" | "stat" | "compare" | "quote" and the data it needs, written from THIS topic and THIS script\'s own narration. Every other scene gets no "graphic" key at all.'
FLASH_GRAPHIC_RULE_NEW = '''- A beat is sometimes better shown as a CARD than as footage — a ranked list, one big number, a comparison, a held quote. For those scenes ONLY, add "graphic", written from THIS topic and THIS script's own narration. The four accepted shapes are exactly:
  {"kind": "ranking", "title": "optional", "items": [{"label": "required", "value": "optional"}]}   (at least 2 items)
  {"kind": "stat", "title": "optional", "value": "required", "caption": "optional"}
  {"kind": "compare", "title": "optional", "left": {"label": "required", "items": ["required"]}, "right": {"label": "required", "items": ["required"]}}
  {"kind": "quote", "text": "required", "attribution": "optional"}
  A malformed card is discarded, so fill every required field. Every other scene gets no "graphic" key at all.'''

FLASH_TRANSPORT = '''
// ── Flash author transport (sentinel: omni-author-flash-v3) ───────────────────
// A MODEL-ONLY call to the local codex-router: one HTTP request to the pinned loopback
// Responses endpoint with NO `tools` field at all, so the model is handed nothing it could
// act with. This follows the router's own documentation (src/caller-auth.mjs): "Codex can
// authenticate the router either with the legacy path capability or with a bearer sent to
// the plain loopback Responses endpoint."
const FLASH_AUTHOR_MODEL = "opencode-go/deepseek-v4.1-flash";
const FLASH_ROUTER_URL = "http://127.0.0.1:4202/v1/responses";
const FLASH_TIMEOUT_MS = 120_000;
const FLASH_MAX_BODY = 1_000_000;
const FLASH_MAX_TOKENS = 12_000;
/** Composition references are evidence, so they keep their detail; the per-scene budget is
 *  generous and the whole note is capped so a long brief cannot blow up the request. */
const HINT_PER_SCENE_CHARS = 2_000;
const HINTS_TOTAL_CHARS = 24_000;

/** The router's caller capability, read from its own 0600 file. It is never logged, never
 *  placed in a URL, and only ever attached to the pinned loopback origin below. */
function readCallerCapability(): string | null {
  try {
    const p = path.join(os.homedir(), ".codex", "codex-router", "caller-secret");
    const s = readFileSync(p, "utf8").trim();
    return s || null;
  } catch { return null; }
}

type AuthorResult = { ok: true; text: string } | { ok: false; error: string };

async function authorWithFlash(system: string, prompt: string): Promise<AuthorResult> {
  let url: URL;
  try { url = new URL(FLASH_ROUTER_URL); } catch { return { ok: false, error: "The Flash author endpoint is malformed." }; }
  // Pinned BEFORE the credential is attached: loopback host, http, exact path.
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!loopback || url.pathname !== "/v1/responses") {
    return { ok: false, error: "The Flash author endpoint is not the pinned loopback Responses endpoint." };
  }
  const key = readCallerCapability();
  if (!key) return { ok: false, error: "The router caller capability is missing, so the brief is not sent anywhere." };

  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(FLASH_TIMEOUT_MS),
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: FLASH_AUTHOR_MODEL,
        input: [{ role: "user", content: [{ type: "input_text", text: `${system}\\n\\n${prompt}\\n\\nOutput ONLY the JSON object, nothing before or after it.` }] }],
        stream: false,
        max_output_tokens: FLASH_MAX_TOKENS,
        // No `tools` key: the model gets no tool surface to call.
      }),
    });
    if (!res.ok) return { ok: false, error: `The Flash author answered ${res.status}.` };

    // Bounded while reading, not after: a runaway answer is cut off instead of buffered.
    let raw = "";
    const reader = res.body?.getReader();
    if (reader) {
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += dec.decode(value, { stream: true });
        if (raw.length > FLASH_MAX_BODY) {
          try { await reader.cancel(); } catch { /* already closed */ }
          return { ok: false, error: "The Flash author's answer was too large to use." };
        }
      }
    } else {
      raw = await res.text();
      if (raw.length > FLASH_MAX_BODY) return { ok: false, error: "The Flash author's answer was too large to use." };
    }

    const j = JSON.parse(raw) as { output?: { type?: string; content?: { type?: string; text?: string }[] }[] };
    const items = Array.isArray(j.output) ? j.output : [];
    // `reasoning` items carry the model's scratch text; only `message` items are the answer.
    const final = items.filter((it) => it?.type === "message");
    const pick = final.length ? final : items;
    const text = pick
      .map((it) => (it.content ?? []).filter((p) => p?.type === "output_text").map((p) => p.text ?? "").join(""))
      .join("\\n")
      .trim();
    if (!text) return { ok: false, error: "The Flash author returned no text." };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: `The Flash author could not be reached: ${String(e)}` };
  }
}

/** Whether this request is driven by an OmniWatch brief — decided by the PRESENCE of the
 *  brief's fields, not their content. An all-footage brief carries `sceneHints` with no
 *  cards and no angle; it is still a brief, and it still goes to Flash only.
 *
 *  The hints are the structure of the watched video: order, per-scene seconds, whether the
 *  scene was a card or footage, and a short composition reference. They are handed over as
 *  something to ADAPT — same slots, same rhythm, different subject and words. */
function planAuthorship(body: Record<string, unknown>, sceneCount: number) {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const angle = typeof body.angle === "string" ? body.angle.trim().slice(0, 300) : "";
  const hints = Array.isArray(body.sceneHints) ? body.sceneHints.slice(0, 60) : [];
  const cardSlots: number[] = [];
  const lines: string[] = [];
  hints.forEach((h, i) => {
    if (!h || typeof h !== "object") return;
    const o = h as { role?: unknown; visual?: { kind?: unknown; hint?: unknown }; seconds?: unknown };
    const kind = o.visual?.kind === "graphic" ? "graphic" : "broll";
    if (kind === "graphic") cardSlots.push(i + 1);
    const secs = Number(o.seconds);
    const rawHint = typeof o.visual?.hint === "string" && o.visual.hint.trim()
      ? o.visual.hint.trim()
      : typeof o.role === "string" ? o.role.trim() : "";
    const hint = rawHint.slice(0, HINT_PER_SCENE_CHARS);
    lines.push(`  scene ${i + 1}: ${Number.isFinite(secs) && secs > 0 ? `${secs.toFixed(2)}s, ` : ""}${kind}${hint ? ` — composition reference: ${hint}` : ""}`);
  });
  // Composition references are evidence, so they keep their detail: a short role string is
  // lossy for a scene whose layout matters. The per-scene budget is generous and the whole
  // note is capped, so a long brief cannot blow up the request.
  let structure = lines.join("\\n");
  if (structure.length > HINTS_TOTAL_CHARS) structure = `${structure.slice(0, HINTS_TOTAL_CHARS)}\\n  (references truncated at ${HINTS_TOTAL_CHARS} characters)`;
  const structureNote = lines.length
    ? `\\n\\nSCENE PLAN FROM THE VIDEO THAT WAS WATCHED — a reference to adapt, never text to copy:\\n${structure}\\n` +
      `How closely to follow it is a judgement call, and the person's angle decides it. What transfers is the PATTERN — the order of beats, the rhythm (the seconds above are the timing to hit), and the kind of each scene — and what changes is the subject, the imagery and every word. Keep the structure that carries the meaning; do not force a whole-clone when the person's topic is better served by a different shape.\\n` +
      (cardSlots.length
        ? `REQUIRED: scene${cardSlots.length === 1 ? " " : "s "}${cardSlots.join(", ")} ${cardSlots.length === 1 ? "is" : "are"} a CARD, not footage. ${cardSlots.length === 1 ? "That scene" : "Each of those scenes"} MUST include a "graphic" object with kind "ranking" | "stat" | "compare" | "quote" and its own data, written from THIS topic and THIS script's own narration. A card scene returned without its "graphic" object is an incomplete answer.\\n`
        : "") +
      `Every scene that is not listed above gets no "graphic" key.\\n` +
      `Treat the composition references as evidence about how the reference video worked, not as content to reproduce. Do not reuse any sentence from the video that was watched.`
    : "";
  return { briefDriven: has("angle") || has("sceneHints"), angle, cardSlots, structureNote };
}
'''


def patch_script_flash_author():
    try:
        s = read(script_route)
    except OSError:
        return None
    if FLASH_SENTINEL in s:
        return "already patched"

    pairs = [
        (FLASH_IMPORT_OLD, FLASH_IMPORT_NEW),
        (FLASH_PENDING_OLD, FLASH_PENDING_NEW),
        (FLASH_SCENECOUNT_OLD, FLASH_SCENECOUNT_NEW),
        (FLASH_SYSTEM_OLD, FLASH_SYSTEM_NEW),
        (FLASH_ENGINE_OLD, FLASH_ENGINE_NEW),
        (FLASH_GROK_OLD, FLASH_GROK_NEW),
        (FLASH_RETURN_OLD, FLASH_RETURN_NEW),
        (FLASH_SLICE_OLD, FLASH_SLICE_NEW),
        (FLASH_GRAPHIC_SHAPE_OLD, FLASH_GRAPHIC_SHAPE_NEW),
        (FLASH_GRAPHIC_RULE_OLD, FLASH_GRAPHIC_RULE_NEW),
        ("export async function POST(req: Request) {", FLASH_TRANSPORT + "\nexport async function POST(req: Request) {"),
    ]
    for old, new in pairs:
        s, hit = sub1(s, old, new)
        if not hit:
            return None
    write(script_route, s)
    return "patched"


if __name__ == "__main__":
    for name, fn in (("VideoDirector", patch_director), ("auto/script cap", patch_script_cap),
                     ("auto/script graphics", patch_script_graphics),
                     ("auto/script flash author", patch_script_flash_author)):
        r = fn()
        print(f"  · {name}: {r or 'could not patch — Agent OS has changed shape here'}")
