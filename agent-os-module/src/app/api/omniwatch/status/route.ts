import { NextResponse } from "next/server";
import { apiKey, toolsPresent, cleanup, DEFAULT_LANG } from "@/lib/omniwatch";
import I18N from "@/lib/omniwatchI18n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/omniwatch/status — what the tab needs before it can run anything.
// Drives the onboarding screen, so a member without a key sees what they'd get
// and how to get there, never a bare error.
export async function GET() {
  const [key, tools] = await Promise.all([apiKey(), toolsPresent()]);
  // Opportunistic: drop videos nobody has asked about for 48 h.
  cleanup().catch(() => {});
  return NextResponse.json({
    ready: Boolean(key) && tools.ytDlp && tools.ffmpeg,
    key: Boolean(key),
    ...tools,
    defaultLang: DEFAULT_LANG,
    langs: Object.entries(I18N).map(([code, l]) => ({ code, name: l.name })),
  });
}
