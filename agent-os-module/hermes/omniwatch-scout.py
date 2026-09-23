#!/usr/bin/env python3
"""Hermes launcher for the OmniWatch scan.

Schedule it with Hermes' own scheduler:

    hermes cron create "0 6 * * *" --name omniwatch-scout \\
      --script omniwatch-scout.py --no-agent --deliver telegram

`--no-agent` means no model runs the schedule itself: this script *is* the job and
whatever it prints is what gets delivered.

This file is a thin launcher and nothing else. It runs the shared CLI — the same
`runScan` the panel's manual button uses — so there is no second engine and no HTTP
dependency on the panel being open:

    omniwatch scan --collection <id> --trigger schedule --json
    omniwatch report --run <runId> --json          (manual re-read)

The collection id comes from Hermes (`--collection`, or OMNIWATCH_COLLECTION), never
from a prompt typed into a chat. Without one, the script scans every channel the
Scout tab saved with a schedule (daily / weekly) — each with its OWN saved goal
(summary by default; teardown only if the user chose it), incrementally and within
the channel's batch size and cost ceiling, all enforced by the shared scan. Zero new material prints nothing: a cron that cries
wolf every morning gets muted, and then it is useless on the day it matters.

Set OMNIWATCH_CLI if the runtime is not in the default place, and OMNIWATCH_DATA_DIR /
OMNIWATCH_CONFIG for a non-default data directory.

Reports printed today remain handed_off until a later invocation sees the
completed Hermes execution and its durable output. A failed or interrupted
Hermes delivery leaves the same report retryable without another analysis.
"""
import argparse
from datetime import datetime
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

def cli_entry():
    """Locate the shared CLI: explicit, then the release layout, then this checkout."""
    explicit = os.environ.get("OMNIWATCH_CLI")
    if explicit:
        return explicit
    for candidate in (
        HERE / ".." / ".." / "packages" / "omniwatch" / "dist" / "runtime" / "cli.js",
        HERE / ".." / ".." / "packages" / "omniwatch" / "src" / "runtime" / "cli.ts",
    ):
        if candidate.exists():
            return str(candidate.resolve())
    return None


def runtime_args():
    args = []
    data_dir = os.environ.get("OMNIWATCH_DATA_DIR")
    if data_dir:
        args += ["--data-dir", data_dir]
    config = os.environ.get("OMNIWATCH_CONFIG")
    if config:
        args += ["--config", config]
    return args


def run_cli(argv):
    """One CLI call. Arguments go as a list — never through a shell, never with secrets."""
    entry = cli_entry()
    if not entry:
        print(
            "OmniWatch: cannot find the shared CLI. Set OMNIWATCH_CLI to packages/omniwatch/dist/runtime/cli.js.",
            file=sys.stderr,
        )
        return None
    command = [os.environ.get("OMNIWATCH_NODE", "node"), entry, *argv, *runtime_args(), "--json"]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=3600)
    except OSError as error:
        print(f"OmniWatch: could not run the shared CLI: {error}", file=sys.stderr)
        return None
    except subprocess.TimeoutExpired:
        print("OmniWatch: the scan is still running after an hour; the report will be read next time.")
        return None
    if completed.returncode != 0:
        message = (completed.stderr or completed.stdout or "").strip().splitlines()
        last = message[-1] if message else "unknown error"
        print(f"OmniWatch: the shared CLI failed ({completed.returncode}): {last}", file=sys.stderr)
        return None
    for line in reversed(completed.stdout.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            return json.loads(line)
        except ValueError:
            continue
    return None


def describe(report):
    if not report:
        return ""
    return report.get("summary") or (
        f"{report.get('newAnalyses', 0)} nowych analiz, "
        f"{report.get('failedItems', 0)} bledow, {report.get('pendingItems', 0)} oczekuje\n"
    )


def hermes_home():
    return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))


def delivered_by_hermes(report_id):
    """Reconcile a previous handoff against Hermes' terminal execution ledger.

    A write to this script's stdout is not delivery: Hermes may die before saving
    the output or sending it. Only a completed execution with a persisted output
    containing this report's identity can close it. Unknown or failed executions
    remain retryable. Hermes retains the output and ledger in its own profile.
    """
    home = hermes_home()
    ledger = home / "cron" / "executions.db"
    if not ledger.is_file():
        return False
    try:
        jobs = json.loads((home / "cron" / "jobs.json").read_text(encoding="utf-8"))
        delivery_targets = {
            job.get("id"): job.get("deliver")
            for job in jobs.get("jobs", [])
            if job.get("no_agent") and job.get("script") == Path(__file__).name
        }
        with sqlite3.connect(f"file:{ledger}?mode=ro", uri=True) as db:
            executions = db.execute(
                "SELECT job_id, started_at, finished_at, delivery_outcome FROM executions "
                "WHERE status = 'completed' ORDER BY finished_at DESC LIMIT 1000"
            ).fetchall()
        marker = f"OmniWatch reportId: {report_id}\n"
        for job_id, started, finished, outcome in executions:
            target = delivery_targets.get(job_id)
            if not target or not started or not finished:
                continue
            if outcome != ("suppressed" if target == "local" else "delivered"):
                continue
            # 'suppressed' is the expected outcome of --deliver local: Hermes
            # persists the output file instead of sending an external message.
            job_dir = home / "cron" / "output" / job_id
            if not job_dir.is_dir():
                continue
            beginning = datetime.fromisoformat(started).timestamp()
            ending = datetime.fromisoformat(finished).timestamp()
            for output in job_dir.glob("*.md"):
                mtime = output.stat().st_mtime
                if beginning <= mtime <= ending and marker in output.read_text(encoding="utf-8"):
                    return True
    except (OSError, sqlite3.Error, ValueError, TypeError):
        pass
    return False


