import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let n = 0;
// The real one makes a HyperFrames project directory; the probe only needs a
// scratch directory it can read index.html back from.
export async function createProject(_title) {
  const cwd = await mkdtemp(path.join(tmpdir(), "assemble-probe-project-"));
  return { slug: `probe-${++n}`, cwd };
}
