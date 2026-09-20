// A tiny job store, kept inside the module so it drops into a stock Agent OS with
// no other files needed.
//
// Watching a video takes minutes: download, upload, then the model writing. Holding
// an HTTP request open for that is the thing to avoid — anything behind a proxy gets
// cut at around two minutes, and a tab reload kills the run. So a route starts a job,
// answers 202 with an id, and the caller polls. The same job is what the Scout agent
// waits on from outside the browser.
//
// In memory on purpose: a dashboard restart drops jobs, which is fine because every
// finished answer is also written to summaries/ and a re-run reuses the cached video
// and the cached upload, so it costs little to ask again.

export type JobState = "running" | "done" | "error";

export interface Job<P = unknown, R = unknown> {
  id: string;
  state: JobState;
  progress?: P;
  result?: R;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const JOBS = new Map<string, Job>();
const TTL_MS = 60 * 60_000; // an hour after finishing, then it is swept

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, j] of JOBS) if ((j.finishedAt ?? j.startedAt) < cutoff) JOBS.delete(id);
}

export function getJob<P, R>(id: string): Job<P, R> | null {
  sweep();
  return (JOBS.get(id) as Job<P, R>) ?? null;
}

/** Start `work` in the background and hand back the job immediately. `work` receives
 *  the job so it can publish progress as it goes. */
export function startJob<P, R>(work: (job: Job<P, R>) => Promise<R>): Job<P, R> {
  sweep();
  const job: Job<P, R> = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    state: "running",
    startedAt: Date.now(),
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

/** Newest first — the Scout tab lists what is in flight. */
export function listJobs(): Job[] {
  sweep();
  return [...JOBS.values()].sort((a, b) => b.startedAt - a.startedAt);
}
