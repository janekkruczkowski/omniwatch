// R5, the Agent OS panel download (`downloadForPanel` over the host library's `run`)
// really invokes yt-dlp through the shared
// classifier/retry, and passes browser cookies ONLY when the user configured them.
//
//   node --test agent-os-module/test/ytdlp-host.test.mjs
//
// Hermetic: HOME points at a temp directory, so the library's own PATH puts a fake
// `yt-dlp` (a shell script that records its arguments and plays back scripted outcomes)
// first, and its cache lives in the temp directory too. No network, no real yt-dlp, no
// browser profile and none of the user's data is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { downloadForPanel } from "../src/lib/omniwatchPanelRuntime.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(process.env.HOME || "", "Documents", "agent-os", "source");
const req = createRequire(path.join(AGENT_OS, "package.json"));

const HOME = mkdtempSync(path.join(tmpdir(), "omni-r5-home-"));
const BIN = path.join(HOME, ".local", "bin");
const LOG = path.join(HOME, "yt-dlp.calls");
const SCRIPT = path.join(HOME, "yt-dlp.script");
mkdirSync(BIN, { recursive: true });
writeFileSync(path.join(BIN, "yt-dlp"), `#!/bin/sh
printf '%s\\n' "$*" >> "${LOG}"
next=$(head -n 1 "${SCRIPT}" 2>/dev/null)
tail -n +2 "${SCRIPT}" > "${SCRIPT}.rest" 2>/dev/null; mv "${SCRIPT}.rest" "${SCRIPT}"
case "$next" in
  429) echo "ERROR: [youtube] QzTkVaC-da4: Unable to download webpage: HTTP Error 429: Too Many Requests" >&2; exit 1 ;;
  bot) echo "WARNING: [youtube] QzTkVaC-da4: HTTP Error 429: Too Many Requests" >&2
       echo "ERROR: [youtube] QzTkVaC-da4: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies" >&2; exit 1 ;;
esac
out=""; prev=""; json=0
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  [ "$a" = "-J" ] && json=1
  prev="$a"
done
if [ "$json" = 1 ]; then echo '{"title":"Fake","channel":"Chan","duration":12,"extractor_key":"Youtube"}'; exit 0; fi
[ -n "$out" ] && printf 'fake-mp4' > "$out"
exit 0
`);
chmodSync(path.join(BIN, "yt-dlp"), 0o755);

// The library computes its PATH and cache root from the home directory when it loads.
process.env.HOME = HOME;

function transpile(file, rewrite = (s) => s) {
  const ts = req("typescript");
  return rewrite(ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
}

function loadLib() {
  const dir = mkdtempSync(path.join(tmpdir(), "omni-r5-lib-"));
  writeFileSync(path.join(dir, "errors.js"), transpile(path.join(REPO, "packages/omniwatch/src/contracts/errors.ts")));
  writeFileSync(path.join(dir, "ytdlp.js"), transpile(
    path.join(REPO, "packages/omniwatch/src/sources/ytdlp.ts"),
    (s) => s.replace(/require\("\.\.\/contracts\/errors\.ts"\)/g, 'require("./errors")'),
  ));
  writeFileSync(path.join(dir, "omniwatch.js"), transpile(
    path.join(REPO, "agent-os-module/src/lib/omniwatch.ts"),
    (s) => s
      .replace(/require\("@\/lib\/omniwatchI18n"\)/g, 'require("./i18n")')
      .replace(/require\("@\/lib\/omniwatchBlueprint"\)/g, 'require("./blueprint")')
      .replace(/require\("(?:\.\.\/)+packages\/omniwatch\/src\/sources\/ytdlp\.ts"\)/g, 'require("./ytdlp")'),
  ));
  writeFileSync(path.join(dir, "i18n.js"), "module.exports = { __esModule: true, default: { en: { sections: {} } } };");
  writeFileSync(path.join(dir, "blueprint.js"), "module.exports = { BLUEPRINT_SCHEMA_PROMPT: '' };");
  return req(path.join(dir, "omniwatch.js"));
}

const lib = loadLib();

function script(lines) {
  writeFileSync(SCRIPT, lines.map((l) => `${l}\n`).join(""));
  writeFileSync(LOG, "");
}
const calls = () => readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean);

let n = 0;
/** A fresh video id per test, so the download cache never short-circuits a test. */
const freshUrl = () => `https://www.youtube.com/watch?v=R5test${String(n++).padStart(5, "0")}`;

test("the library runs the fake yt-dlp under the temp HOME, never the real one", () => {
  assert.ok(lib.BIN_PATH.startsWith(BIN), "the temp bin directory is first on the library's PATH");
  assert.ok(lib.CACHE_ROOT.startsWith(HOME), "the cache is inside the temp HOME");
});

test("no cookie flag unless configured", async () => {
  script(["ok", "ok"]);
  const { src } = await downloadForPanel(lib, freshUrl(), { env: { OMNIWATCH_YTDLP_RETRY_SECONDS: "0" } });
  assert.ok(existsSync(src));
  const made = calls();
  assert.equal(made.length, 2, "metadata + download");
  for (const line of made) assert.doesNotMatch(line, /--cookies/, line);
});

test("cookies from the browser are passed to every yt-dlp call when (and only when) configured", async () => {
  script(["ok", "ok"]);
  await downloadForPanel(lib, freshUrl(), { env: { OMNIWATCH_YTDLP_COOKIES_FROM_BROWSER: "chrome", OMNIWATCH_YTDLP_RETRY_SECONDS: "0" } });
  const made = calls();
  assert.equal(made.length, 2);
  for (const line of made) assert.match(line, /^--cookies-from-browser chrome /, line);

  script(["ok", "ok"]);
  await downloadForPanel(lib, freshUrl(), { env: { OMNIWATCH_YTDLP_COOKIES: "/tmp/r5-cookies.txt", OMNIWATCH_YTDLP_RETRY_SECONDS: "0" } });
  for (const line of calls()) assert.match(line, /^--cookies \/tmp\/r5-cookies\.txt /, line);
});

test("a 429 is retried exactly once, after a reported wait", async () => {
  script(["429", "ok", "ok"]);
  const waits = [];
  const { info } = await downloadForPanel(lib, freshUrl(), {
    env: { OMNIWATCH_YTDLP_RETRY_SECONDS: "0" },
    onWait: (wait) => waits.push(wait),
  });
  assert.equal(info.title, "Fake");
  assert.equal(calls().length, 3, "metadata (429), metadata again, download");
  assert.deepEqual(waits, [{ reason: "rate_limited_by_youtube", seconds: 0, attempt: 1 }]);
});

test("a bot check fails at once, classified, with the raw output kept for details", async () => {
  script(["bot", "ok"]);
  const waits = [];
  await assert.rejects(
    downloadForPanel(lib, freshUrl(), { env: { OMNIWATCH_YTDLP_RETRY_SECONDS: "0" }, onWait: (w) => waits.push(w) }),
    (error) => {
      assert.equal(error.errorClass, "source_unavailable");
      assert.match(error.message, /weryfikacja "nie jestem botem"/);
      assert.match(error.message, /--- yt-dlp ---\n[\s\S]*Sign in to confirm you're not a bot/);
      return true;
    },
  );
  assert.equal(calls().length, 1, "no retry for a bot check");
  assert.deepEqual(waits, []);
});
