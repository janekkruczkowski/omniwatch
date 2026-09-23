/**
 * R2-02 (offline, stub model): a question in one language about an analysis saved in
 * another must not become a false "nie znalazłem tego w analizach".
 *
 * QA 2026-09-23 reproduced it in Agent OS: the panel's default language is `en`, so the
 * analysis of `https://www.youtube.com/shorts/c-lBErfxszs` was saved in English while
 * the question was Polish ("Jaki zakres kąta ramion podaje instruktor w filmie Perfect
 * Push-Up?"). The note holds "40–60°", yet the library answered NOT_FOUND without
 * calling any model: `queryTerms` produced eight terms, the gate was 60% of all of them
 * (five), and only `perfect` and `push` matched — `instruktor` is not `instructor`.
 *
 * The fix keeps retrieval lexical (SPEC D7: no vector DB, no RAG, the host Vault is the
 * only knowledge base) and adds two things: a cheap host-model call that turns the
 * question into keywords in the notes' language, and a gate computed over the
 * question's *content* terms instead of all of its tokens.
 *
 * What this file pins down:
 *   - a Polish question about an English note is found and answered with [[path|title]];
 *   - the reverse direction works too;
 *   - a topic that is really absent still answers NOT_FOUND, and when the question is
 *     already in the notes' language it pays for no model call at all;
 *   - the expansion call never receives note content (only the question);
 *   - a question the library can already answer pays for no expansion call;
 *   - a missing host model is a loud `missing_config`, never a false NOT_FOUND.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EVIDENCE_CHARS_PER_NOTE,
  EXPANSION_FAILED_TEXT,
  NOT_FOUND_TEXT,
  QUERY_EXPANSION_SYSTEM,
  createVaultMemory,
  detectLanguage,
  evidencePassage,
  expansionKeywords,
  expansionKeywordsFromReply,
  gateThreshold,
  languageName,
  queryTerms,
  stemToken,
} from "../../agent-os-module/src/lib/omniwatchMemory.ts";
import { OmniWatchError } from "../../packages/omniwatch/src/contracts/errors.ts";
import { ANALYSIS_VERSION } from "../../packages/omniwatch/src/contracts/index.ts";

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempVault() {
  const dir = mkdtempSync(join(tmpdir(), "omniwatch-r202-"));
  tempDirs.push(dir);
  const vault = join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  return { dir, vault };
}

function makeResult({ analysisId, title, content, language, sourceId = "SYNTH0001", canonicalUrl = "https://youtu.be/SYNTH0001" }) {
  return {
    analysisId,
    analysisKey: `key_${analysisId}`,
    mode: "summary",
    focus: null,
    question: null,
    language,
    analysisVersion: ANALYSIS_VERSION,
    sourceRef: { platform: "youtube", sourceId, canonicalUrl, legacyId: sourceId },
    title,
    content,
    highlights: [],
    conversationId: `conv_${analysisId}`,
    turnId: `turn_${analysisId}`,
    parentTurnId: null,
    parts: 1,
    usage: { inputTokens: 100, outputTokens: 20, costUsd: null, costKnown: false },
    createdAt: "2026-09-23T10:00:00.000Z",
  };
}

/** The English note from the QA reproduction: the answer is the arm angle, 40–60°. */
const PUSHUP_EN = makeResult({
  analysisId: "omni_pushup",
  title: "Perfect Push-Up — form breakdown",
  language: "en",
  sourceId: "c-lBErfxszs",
  canonicalUrl: "https://www.youtube.com/shorts/c-lBErfxszs",
  content: [
    "## Summary",
    "The instructor breaks down the perfect push-up and the arm angle he teaches.",
    "The clip opens with a short introduction to the camera.",
    "He repeats that the elbows stay at a 40-60 degree angle to the torso during every rep.",
    "## Notes",
    "Hands are shoulder width apart; the hips never sag.",
  ].join("\n"),
});

