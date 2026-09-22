/**
 * T0 beta fixtures (docs/omniwatch/work-orders/BETA-FIXTURES.md).
 *
 * Everything here is synthetic and generated from zero: no real user .env,
 * .cache/, summaries/, Vault or key is ever read. The frozen clock is
 * nowSeconds = 1800000000. Media is our own colour clip generated with ffmpeg.
 *
 * Run: node test/fixtures/beta/make-fixtures.mjs
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NOW_SECONDS = 1800000000;
export const NOW_MILLISECONDS = 1800000000000;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "legacy");
const cache = path.join(root, ".cache");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const write = (rel, contents) => {
  const file = path.join(here, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
};
const writeJson = (rel, value) => write(rel, `${JSON.stringify(value, null, 2)}\n`);

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });
}

/* --------------------------------------------------------------- configuration */

const DEFAULT_CONFIG = [
  "DASHSCOPE_API_KEY=fixture-not-a-secret",
  "DASHSCOPE_API=https://provider.example.invalid",
  "OMNI_MODEL=fixture-omni",
  "OMNI_LANG=pl",
  "OMNI_CACHE_HOURS=48",
  "OMNI_MAX_FRAMES=2400",
].join("\n");

writeJson("config/precedence.json", {
  file: {
    OMNI_LANG: "pl",
    OMNI_MODEL: "fixture-omni",
    DASHSCOPE_API_KEY: "fixture-not-a-secret",
    DASHSCOPE_API: "https://provider.example.invalid",
    OMNI_CACHE_HOURS: "48",
    OMNI_MAX_FRAMES: "2400",
  },
  processEnv: { OMNI_LANG: "en", OMNI_MODEL: "fixture-process", DASHSCOPE_API_KEY: "fixture-process-key" },
  expected: { OMNI_LANG: "en", OMNI_MODEL: "fixture-process", DASHSCOPE_API_KEY: "fixture-process-key" },
  note: "Process environment wins; remaining values come from the .env file.",
});

const configCsv = [
  ["default.env.txt", DEFAULT_CONFIG, "full fixture config"],
  ["legacy-minutes.env.txt", DEFAULT_CONFIG.replace("OMNI_MAX_FRAMES=2400", "OMNI_PART_MINUTES=40"), "documented beta divergence: minutes had no effect"],
  ["missing-key.env.txt", "OMNI_LANG=en", "no API key -> readable config error before any paid call"],
];
for (const [name, contents, note] of configCsv) {
  write(path.join("config", name), `${contents}\n`);
  write(path.join("config", `${name}.note.txt`), `${note}\n`);
}

/* ------------------------------------------------------------------ identities */

writeJson("ids.json", {
  youtube: [
    "https://www.youtube.com/watch?v=SYNTHETIC01",
    "https://youtube.com/shorts/SYNTHETIC01",
    "https://www.youtube.com/live/SYNTHETIC01",
    "https://www.youtube.com/embed/SYNTHETIC01",
    "https://youtu.be/SYNTHETIC01",
  ],
  nonYoutube: [
    { url: "https://example.test/video/alpha", expectedLegacyId: "ade4dd11a0580e69" },
    { url: "https://example.test/video/alpha?x=1", expectedLegacyId: "ade4dd11a0580e69" },
    { url: "https://example.test/video/alpha#clip", expectedLegacyId: "ade4dd11a0580e69" },
  ],
  note: "YouTube -> SYNTHETIC01; canonicalized non-YouTube -> SHA-1 first 16.",
});

/* ---------------------------------------------------------------------- oss */

const oss = {
  "fresh.json": { "source.mp4": { url: "oss://fixture/source.mp4", at: NOW_SECONDS - 60 } },
  "expired.json": { "source.mp4": { url: "oss://fixture/source.mp4", at: NOW_SECONDS - 47 * 3600 } },
  "invalid.json": { "source.mp4": { url: "oss://fixture/source.mp4", at: "not-a-time" } },
  "future.json": { "source.mp4": { url: "oss://fixture/source.mp4", at: NOW_SECONDS + 60 } },
};
for (const [name, value] of Object.entries(oss)) writeJson(path.join("oss", name), value);
write(path.join("oss", "malformed.txt"), "{broken\n");

