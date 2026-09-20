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


if __name__ == "__main__":
    for name, fn in (("VideoDirector", patch_director), ("auto/script", patch_script_cap)):
        r = fn()
        print(f"  · {name}: {r or 'could not patch — Agent OS has changed shape here'}")
