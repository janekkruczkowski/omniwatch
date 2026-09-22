// Apify — a direct client, replacing `hermes -t apify`.
//
// Scout (omniwatchScout.ts) and the channel scan currently reach Apify by shelling
// out to Hermes and asking it, in prose, to call apify_discover/apify_start/apify_collect
// and hand back JSON. That works, but it means this module cannot run a scrape without
// Hermes installed and configured on the same machine — the opposite of "the module is
// self-contained". This file talks to the Apify REST API directly: start a run, poll it,
// read the dataset. No LLM in the loop, no Hermes on PATH.
//
// https://docs.apify.com/api/v2 — actor runs and datasets.

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const API = "https://api.apify.com/v2";

const DEFAULT_TIMEOUT_MS = 5 * 60_000; // generous: most scrapes here are metadata-only and finish in well under a minute, but a hashtag or a cold actor build can take a few
const POLL_MS = 2000; // fast enough that a quick run (most of what Scout asks for) doesn't sit idle waiting for the next poll, slow enough not to hammer the API for a run that takes minutes

// ── the token ──────────────────────────────────────────────────────────────────
// Same resolution order as apiKey() in omniwatch.ts: environment first, then the
// Hermes profile .env (where someone running both tools already keeps their keys),
// then ~/.agentic-os/config.json (the module's own settings file).
export async function apifyToken(): Promise<string | null> {
  const env = process.env.APIFY_TOKEN?.trim();
  if (env) return env;

  const hermes = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  try {
    const m = (await readFile(path.join(hermes, ".env"), "utf8")).match(/^APIFY_TOKEN=(.+)$/m);
    if (m && m[1].trim().length > 5) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch { /* no ~/.hermes/.env, or no APIFY_TOKEN line in it */ }

  try {
    const cfg = JSON.parse(await readFile(path.join(os.homedir(), ".agentic-os", "config.json"), "utf8"));
    const k = String(cfg.apifyToken || "").trim();
    if (k.length > 5) return k;
  } catch { /* no config.json, or it has no apifyToken */ }

  return null;
}

// The reader here is not a developer — it is someone in the Skool community who
// cannot "just get an API key" without being told exactly where to click. So the
// message is a checklist, not a description of what failed.
export const APIFY_SETUP_HINT =
  "This needs an Apify account token. To get one:\n"
  + "1. Go to https://console.apify.com and sign up (free tier works for testing).\n"
  + "2. Open Settings → Integrations in the left sidebar.\n"
  + "3. Copy the value under \"Personal API tokens\" (the default token works).\n"
  + "4. Paste it into ~/.agentic-os/config.json as \"apifyToken\": \"<paste here>\",\n"
  + "   or set it as the APIFY_TOKEN environment variable before starting the app.\n"
  + "Then try again.";

function missingTokenError(): Error {
  return new Error(APIFY_SETUP_HINT);
}

// ── the actor id ───────────────────────────────────────────────────────────────
// Apify's REST paths take an actor id with the owner and name joined by a tilde
// rather than a slash (a slash would collide with the path separator), e.g.
// "apidojo/tweet-scraper" on the console is "apidojo~tweet-scraper" in the URL.
// Callers in this codebase already pass the tilde form (see ACTORS in
// omniwatchScout.ts), so this only guards against someone passing the slash form.
const urlSafeActorId = (actorId: string) => actorId.replace(/\//g, "~");

interface RunStatus {
  id: string;
  status: "READY" | "RUNNING" | "SUCCEEDED" | "FAILED" | "ABORTED" | "TIMED-OUT" | string;
  defaultDatasetId: string;
  statusMessage?: string;
}

const DONE = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

/**
 * Runs an Apify actor and returns its dataset items.
 *
 * Three REST calls, not the one-shot `run-sync-get-dataset-items` convenience
 * endpoint: that endpoint enforces its own server-side timeout (well under what a
 * slow actor build can take) and gives no visibility into why a run is still going.
 * Starting the run ourselves and polling it means a caller-controlled timeout and a
 * status worth reporting if something goes wrong.
 */
export async function runActor<T = Record<string, unknown>>(
  actorId: string,
  input: Record<string, unknown>,
  opts: { timeoutMs?: number; limit?: number } = {},
): Promise<T[]> {
  const token = await apifyToken();
  if (!token) throw missingTokenError();

  const auth = { Authorization: `Bearer ${token}` };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const startRes = await fetch(`${API}/acts/${urlSafeActorId(actorId)}/runs`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!startRes.ok) {
    const body = (await startRes.text()).slice(0, 400);
    if (startRes.status === 401 || startRes.status === 403) throw missingTokenError();
    if (startRes.status === 404) {
      throw new Error(`Apify actor "${actorId}" was not found. Check the actor id — it should look like "owner~actor-name".`);
    }
    throw new Error(`Apify would not start actor "${actorId}" (${startRes.status}): ${body}`);
  }
  let run = ((await startRes.json()) as { data: RunStatus }).data;

  // Poll until the run leaves a terminal state or the caller's deadline passes.
  // A fixed interval rather than backoff: Scout's actors (TikTok/Instagram/X
  // metadata scrapes) mostly finish in tens of seconds, so a short constant poll
  // costs little and answers fast; nothing here is latency-sensitive enough to
  // need anything cleverer.
  while (!DONE.has(run.status)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Apify actor "${actorId}" did not finish within ${Math.round(timeoutMs / 1000)}s `
        + `(still ${run.status}). It may just be slow — try again, or raise timeoutMs.`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    const pollRes = await fetch(`${API}/actor-runs/${run.id}`, { headers: auth });
    if (!pollRes.ok) throw new Error(`Apify lost track of the run (${pollRes.status}). Try again.`);
    run = ((await pollRes.json()) as { data: RunStatus }).data;
  }

  if (run.status !== "SUCCEEDED") {
    throw new Error(`Apify actor "${actorId}" ${run.status.toLowerCase()}${run.statusMessage ? `: ${run.statusMessage}` : "."}`);
  }

  const qs = new URLSearchParams({ clean: "true", format: "json" });
  if (opts.limit) qs.set("limit", String(opts.limit));
  const itemsRes = await fetch(`${API}/datasets/${run.defaultDatasetId}/items?${qs}`, { headers: auth });
  if (!itemsRes.ok) throw new Error(`Apify would not return the dataset (${itemsRes.status}).`);
  return (await itemsRes.json()) as T[];
}