/* --------------------------------------------------------------------- media */

const MEDIA = [
  { id: "SYNTHETIC01", color: "0x1e6f5c" },
  { id: "ade4dd11a0580e69", color: "0x8b2f2f" },
];

function ensureMedia() {
  for (const { id, color } of MEDIA) {
    const dir = path.join(cache, id);
    fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
    const source = path.join(dir, "source.mp4");
    if (!fs.existsSync(source)) {
      ffmpeg([
        "-f", "lavfi", "-i", `color=c=${color}:s=320x180:d=16:r=10`,
        "-f", "lavfi", "-i", "sine=frequency=220:duration=16",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
      ]);
    }
    const frame = path.join(dir, "frames", "3.jpg");
    if (!fs.existsSync(frame)) {
      ffmpeg(["-ss", "3", "-i", source, "-frames:v", "1", "-q:v", "3", frame]);
    }
  }
  const a = path.join(cache, "SYNTHETIC01");
  const part0 = path.join(a, "part_2_0.mp4");
  const part1 = path.join(a, "part_2_1.mp4");
  if (!fs.existsSync(part0)) ffmpeg(["-ss", "0", "-t", "2", "-i", path.join(a, "source.mp4"), "-c", "copy", part0]);
  if (!fs.existsSync(part1)) ffmpeg(["-ss", "2", "-t", "2", "-i", path.join(a, "source.mp4"), "-c", "copy", part1]);
}

/* ---------------------------------------------------------------- legacy info */

writeJson(path.join(".cache", "SYNTHETIC01", "info.json"), {
  id: "SYNTHETIC01",
  title: "Fixture A — ekran",
  channel: "Fixture Channel",
  uploader: "Fallback A",
  duration: 16,
  extractor_key: "Youtube",
});
writeJson(path.join(".cache", "ade4dd11a0580e69", "info.json"), {
  id: "ade4dd11a0580e69",
  title: "Fixture B — dźwięk",
  channel: null,
  uploader: "Fixture Uploader",
  duration: 16,
  extractor_key: "Generic",
});

/* ----------------------------------------------------------------- summaries */

write(
  path.join("summaries", "SYNTHETIC01.md"),
  [
    "# Fixture A — ekran",
    "",
    "Fixture Channel · 0:16 · https://youtu.be/SYNTHETIC01",
    "",
    "---",
    "",
    "# 📋 Full summary of the video",
    "",
    "_2026-01-01 12:00_",
    "",
    "## In short",
    "Synthetic result: the screen shows 7.",
    "",
    "---",
    "",
    "# ❓ Co pokazuje ekran?",
    "",
    "_2026-01-01 12:01_",
    "",
    "[0:03] Syntetyczny ekran: 7.",
    "",
    "---",
    "",
    "# 🔧 Fixture teardown — mój temat",
    "",
    "_2026-01-01 12:02_",
    "",
    "Kamera statyczna, jeden kadr, brak montażu.",
  ].join("\n"),
);

// User-authored header, CRLF line endings and NO trailing newline on purpose.
write(
  path.join("summaries", "ade4dd11a0580e69.md"),
  "# Moje notatki\r\n\r\nhttps://example.test/video/alpha\r\n\r\n## In short\r\nSynthetic result: 220 Hz tone.",
);

/* ----------------------------------------------------------------------- SSE */

