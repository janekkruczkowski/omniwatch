import { getPanelRuntime } from "@/lib/omniwatchPanelRuntime";
import { createLibraryHandler } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The OmniWatch library in the host Vault: which Vault is in use, search over the saved
// analyses, and a question answered from them with references (F5, D7). The behaviour
// lives in `./handler.ts`, which the offline tests drive directly.

/** The host's own Vault setting (`config.vaultRoot`), shown next to OmniWatch's. */
let hostVault: Promise<string | null> | null = null;
function hostVaultRoot(): Promise<string | null> {
  if (!hostVault) {
    hostVault = import("@/lib/config")
      .then((mod) => (mod as { config?: { vaultRoot?: string | null } }).config?.vaultRoot ?? null)
      .catch(() => null);
  }
  return hostVault;
}

const handler = createLibraryHandler({
  library() {
    const panel = getPanelRuntime();
    return {
      memory: panel.memory,
      info: { vaultRoot: panel.vaultRoot, analysesDir: panel.analysesDir, answerModel: panel.answerModel },
    };
  },
  hostVaultRoot,
});

export async function GET(req: Request): Promise<Response> {
  return handler.GET(req);
}

export async function POST(req: Request): Promise<Response> {
  return handler.POST(req);
}
