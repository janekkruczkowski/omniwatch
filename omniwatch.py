#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["openai>=1.52", "rich>=13", "requests>=2.31"]
# ///
"""omniwatch — ask a video a question; Qwen3.8-Omni-Flash watches it for you.

The model gets the whole video at once (picture + sound, not a transcript), so it has the full
context and sees slides, demos, code and charts.

    uv run omniwatch.py <url> [-q "question"] [--lang en]

Pipeline: yt-dlp → temporary upload to Model Studio (oss://, 48 h) → one request to Omni.
Videos longer than PART_MAX (courses etc.) are watched in equal parts in parallel, then merged.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from openai import OpenAI
from rich.console import Console
from rich.live import Live
from rich.markdown import Markdown
from rich.panel import Panel

ROOT = Path(__file__).parent
for line in (ROOT / ".env").read_text().splitlines() if (ROOT / ".env").exists() else []:
    k, _, v = line.partition("=")
    if k.strip() and not k.startswith("#"):
        os.environ.setdefault(k.strip(), v.strip())

MODEL = os.getenv("OMNI_MODEL", "qwen3.8-omni-flash")
API = os.getenv("DASHSCOPE_API", "https://dashscope-intl.aliyuncs.com")
I18N = json.loads((ROOT / "static" / "i18n.json").read_text())
LANG = os.getenv("OMNI_LANG", "en")  # answer language; see static/i18n.json
CACHE = ROOT / ".cache"
OUT = ROOT / "summaries"
# Measured: 480p at the default 2 fps costs ~350 video tokens per second (8:25 -> 177k).
# 40 min ≈ 840k tokens, leaving ~150k of the 991k input for the prompt and question. 50 min would overflow.
PART_MAX = int(float(os.getenv("OMNI_PART_MINUTES", "40")) * 60)  # longer videos are split into equal parts
OSS_TTL = 47 * 3600              # oss:// URLs live 48 h; refresh an hour early
CACHE_TTL = float(os.getenv("OMNI_CACHE_HOURS", "48")) * 3600  # local videos go once Qwen's copy expires anyway
SHORT_MAX = 3 * 60               # shorts/reels/TikToks: fast cuts, so sample at the API maximum
FPS_SHORT, FPS_LONG = 10, 2      # API accepts 0.1–10 fps; 2 is its default for normal videos
console = Console()


# ---------- download ----------

def run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed:\n{p.stderr[-2000:]}")
    return p.stdout


def cleanup() -> list[str]:
    """Delete cached videos (source, parts, frames) not used for CACHE_TTL. Answers in summaries/ stay."""
    removed = []
    for d in CACHE.glob("*/"):
        info = d / "info.json"
        if time.time() - (info.stat().st_mtime if info.exists() else d.stat().st_mtime) > CACHE_TTL:
            shutil.rmtree(d, ignore_errors=True)
            removed.append(d.name)
    return removed


def cache_key(url: str) -> str:
    """yt-dlp handles YouTube, TikTok, Instagram, Facebook, X… — key the cache by the normalized URL."""
    m = re.search(r"(?:youtube\.com/(?:watch\?v=|shorts/|live/|embed/)|youtu\.be/)([\w-]{11})", url)
    if m:
        return m.group(1)
    return hashlib.sha1(re.sub(r"[?#].*$", "", url.strip().rstrip("/")).encode()).hexdigest()[:16]


def fps_for(info: dict) -> int:
    return FPS_SHORT if (info.get("duration") or 0) <= SHORT_MAX else FPS_LONG


def fmt(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 3600}:{sec // 60 % 60:02d}:{sec % 60:02d}" if sec >= 3600 else f"{sec // 60}:{sec % 60:02d}"


def fetch(url: str) -> tuple[dict, Path]:
    """Download once; follow-up questions about the same video reuse the cache (no yt-dlp call)."""
    cleanup()
    vdir = CACHE / cache_key(url)
    cached = vdir / "info.json"
    if cached.exists() and (vdir / "source.mp4").exists():
        info = json.loads(cached.read_text())
        cached.touch()  # keeps a video you're still asking about from being cleaned up
    else:
        info = json.loads(run(["yt-dlp", "-J", "--no-playlist", url]))
        info = {k: info.get(k) for k in ("title", "channel", "uploader", "duration", "extractor_key")}
        info["id"] = vdir.name
        vdir.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(info))
    src = vdir / "source.mp4"
    if not src.exists():
        # 480p is plenty for reading slides/code and keeps even a long part well under the 1 GB upload limit
        run(["yt-dlp", "--no-playlist", "-q", "--no-warnings", "-N", "8",
             "-f", "bv*[height<=480]+ba/b[height<=480]/bv*+ba/b",
             "--merge-output-format", "mp4", "-o", str(src), url])
    return info, src


def parts(info: dict, src: Path) -> list[tuple[float, Path]]:
    """[(start_seconds, file)]. Whole video if it fits one request, else equal parts of <= PART_MAX."""
    seconds = float(info.get("duration") or 0)
    n = max(1, -(-int(seconds) // PART_MAX))
    if n == 1:
        return [(0.0, src)]
    length = seconds / n
    out = []
    for i in range(n):
        dst = src.parent / f"part_{n}_{i}.mp4"
        if not dst.exists():  # stream copy: no re-encode, cuts land on the nearest keyframe
            run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{i * length}", "-t", f"{length}",
                 "-i", str(src), "-c", "copy", "-avoid_negative_ts", "make_zero", str(dst)])
        out.append((i * length, dst))
    return out


# ---------- upload to Model Studio temp storage ----------

def upload(src: Path) -> tuple[str, bool]:
    """Returns (oss:// url, reused). The URL is cached next to the video for follow-up questions."""
    meta = src.parent / "oss.json"
    known = json.loads(meta.read_text()) if meta.exists() else {}
    m = known.get(src.name)
    if m and time.time() - m["at"] < OSS_TTL:
        return m["url"], True
    auth = {"Authorization": f"Bearer {os.environ['DASHSCOPE_API_KEY']}"}
    r = requests.get(f"{API}/api/v1/uploads", headers=auth, params={"action": "getPolicy", "model": MODEL}, timeout=30)
    r.raise_for_status()
    d = r.json()["data"]
    key = f"{d['upload_dir']}/{src.name}"
    with src.open("rb") as f:
        r = requests.post(d["upload_host"], timeout=900, files={
            "OSSAccessKeyId": (None, d["oss_access_key_id"]), "Signature": (None, d["signature"]),
            "policy": (None, d["policy"]), "x-oss-object-acl": (None, d["x_oss_object_acl"]),
            "x-oss-forbid-overwrite": (None, d["x_oss_forbid_overwrite"]), "key": (None, key),
            "success_action_status": (None, "200"), "file": (src.name, f)})
    r.raise_for_status()
    url = f"oss://{key}"
    known[src.name] = {"url": url, "at": time.time()}
    meta.write_text(json.dumps(known))
    return url, False


# ---------- Omni ----------

def client() -> OpenAI:
    key = os.getenv("DASHSCOPE_API_KEY")
    if not key:
        sys.exit("Set DASHSCOPE_API_KEY (Alibaba Model Studio / QwenCloud — see .env.example).")
    # the header lets the compatible-mode endpoint resolve oss:// temp URLs
    return OpenAI(api_key=key, base_url=f"{API}/compatible-mode/v1",
                  default_headers={"X-DashScope-OssResourceResolve": "enable"})


def stream(cli: OpenAI, content, on_token=None) -> tuple[str, object]:
    """Omni only supports streaming. Returns (text, usage)."""
    resp = cli.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": content}],
        modalities=["text"],
        stream=True,
        stream_options={"include_usage": True},
        extra_body={"enable_thinking": False},  # on by default; silent reasoning only adds latency here
    )
    text, usage = [], None
    for ev in resp:
        if ev.choices and ev.choices[0].delta.content:
            text.append(ev.choices[0].delta.content)
            if on_token:
                on_token("".join(text))
        elif getattr(ev, "usage", None):
            usage = ev.usage
    return "".join(text), usage


