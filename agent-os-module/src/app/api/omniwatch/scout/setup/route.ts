import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "@/lib/omniwatch";
import { apifyReady } from "@/lib/omniwatchScout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/omniwatch/scout/setup  { token }
//
// Installs the Apify plugin into Hermes and stores the token. This exists so nobody
// has to be told to "run pip install" — most people in this community are not
// developers, and a terminal instruction is where they stop.

function hermesPython(): string | null {
  const home = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  // The Agent OS pack hardcodes `.venv`, but Hermes actually ships `venv` — try both
  // rather than guessing, because guessing wrong looks like "the button does nothing".
  for (const dir of ["venv", ".venv"]) {
    const p = path.join(home, "hermes-agent", dir, "bin", "python");
    if (existsSync(p)) return p;
    const win = path.join(home, "hermes-agent", dir, "Scripts", "python.exe");
    if (existsSync(win)) return win;
  }
  return null;
}

export async function POST(req: Request) {
  const { token } = await req.json().catch(() => ({ token: "" }));
  const clean = String(token || "").trim();
  if (!/^apify_api_[A-Za-z0-9]{10,}$/.test(clean)) {
    return NextResponse.json({
      error: "That does not look like an Apify token. It starts with apify_api_ and comes from apify.com → Settings → API & Integrations.",
    }, { status: 400 });
  }

  const python = hermesPython();
  if (!python) {
    return NextResponse.json({
      error: "Could not find Hermes' Python environment. Is Hermes installed on this machine?",
    }, { status: 503 });
  }

  const steps: string[] = [];
  try {
    await run(python, ["-m", "pip", "install", "--quiet", "--upgrade", "apify-hermes-agent-plugin"], 600_000);
    steps.push("plugin installed");

    // Already-enabled is not a failure, so a re-run stays harmless.
    await run("hermes", ["plugins", "enable", "apify"], 120_000).catch(() => {});
    steps.push("plugin enabled");

    // Hermes writes the token to ~/.hermes/.env itself.
    await run("hermes", ["apify-setup", "--token", clean], 120_000);
    steps.push("token saved");
  } catch (e) {
    return NextResponse.json({
      error: `${e instanceof Error ? e.message : String(e)}`.slice(-400),
      steps,
    }, { status: 500 });
  }

  const ready = await apifyReady();
  return NextResponse.json({ ok: ready.apify, steps, ready });
}
