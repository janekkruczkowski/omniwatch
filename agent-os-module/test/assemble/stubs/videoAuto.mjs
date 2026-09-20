import { writeFile } from "node:fs/promises";

// A fixed duration keeps the timing in the output deterministic; the route only
// needs a number here.
export async function probeDuration(_absPath) {
  return 12;
}

// A URL containing "fail" stands in for a download that did not arrive. Otherwise
// 2 KB of filler is written: probeDuration is stubbed above, so nothing parses it.
export async function downloadTo(url, absPath) {
  if (url.includes("fail")) return false;
  await writeFile(absPath, Buffer.alloc(2048, 1));
  return true;
}

export function estimateNarrationSec(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(6, Math.round((words / 2.6) * 10) / 10);
}