SECTIONS_SUMMARY = """## {tldr}
2-3 sentences.

## {takeaways}
5-8 bullets, concrete and actionable.

## {visual}
4-7 bullets of things that come from the visuals (screens, demos, slides, code, charts, on-screen text) —
not from what is said. Start every bullet with the `[{ts}]` where it appears.

## {timeline}
Bullets starting with `[{ts}]` + one line, max ~12, covering the whole video.

## {verdict}
One line verdict + which timestamp to jump to."""

SECTIONS_QUESTION = """## {answer}
A direct answer in 2-6 sentences. If the video does not answer the question (or only partly), say so plainly first.

## {evidence}
3-8 bullets, each starting with `[{ts}]`: what is said or SHOWN at that moment (screens, UI, code, slides,
charts, on-screen text) that supports the answer. Prefer moments where something relevant is visible.

## {gaps}
1-3 bullets: gaps, caveats, or what you'd still need to check. Skip the section if there are none.

## {jump}
1-3 bullets starting with a single `[{ts}]` (no ranges) + why — the moments worth watching yourself for this question."""

SECTIONS_TEARDOWN = """## {hook}
What happens in the first 3 seconds — the exact words, the first shot, the on-screen text — and why it stops the scroll.

## {beats}
5-12 bullets starting with `[{ts}]`: every beat/shot — what is shown, what is said, what changes. This is the skeleton.

## {edit}
Cuts per 10 s, average shot length, camera moves, zooms, b-roll, captions style, aspect ratio, transitions. Be specific.

## {text}
Every piece of on-screen text worth copying (hook text, labels, numbers), with `[{ts}]`.

## {audio}
Voice (tone, pace, accent), music, sound effects, silence — and how they carry the pacing.

## {cta}
What the viewer is asked to do, when, and how it is phrased.

## {adapt}
A ready shot-by-shot script for {topic}, following the same structure — same beats and timing, new content.
Never copy their words; adapt the formula."""