/** A Polish note about a different topic, used to prove the absent topic stays absent. */
const POLISH_NOTE = makeResult({
  analysisId: "omni_pl",
  title: "Montaż i dźwięk",
  language: "pl",
  content: "Teardown opisuje montaż, cięcia oraz warstwę dźwięku w tle.",
});

const PL_QUESTION = "Jaki zakres kąta ramion podaje instruktor w filmie Perfect Push-Up?";
const ABSENT_PL = "Co mówiono o fuzji jądrowej w tokamaku?";

/**
 * Stub host model. It answers the cheap expansion call with keywords in the notes'
 * language and the grounded call with a sentence carrying a [[path|title]] reference,
 * exactly like the real host model would. Every call is recorded so the tests can
 * assert how many were made and what each one received.
 *
 * `keywords` is the raw reply; it defaults to the JSON array the prompt asks for, so
 * the happy path exercises the requested format. A test that wants to pin the prose
 * fallback passes a comma list instead.
 */
function stubModel({ keywords = '["instructor", "arm angle", "range", "degrees", "push-up"]', answer = null } = {}) {
  const calls = [];
  const model = {
    modelName: "stub-crosslang",
    calls,
    tools: [],
    expansionCalls: () => calls.filter((call) => call.system.startsWith(QUERY_EXPANSION_SYSTEM)),
    answerCalls: () => calls.filter((call) => !call.system.startsWith(QUERY_EXPANSION_SYSTEM)),
    async complete(request) {
      calls.push(request);
      if (request.system.startsWith(QUERY_EXPANSION_SYSTEM)) return keywords;
      return answer ?? "Instruktor podaje kąt 40–60° [[OmniWatch/Analyses/omni_pushup.md|Perfect Push-Up — form breakdown]].";
    },
  };
  return model;
}

async function library(notes, model) {
  const { vault } = tempVault();
  const memory = createVaultMemory({ root: vault, model });
  for (const note of notes) await memory.writeAnalysis(note);
  return { vault, memory };
}

/* ---------------------------------------------------------------- unit level --- */

test("R2-02: the gate counts the question's content terms, not all of its tokens", () => {
  const terms = queryTerms(PL_QUESTION);
  // The QA reproduction: eight terms, of which `podaje` is a verb that names no topic.
  assert.ok(terms.includes("instruktor"), "the Polish word for instructor is a term");
  assert.ok(terms.includes("perfect") && terms.includes("push"), "the title words survive");
  assert.equal(terms.length, 8, `expected the eight QA terms, got ${terms.join(",")}`);
  // 7 content terms (podaje is a verb) at 40% => 3, not the old ceil(0.6*8)=5.
  assert.equal(gateThreshold(terms), 3);
  assert.equal(gateThreshold(queryTerms("narzedzie")), 1, "one content term still needs one match");
});

test("R2-02: Polish inflection meets the note's form through the stem, not the prefix", () => {
  assert.equal(stemToken("ramiona"), stemToken("ramion"), "ramiona/ramion share a stem");
  assert.equal(stemToken("ramion"), "ramion", "the question's own form is already a stem");
  assert.equal(stemToken("kata"), "kat", "kąta -> kat");
  assert.equal(stemToken("katem"), "kat", "kątem -> kat");
  assert.equal(stemToken("instructor"), "instructor", "an English word is left alone");
  assert.notEqual(stemToken("instructor"), stemToken("instruktor"), "the QA pair stays distinct");
});

test("R2-02: expansion keywords are folded, deduplicated and stripped of filler", () => {
  assert.deepEqual(
    expansionKeywords("Slowa kluczowe: instructor, arm angle, 40-60 degrees, instructor."),
    ["instructor", "arm", "angle", "degrees"],
    "`40`/`60` are two characters, filler words are dropped, duplicates collapse",
  );
  assert.deepEqual(expansionKeywords(""), []);
});

