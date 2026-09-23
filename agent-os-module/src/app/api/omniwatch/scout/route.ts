import { getPanelRuntime } from "@/lib/omniwatchPanelRuntime";
import { saveCollection } from "../../../../../../packages/omniwatch/src/collections/scan.ts";
import { createScoutHandler } from "./handler.ts";
import { accountSourceRef } from "../channel/handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  /api/omniwatch/scout              → config, last run, and what still needs setting up
// GET  /api/omniwatch/scout?job=<id>     → poll a manual scan
// GET  /api/omniwatch/scout?report=<run> → read one run's durable report (report --run)
// POST /api/omniwatch/scout {action:"config", config:{channels}} | {action:"scan", channelId?}
//
// Hermes does not call this route: it runs the shared CLI (`scan --collection <id>` /
// `report --run <id>`), which is the same `runScan` this route uses for the manual
// button. The manual button and the cron therefore cannot drift apart.

type ScoutHandler = ReturnType<typeof createScoutHandler>;

let handlerPromise: Promise<ScoutHandler> | null = null;

function handler(): Promise<ScoutHandler> {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const panel = getPanelRuntime();
      const host = await panel.host();
      return createScoutHandler({
        store: panel.store,
        runScan: (input) => panel.runScan(input),
        reportsToHandOff: (limit) => panel.reportsToHandOff(limit),
        handOffRunReport: (id, note) => panel.handOffRunReport(id, note),
        readRunReport: (runId) => panel.readRunReport(runId),
        readConfig: () => host.scout.readConfig(),
        writeConfig: (config) => host.scout.writeConfig(config as never),
        toolsPresent: () => host.omniwatch.toolsPresent(),
        apiKeyPresent: async () => Boolean(await host.omniwatch.apiKey()),
        // The channel's saved goal (summary by default) — never a hard-coded teardown.
        saveCollection: ({ collectionId, sources, settings }) =>
          saveCollection(panel.store, {
            settings: settings ?? {
              collectionId,
              mode: "summary",
              focus: null,
              question: null,
              language: "en",
              maxNewItems: null,
              budgetUsd: null,
            },
            sources,
          }),
        accountRef: (platform, handle) => accountSourceRef({ platform, handle }),
        listChannel: async (source) => {
          if (!panel.source.list) return [];
          const ids: string[] = [];
          let cursor: string | null | undefined = null;
          for (let page = 0; page < 200; page += 1) {
            const listed = await panel.source.list(source, { cursor, limit: 50 });
            for (const item of listed.items) ids.push(item.sourceRef.sourceId);
            cursor = listed.cursor;
            if (!cursor) break;
          }
          return ids;
        },
      });
    })();
  }
  return handlerPromise;
}

export async function GET(req: Request): Promise<Response> {
  return (await handler()).GET(req);
}

export async function POST(req: Request): Promise<Response> {
  return (await handler()).POST(req);
}