def emit_report(report, heading):
    """Hand a report to Hermes; confirmation waits for the next execution."""
    report_id = report.get("reportId") or report.get("id")
    if not report_id:
        print("OmniWatch: report has no durable id; leaving it pending", file=sys.stderr)
        return False
    text = describe(report)
    if not text:
        return True
    try:
        print(f"{heading}\nOmniWatch reportId: {report_id}\n{text}\n")
        sys.stdout.flush()
    except BrokenPipeError:
        return False
    return run_cli(["report", "--handoff", report_id]) is not None


def deliver_previous():
    """Read ALL undelivered reports from SQLite, never a single last-run marker."""
    payload = run_cli(["report", "--pending"])
    if payload is None:
        return False
    for report in payload.get("reports") or []:
        report_id = report.get("reportId") or report.get("id")
        if report_id and delivered_by_hermes(report_id):
            if run_cli(["report", "--confirm", report_id]) is None:
                return False
            continue
        run_id = report.get("runId") or "?"
        if not emit_report(report, f"OmniWatch Scout — raport z poprzedniego przebiegu {run_id}"):
            return False
    return True


def scan(collection_id):
    payload = run_cli(["scan", "--collection", collection_id, "--trigger", "schedule"])
    if payload is None:
        return 1
    if payload.get("state") == "failed":
        reason = payload.get("errorMessage") or "nieznany blad"
        print(f"OmniWatch Scout — skan nie doszedl do skutku: {reason}")
        return 1
    report = payload.get("report")
    if not report:
        # Zero new material, nothing failed, nothing waiting: silence (D8).
        return 0
    # The durable report carries the counts and identity; the same record is used
    # by the retry path after a process interruption.
    current = {
        **report,
        "newAnalyses": payload.get("analysed", 0),
        "failedItems": payload.get("failedItems", 0),
        "pendingItems": payload.get("pendingItems", 0),
    }
    return 0 if emit_report(current, "OmniWatch Scout") else 1


def scout_root():
    explicit = os.environ.get("OMNIWATCH_SCOUT_DIR")
    if explicit:
        return Path(explicit)
    return Path.home() / ".agentic-os" / "omniwatch" / "scout"


def scheduled_channels(now=None):
    """Channels the Scout tab saved with a schedule that is due now.

    daily = every run of this job; weekly = at most once in ~7 days. The goal is not
    read here: it lives on the channel's collection, where the shared scan reads it.
    """
    now = now or datetime.now()
    root = scout_root()
    try:
        config = json.loads((root / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    try:
        state = json.loads((root / "schedule-state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    due = []
    for channel in config.get("channels") or []:
        collection = channel.get("collectionId")
        every = channel.get("schedule") or "off"
        if not collection or every not in ("daily", "weekly"):
            continue
        last = state.get(collection)
        if every == "weekly" and last:
            try:
                if (now - datetime.fromisoformat(last)).total_seconds() < 6.5 * 86400:
                    continue
            except ValueError:
                pass
        due.append(collection)
    return due


def mark_scheduled(collection, now=None):
    root = scout_root()
    path = root / "schedule-state.json"
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    state[collection] = (now or datetime.now()).isoformat(timespec="seconds")
    try:
        root.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except OSError:
        pass


def main():
    parser = argparse.ArgumentParser(description="Thin Hermes launcher for the shared OmniWatch scan")
    parser.add_argument(
        "--collection",
        default=os.environ.get("OMNIWATCH_COLLECTION"),
        help="Collection id (Hermes passes this; never a prompt)",
    )
    parser.add_argument(
        "--report",
        metavar="RUN_ID",
        help="Read or re-send one run's stored report; runs no analysis",
    )
    args = parser.parse_args()

    if args.report:
        payload = run_cli(["report", "--run", args.report])
        if not payload:
            return 1
        reports = payload.get("reports") or []
        if not reports:
            print(f"OmniWatch Scout — brak raportu dla przebiegu {args.report}")
            return 0
        for report in reports:
            print(describe(report))
        return 0

    if not args.collection:
        collections = scheduled_channels()
        if not deliver_previous():
            return 1
        status = 0
        for collection in collections:
            result = scan(collection)
            if result == 0:
                mark_scheduled(collection)
            status = status or result
        return status

    if not deliver_previous():
        return 1
    return scan(args.collection)


if __name__ == "__main__":
    sys.exit(main())
