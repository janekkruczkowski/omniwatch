// The A→B case, as a test.
//
// The bug this pins down: answers stay on screen after the tab has moved to another
// video, so a card for video A was offering to build a brief out of B, drawing A's
// evidence frames out of B's file, and jumping the player to a second that only means
// something in A. The three decisions that were reading the tab's current video —
// which frame, which brief, which video to seek — now take the card's own source, and
// those decisions are what this file runs.
//
//   node --test agent-os-module/test/card-source.test.mjs
//
// It needs a TypeScript compiler to load the component, which it borrows from the
// Agent OS install (AGENT_OS_SOURCE, default ~/Documents/agent-os/source). No browser,
// no build step.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW = process.env.OMNIWATCH_VIEW || path.join(HERE, "..", "src", "components", "OmniWatchView.tsx");
const AGENT_OS = process.env.AGENT_OS_SOURCE || path.join(process.env.HOME || "", "Documents", "agent-os", "source");

const source = readFileSync(VIEW, "utf8");
const req = createRequire(path.join(AGENT_OS, "package.json"));

// Load the real component module without a bundler: transpile it, and let the imports
// resolve out of Agent OS's own node_modules (react, lucide-react).
function loadView() {
  const ts = req("typescript");
  const out = ts.transpileModule(source, {
    fileName: VIEW,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;

  const dir = mkdtempSync(path.join(tmpdir(), "omniwatch-card-"));
  writeFileSync(path.join(dir, "OmniWatchView.js"), out);
  for (const stub of ["OmniMarkdown", "ChannelScan", "OmniLibrary"]) {
    writeFileSync(path.join(dir, `${stub}.js`),
      "module.exports = { __esModule: true, default: () => null, TS_RE: /x/g, toSec: () => 0 };");
  }
  req.extensions[".css"] = () => {};
  writeFileSync(path.join(dir, "OmniWatch.css"), "");

  process.env.NODE_PATH = [path.join(AGENT_OS, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  req("node:module").Module._initPaths();

  return req(path.join(dir, "OmniWatchView.js"));
}

const view = loadView();

const A = { url: "https://youtu.be/video-A", lang: "en", id: "aaa", title: "A — the teardown", seconds: 47, channel: "Chan A", duration: "0:47" };
const B = { url: "https://youtu.be/video-B", lang: "pl", id: "bbb", title: "B — the other one", seconds: 12, channel: "Chan B", duration: "0:12" };

const cardA = { id: 1, q: "", mode: "teardown", text: "## Hook\n- [0:03] the claim", src: A, done: true, stats: {} };

test("a card's frames come from the card's video, not the one the tab moved on to", () => {
  // B is the video in the player now; the card on screen is A's.
  assert.equal(view.frameUrl(A, 3), "/api/omniwatch/media/frame/aaa/3");
  assert.equal(view.frameUrl(cardA.src, 3.9), "/api/omniwatch/media/frame/aaa/3");
  assert.notEqual(view.frameUrl(cardA.src, 3), view.frameUrl(B, 3));
});

test("a card with no metadata yet asks for no frame instead of guessing", () => {
  const pending = { url: "https://youtu.be/video-A", lang: "en", title: "", seconds: 0 };
  assert.equal(view.frameUrl(pending, 3), "");
  assert.equal(view.frameUrl(null, 3), "");
});

test("the brief is built from the card's own video, even while the tab is on B", () => {
  const body = view.briefBody(cardA, A, "cold email teardown", "  the myth  ", "voiceover", "pattern");
  assert.deepEqual(body, {
    url: "https://youtu.be/video-A", title: "A — the teardown", seconds: 47,
    text: cardA.text, topic: "cold email teardown", angle: "the myth", mode: "voiceover", lang: "en",
    purpose: "pattern",
  });
  assert.notEqual(view.briefBody(cardA, A, "t", "", "avatar", "pattern").url, B.url);
  assert.equal(view.briefBody(cardA, A, "t", "", "avatar", "pattern").angle, "");
});

test("briefBody carries purpose through unchanged, and the default UI choice is pattern", () => {
  // purpose passes through exactly as given — this is a pass-through, not a
  // normalisation, so a caller's own value (whatever it is) survives untouched.
  assert.equal(view.briefBody(cardA, A, "t", "", "avatar", "pattern").purpose, "pattern");
  assert.equal(view.briefBody(cardA, A, "t", "", "avatar", "review").purpose, "review");
  // The component itself defaults the control's state to "pattern" — a person who
  // never touches the purpose control gets exactly today's behaviour.
  assert.match(source, /useState<"pattern" \| "review">\("pattern"\)/, "the purpose control defaults to pattern");
});

test("review survives to the payload sent to /api/omniwatch/recreate", () => {
  const body = view.briefBody(cardA, A, "cold email teardown", "the myth", "voiceover", "review");
  assert.equal(body.purpose, "review");
  assert.deepEqual(body, {
    url: "https://youtu.be/video-A", title: "A — the teardown", seconds: 47,
    text: cardA.text, topic: "cold email teardown", angle: "the myth", mode: "voiceover", lang: "en",
    purpose: "review",
  });
});

test("a streaming or failed card does not offer a brief", () => {
  // text is already on screen while the answer is still being written
  assert.equal(view.canBuildBrief({ ...cardA, done: false }, A), false);
  assert.equal(view.canBuildBrief({ ...cardA, error: "boom" }, A), false);
  assert.equal(view.canBuildBrief({ ...cardA, text: "" }, A), false);
  assert.equal(view.canBuildBrief({ ...cardA, mode: "ask" }, A), false);
  assert.equal(view.canBuildBrief(cardA, A), true);
});

test("a card whose video is not resolved yet does not offer a brief", () => {
  const unresolved = { url: A.url, lang: "en", title: "", seconds: 0 };
  assert.equal(view.canBuildBrief(cardA, unresolved), false);
  assert.equal(view.canBuildBrief(cardA, { ...unresolved, id: "aaa", title: "A", seconds: 0 }), false);
  assert.equal(view.canBuildBrief(cardA, null), false);
});

test("the component wires the card's own source into frames, seeking and the brief", () => {
  // The decisions above are only the fix if the render path uses them per card. These
  // are the call sites that used to read the tab's current meta.
  assert.match(source, /frame=\{\(sec\) => frameUrl\(c\.src, sec\)\}/, "Answer gets the card's frames");
  assert.match(source, /onSeek=\{\(sec\) => seek\(sec, c\.src\?\.id\)\}/, "Answer seeks the card's video");
  assert.match(source, /source=\{c\.src \?\? null\}/, "Answer gets the card's source");
  assert.match(source, /canBuildBrief\(card, source\) && source/, "MakeSimilar is gated on the finished card");
  assert.match(source, /briefBody\(card, source, topic, angle, mode, purpose\)/, "the brief body carries the angle and purpose");
  assert.match(source, /setAngle/, "MakeSimilar has its own angle field");
  // and the old wiring is gone
  assert.doesNotMatch(source, /onSeek=\{seek\} frame=\{frame\}/, "no tab-wide seek/frame left on cards");
  assert.doesNotMatch(source, /card\.text && !card\.error && card\.mode === "teardown" && source &&/, "the ungated button is gone");
});

test("the player follows the card back and the caption follows the player", () => {
  assert.match(source, /src=\{`\/api\/omniwatch\/media\/video\/\$\{playId \|\| meta\.id\}`\}/);
  assert.match(source, /onLoadedMetadata=\{applyPendingSeek\}/);
  assert.match(source, /playing\?\.title \|\| meta\.title/);
});

test("a second poll does not yank the player back off an older card", () => {
  // Run B's first report: the player is handed to B.
  assert.deepEqual(view.pinPlayerForRun(false, "bbb", "aaa"), { id: "bbb", moved: true });
  // The next poll of the same run, 700 ms later. The person has clicked a timestamp on
  // card A in the meantime, so the player is on A and has to stay there.
  assert.deepEqual(view.pinPlayerForRun(true, "bbb", "aaa"), { id: "aaa", moved: false });
  assert.deepEqual(view.pinPlayerForRun(true, "bbb", "bbb"), { id: "bbb", moved: false });
  // A run reporting the video already in the player moves nothing, so nothing is queued.
  assert.deepEqual(view.pinPlayerForRun(false, "bbb", "bbb"), { id: "bbb", moved: false });
});

test("the poll pins the player per run, not per poll, and clears a stale queued seek", () => {
  assert.match(source, /let playerPinned = false;/, "the flag lives in ask(), so it is per run");
  assert.match(source, /pinPlayerForRun\(playerPinned, m\.id, playIdRef\.current\)/);
  assert.match(source, /if \(step\.moved\) setPlayer\(m\.id, true\);/, "a run's first report clears the queued seek");
  assert.doesNotMatch(source, /setPlayId\(d\.meta\.id\)/, "no per-poll switch back to the new video");
});

test("the form submits the mode that was clicked, and follow-ups are questions", () => {
  assert.match(source, /const submit = \(\) => ask\(question, undefined, mode === "teardown" \? "teardown" : "ask"\)/);
  assert.match(source, /onClick=\{submit\}/, "the button");
  assert.match(source, /e\.preventDefault\(\); submit\(\); \}/, "and ⌘↵");
  assert.match(source, /ask\(followUp, undefined, "ask"\)/, "a follow-up is always a question");
  assert.doesNotMatch(source, /cards\.length > 0 \? "ask"/, "the cards.length guess is gone");
});

test("FAIL-A: only a retryable (outcome_unknown) failure offers a retry, and it carries id + consent only", () => {
  const warning = "Wywołanie modelu ma nieznany wynik; ponowienie moze oznaczac drugi koszt u dostawcy.";
  assert.deepEqual(view.retryOffer({ retryable: true, retryWarning: warning }, "op_1"), { operationId: "op_1", kind: "unknown", warning });
  assert.equal(view.retryOffer({ retryable: true, operationId: "op_2", retryWarning: warning }).operationId, "op_2");
  assert.equal(view.retryOffer({ error: "source_unavailable" }, "op_3"), undefined, "an ordinary failure has no paid retry");
  assert.equal(view.retryOffer({ retryable: true }), undefined, "no operation id, no retry");
  assert.deepEqual(view.retryBody("op_1"), { retryOperation: "op_1", confirmRetry: true });
});

test("a definitively failed run offers a plain 'try again' (no cost warning) that resumes the same operation", () => {
  const offer = view.retryOffer({ retryFailed: true, error: "Filtr treści Qwen odrzucił część 3" }, "op_9",
    { retryFailedNote: "Gotowe części zostaną użyte ponownie; zapłacisz tylko za brakujące." });
  assert.deepEqual(offer, { operationId: "op_9", kind: "failed", warning: "Gotowe części zostaną użyte ponownie; zapłacisz tylko za brakujące." });
  assert.equal(view.retryOffer({ retryFailed: true }), undefined, "no operation id, no retry");
});
