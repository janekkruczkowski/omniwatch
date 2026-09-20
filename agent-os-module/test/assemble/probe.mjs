// Offline probe for /api/video/auto/assemble.
//
// Runs the installed route behind local stubs and checks the things the assembler
// has been wrong about before: a malformed body must answer 400 naming the field
// instead of a 500 from halfway through the request, a caller that asked for
// narration must not be handed a silent film reported as a success, caller text
// must come out escaped, and the HTML for valid input must be stable.
//
// Nothing here writes to the Agent OS tree: every project directory is a mkdtemp.
//
//   node --experimental-strip-types probe.mjs --source /path/to/agent-os/source
//   node --experimental-strip-types probe.mjs --source ... --repro   # installer round-trip
//
// Flags (env fallbacks in brackets):
//   --source <dir>      agent-os source root, the one with src/ and node_modules/
//                       [AGENT_OS_SOURCE]
//   --route <file>      route under test [<source>/src/app/api/video/auto/assemble/route.ts]
//   --installer <file>  register-nav.py used by --repro [<test dir>/../register-nav.py]
//   --tsc <bin>         tsc used by --repro to typecheck the regenerated route
//                       [<source>/node_modules/.bin/tsc]
//   --scratch <dir>     where scratch files go [mkdtemp]
//   --repro             also check that one installer run reproduces the live route
import { readFile, writeFile, mkdir, cp, mkdtemp, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUBS = path.join(HERE, "stubs");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "repro" || key === "keep") { out[key] = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const SOURCE = args.source || process.env.AGENT_OS_SOURCE;
if (!SOURCE) {
  console.error("need --source <agent-os/source> (or AGENT_OS_SOURCE): the tree that holds src/ and node_modules/");
  process.exit(2);
}
const ROUTE = args.route || path.join(SOURCE, "src/app/api/video/auto/assemble/route.ts");
const INSTALLER = args.installer || path.join(HERE, "..", "register-nav.py");
const TSC = args.tsc || path.join(SOURCE, "node_modules/.bin/tsc");
const SCRATCH = args.scratch || await mkdtemp(path.join(tmpdir(), "assemble-probe-"));
const GEN = path.join(SCRATCH, "gen");

async function loadRoute(srcPath, tag) {
  let s = await readFile(srcPath, "utf8");
  s = s.replace('from "next/server"', `from "${STUBS}/next-server.mjs"`)
       .replace('from "@/lib/videoProjects"', `from "${STUBS}/videoProjects.mjs"`)
       .replace('from "@/lib/videoAuto"', `from "${STUBS}/videoAuto.mjs"`);
  const out = path.join(GEN, `${tag}.ts`);
  await writeFile(out, s);
  return import(out);
}

async function fire(POST, body) {
  const req = new Request("http://localhost:3000/api/video/auto/assemble", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const res = await POST(req);
    const j = await res.json().catch(() => null);
    let html = null;
    if (j && j.cwd) {
      try { html = await readFile(path.join(j.cwd, "index.html"), "utf8"); } catch { html = null; }
    }
    return { status: res.status, json: j, html, threw: null };
  } catch (e) {
    return { status: 0, json: null, html: null, threw: String((e && e.message) || e) };
  }
}

const legacyAvatar = {
  title: "How the winning ad opens", brand: "Agent OS", mode: "avatar",
  avatarUrl: "/api/hermes/preview/videos/avatar.mp4",
  narrationUrl: "/api/hermes/preview/videos/avatar.mp4",
  scenes: [
    { caption: "The hook lands in the first second", narration_line: "Most ads lose you before the second sentence." },
    { caption: "Then it names the price", narration_line: "Say the number out loud and the room goes quiet." },
    { caption: "Close on the offer", narration_line: "End on the offer, not on a logo." },
  ],
};
const voiceoverLegacy = {
  title: "Voiceover only", mode: "voiceover", narrationUrl: "https://example.test/voice.mp3",
  scenes: [{ caption: "One", narration_line: "one two three" }, { caption: "Two", narration_line: "four five" }],
};
const withGraphics = {
  title: "Cards", mode: "voiceover", narrationUrl: "https://example.test/voice.mp3",
  scenes: [
    { caption: "Ranking", narration_line: "the top three", graphic: { kind: "ranking", title: "Top 3", items: [{ label: "One", value: "42%" }, { label: "Two" }, { label: "Three", value: "9%" }] } },
    { caption: "Stat", narration_line: "one number", graphic: { kind: "stat", value: "3.2x", caption: "faster than last quarter" } },
    { caption: "Compare", narration_line: "side by side", graphic: { kind: "compare", title: "Us vs them", left: { label: "Us", items: ["one", "two"] }, right: { label: "Them", items: ["three"] } } },
    { caption: "Quote", narration_line: "a line worth keeping", graphic: { kind: "quote", text: "Say it once, say it well.", attribution: "Someone" } },
  ],
};
const withSeconds = {
  title: "Copied rhythm", mode: "voiceover", narrationUrl: "https://example.test/voice.mp3",
  scenes: [
    { caption: "One", narration_line: "a", brollUrl: "https://example.test/a.mp4", seconds: 1.2 },
    { caption: "Two", narration_line: "b", brollUrl: "https://example.test/b.mp4", seconds: 3.4 },
    { caption: "Three", narration_line: "c", seconds: 0.9 },
  ],
};
const smoke = {
  title: "Smoke: five clips, local narration, two cards", brand: "Agent OS", mode: "voiceover",
  narrationUrl: "/api/video/preview/project/smoke/assets/voiceover.mp3",
  scenes: [
    { caption: "Open", narration_line: "the hook", brollUrl: "/api/video/preview/project/smoke/assets/broll-0.mp4", seconds: 2.1 },
    { caption: "Three things", narration_line: "a list", brollUrl: "/api/video/preview/project/smoke/assets/broll-1.mp4", seconds: 3.4, graphic: { kind: "ranking", title: "Top 3", items: [{ label: "One", value: "42%" }, { label: "Two", value: "31%" }, { label: "Three", value: "18%" }] } },
    { caption: "The number", narration_line: "a stat", brollUrl: "/api/video/preview/project/smoke/assets/broll-2.mp4", seconds: 1.7, graphic: { kind: "stat", value: "3.2x", caption: "faster" } },
    { caption: "Side by side", narration_line: "a compare", brollUrl: "/api/video/preview/project/smoke/assets/broll-3.mp4", seconds: 2.6, graphic: { kind: "compare", left: { label: "Us", items: ["fast", "cheap"] }, right: { label: "Them", items: ["slow"] } } },
    { caption: "Close", narration_line: "the offer", brollUrl: "/api/video/preview/project/smoke/assets/broll-4.mp4", seconds: 2.2 },
  ],
};
const escapes = {
  title: "Escapes", mode: "voiceover", narrationUrl: "https://example.test/voice.mp3",
  scenes: [{ caption: "</script><img onerror=alert(1)>", narration_line: "plain text stays plain", graphic: { kind: "quote", text: "</script><img src=x onerror=alert(1)>", attribution: "a & b" } }],
};
const silent = { title: "Silent", mode: "voiceover", scenes: [{ caption: "Only a caption", narration_line: "no audio asked for" }] };

// The HTML a correct legacy body produced before framing and output size existed. The
// requirement is that this stays byte-identical — new options may not disturb the
// composition of an edit that does not use them — so it is pinned as a hash rather
// than reviewed by eye.
// (Computed from the route as it stood before framing/output existed, for the exact
// body in the case below.)
const LEGACY_HTML_SHA256 = "00b2b43d8edac9e5d861427e74f23511bd10fc87cc6ee32b45bc3b066cd7a094";

// Source excerpts keep the whole image; generated footage may fill the frame when the
// caller says so. `excerpt: true` is the shorthand for the first case.
const containStyle = 'style="object-fit:contain;object-position:50% 50%"';
const containScene = {
  title: "Excerpt kept whole", mode: "voiceover", narrationUrl: "https://example.test/voice.mp3",
  scenes: [
    { caption: "The whole slide", narration_line: "a source excerpt", brollUrl: "https://example.test/slide.mp4", framing: { fit: "contain" } },
    { caption: "Generated", narration_line: "generated footage may fill", brollUrl: "https://example.test/gen.mp4" },
  ],
};
const excerptShorthand = {
  title: "Excerpt shorthand", mode: "voiceover", narrationUrl: "https://example.test/voice.mp3",
  scenes: [{ caption: "Slide", narration_line: "shorthand", brollUrl: "https://example.test/slide.mp4", excerpt: true }],
};
const portrait = {
  title: "Portrait frame", mode: "voiceover", narrationUrl: "https://example.test/voice.mp3",
  output: { width: 1080, height: 1920 },
  scenes: [
    // Every scene carries seconds, so each one's own clip is placed in its own slot —
    // otherwise the first 12 s clip fills the whole 6 s body and the second never lands.
    { caption: "Slide", narration_line: "portrait reference", brollUrl: "https://example.test/slide.mp4", seconds: 3, framing: { fit: "contain", position: "50% 20%" } },
    { caption: "Generated", narration_line: "and a generated beat", brollUrl: "https://example.test/gen.mp4", seconds: 3, framing: { fit: "cover", position: "20% 30%" } },
  ],
};

const CASES = [
  { name: "smoke shape: 5 broll + local audio + graphic variants", body: smoke, status: 200 },
  { name: "legacy avatar (no seconds, no graphics)", body: legacyAvatar, status: 200 },
  { name: "legacy voiceover", body: voiceoverLegacy, status: 200 },
  { name: "legacy HTML is byte-identical (hash guard)", body: voiceoverLegacy, status: 200, sha256: LEGACY_HTML_SHA256 },
  { name: "framing: contain on a source excerpt", body: containScene, status: 200, htmlHas: containStyle },
  { name: "excerpt: true defaults to contain", body: excerptShorthand, status: 200, htmlHas: containStyle },
  { name: "portrait output with per-scene framing", body: portrait, status: 200,
    htmlHas: ['data-width="1080"', 'data-height="1920"', "width: 1080px; height: 1920px", 'object-fit:contain;object-position:50% 20%', 'object-fit:cover;object-position:20% 30%'] },
  { name: "framing.fit: stretch is refused", body: { ...containScene, scenes: [{ narration_line: "x", framing: { fit: "stretch" } }] }, status: 400, error: /fit/ },
  { name: "framing.position: css injection is refused", body: { ...containScene, scenes: [{ narration_line: "x", framing: { fit: "contain", position: "50%;color:red" } }] }, status: 400, error: /position/ },
  { name: "framing: not an object is refused", body: { ...containScene, scenes: [{ narration_line: "x", framing: "contain" }] }, status: 400, error: /framing/ },
  { name: "graphics: ranking/stat/compare/quote", body: withGraphics, status: 200 },
  { name: "every scene carries seconds + broll", body: withSeconds, status: 200 },
  { name: "no narration asked for at all (stays silent)", body: silent, status: 200, hasAudio: false },
  { name: "esc: literal </script><img onerror>", body: escapes, status: 200, escaped: true },
  { name: "scenes: [null]", body: { ...legacyAvatar, scenes: [null] }, status: 400, error: /scenes\[0\]/ },
  { name: "scenes: [42]", body: { ...legacyAvatar, scenes: [42] }, status: 400, error: /scenes\[0\]/ },
  { name: "narration_line: 5 (number)", body: { ...legacyAvatar, scenes: [{ caption: "c", narration_line: 5 }] }, status: 400, error: /narration_line/ },
  { name: "caption: {} (object)", body: { ...legacyAvatar, scenes: [{ caption: {}, narration_line: "x" }] }, status: 400, error: /caption/ },
  { name: "seconds: -3", body: { ...legacyAvatar, scenes: [{ narration_line: "x", seconds: -3 }] }, status: 400, error: /seconds/ },
  { name: "ranking items: [null]", body: { ...withGraphics, scenes: [{ caption: "r", narration_line: "x", graphic: { kind: "ranking", items: [null] } }] }, status: 400, error: /items\[0\]/ },
  { name: "ranking items: 9 rows", body: { ...withGraphics, scenes: [{ caption: "r", narration_line: "x", graphic: { kind: "ranking", items: Array.from({ length: 9 }, (_, i) => ({ label: "row " + i })) } }] }, status: 400, error: /fits 8/ },
  { name: "ranking items: not an array", body: { ...withGraphics, scenes: [{ caption: "r", narration_line: "x", graphic: { kind: "ranking", items: "nope" } }] }, status: 400, error: /items/ },
  { name: "graphic kind: unknown", body: { ...withGraphics, scenes: [{ caption: "r", narration_line: "x", graphic: { kind: "pie", value: "1" } }] }, status: 400, error: /kind/ },
  { name: "stat with blank value", body: { ...withGraphics, scenes: [{ caption: "r", narration_line: "x", graphic: { kind: "stat", value: "  " } }] }, status: 400, error: /value/ },
  { name: "compare items: 9 lines", body: { ...withGraphics, scenes: [{ caption: "r", narration_line: "x", graphic: { kind: "compare", left: { label: "L", items: Array(9).fill("x") } } }] }, status: 400, error: /fits 8/ },
  { name: "audio download fails (avatar)", body: { ...legacyAvatar, avatarUrl: "https://example.test/fail.mp4" }, status: 502, error: /could not download/ },
  { name: "audio download fails (voiceover)", body: { ...voiceoverLegacy, narrationUrl: "https://example.test/fail.mp3" }, status: 502, error: /could not download/ },
];

// A shell script named ffprobe earlier on PATH than the real one is how the audio
// check is driven: the route runs the binary it finds, so this answers for it.
async function fakeFfprobe(dir, line) {
  await mkdir(dir, { recursive: true });
  const f = path.join(dir, "ffprobe");
  await writeFile(f, `#!/bin/sh\n${line}\n`, { mode: 0o755 });
  return dir;
}

async function main() {
  await mkdir(GEN, { recursive: true });
  const audioPath = await fakeFfprobe(path.join(SCRATCH, "bin-audio"), "echo audio");
  const silentPath = await fakeFfprobe(path.join(SCRATCH, "bin-silent"), "exit 0");
  process.env.PATH = `${audioPath}:${process.env.PATH}`;

  const POST = (await loadRoute(ROUTE, "route")).POST;
  const failures = [];
  const check = (name, ok, detail) => {
    if (!ok) failures.push(`${name}: ${detail}`);
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : " -- " + detail}`);
  };

  for (const c of CASES) {
    const r = await fire(POST, c.body);
    const bad = [];
    if (r.status !== c.status) bad.push(`status ${r.status} != ${c.status} ${r.threw || (r.json && r.json.error) || ""}`);
    if (c.error && !c.error.test((r.json && r.json.error) || "")) bad.push(`message does not match ${c.error}: ${(r.json && r.json.error) || ""}`);
    if (c.hasAudio !== undefined && r.json && r.json.hasAudio !== c.hasAudio) bad.push(`hasAudio ${r.json.hasAudio} != ${c.hasAudio}`);
    if (c.sha256) {
      const got = r.html ? createHash("sha256").update(r.html).digest("hex") : "(no html)";
      if (got !== c.sha256) bad.push(`html sha256 ${got} != ${c.sha256}`);
    }
    for (const needle of [].concat(c.htmlHas || [])) {
      if (!r.html || !r.html.includes(needle)) bad.push(`html missing ${JSON.stringify(needle)}`);
    }
    if (c.escaped && r.html) {
      if (!r.html.includes("&lt;/script&gt;&lt;img onerror=alert(1)&gt;")) bad.push("caption not escaped");
      if (!r.html.includes("&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;")) bad.push("quote card not escaped");
      if (!r.html.includes("a &amp; b")) bad.push("ampersand not escaped");
      if (r.html.includes("</script><img")) bad.push("raw script tag survived");
    }
    check(c.name, bad.length === 0, bad.join("; "));
  }

  process.env.PATH = `${silentPath}:${process.env.PATH}`;
  const noStream = await fire(POST, { ...legacyAvatar, avatarUrl: "https://example.test/noaudio.mp4" });
  check("downloaded narration with no audio stream", noStream.status === 502 && /no audio stream/.test(noStream.json?.error || ""),
        `status ${noStream.status} ${noStream.json?.error || ""}`);
  process.env.PATH = `${audioPath}:${process.env.PATH}`;

  if (args.repro) {
    const rel = path.relative(SOURCE, ROUTE);
    const tree = path.join(SCRATCH, "repro");
    const navTargets = [
      "src/components/Sidebar.tsx", "src/components/TopBar.tsx",
      "src/components/AstrosView.tsx", "src/app/hermes/page.tsx",
    ];
    for (const t of navTargets) {
      await mkdir(path.dirname(path.join(tree, t)), { recursive: true });
      try { await cp(path.join(SOURCE, t), path.join(tree, t)); } catch { /* optional on a fresh tree */ }
    }
    await mkdir(path.dirname(path.join(tree, rel)), { recursive: true });
    const { stdout } = await run("git", ["show", `HEAD:${rel}`], { cwd: SOURCE, maxBuffer: 64 * 1024 * 1024 });
    await writeFile(path.join(tree, rel), stdout);
    const py = await run("python3", [INSTALLER, tree], { maxBuffer: 64 * 1024 * 1024 });
    const reproduced = await readFile(path.join(tree, rel), "utf8");
    const live = await readFile(ROUTE, "utf8");
    check("one installer run on HEAD reproduces the live route", reproduced === live,
          py.stdout.trim().split("\n").slice(-4).join(" | "));
    if (reproduced === live && TSC) {
      // The regenerated file lives in the scratch tree, so give tsc the same
      // node_modules it would see in the real checkout (next/server, @types/node).
      try { await symlink(path.join(SOURCE, "node_modules"), path.join(tree, "node_modules")); }
      catch { /* already linked */ }
      const tsconfig = path.join(SCRATCH, "tsconfig.json");
      await writeFile(tsconfig, JSON.stringify({
        compilerOptions: {
          target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], strict: true, skipLibCheck: true,
          noEmit: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler",
          isolatedModules: true, jsx: "react-jsx", baseUrl: SOURCE, paths: { "@/*": ["./src/*"] },
        },
        files: [path.join(tree, rel)],
      }, null, 2));
      try {
        await run(TSC, ["-p", tsconfig], { maxBuffer: 64 * 1024 * 1024 });
        check("tsc accepts the regenerated route", true, "");
      } catch (e) {
        check("tsc accepts the regenerated route", false, String(e.stdout || e.message).slice(0, 400));
      }
    }
  }

  console.log(`\n${failures.length ? failures.length + " FAILURES" : "all cases ok"}  (scratch: ${SCRATCH})`);
  if (failures.length) process.exitCode = 1;
}

await main();
