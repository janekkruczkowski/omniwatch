# /// script
# dependencies = ["playwright==1.63.0"]
# ///
"""Record a real OmniWatch run for the demo GIF. Server must be on :8765.

    uv run demo/record.py '<url>' '<topic>' [ask|teardown] [lang]
"""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "https://www.tiktok.com/@techfren/video/7437375434196552968"
TOPIC = sys.argv[2] if len(sys.argv) > 2 else "AI automation for small business owners"
MODE = sys.argv[3] if len(sys.argv) > 3 else "teardown"
LANG = sys.argv[4] if len(sys.argv) > 4 else "en"
OUT = Path(__file__).parent
W, H = 1280, 800

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": W, "height": H}, record_video_dir=str(OUT / "video"),
                              record_video_size={"width": W, "height": H})
    page = ctx.new_page()
    t0 = time.time()
    page.goto("http://localhost:8765")
    page.wait_for_selector("#go:not(:empty)")
    page.select_option("#lang", LANG)
    page.wait_for_timeout(600)
    if MODE == "teardown":
        page.click("#mTear")
        page.wait_for_timeout(400)
    page.fill("#url", "")
    page.type("#url", URL, delay=18)
    page.wait_for_timeout(300)
    page.type("#q", TOPIC, delay=22)
    page.wait_for_timeout(500)
    page.click("#go")
    t_click = time.time() - t0
    page.wait_for_selector(".qa .stats", timeout=600_000)
    t_done = time.time() - t0
    page.wait_for_timeout(1500)
    for _ in range(4):
        page.mouse.wheel(0, 130); page.wait_for_timeout(240)
    page.evaluate("document.querySelector('.tl')?.scrollIntoView({behavior:'smooth', block:'start'})")
    page.wait_for_timeout(3500)
    for _ in range(10):
        page.mouse.wheel(0, 120); page.wait_for_timeout(220)
    page.wait_for_timeout(2500)
    t_end = time.time() - t0
    video = page.video.path()
    ctx.close(); browser.close()

(OUT / "timings.json").write_text(json.dumps({"video": video, "click": t_click, "done": t_done, "end": t_end}))
print(json.dumps({"video": video, "click": round(t_click, 1), "run_s": round(t_done - t_click, 1)}))