test("R2-02: the question's language is recognised, with or without diacritics", () => {
  assert.equal(detectLanguage(PL_QUESTION), "pl", "Polish without diacritics is still Polish");
  assert.equal(detectLanguage("Co mówiono o fuzji jądrowej w tokamaku?"), "pl");
  assert.equal(detectLanguage("What arm angle does the instructor show?"), "en");
  assert.equal(detectLanguage("   "), null, "an empty question claims no language");
});

test("R2-02: after expansion the evidence passage is ranked to the sentence with 40-60°", () => {
  // The passage is ranked by the terms actually used for the search, so it must be
  // built from the merged terms: those surface the two lines about the arm angle and
  // the ranking picks them out of the note.
  const merged = [...queryTerms(PL_QUESTION), "instructor", "arm", "angle", "degrees"];
  const passage = evidencePassage(merged, PUSHUP_EN.content);
  assert.match(passage, /40-60 degree/, "the answering sentence is in the evidence");
  assert.match(passage, /arm angle he teaches/, "the other ranking line is there too");
  assert.doesNotMatch(passage, /hips never sag/, "unranked lines are left out");
  assert.ok(passage.length <= EVIDENCE_CHARS_PER_NOTE, "the evidence stays bounded");
  // The question's own words only reach the title words ("perfect push-up") in an English
  // note, so without the expansion the evidence misses the answering sentence.
  const ownOnly = evidencePassage(queryTerms(PL_QUESTION), PUSHUP_EN.content);
  assert.doesNotMatch(ownOnly, /40-60 degree/, "without expansion the answer is not in the evidence");
});

/* ------------------------------------------------------------- end to end --- */

test("R2-02: a Polish question finds and answers from an English note, with a reference", async () => {
  const model = stubModel();
  const { memory } = await library([PUSHUP_EN, POLISH_NOTE], model);

  const answer = await memory.answerFromAnalyses(PL_QUESTION, { limit: 3 });
  assert.equal(answer.notFound, false, `expected a grounded answer, got: ${answer.text}`);
  assert.deepEqual(answer.refs.map((ref) => ref.analysisId), ["omni_pushup"]);
  assert.equal(answer.refs[0].relativePath, "OmniWatch/Analyses/omni_pushup.md");
  assert.match(answer.text, /\[\[OmniWatch\/Analyses\/omni_pushup\.md\|Perfect Push-Up — form breakdown\]\]/);
  assert.match(answer.text, /https:\/\/www\.youtube\.com\/shorts\/c-lBErfxszs/, "the source URL is attributed");

  // One cheap expansion call, then one grounded call — and the note body reached only
  // the grounded call: the expansion sees the question alone.
  assert.equal(model.expansionCalls().length, 1, "exactly one keyword call");
  assert.equal(model.answerCalls().length, 1, "exactly one grounded call");
  assert.match(model.expansionCalls()[0].user, /Perfect Push-Up/, "the expansion gets the question");
  assert.doesNotMatch(model.expansionCalls()[0].user, /40-60 degree/, "no note content reaches it");
  assert.match(model.answerCalls()[0].user, /40-60 degree/, "the grounded call gets the evidence");
});

test("R2-02: the reverse direction works — an English question about a Polish note", async () => {
  const polishNote = makeResult({
    analysisId: "omni_pl_angle",
    title: "Kąt ramion w pompce",
    language: "pl",
    content: "Instruktor pokazuje, że ramiona ustawiamy pod kątem 40-60 stopni do tułowia.",
  });
  const model = stubModel({ keywords: '["kat", "ramion", "pompka", "instruktor", "stopnie"]' });
  const { memory } = await library([polishNote], model);

  const answer = await memory.answerFromAnalyses("What arm angle does the instructor show for push-ups?", { limit: 3 });
  assert.equal(answer.notFound, false, `expected a grounded answer, got: ${answer.text}`);
  assert.deepEqual(answer.refs.map((ref) => ref.analysisId), ["omni_pl_angle"]);
  assert.equal(model.expansionCalls().length, 1);
});

