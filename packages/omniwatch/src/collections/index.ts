/**
 * T5 public entry point: durable enumeration, the one scan operation and the
 * durable per-run report. Hermes, the Agent OS UI and the standalone shell import
 * only from here, never from the individual files.
 *
 * Protocol for a caller (manual button or cron):
 *
 * 1. Next cron run: deliver what previous runs produced but nobody confirmed.
 *    `reportsToHandOff(store)` then `handOffRunReport` / `confirmRunReport` /
 *    `failRunReport`.
 * 2. One scan, the same call for the manual button and Hermes:
 *    `await runScan({ deps, request: { collectionId, trigger, confirmPaidListing } })`,
 *    then `scanPayload(outcome)` for the JSON-safe summary.
 * 3. Read or re-send a single run's report without any new analysis:
 *    `readRunReport(store, runId)` (the `report --run <id>` path).
 */

export * from "./listing.ts";
export * from "./report.ts";
export * from "./scan.ts";