TS_RULE = "Timestamps must be real positions in the video, written exactly like `[{ts}]`, one per bullet, no ranges."

TEARDOWN_TASK = """Take this video apart like a creator who wants to make something as good in their own niche.
Explain HOW it is made, not just what it says: hook, structure, pacing, editing, on-screen text, sound, CTA."""

WHOLE = """You are watching the whole video "{title}" by {channel} ({duration}) — video AND audio.
{task}
Base everything strictly on what is said and shown — never invent. Write in {lang}. Markdown, exactly these
sections, with the headings exactly as written (they are in {lang}):

{sections}

{ts_rule}"""

PART = """You are watching part {i}/{n} of the video "{title}" by {channel}. Watch AND listen.
{focus}
Write dense notes in {lang}. Prefix each note with its timestamp in THIS clip (it starts at [0:00]), like [12:34].
Max 15 notes. No intro, no outro."""

FOCUS_SUMMARY = """Note what is said (key claims, numbers, names, steps) and what is SHOWN that audio alone would miss
(slides, UI/screens, code, charts, demos, on-screen text). Be concrete."""

FOCUS_TEARDOWN = """Note HOW this part is made: every shot/beat, what is shown, what is said, on-screen text,
cuts and pacing, camera moves, music and sound, and any call to action. Be concrete and visual."""

FOCUS_QUESTION = """The user wants to know: {question}
Note only material that helps answer it — what is said and what is SHOWN (screens, UI, code, slides, charts,
on-screen text). Quote key phrases when they matter. If nothing in this part is relevant, reply with exactly one line:
NOTHING RELEVANT — <what this part is about, max 12 words>"""

MERGE = """Below are timestamped notes an AI took while watching the video "{title}" by {channel}
({duration}) in {n} parts — video AND audio. Timestamps are already positions in the full video.
{task}
Base everything strictly on the notes — never invent. Write in {lang}. Markdown, exactly these sections,
with the headings exactly as written (they are in {lang}):

{sections}

{ts_rule}

NOTES:
{notes}"""


def _vars(info: dict, question: str, lang: str, mode: str = "ask") -> dict:
    loc = I18N.get(lang) or I18N[LANG]
    seconds = info.get("duration") or 0
    ts = "h:mm:ss" if seconds >= 3600 else "m:ss"
    q = question.strip()
    if mode == "teardown":
        tpl, task = SECTIONS_TEARDOWN, TEARDOWN_TASK
    elif q:
        tpl, task = SECTIONS_QUESTION, f"The user will NOT watch it. They want to know:\n\nQUESTION: {q}\n"
    else:
        tpl, task = SECTIONS_SUMMARY, "Write a summary for someone who will NOT watch it."
    return dict(title=info.get("title", "?"), channel=info.get("channel") or info.get("uploader", "?"),
                duration=fmt(seconds), lang=loc["name"], question=q, ts_rule=TS_RULE.format(ts=ts),
                sections=tpl.format(ts=ts, topic=q or "the same niche as this video", **loc["sections"]),
                task=task)


def shift_timestamps(text: str, offset: float, length: float) -> str:
    """Part notes use part-relative [m:ss] / [h:mm:ss]; rewrite them as positions in the full video.
    A timestamp past the end of the part must already be absolute, so it is left as is."""
    def sub(m):
        t = int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
        return f"[{fmt(t if t > length + 5 else offset + t)}]"
    return re.sub(r"\[(?:(\d+):)?(\d{1,2}):(\d{2})\]", sub, text)


def video(url: str, fps: float) -> dict:
    return {"type": "video_url", "video_url": {"url": url}, "fps": fps}