test("R2-02: a question the library can already answer pays for no expansion call", async () => {
  const model = stubModel();
  const { memory } = await library([POLISH_NOTE], model);

  const answer = await memory.answerFromAnalyses("Co mówiono o montażu i dźwięku?", { limit: 3 });
  assert.equal(answer.notFound, false);
  assert.equal(model.expansionCalls().length, 0, "the notes' own language needs no translation");
  assert.equal(model.answerCalls().length, 1);
});

test("R2-02: a really absent topic stays notFound and costs no model call", async () => {
  const model = stubModel();
  // Polish notes and a Polish question: the words are already in the right language, so
  // an empty result means the topic is absent and no call is made (the old behaviour).
  const { memory } = await library([POLISH_NOTE], model);

  const answer = await memory.answerFromAnalyses(ABSENT_PL);
  assert.equal(answer.notFound, true);
  assert.equal(answer.text, NOT_FOUND_TEXT);
  assert.deepEqual(answer.refs, []);
  assert.equal(model.calls.length, 0, "an absent topic in the notes' own language is free");
});

test("R2-02: an absent topic with a language mismatch costs one cheap call, never a grounded one", async () => {
  const model = stubModel({ keywords: '["nuclear fusion", "tokamak", "reactor"]' });
  // The library is English, the question Polish: the adapter must look before it says
  // "not found", but it must not pay for the expensive grounded answer.
  const { memory } = await library([PUSHUP_EN], model);

  const answer = await memory.answerFromAnalyses(ABSENT_PL);
  assert.equal(answer.notFound, true);
  assert.deepEqual(answer.refs, []);
  assert.equal(model.answerCalls().length, 0, "no evidence means no grounded call");
  assert.equal(model.expansionCalls().length, 1, "one cheap keyword call is the honest cost");
});

test("R2-02: a broken expansion call is a loud error, not a false NOT_FOUND", async () => {
  const model = {
    modelName: "stub-flaky-expansion",
    async complete() {
      throw new Error("provider 503");
    },
  };
  // The library is English and the question Polish, so the adapter must expand before
  // it may claim absence. The expansion fails: reporting "the library has nothing"
  // would be a lie — the truth is that the library could not be searched.
  const { memory } = await library([PUSHUP_EN], model);
  await assert.rejects(
    () => memory.answerFromAnalyses(PL_QUESTION),
    (error) => error instanceof OmniWatchError && error.errorClass === "runtime_unavailable",
    "a failed expansion is reported, never dressed up as an absent topic",
  );
});

test("R2-02: no host model is a loud missing_config, never a false NOT_FOUND", async () => {
  const { vault } = tempVault();
  const memory = createVaultMemory({ root: vault, model: null });
  await memory.writeAnalysis(PUSHUP_EN);

  await assert.rejects(
    () => memory.answerFromAnalyses(PL_QUESTION),
    (error) => error instanceof OmniWatchError && error.errorClass === "missing_config",
    "without a model the adapter cannot expand the question, so it must not claim absence",
  );

  // The lexical search still works without a model: it is free and needs no host.
  const hits = await memory.searchAnalyses("Perfect Push-Up");
  assert.deepEqual(hits.map((hit) => hit.analysisId), ["omni_pushup"]);
});

