#!/usr/bin/env python3
"""Nightly competitor scan for OmniWatch Scout.

Schedule it with Hermes' own scheduler:

    hermes cron create "0 6 * * *" --name omniwatch-scout \\
      --script omniwatch-scout.py --no-agent --deliver telegram

`--no-agent` means no model runs the schedule itself: this script *is* the job and
whatever it prints is what gets delivered. The thinking happens inside the scan —
Hermes scrapes through Apify, and OmniWatch watches the winners.

Python rather than bash because Hermes runs any non-.sh script with its own
interpreter, and Hermes is a Python program — so this behaves the same on macOS,
Linux and Windows, where bash may not exist.

Set OMNIWATCH_URL if the dashboard is not on the default port.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("OMNIWATCH_URL", "http://127.0.0.1:3000").rstrip("/")
POLL_SECONDS = 15
GIVE_UP_AFTER = 60 * 60  # a scan is a scrape plus a teardown per winner: minutes, not seconds


def call(path, payload=None, timeout=60):
    url = f"{BASE}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data,
        headers={"content-type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def quiet_exit(msg=""):
    """A cron that cries wolf every morning gets muted, and then it is useless on the
    day it matters. Nothing new to say means say nothing."""
    if msg:
        print(msg)
    sys.exit(0)


def main():
    try:
        started = call("/api/omniwatch/scout", {"action": "scan"}, timeout=30)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        err = ""
        try:
            err = json.loads(body).get("error", "")
        except ValueError:
            err = body[:200]
        # "nothing configured" is not a failure worth waking anyone for
        if "Add at least one" in err:
            quiet_exit()
        print(f"OmniWatch Scout could not start: {err}")
        sys.exit(1)
    except OSError as e:
        print(f"OmniWatch Scout could not reach the dashboard at {BASE}: {e}")
        sys.exit(1)

    job = started.get("id")
    if not job:
        quiet_exit()

    deadline = time.time() + GIVE_UP_AFTER
    while time.time() < deadline:
        time.sleep(POLL_SECONDS)
        try:
            poll = call(f"/api/omniwatch/scout?job={job}", timeout=30)
        except OSError:
            continue  # a dropped poll is not a failed scan
        state = poll.get("state")
        if state == "done":
            return report(poll.get("run") or {})
        if state == "error":
            print(f"OmniWatch Scout failed: {poll.get('error') or 'unknown error'}")
            sys.exit(1)
        if state == "gone":
            print("OmniWatch Scout: the dashboard restarted mid-scan.")
            sys.exit(1)

    print("OmniWatch Scout is still running after an hour — check the Scout tab.")
    sys.exit(1)


def first_section(text, heading):
    """Pull one '## <heading>' section out of a teardown."""
    for block in (text or "").split("## "):
        if block.lower().startswith(heading.lower()):
            return " ".join(block.split("\n")[1:]).strip()
    return ""


def report(run):
    teardowns = run.get("teardowns") or []
    if not teardowns:
        quiet_exit()  # nothing beat its baseline; a silent morning is the right answer

    by_url = {c.get("url"): c for c in (run.get("candidates") or [])}
    lines = [f"OmniWatch Scout — {len(teardowns)} new winner(s) out of {run.get('scanned', 0)} videos", ""]
    for t in teardowns:
        c = by_url.get(t.get("url"), {})
        lines.append(f"• {t.get('title') or t.get('url')}")
        if c:
            lines.append(f"  {c.get('why', '')} · @{c.get('author', '')}")
        hook = first_section(t.get("text"), "the hook")
        if hook:
            lines.append(f"  Hook: {hook[:220]}")
        lines.append(f"  {t.get('url')}")
        lines.append("")
    lines.append("Full teardowns and the adapted scripts: the Scout tab in Agent OS.")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