def watch(cli: OpenAI, info: dict, src: Path, question: str = "", lang: str = LANG,
          on_event=lambda *a, **k: None, on_token=None, mode: str = "ask") -> tuple[str, dict]:
    """Whole video in one request when it fits; otherwise parts watched in parallel, then merged.
    Returns (answer, stats). on_event(name, **data) reports progress."""
    v = _vars(info, question, lang, mode)
    fps = fps_for(info)
    ps = parts(info, src)
    on_event("parts", n=len(ps), starts=[s for s, _ in ps])
    with ThreadPoolExecutor(8) as pool:
        uploads = list(pool.map(lambda p: upload(p[1]), ps))
    on_event("uploaded", reused=all(r for _, r in uploads))
    tokens = {"in": 0, "out": 0}

    def count(u):
        if u:
            tokens["in"] += u.prompt_tokens
            tokens["out"] += u.completion_tokens

    on_event("watch", n=len(ps), fps=fps)
    if len(ps) == 1:
        answer, u = stream(cli, [video(uploads[0][0], fps), {"type": "text", "text": WHOLE.format(**v)}], on_token)
        count(u)
    else:
        seconds = info.get("duration") or 0
        focus = (FOCUS_TEARDOWN if mode == "teardown" else
                 FOCUS_QUESTION.format(question=v["question"]) if v["question"] else FOCUS_SUMMARY)

        def one(i):
            start = ps[i][0]
            end = ps[i + 1][0] if i + 1 < len(ps) else seconds
            text = PART.format(i=i + 1, n=len(ps), focus=focus, **v)
            notes, u = stream(cli, [video(uploads[i][0], fps), {"type": "text", "text": text}])
            on_event("part_done", i=i)
            return shift_timestamps(notes, start, end - start), u

        with ThreadPoolExecutor(len(ps)) as pool:
            results = list(pool.map(one, range(len(ps))))
        for _, u in results:
            count(u)
        notes = "\n\n".join(f"### Part {i + 1} (from {fmt(ps[i][0])})\n{n}" for i, (n, _) in enumerate(results))
        on_event("merge")
        answer, u = stream(cli, MERGE.format(n=len(ps), notes=notes, **v), on_token)
        count(u)
    return answer, {"parts": len(ps), "fps": fps, "reused": all(r for _, r in uploads), **tokens}


def save(info: dict, url: str, question: str, answer: str, lang: str = LANG, mode: str = "ask") -> Path:
    """One markdown file per video; every question is appended as its own section."""
    OUT.mkdir(exist_ok=True)
    md = OUT / f"{info['id']}.md"
    if not md.exists():
        channel = info.get("channel") or info.get("uploader", "?")
        md.write_text(f"# {info.get('title')}\n\n{channel} · {fmt(info.get('duration') or 0)} · {url}\n")
    loc = I18N.get(lang) or I18N[LANG]
    heading = (f"🔧 {loc['ui']['teardownCard']}" + (f" — {question.strip()}" if question.strip() else "")) if mode == "teardown" \
        else (f"❓ {question.strip()}" if question.strip() else f"📋 {loc['ui']['summaryCard']}")
    with md.open("a") as f:
        f.write(f"\n---\n\n# {heading}\n\n_{time.strftime('%Y-%m-%d %H:%M')}_\n\n{answer}\n")
    return md


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description="Qwen Omni watches a video for you — ask it a question.")
    ap.add_argument("url")
    ap.add_argument("-q", "--question", default="", help="question about the video (empty = summary)")
    ap.add_argument("--lang", default=LANG, choices=sorted(I18N), help="answer language")
    ap.add_argument("--teardown", action="store_true", help="take the video apart: hook, beats, editing, CTA, your version")
    args = ap.parse_args()
    cli = client()
    t0 = time.time()

    with console.status("[bold cyan]yt-dlp[/] downloading…"):
        info, src = fetch(args.url)
    console.print(Panel.fit(f"[bold]{info.get('title')}[/]\n{info.get('channel') or info.get('uploader')} · "
                            f"{fmt(info.get('duration') or 0)}"
                            + (f"\n\n❓ {args.question}" if args.question else ""),
                            title="🎬 omniwatch", border_style="cyan"))

    status = console.status("[bold cyan]upload[/] sending the video to Model Studio…")
    live = Live(Markdown(""), console=console, refresh_per_second=12, vertical_overflow="visible")
    status.start()
    labels = {"watch": "[bold magenta]Omni[/] is watching…", "merge": "[bold magenta]Omni[/] is merging the parts…"}

    def on_event(name, **d):
        if name == "parts" and d["n"] > 1:
            console.print(f"[dim]Longer than {PART_MAX // 60} min → {d['n']} parts watched in parallel[/]")
        if name in labels and not live.is_started:
            status.update(labels[name] if d.get("n", 1) == 1 else f"[bold magenta]Omni[/] is watching {d['n']} parts…")

    def on_tok(s: str):
        if not live.is_started:
            status.stop()
            live.start()
        live.update(Markdown(s))

    try:
        answer, st = watch(cli, info, src, args.question, args.lang, on_event, on_tok,
                           "teardown" if args.teardown else "ask")
    finally:
        status.stop()
        live.stop()

    md = save(info, args.url, args.question, answer, args.lang, "teardown" if args.teardown else "ask")
    console.print(f"\n[dim]{st['in'] + st['out']:,} tokens · {time.time() - t0:.0f}s"
                  f"{' · upload cached' if st['reused'] else ''} · saved {md.relative_to(ROOT)}[/]")


if __name__ == "__main__":
    main()
