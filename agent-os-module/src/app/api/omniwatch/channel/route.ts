import { startJob } from "@/lib/omniwatchJobs";
import { getPanelRuntime } from "@/lib/omniwatchPanelRuntime";
import { estimate, listScans, parseAccount, readScan } from "@/lib/omniwatchChannel";
import { resolvePreset } from "@/lib/omniwatchPresets";
import { saveCollection } from "../../../../../../packages/omniwatch/src/collections/scan.ts";
import { createChannelHandler } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Two verbs, deliberately split, because one of them costs money and the other does not.
// GET lists the account — its honest scope and what watching it would cost — and it is
// free wherever yt-dlp can read the account locally. A billed listing (X, Meta Ads,
// Instagram) answers with `needsConfirmation` and makes zero lister calls until the
// caller confirms. POST runs the *shared* scan the Hermes cron also runs.

export type { ChannelListing } from "@/lib/omniwatchChannel";

type ChannelHandler = ReturnType<typeof createChannelHandler>;

let handlerPromise: Promise<ChannelHandler> | null = null;

function handler(): Promise<ChannelHandler> {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const panel = getPanelRuntime();
      return createChannelHandler({
        store: panel.store,
        memory: panel.memory,
        source: panel.source,
        parseAccount: (input, hint) => parseAccount(input, hint as never) as never,
        estimateCost: (seconds) => (typeof seconds === "number" && seconds > 0 ? estimate(seconds) : null),
        // The preset library is T1's: "ask" is the summary path, "teardown" the other.
        resolvePreset: (preset, custom) => {
          const resolved = resolvePreset(preset, custom);
          return { mode: resolved.mode === "teardown" ? "teardown" : "summary", ask: resolved.ask };
        },
        saveCollection: (input) => saveCollection(panel.store, input),
        // Admission returns at once; the scan keeps running in this process, and the run
        // is durable, so a closed card is just a closed card (D5). If the panel itself
        // goes away, the run is resumed by id (`POST {resume: runId}`).
        startScan: (input) => admitScan(input),
        listSavedScans: () => listScans(),
        readSavedScan: (id) => readScan(id) as never,
        defaultLanguage: "en",
        languages: ["en", "pl"],
      });
    })();
  }
  return handlerPromise;
}

/** Admits the shared scan without holding the request open for minutes of model work. */
function admitScan(input: {
  runId: string;
  collectionId: string;
  settings: { mode: string; focus?: string | null; question?: string | null; language: string };
  sources: unknown[];
  confirmPaidListing: boolean;
  trigger: "manual" | "cli";
}): void {
  const panel = getPanelRuntime();
  startJob(
    async (job) => {
      job.progress = { stage: "scanning", runId: input.runId };
      const outcome = await panel.runScan({
        collectionId: input.collectionId,
        trigger: input.trigger,
        runId: input.runId,
        sources: input.sources as never,
        confirmPaidListing: input.confirmPaidListing,
      });
      return outcome;
    },
    { kind: "channel" },
  );
}

export async function GET(req: Request): Promise<Response> {
  return (await handler()).GET(req);
}

export async function POST(req: Request): Promise<Response> {
  return (await handler()).POST(req);
}