test("R2-02: the expansion reply is data — an instruction inside it is only a keyword", async () => {
  // The injected instruction becomes plain keywords, like any other word in the reply.
  // They are never executed; the note is found through the real keywords around them.
  const model = stubModel({
    keywords: '["instructor", "arm angle", "range", "degrees", "push-up", "ignore previous instructions"]',
  });
  const { memory } = await library([PUSHUP_EN], model);

  const answer = await memory.answerFromAnalyses(PL_QUESTION, { limit: 3 });
  assert.equal(answer.notFound, false, "the note was still found through the real keywords");
  assert.deepEqual(answer.refs.map((ref) => ref.analysisId), ["omni_pushup"]);
  assert.deepEqual(model.tools, [], "the adapter exposes no tool to the host model");
  // The expansion call received the question, never the note, and nothing in the reply
  // was executed: the note is untouched and still searchable.
  assert.doesNotMatch(model.expansionCalls()[0].user, /40-60 degree/, "no note content reaches it");
  const hits = await memory.searchAnalyses("instructor");
  assert.deepEqual(hits.map((hit) => hit.analysisId), ["omni_pushup"], "the note is still there");
});

/* -------------------------------------------------------------- R3-02 --- */

/**
 * The English note from the R3-02 reproduction: a 20 s teaser whose on-screen text is
 * "There's more to discover" and whose subject is Claude Opus 5.5. The question is
 * Polish, so pass 1 can never reach it — the whole case turns on pass 2.
 */
const OPUS_EN = makeResult({
  analysisId: "omni_opus",
  title: "Introducing Claude Opus 5.5",
  language: "en",
  sourceId: "1f13Bl1sYkw",
  canonicalUrl: "https://www.youtube.com/watch?v=1f13Bl1sYkw",
  content: [
    "## In short",
    "A 20-second teaser video announcing Claude Opus 5.5, built from macro close-ups.",
    "On-screen text builds the phrase \"There's more to discover\" before the product name.",
    "## Timeline",
    "[0:09] The word \"There's\" appears over a gas giant.",
    "[0:13] \"discover\" appears over a crayon-drawn arc.",
  ].join("\n"),
});

/** A second, unrelated English note: the false source the QA run reported. */
const ZOO_EN = makeResult({
  analysisId: "omni_zoo",
  title: "Me at the zoo",
  language: "en",
  sourceId: "jNQXAC9IVRw",
  canonicalUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  content: "A young man films himself in front of an elephant enclosure and says the trunks are long.",
});

/** A third note that shares ONE generic word with the question and nothing else. */
const FILM_EN = makeResult({
  analysisId: "omni_film",
  title: "How we shot the film",
  language: "en",
  sourceId: "FILM00001",
  canonicalUrl: "https://youtu.be/FILM00001",
  content: "The crew talks about the film and how the lighting was set up on location.",
});

const OPUS_PL = "Jakie hasło pojawia się na ekranie w filmie zapowiadającym Claude Opus 5.5?";
/** The grounded reply the stub returns for the teaser note. */
const OPUS_ANSWER =
  'Na ekranie pojawia się hasło „There\'s more to discover" [[OmniWatch/Analyses/omni_opus.md|Introducing Claude Opus 5.5]].';

test("R3-02: the expansion call is deterministic — temperature 0, low reasoning, JSON, one language", async () => {
  const model = stubModel({ keywords: '["hasło", "ekran", "zapowiedź", "Claude Opus 5.5"]', answer: OPUS_ANSWER });
  const { memory } = await library([OPUS_EN], model);

  await memory.answerFromAnalyses(OPUS_PL, { limit: 3 });
  const call = model.expansionCalls()[0];
  assert.ok(call, "the Polish question against an English note must expand");
  // The two fields that made the step deterministic and cheap (R3-02): without them the
  // model spent 360-1290 output tokens on reasoning for a 4-8 word answer, and two runs
  // of the same question returned different keywords.
  assert.equal(call.temperature, 0, "the keyword call pins the temperature");
  assert.equal(call.reasoningEffort, "low", "reasoning is turned down, as the analysis provider does");
  // The prompt asks for a JSON array and names ONE language: the old "polski lub
  // angielski" let the model hedge with both, which is what inflated the gate.
  assert.match(call.system, /tablic/i, "the reply format is requested");
  assert.match(call.system, /polski|angielski/, "the target language is named");
  assert.doesNotMatch(call.system, /polski lub angielski/, "the model is no longer left to choose");
});

