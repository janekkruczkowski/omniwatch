# OmniWatch QA fix handoff — 2026-09-22

This handoff covers ISSUE-003, ISSUE-006 and ISSUE-007 from the independent QA report at `../qa-omniwatch-20260922/QA-REPORT.md`.

## Delivered

- ISSUE-003: a terminal SSE error leaves the standalone result area visible with the error and Retry button. The progress clock and label clear, the stream closes, and a later transport error cannot overwrite the server's reason. A successful answer also enters a visible terminal state.
- ISSUE-006: `ChannelScan` now has separate names for the paid-listing prompt and the selected-video spend threshold. The isolated Agent OS host compiles this component and `/omniwatch` returns HTTP 200.
- ISSUE-007: requests entering the same standalone process run in arrival order. Ownership is acquired before durable admission, is refreshed during long work, and is released after completion. Recovery precedes admission; an interrupted paid call with uncertain outcome is not resubmitted automatically. Distinct concurrent requests leave two delivered operations and no stranded pending/running operations in the offline regression.
- The Agent OS installer now materializes the core TypeScript source graph from the verified tarball for the host integration's relative imports, configures explicit `.ts` imports, and records the final `current` pointer hash. The builder removes stale manifests when changing versions.

## Artifact and checks

- Core package: `dist/release/omniwatch-core-0.2.1.tgz`
- SHA-256: `d488f19523517259da1c07b322d3af93c439672d35f064b901873a42347b606f`
- Isolated Agent OS install: `qa-omniwatch-20260922/agent-os/omniwatch/releases/0.2.1-d488f1952351`; integration installed from the same checkout, with no writes to the live host.
- `npm run build`, `npm run typecheck`, isolated host `tsc --noEmit`, and isolated host `/omniwatch` HTTP 200 passed.
- `node --test test/install/qa-regressions.test.mjs` with local socket permission: 16 pass, 0 fail, 0 skip. No provider calls.
- Full `npm test` with local socket permission: 243 pass, 0 fail, 0 skip. No provider calls.
- A production `next build` in the isolated host was limited by the test host's external `node_modules` symlink under Turbopack and blocked Google Fonts DNS under webpack. The host TypeScript check and running Next route succeeded.

## Independent retest

1. Open `http://127.0.0.1:13000/omniwatch` in the isolated Agent OS host and inspect the channel tab. It must render without HTTP 500 or a duplicate declaration error.
2. Run standalone with a temporary data directory and no provider key. Submit a valid URL. The error message and Retry button must both have nonzero client rectangles; the progress spinner must stop.
3. Drive two distinct requests through one standalone server with the controlled model fixture. Both must deliver once, with no pending/running operation left. Do not repeat the paid live scenario while the old follow-up and teardown are in `outcome_unknown`/unfinished state; inspect those persisted operation records separately.

No additional paid model call was made for this repair.
