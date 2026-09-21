import { NextResponse } from "next/server";
import { startJob, getJob } from "@/lib/omniwatchJobs";
import {
  apiKey, fetchVideo, watch, save, fmt,
  DEFAULT_LANG, PRICE_IN, PRICE_OUT, STRIP, type Mode,
} from "@/lib/omniwatch";
import I18N from "@/lib/omniwatchI18n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Watching a video is minutes of work: download, upload, then the model. So this
// never holds a request open — POST starts the job and answers 202 with an id, and
// the tab polls GET for the stage and the answer as it is written. Closing or
// reloading the tab no longer kills the run, and the same job is what the Scout
// agent will wait on.

export interface Progress {
  stage: "download" | "upload" | "watch" | "merge" | "answer";
  meta?: { id: string; title: string; channel: string; duration: string; seconds: number; strip: number[] };
  parts?: number;
  partsDone?: number;
  fps?: number;
  reused?: boolean;
  text?: string;
}
export interface Result extends Progress {
  text: string;
  seconds: number;
  tokens: number;
  parts: number;
  reused: boolean;
  cost: number;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const url = String(body.url || "").trim();
  const question = String(body.q || "");
  const mode: Mode = body.mode === "teardown" ? "teardown" : body.mode === "blueprint" ? "blueprint" : "ask";
  const l = I18N[String(body.lang || "")] ? String(body.lang) : DEFAULT_LANG;
  if (!/^https?:\/\//i.test(url)) return NextResponse.json({ error: "a http(s) link is required" }, { status: 400 });

  const key = await apiKey();
  if (!key) {
    return NextResponse.json({
      error: "No Qwen key yet. Add DASHSCOPE_API_KEY to ~/.hermes/.env or ~/.agentic-os/config.json.",
    }, { status: 503 });
  }

  const job = startJob<Progress, Result>(async (j) => {
    const t0 = Date.now();
    const p: Progress = { stage: "download" };
    // publish a copy: the poll must never observe a half-written object
    const push = () => { j.progress = { ...p }; };
    push();

    const { info, src } = await fetchVideo(url);
    const seconds = info.duration || 0;
    p.meta = {
      id: info.id, title: info.title, channel: info.channel,
      duration: fmt(seconds), seconds,
      strip: Array.from({ length: STRIP }, (_, i) => Math.round((seconds * (i + 0.5)) / STRIP)),
    };
    p.stage = "upload";
    push();

    let last = 0;
    const { answer, stats } = await watch(key, info, src, question, l, mode, {
      onEvent: (name, d) => {
        if (name === "watch") { p.stage = "watch"; p.parts = d.n as number; p.fps = d.fps as number; p.partsDone = 0; }
        else if (name === "uploaded") p.reused = d.reused as boolean;
        else if (name === "part_done") p.partsDone = (p.partsDone || 0) + 1;
        else if (name === "merge") p.stage = "merge";
        push();
      },
      onToken: (text) => {
        p.text = text;
        // the model writes faster than anyone polls; no point re-serialising every token
        if (Date.now() - last > 250) { last = Date.now(); p.stage = "answer"; push(); }
      },
    });

    p.text = answer;
    p.stage = "answer";
    push();
    await save(info, url, question, answer, l, mode).catch(() => {});

    const result: Result = {
      ...p, text: answer,
      seconds: Math.round((Date.now() - t0) / 1000),
      tokens: stats.in + stats.out,
      parts: stats.parts,
      reused: stats.reused,
      cost: Number((stats.in * PRICE_IN + stats.out * PRICE_OUT).toFixed(4)),
    };
    return result;
  });

  return NextResponse.json({ id: job.id }, { status: 202 });
}

// GET /api/omniwatch/jobs?id=… — one poll. Unknown id means the dashboard restarted
// (the store is in memory, like the rest of Agent OS), so the tab shows that plainly
// instead of spinning forever.
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") || "";
  const job = getJob<Progress, Result>(id);
  if (!job) return NextResponse.json({ state: "gone" }, { status: 404 });
  return NextResponse.json({
    state: job.state,
    ...(job.progress || {}),
    ...(job.result || {}),
    error: job.error,
  });
}
