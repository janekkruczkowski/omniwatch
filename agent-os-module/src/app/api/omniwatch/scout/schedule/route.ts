import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "@/lib/omniwatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The schedule, as a control rather than a command to copy into a terminal.
//
// Hermes owns the scheduling — it is the thing that runs 24/7 — so this reads its job
// store and drives `hermes cron` to change it. Nobody should have to know what a cron
// expression is to make Scout run twice a day.

const JOB_NAME = "omniwatch-scout";
const SCRIPT = "omniwatch-scout.py";

const hermesHome = () => process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");

interface CronJob {
  id?: string;
  name?: string;
  schedule?: { kind?: string; expr?: string; display?: string };
  enabled?: boolean;
  paused_at?: string | null;
  last_run_at?: string | null;
  next_run_at?: string | null;
  last_status?: string | null;
  deliver?: string | null;
}

/** Hermes keeps jobs in ~/.hermes/cron/jobs.json, and per profile under profiles/<p>/cron. */
async function findJob(): Promise<CronJob | null> {
  const stores = [path.join(hermesHome(), "cron", "jobs.json")];
  try {
    const { readdir } = await import("node:fs/promises");
    for (const p of await readdir(path.join(hermesHome(), "profiles"))) {
      stores.push(path.join(hermesHome(), "profiles", p, "cron", "jobs.json"));
    }
  } catch { /* no profiles dir */ }

  for (const store of stores) {
    try {
      const raw = JSON.parse(await readFile(store, "utf8"));
      const jobs: CronJob[] = Array.isArray(raw) ? raw
        : Array.isArray(raw.jobs) ? raw.jobs
          : Object.values(raw.jobs || raw);
      const hit = jobs.find((j) => j && j.name === JOB_NAME);
      if (hit) return hit;
    } catch { /* store missing or not readable */ }
  }
  return null;
}

// Presets, so the UI is a dropdown and not a cron expression.
const PRESETS: Record<string, { expr: string; label: string }> = {
  "6": { expr: "0 */6 * * *", label: "every 6 hours" },
  "12": { expr: "0 */12 * * *", label: "twice a day" },
  "24": { expr: "0 6 * * *", label: "every morning at 6" },
  "168": { expr: "0 6 * * 1", label: "Mondays at 6" },
};

export async function GET() {
  const job = await findJob();
  const expr = job?.schedule?.expr || "";
  const preset = Object.entries(PRESETS).find(([, p]) => p.expr === expr)?.[0];
  return NextResponse.json({
    scheduled: Boolean(job) && job?.enabled !== false && !job?.paused_at,
    every: preset || (expr ? "custom" : "off"),
    expr,
    display: job?.schedule?.display || expr,
    lastRun: job?.last_run_at || null,
    nextRun: job?.next_run_at || null,
    lastStatus: job?.last_status || null,
    deliver: job?.deliver || null,
    presets: Object.entries(PRESETS).map(([k, v]) => ({ every: k, label: v.label })),
  });
}

// POST { every: "off" | "6" | "12" | "24" | "168", deliver?: "telegram" | ... }
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const every = String(body.every || "off");
  const deliver = String(body.deliver || "local").replace(/[^a-z0-9:_-]/gi, "") || "local";
  const existing = await findJob();

  try {
    if (every === "off") {
      if (existing) await run("hermes", ["cron", "remove", existing.id || JOB_NAME], 60_000);
      return NextResponse.json({ scheduled: false });
    }

    const preset = PRESETS[every];
    if (!preset) return NextResponse.json({ error: "unknown interval" }, { status: 400 });

    // Recreate rather than edit: one code path, and `create` is the command whose
    // flags we know are stable across Hermes versions.
    if (existing) await run("hermes", ["cron", "remove", existing.id || JOB_NAME], 60_000).catch(() => {});
    await run("hermes", [
      "cron", "create", preset.expr,
      "--name", JOB_NAME,
      "--script", SCRIPT,
      "--no-agent",          // the script is the job; no model runs the trigger
      "--deliver", deliver,
    ], 120_000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      error: /could not start|enoent/i.test(msg)
        ? "Hermes is not on this machine's PATH, so the schedule cannot be set from here."
        : msg.slice(-400),
    }, { status: 500 });
  }

  return NextResponse.json(await (await GET()).json());
}
