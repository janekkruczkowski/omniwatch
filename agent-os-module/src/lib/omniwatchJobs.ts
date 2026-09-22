// The panel's job store. Two kinds of job live behind one id:
//
//   * in-RAM jobs — the film-production modes (both/blueprint/screentext) that still
//     run inside the Next process, exactly as before;
//   * durable operations — a core analysis admitted into the shared SQLite store and
//     executed by the on-demand worker process (D5). Closing the tab, or the whole
//     panel, only stops the polling: the operation and its progress stay readable.
//
// `getJob` therefore answers from RAM first and then from a registered durable reader,
// so every existing caller (the legacy routes, ScoutView, OmniWatchView) keeps working
// with the same three exported functions.

export type JobState = "running" | "done" | "error";

export interface Job<P = unknown, R = unknown> {
  id: string;
  state: JobState;
  progress?: P;
  result?: R;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  /** Set when this job is backed by a durable operation (core analysis). */
  operationId?: string;
  kind?: "analysis" | "legacy-film" | "channel" | "scout";
}

const JOBS = new Map<string, Job>();
const TTL_MS = 60 * 60_000; // an hour after finishing, then it is swept

// A job that is still running is never swept on its age. Sweeping it on startedAt is
// what the obvious version does, and it is wrong in the one case that matters: a scan
// that takes longer than the TTL would have its own poll delete it, answer 404, and
// tell the tab the dashboard restarted — while the worker carries on downloading,
// uploading and spending, now with nothing watching it. Running jobs are held until
// they finish, with a far outer bound so a wedged one cannot leak forever.
const RUNNING_MAX_MS = 24 * 3600_000;

/**
 * Durable read side, registered by the OmniWatch panel wiring. It turns a core
 * operation id into the same `Job` shape the routes already poll, so a re-opened
 * card shows the progress of work that outlived the tab.
 */
export type DurableJobReader = (id: string) => Job | null;

let durableReader: DurableJobReader | null = null;

export function registerDurableJobReader(reader: DurableJobReader | null): void {
  durableReader = reader;
}

function sweep() {
  const now = Date.now();
  for (const [id, j] of JOBS) {
    const stale = j.finishedAt
      ? j.finishedAt < now - TTL_MS
      : j.startedAt < now - RUNNING_MAX_MS;
    if (stale) JOBS.delete(id);
  }
}

export function getJob<P, R>(id: string): Job<P, R> | null {
  sweep();
  const local = JOBS.get(id) as Job<P, R> | undefined;
  if (local) return local;
  if (durableReader && id) return durableReader(id) as Job<P, R> | null;
  return null;
}

/** Start `work` in the background and hand back the job immediately. `work` receives
 *  the job so it can publish progress as it goes. */
export function startJob<P, R>(
  work: (job: Job<P, R>) => Promise<R>,
  options: { kind?: Job["kind"] } = {},
): Job<P, R> {
  sweep();
  const job: Job<P, R> = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    state: "running",
    startedAt: Date.now(),
    ...(options.kind ? { kind: options.kind } : {}),
  };
  JOBS.set(job.id, job as Job);
  void work(job).then(
    (result) => { job.result = result; job.state = "done"; job.finishedAt = Date.now(); },
    (e: unknown) => {
      job.error = e instanceof Error ? e.message : String(e);
      job.state = "error";
      job.finishedAt = Date.now();
    },
  );
  return job;
}

/** Record a RAM job under a caller-chosen id (used by tests and by resumed panels). */
export function trackJob<P, R>(job: Job<P, R>): Job<P, R> {
  JOBS.set(job.id, job as Job);
  return job;
}

/** Newest first — the Scout tab lists what is in flight. */
export function listJobs(): Job[] {
  sweep();
  return [...JOBS.values()].sort((a, b) => b.startedAt - a.startedAt);
}
