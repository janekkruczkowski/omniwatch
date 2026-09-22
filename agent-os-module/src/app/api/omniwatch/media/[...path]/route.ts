import { frameJpeg, videoDir } from "@/lib/omniwatch";
import { createMediaHandler } from "./handler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serves the downloaded video and single frames out of the OmniWatch cache:
//   /api/omniwatch/media/video/<id>        the file itself, with range support so
//                                          clicking a timestamp can seek
//   /api/omniwatch/media/frame/<id>/<sec>  one real frame — the evidence next to
//                                          each bullet of the answer
export async function GET(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  return createMediaHandler({ videoDir, frameJpeg }).GET(req, ctx);
}