test("R3-02: the expansion reply is parsed from JSON, and prose still falls back cleanly", () => {
  // The requested shape. Each element is folded and tokenised like any text, so
  // `Claude Opus 5.5` becomes two keywords and `5.5` is dropped (it is two characters).
  // `hasło` is dropped as reply filler — it is the Polish word for "password" and the
  // noise list already covers it — which is the same rule the prose path always had.
  assert.deepEqual(
    expansionKeywordsFromReply('["hasło", "ekran", "Claude Opus 5.5"]'),
    ["ekran", "claude", "opus"],
    "array elements are folded, tokenised and stripped of reply filler",
  );
  // A model that wraps the array in prose or a fence still yields its elements.
  assert.deepEqual(
    expansionKeywordsFromReply('Oto slowa kluczowe:\n```json\n["ekran", "zapowiedź"]\n```'),
    ["ekran", "zapowiedz"],
  );
  // A model that ignores the format is not punished for it: the prose path is the old
  // behaviour, so a format drift can never turn into a false "could not translate".
  assert.deepEqual(
    expansionKeywordsFromReply("Slowa kluczowe: ekran, zapowiedź"),
    ["ekran", "zapowiedz"],
  );
  // A reply that is not an array at all falls back to the whole text, not to nothing.
  assert.deepEqual(expansionKeywordsFromReply("ekran, zapowiedź"), ["ekran", "zapowiedz"]);
  // Nothing usable really is nothing usable.
  assert.deepEqual(expansionKeywordsFromReply(""), []);
  assert.deepEqual(expansionKeywordsFromReply("[]"), []);
  assert.deepEqual(expansionKeywordsFromReply("Slowa kluczowe: "), []);
});

test("R3-02: the second pass is gated on the translated terms, not on the original question", async () => {
  // The model translated the Polish question into English, as the prompt now asks, and
  // returned three keywords, two of which the teaser note carries.
  //
  // The question has six content terms, so its gate is ceil(6 * 0.4) = 3. The keywords
  // have three, so their gate is ceil(3 * 0.4) = 2. Judged on the QUESTION, the note's
  // two matches fail a bar of three that no English note could ever clear — the Polish
  // words of the question are terms it can never contain. Judged on the keywords, it
  // passes.
  const model = stubModel({ keywords: '["film", "claude", "opus"]', answer: OPUS_ANSWER });
  const { memory } = await library([OPUS_EN, ZOO_EN], model);

  const answer = await memory.answerFromAnalyses(OPUS_PL, { limit: 3 });
  assert.equal(answer.notFound, false, `the teaser note is in the library, got: ${answer.text}`);
  assert.deepEqual(
    answer.refs.map((ref) => ref.analysisId),
    ["omni_opus"],
    "the unrelated zoo note is not a source",
  );
  assert.match(answer.text, /more to discover/, "the answer carries the note's content");
});

test("R3-02: a note that clears the gate on one generic word is not a source", async () => {
  // `film` is the one keyword the teaser and the crew note share, and it is also the
  // only term the crew note matches. One match cannot clear a gate of two, so the note
  // is not evidence and must not be glued onto the answer as a source the question
  // never asked about — which is exactly what the QA run reported ("a hit with an extra,
  // unrelated source"). The zoo note matches nothing at all.
  const model = stubModel({ keywords: '["film", "claude", "opus"]', answer: OPUS_ANSWER });
  const { memory } = await library([OPUS_EN, ZOO_EN, FILM_EN], model);

  const answer = await memory.answerFromAnalyses(OPUS_PL, { limit: 5 });
  assert.equal(answer.notFound, false, answer.text);
  assert.deepEqual(answer.refs.map((ref) => ref.analysisId), ["omni_opus"]);
  assert.doesNotMatch(answer.text, /Me at the zoo/, "no unrelated source is attributed");
  assert.doesNotMatch(answer.text, /How we shot the film/, "a one-word match is not a source");
  assert.doesNotMatch(answer.text, /jNQXAC9IVRw|FILM00001/, "and no unrelated URL is printed");
});

