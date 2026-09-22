import { DEFAULT_LANG } from "@/lib/omniwatch";
import I18N from "@/lib/omniwatchI18n";
import { getPanelRuntime } from "@/lib/omniwatchPanelRuntime";
import { createStatusHandler } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/omniwatch/status — what the tab needs before it can run anything. Drives the
// onboarding screen, so a member without a key sees what they would get and how to get
// there, never a bare error. The durable part (owner, operations, reports) is additive.

export async function GET(): Promise<Response> {
  const panel = getPanelRuntime();
  const host = await panel.host();
  return createStatusHandler({
    store: panel.store,
    apiKeyPresent: async () => Boolean(await host.omniwatch.apiKey()),
    toolsPresent: () => host.omniwatch.toolsPresent(),
    cleanup: () => host.omniwatch.cleanup(),
    defaultLang: DEFAULT_LANG,
    langs: Object.entries(I18N).map(([code, locale]) => ({ code, name: (locale as { name: string }).name })),
  }).GET();
}
