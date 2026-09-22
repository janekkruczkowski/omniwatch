#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["openai>=1.52", "rich>=13", "requests>=2.31", "fastapi>=0.110", "uvicorn>=0.29"]
# ///
"""OmniWatch web UI — paste a link, ask a question, Qwen Omni watches the video for you.

    uv run app.py            # http://localhost:8765
"""
from __future__ import annotations

import json
import queue
import subprocess
import threading
import time

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse

import omniwatch as ow

PRICE_IN, PRICE_OUT = 0.15 / 1e6, 0.47 / 1e6  # USD per token, qwen3.8-omni-flash
STRIP = 16  # thumbnails in the film strip

app = FastAPI()


@app.get("/")
def index():
    return FileResponse(ow.ROOT / "static" / "index.html")


@app.get("/i18n.json")
def i18n():
    return FileResponse(ow.ROOT / "static" / "i18n.json")


def cached_video(vid: str):
    src = ow.CACHE / vid / "source.mp4"
    if not vid.replace("-", "").replace("_", "").isalnum() or not src.exists():
        raise HTTPException(404)
    return src


@app.get("/video/{vid}.mp4")
def video(vid: str):
    """The downloaded file itself — plays any platform yt-dlp supports; Range requests make seeking work."""
    return FileResponse(cached_video(vid), media_type="video/mp4")


@app.get("/frame/{vid}/{sec}.jpg")
def frame(vid: str, sec: int):
    """A real frame from the downloaded video — visual proof of what the model saw."""
    src = cached_video(vid)
    out = ow.CACHE / vid / "frames" / f"{sec}.jpg"
    if not out.exists():
        out.parent.mkdir(exist_ok=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(sec), "-i", str(src),
                        "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", str(out)], check=True)
    return FileResponse(out, headers={"Cache-Control": "max-age=86400"})


def pipeline(url: str, question: str, lang: str, mode: str, emit):
    t0 = time.time()
    cli = ow.client()

    emit("stage", step="download")
    info, src = ow.fetch(url)
    seconds = info.get("duration") or 0
    emit("meta", id=info["id"], title=info.get("title"), channel=info.get("channel") or info.get("uploader"),
         duration=ow.fmt(seconds), seconds=seconds,
         strip=[round(seconds * (i + 0.5) / STRIP) for i in range(STRIP)])
    emit("stage", step="upload")

    def on_event(name, **d):
        if name == "watch":
            emit("stage", step="watch", parts=d["n"], fps=d["fps"])
        elif name in ("parts", "uploaded", "part_done", "merge"):
            emit(name, **d)

    last = [0.0]

    def on_tok(txt):
        if last[0] == 0.0:
            emit("stage", step="answer")
        if time.time() - last[0] > 0.1:
            last[0] = time.time()
            emit("answer", text=txt)

    answer, st = ow.watch(cli, info, src, question, lang, on_event, on_tok, mode)
    emit("answer", text=answer)
    ow.save(info, url, question, answer, lang, mode)
    emit("done", seconds=round(time.time() - t0), tokens=st["in"] + st["out"], parts=st["parts"],
         reused=st["reused"], cost=round(st["in"] * PRICE_IN + st["out"] * PRICE_OUT, 4))


@app.get("/api/watch")
def api_watch(url: str, q: str = "", lang: str = ow.LANG, mode: str = "ask"):
    events: queue.Queue = queue.Queue()

    def emit(event, **data):
        events.put(f"event: {event}\ndata: {json.dumps(data)}\n\n")

    def worker():
        try:
            pipeline(url, q, lang if lang in ow.I18N else ow.LANG, "teardown" if mode == "teardown" else "ask", emit)
        except Exception as e:  # surface any failure to the UI
            emit("error", message=str(e)[-600:])
        finally:
            events.put(None)

    threading.Thread(target=worker, daemon=True).start()

    def gen():
        while (item := events.get()) is not None:
            yield item

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


if __name__ == "__main__":
    if gone := ow.cleanup():
        print(f"Cache: removed {len(gone)} unused video(s) (older than {ow.CACHE_TTL / 3600:.0f} h)")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
