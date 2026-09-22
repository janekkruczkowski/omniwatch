/**
 * T9 evaluation harness (D10).
 *
 * Default (offline) mode validates the eval plumbing, the memory adapter and the
 * deterministic stub path, and reports every live-model case as NOT EXECUTED. It
 * never invents a quality result: a paid run needs an explicit `--live`, a key
 * and a cost/attempt limit.
 *
 * Usage:
 *   node test/eval/omniwatch/run-evals.mjs                 # offline
 *   node test/eval/omniwatch/run-evals.mjs --live --max-cases 5
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const cases = JSON.parse(fs.readFileSync(path.join(here, "cases.json"), "utf8"));
const argv = process.argv.slice(2);
const live = argv.includes("--live");
const maxCasesArg = argv.indexOf("--max-cases");
const maxCases = maxCasesArg >= 0 ? Number(argv[maxCasesArg + 1]) : cases.cases.length;
const apiKey = process.env.OMNIWATCH_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? null;

const results = [];

async function offlineChecks() {
  const checks = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "omniwatch-eval-"));

  // E05 plumbing: the Vault memory adapter must answer from real note content and
  // must report absence honestly. This runs offline with synthetic notes.
  const { createVaultMemory } = await import(
    path.join(repo, "agent-os-module/src/lib/omniwatchMemory.ts")
  );
  // Offline plumbing only: the host model is a stub that echoes the evidence it
  // was given. It never invents content and it is never used for a live verdict.
  const stubHostModel = {
    modelName: "eval-stub",
    complete: async ({ user }) => `Eval stub answer based on evidence: ${String(user).slice(0, 200)}`,
  };
  const memory = createVaultMemory({
    root: work,
    analysesDir: "OmniWatch/Analyses",
    model: stubHostModel,
  });
  const baseResult = {
    analysisKey: "eval-key-1",
    mode: "summary",
    focus: null,
    question: null,
    language: "pl",
    analysisVersion: "analysis-v1",
    sourceRef: {
      platform: "youtube",
      sourceId: "EVAL1",
      canonicalUrl: "https://youtu.be/EVAL1",
    },
    title: "Eval note one",
    content: "Narzedzie X skraca montaz, ograniczeniem jest brak eksportu.",
    highlights: [{ seconds: 3, label: "0:03" }],
    conversationId: "conv-eval",
    turnId: "turn-eval-1",
    parentTurnId: null,
    parts: 1,
    usage: { costKnown: false, costUsd: null },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await memory.writeAnalysis({ ...baseResult, analysisId: "omni_eval1", title: "Eval note one" });
  await memory.writeAnalysis({
    ...baseResult,
    analysisId: "omni_eval2",
    analysisKey: "eval-key-2",
    title: "Eval note two",
    content: "Narzedzie Y dziala lokalnie, ograniczeniem jest brak podgladu.",
  });
  const hits = await memory.searchAnalyses("narzedzie", 5);
  checks.push({ id: "E05.search", ok: hits.length === 2, detail: `${hits.length} hits` });
  const absent = await memory.answerFromAnalyses("co mowi o kryptowalutach", { limit: 5 });
  checks.push({ id: "E05.absence", ok: absent.notFound === true, detail: absent.text.slice(0, 80) });
  const answer = await memory.answerFromAnalyses("narzedzie", { limit: 5 });
  checks.push({
    id: "E05.references",
    ok: answer.refs.length >= 2 && answer.notFound === false,
    detail: `${answer.refs.length} refs`,
  });
  return checks;
}

console.log(`OmniWatch evals — mode: ${live ? "LIVE (paid)" : "offline"}`);
const offline = await offlineChecks();
for (const check of offline) {
  results.push({ case: check.id, status: check.ok ? "PASS" : "FAIL", detail: check.detail });
}

for (const evalCase of cases.cases.slice(0, maxCases)) {
  if (evalCase.mode === "memory") continue; // covered by the offline E05 plumbing above
  if (!live) {
    results.push({
      case: evalCase.id,
      status: "NOT_EXECUTED",
      detail: "live model quality check requires --live and an API key; no result is invented",
    });
    continue;
  }
  if (!apiKey) {
    results.push({ case: evalCase.id, status: "BLOCKED", detail: "no OMNIWATCH_API_KEY / DASHSCOPE_API_KEY" });
    continue;
  }
  results.push({
    case: evalCase.id,
    status: "NOT_EXECUTED",
    detail: "live runner requires a human-scored sample set; wire a sample before enabling",
  });
}

const report = {
  protocol: "omniwatch.eval.v1",
  generatedAt: new Date().toISOString(),
  mode: live ? "live" : "offline",
  apiKeyPresent: apiKey !== null,
  node: process.version,
  results,
};

const outDir = path.join(repo, "docs/omniwatch/release-evidence");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "eval-results.json"), `${JSON.stringify(report, null, 2)}\n`);

for (const row of results) console.log(`${row.status.padEnd(13)} ${row.case}  ${row.detail}`);
const failed = results.filter((row) => row.status === "FAIL").length;
const executed = results.filter((row) => row.status === "PASS").length;
console.log(`\nsummary: ${executed} executed/pass, ${failed} failed, ${results.length - executed - failed} not executed`);
process.exitCode = failed > 0 ? 1 : 0;