test("R3-02: the keywords drive the answer's evidence, not the question's own words", async () => {
  // The gate arithmetic the two tests above rely on, pinned as a unit check so a future
  // change to `gateThreshold` cannot silently move it. The question's own words are all
  // Polish and none of them is in an English note.
  const own = queryTerms(OPUS_PL);
  assert.equal(gateThreshold(own), 3, `the question's gate is 3, terms: ${own.join(",")}`);
  const keywords = expansionKeywords('["film", "claude", "opus"]');
  assert.deepEqual(keywords, ["film", "claude", "opus"]);
  assert.equal(gateThreshold(keywords), 2, "the translated gate is 2");
  // And the note really carries exactly two of them.
  const content = OPUS_EN.content.toLowerCase();
  assert.ok(content.includes("claude") && content.includes("opus"), "the note carries two keywords");
  assert.ok(!content.includes("film"), "and does not carry the third");
});

test("R3-02: an unusable expansion says so, instead of a false 'not found'", async () => {
  const model = stubModel({ keywords: "" });
  const { memory } = await library([OPUS_EN], model);

  const answer = await memory.answerFromAnalyses(OPUS_PL, { limit: 3 });
  // The library was never searched in the note's language, so "the analyses do not
  // mention it" would be a lie. The distinct text says what actually happened.
  assert.equal(answer.text, EXPANSION_FAILED_TEXT);
  assert.notEqual(answer.text, NOT_FOUND_TEXT);
  assert.deepEqual(answer.refs, []);
  assert.equal(answer.notFound, true, "no answer was produced");
  // No retry: the same prompt would pay again for the same coin flip (R3-02).
  assert.equal(model.expansionCalls().length, 1, "the prompt is sent once, never repeated");
  assert.equal(model.answerCalls().length, 0, "an unusable expansion never reaches the grounded call");
});

