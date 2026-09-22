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
from a prompt typed into a chat. Zero new material prints nothing: a cron that cries
wolf every morning gets muted, and then it is useless on the day it matters.

Set OMNIWATCH_CLI if the runtime is not in the default place, and OMNIWATCH_DATA_DIR /
OMNIWATCH_CONFIG for a non-default data directory.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE_FILE = Path(
    os.environ.get("OMNIWATCH_STATE", Path.home() / ".agentic-os" / "omniwatch" / "scout-last-run")
)


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


def last_run_id():
    try:
        return STATE_FILE.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def remember_run(run_id):
    if not run_id:
        return
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(run_id, encoding="utf-8")
    except OSError:
        pass  # losing the marker only repeats a message, never an analysis


def describe(report):
    if not report:
        return ""
    return (
        f"{report.get('newAnalyses', 0)} nowych analiz, "
        f"{report.get('failedItems', 0)} bledow, {report.get('pendingItems', 0)} oczekuje\n"
        f"{report.get('summary', '')}"
    )


def deliver_previous():
    """D8: read what a previous run produced before requesting new work.

    A report finished after the launcher gave up still arrives here — at the latest on
    the next active cron run. Repeating a message is allowed; repeating an analysis is
    not, which is why this path never scans.
    """
    run_id = last_run_id()
    if not run_id:
        return
    payload = run_cli(["report", "--run", run_id])
    if not payload:
        return
    for report in payload.get("reports") or []:
        if report.get("state") == "confirmed":
            continue
        text = describe(report)
        if text:
            print(f"OmniWatch Scout — raport z poprzedniego przebiegu {run_id}\n{text}\n")


def scan(collection_id):
    payload = run_cli(["scan", "--collection", collection_id, "--trigger", "schedule"])
    if payload is None:
        return 1
    remember_run(payload.get("runId"))
    if payload.get("state") == "failed":
        reason = payload.get("errorMessage") or "nieznany blad"
        print(f"OmniWatch Scout — skan nie doszedl do skutku: {reason}")
        return 1
    report = payload.get("report")
    if not report:
        # Zero new material, nothing failed, nothing waiting: silence (D8).
        return 0
    # The scan payload carries the counts; the report carries the durable summary.
    text = (
        f"{payload.get('analysed', 0)} nowych analiz, "
        f"{payload.get('failedItems', 0)} bledow, {payload.get('pendingItems', 0)} oczekuje"
    )
    summary = report.get("summary") if isinstance(report, dict) else None
    print(f"OmniWatch Scout — {text}" + (f"\n{summary}" if summary else ""))
    return 0


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
        print(
            "OmniWatch Scout: no collection id. Pass --collection <id> or set OMNIWATCH_COLLECTION.",
            file=sys.stderr,
        )
        return 2

    deliver_previous()
    return scan(args.collection)


if __name__ == "__main__":
    sys.exit(main())