writeJson(path.join("sse", "single.events.json"), [
  { event: "stage", data: { step: "download" } },
  {
    event: "meta",
    data: {
      id: "SYNTHETIC01",
      title: "Fixture A — ekran",
      channel: "Fixture Channel",
      duration: "0:16",
      seconds: 16,
      strip: [0, 2, 2, 4, 4, 6, 6, 8, 8, 10, 10, 12, 12, 14, 14, 16],
    },
  },
  { event: "stage", data: { step: "upload" } },
  { event: "parts", data: { n: 1, starts: [0] } },
  { event: "uploaded", data: { reused: true } },
  { event: "stage", data: { step: "watch", parts: 1, fps: 10 } },
  { event: "stage", data: { step: "answer" } },
  { event: "answer.text", data: { text: "Synthetic result: the screen shows 7." } },
  { event: "done", data: { text: "Synthetic result: the screen shows 7.", usage: { in: 1000, out: 200, parts: 1, reused: true } } },
]);
writeJson(path.join("sse", "multipart.events.json"), [
  { event: "stage", data: { step: "download" } },
  { event: "parts", data: { n: 2, starts: [0, 1200] } },
  { event: "uploaded", data: { reused: false } },
  { event: "stage", data: { step: "watch", parts: 2, fps: 10 } },
  { event: "done", data: { text: "Two parts merged.", usage: { in: 2400, out: 400, parts: 2, reused: false } } },
]);
writeJson(path.join("sse", "error.events.json"), [
  { event: "stage", data: { step: "download" } },
  { event: "error", data: { error: "missing_config", message: "Brak klucza modelu." } },
]);

/* ------------------------------------------------------------------ CLI cases */

writeJson(path.join("cli", "cases.json"), [
  { argv: ["https://youtu.be/SYNTHETIC01"], expected: { mode: "summary", language: "from-config", exitCode: 0 } },
  { argv: ["https://youtu.be/SYNTHETIC01", "-q", "Co pokazuje ekran?"], expected: { mode: "summary", question: "Co pokazuje ekran?", exitCode: 0 } },
  { argv: ["https://youtu.be/SYNTHETIC01", "--lang", "en"], expected: { language: "en", exitCode: 0 } },
  { argv: ["https://youtu.be/SYNTHETIC01", "--teardown"], expected: { mode: "teardown", exitCode: 0 } },
  { argv: ["https://youtu.be/SYNTHETIC01", "-q", "Zażółć gęślą jaźń"], expected: { questionPreservedUtf8: true, exitCode: 0 } },
  { argv: [], expected: { exitCode: 2, errorClass: "invalid_input" } },
  { argv: ["http://127.0.0.1:9999/x"], expected: { exitCode: 2, errorClass: "invalid_input" } },
]);

writeJson(path.join("expected", "migration.json"), {
  modelCallsDuringMigration: 0,
  downloadsDuringMigration: 0,
  summarisedFilesModified: 0,
  legacyIdsRewritten: 0,
  note: "Migration reads configuration and old results; it never pays for analysis.",
});

/* ------------------------------------------------------------------ variants */

writeJson("variants.json", [
  "missing-source",
  "missing-info",
  "malformed-info",
  "missing-oss",
  "orphan-summary",
  "expired-local-cache",
  "incomplete-release",
]);

/* --------------------------------------------------------------- build + manifest */

function walk(dir, base = here) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "manifest.json" || entry.name === "make-fixtures.mjs") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

ensureMedia();

const files = [];
for (const rel of walk(here).sort()) {
  const file = path.join(here, rel);
  const buf = fs.readFileSync(file);
  const stat = fs.statSync(file);
  files.push({ path: rel, bytes: buf.length, sha256: sha256(buf), mtimeSeconds: Math.floor(stat.mtimeMs / 1000) });
}

writeJson("manifest.json", {
  fixtureVersion: 1,
  generatedBy: "test/fixtures/beta/make-fixtures.mjs",
  nowSeconds: NOW_SECONDS,
  nowMilliseconds: NOW_MILLISECONDS,
  mediaRecipe: "ffmpeg color=320x180@10fps 16s + sine 220Hz, libx264/aac; frame at 3s",
  secrets: "none: every key is the literal fixture-not-a-secret string",
  files,
});

write(
  "README.md",
  [
    "# Beta fixtures (synthetic)",
    "",
    "Generated by `make-fixtures.mjs`. No real `.env`, `.cache/`, `summaries/`,",
    "Vault, key or user file is read. Regenerate with:",
    "",
    "```bash",
    "node test/fixtures/beta/make-fixtures.mjs",
    "```",
    "",
    `Frozen clock: nowSeconds=${NOW_SECONDS}, nowMilliseconds=${NOW_MILLISECONDS}.`,
    "`manifest.json` lists every file with size, SHA-256 and mtime.",
  ].join("\n") + "\n",
);

console.log(`beta fixtures written: ${files.length} files`);