test("R3-02: the expansion keywords are logged, without the question or any note text", async () => {
  const lines = [];
  const { vault } = tempVault();
  const model = stubModel({ keywords: '["ekran", "zapowiedź", "Claude Opus 5.5"]', answer: OPUS_ANSWER });
  const memory = createVaultMemory({ root: vault, model, log: (line) => lines.push(line) });
  await memory.writeAnalysis(OPUS_EN);

  await memory.answerFromAnalyses(OPUS_PL, { limit: 3 });
  const expansion = lines.find((line) => line.startsWith("omniwatch.memory.expansion "));
  assert.ok(expansion, `expected an expansion log line, got: ${lines.join(" | ")}`);
  // The keywords are the diagnosis; the gate is what the pass was judged on.
  assert.match(expansion, /keywords=ekran,zapowiedz,claude,opus/);
  assert.match(expansion, /contentTerms=4/);
  assert.match(expansion, /gate=2/);
  assert.match(expansion, /target=en/, "the language the model was asked for");
  // The question is the user's words and the note body is the library's: neither is
  // logged, so a log line can never leak the Vault.
  assert.doesNotMatch(expansion, /Jakie hasło pojawia się/, "the raw question is not logged");
  assert.doesNotMatch(expansion, /There's more to discover/, "no note text is logged");
  assert.doesNotMatch(expansion, /macro close-ups/, "no note text is logged");
});

test("R3-02: a model failure is still a loud error, and an unusable reply is not", async () => {
  // A thrown provider error keeps its existing meaning: the library could not be
  // searched, which is `runtime_unavailable`, never a text that looks like an answer.
  const failing = {
    modelName: "stub-throws",
    async complete() {
      throw new Error("provider 503");
    },
  };
  const { memory } = await library([OPUS_EN], failing);
  await assert.rejects(
    () => memory.answerFromAnalyses(OPUS_PL),
    (error) => error instanceof OmniWatchError && error.errorClass === "runtime_unavailable",
  );
});

test("R3-02: the language named to the model comes from the library, not from the question", () => {
  assert.equal(languageName("en"), "angielski");
  assert.equal(languageName("pl"), "polski");
  assert.equal(languageName("EN"), "angielski", "case does not matter");
  // An unknown code is passed through rather than guessed at, so the prompt never names
  // a language the model would then translate *out* of the notes.
  assert.equal(languageName("de"), "de");
  assert.equal(languageName(""), "notatek");
});

/* ------------------------------------------------ R4: sources the answer cites --- */

/**
 * R4 live (2026-09-23, final build, run api-opus-9): the model translated the question
 * into `password,teaser,claude,opus,screen,video,reveal,code`, gate 3. Two unrelated
 * notes carried `screen,video,reveal` and `screen,video,code` - three generic words -
 * and cleared the gate. The answer cited only the teaser, yet `Źródła:` and `refs`
 * listed all three. The fixtures below reproduce those word overlaps.
 */
const KANBAN_EN = makeResult({
  analysisId: "omni_kanban",
  title: "NEW Hermes Super Kanban Agent is SCARY GOOD!",
  language: "en",
  sourceId: "Xu0JinVn_Fg",
  canonicalUrl: "https://www.youtube.com/watch?v=Xu0JinVn_Fg",
  content: "The video shows a kanban board on screen, then a reveal of the agent moving cards.",
});
const PUSHUP_CODE_EN = makeResult({
  analysisId: "omni_pushup2",
  title: "The Perfect Push-Up",
  language: "en",
  sourceId: "c-lBErfxszs",
  canonicalUrl: "https://www.youtube.com/watch?v=c-lBErfxszs",
  content: "The video puts a form checklist on screen, like a code for the elbows at 40-60 degrees.",
});
const R4_KEYWORDS = '["password", "teaser", "claude", "opus", "screen", "video", "reveal", "code"]';

test("R4: a note that clears the gate on generic words but is not cited is not a source", async () => {
  const model = stubModel({ keywords: R4_KEYWORDS, answer: OPUS_ANSWER });
  const { memory } = await library([OPUS_EN, KANBAN_EN, PUSHUP_CODE_EN], model);

  const answer = await memory.answerFromAnalyses(OPUS_PL, { limit: 5 });
  assert.equal(answer.notFound, false, answer.text);
  // Precondition: the unrelated notes really were evidence (handed to the model), so
  // this test fails without the citation filter rather than passing on the gate alone.
  const handed = model.answerCalls()[0].user;
  assert.match(handed, /Hermes Super Kanban/, "the kanban note cleared the gate");
  assert.match(handed, /The Perfect Push-Up/, "the push-up note cleared the gate");
  assert.deepEqual(answer.refs.map((ref) => ref.analysisId), ["omni_opus"]);
  assert.match(answer.text, /Źródła:\n- \[\[OmniWatch\/Analyses\/omni_opus\.md\|Introducing Claude Opus 5\.5\]\]/);
  assert.doesNotMatch(answer.text, /Kanban|Xu0JinVn_Fg|Push-Up|c-lBErfxszs/, "no uncited source is glued on");
});

test("R4: an answer that cites no note keeps every evidence note as a source", async () => {
  const model = stubModel({ keywords: R4_KEYWORDS, answer: "Na ekranie pojawia się hasło „There's more to discover”." });
  const { memory } = await library([OPUS_EN, KANBAN_EN, PUSHUP_CODE_EN], model);

  const answer = await memory.answerFromAnalyses(OPUS_PL, { limit: 5 });
  assert.equal(answer.notFound, false, answer.text);
  assert.deepEqual(
    answer.refs.map((ref) => ref.analysisId).sort(),
    ["omni_kanban", "omni_opus", "omni_pushup2"],
    "without citations the sources say what the model was given",
  );
});
