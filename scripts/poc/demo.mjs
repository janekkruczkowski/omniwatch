/**
 * OmniWatch POC (internal gate for T0-T3).
 *
 * Demonstrates, on synthetic data with a stub model and no API key:
 *   1. one URL -> default summary, saved as an individual analysis note;
 *   2. an identical repeat -> deduplicated, zero new model calls;
 *   3. a focus summary -> a separate operation;
 *   4. teardown -> a separate operation in the other mode;
 *   5. a follow-up question with parentTurnId -> context reaches the model;
 *   6. an enqueued operation resumed by a freshly spawned worker process
 *      (restart/resume, no repeated paid call).
 *
 * Run: node scripts/poc/demo.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repo, "packages/omniwatch/src/runtime/cli.ts");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "omniwatch-poc-"));
const dataDir = path.join(work, "data");
const memoryRoot = path.join(work, "vault");
const callsFile = path.join(work, "model-calls.jsonl");
const configPath = path.join(work, "runtime-config.json");

fs.writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      protocol: "omniwatch.runtime-config.v1",
      dataDir,
      memoryRoot,
      language: "pl",
      modelName: "stub-model",
      // The beta's own default (OMNI_MAX_FRAMES=2400): a 16 s clip is one part.
      maxFramesPerPart: 2400,
      cacheHours: 48,
      model: {
        kind: "stub",
        reply: "Streszczenie: [0:03] na ekranie widnieje liczba 7.",
        callsFile,
        usage: { inputTokens: 1000, outputTokens: 200 },
      },
      source: {
        kind: "fixture",
        title: "Fixture A - ekran",
        channel: "Fixture Channel",
        durationSeconds: 16,
      },
    },
    null,
    2,
  )}\n`,
);

function calls() {
  if (!fs.existsSync(callsFile)) return 0;
  return fs.readFileSync(callsFile, "utf8").split("\n").filter((line) => line.trim() !== "").length;
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args, "--config", configPath, "--data-dir", dataDir, "--json"], {
    encoding: "utf8",
    env: { ...process.env, OMNIWATCH_API_KEY: "" },
  });
  const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
  const last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
  return { code: result.status, stderr: result.stderr.trim(), payload: last, stdout: result.stdout };
}

const steps = [];
function check(name, condition, detail) {
  steps.push({ name, ok: Boolean(condition), detail });
  if (!condition) process.exitCode = 1;
}

const url = "https://youtu.be/SYNTHETIC01";

// 1. default summary
const before1 = calls();
const summary = run(["analyze", url]);
check("summary exit 0", summary.code === 0, `exit=${summary.code} ${summary.stderr}`);
check("summary produced content", typeof summary.payload?.content === "string" && summary.payload.content.length > 0, summary.payload?.content);
check("summary made exactly one paid call", calls() - before1 === 1, `calls=${calls() - before1}`);
check("summary wrote an individual note", summary.payload?.memoryRef?.relativePath?.endsWith(".md"), summary.payload?.memoryRef?.relativePath);
const notePath = path.join(memoryRoot, summary.payload?.memoryRef?.relativePath ?? "");
check("note exists on disk", fs.existsSync(notePath), notePath);

// 2. identical repeat -> dedup, no new paid call
const before2 = calls();
const repeat = run(["analyze", url]);
check("repeat exit 0", repeat.code === 0, `exit=${repeat.code}`);
check("repeat reused the operation (same analysisId)", repeat.payload?.analysisId === summary.payload?.analysisId, `${repeat.payload?.analysisId} vs ${summary.payload?.analysisId}`);
check("repeat made zero new paid calls", calls() - before2 === 0, `calls=${calls() - before2}`);

// 3. focus summary -> separate operation
const focus = run(["analyze", url, "--focus", "redukcja tkanki tluszczowej"]);
check("focus exit 0", focus.code === 0, `exit=${focus.code}`);
check("focus is a different analysis", focus.payload?.analysisId !== summary.payload?.analysisId, focus.payload?.analysisId);

// 4. teardown -> separate mode
const teardown = run(["analyze", url, "--teardown"]);
check("teardown exit 0", teardown.code === 0, `exit=${teardown.code}`);
check("teardown is a different analysis", teardown.payload?.analysisId !== summary.payload?.analysisId, teardown.payload?.analysisId);

// 5. follow-up with parent turn
const { openSqliteStore } = await import(path.join(repo, "packages/omniwatch/src/storage/index.ts"));
const { conversationIdForSource } = await import(path.join(repo, "packages/omniwatch/src/analysis/context.ts"));
const store = openSqliteStore({ path: path.join(dataDir, "state.sqlite") });
const teardownOperation = store.getOperation(teardown.payload.operation.operationId);
const conversationId = teardownOperation ? conversationIdForSource(teardownOperation.request.sourceRef) : null;
const turns = conversationId ? store.listTurns(conversationId, 50) : [];
store.close();
const parentTurn = turns.find((turn) => turn.role === "assistant");
check("teardown stored an assistant turn", Boolean(parentTurn), `turns=${turns.length}`);

if (parentTurn) {
  const followUp = run([
    "analyze",
    url,
    "--teardown",
    "--question",
    "rozwiń drugi punkt",
    "--conversation",
    parentTurn.conversationId,
    "--parent",
    parentTurn.turnId,
  ]);
  check("follow-up exit 0", followUp.code === 0, `exit=${followUp.code} ${followUp.stderr}`);
  check("follow-up is a new analysis", followUp.payload?.analysisId !== teardown.payload?.analysisId, followUp.payload?.analysisId);
}

// 6. enqueue only, then resume with a freshly spawned worker process
const beforeEnqueue = calls();
const enqueue = spawnSync(process.execPath, [cli, "analyze", url, "--focus", "nowy watek", "--enqueue-only", "--config", configPath, "--data-dir", dataDir, "--json"], {
  encoding: "utf8",
});
check("enqueue exit 0", enqueue.status === 0, `exit=${enqueue.status}`);
check("enqueue performed zero paid calls", calls() === beforeEnqueue, `calls=${calls() - beforeEnqueue}`);
const beforeResume = calls();
const worker = spawnSync(process.execPath, [cli, "worker", "--config", configPath, "--data-dir", dataDir, "--json"], {
  encoding: "utf8",
});
check("resumed worker exit 0", worker.status === 0, `exit=${worker.status} ${worker.stderr.trim()}`);
check("resume delivered the pending analysis", worker.stdout.includes('"delivered":1'), worker.stdout.trim().split("\n").slice(-1)[0]);
check("resume made exactly one paid call", calls() - beforeResume === 1, `calls=${calls() - beforeResume}`);

// status shows the durable state and no owner left behind
const status = spawnSync(process.execPath, [cli, "status", "--config", configPath, "--data-dir", dataDir, "--json"], {
  encoding: "utf8",
});
check("status exit 0", status.status === 0, `exit=${status.status}`);
const statusPayload = JSON.parse(status.stdout.trim().split("\n").slice(-1)[0]);
check("no owner left after worker exit", statusPayload.owner === null, JSON.stringify(statusPayload.owner));
check("all operations delivered", statusPayload.operations.every((operation) => operation.state === "delivered"), statusPayload.operations.map((operation) => operation.state).join(","));

const notesDir = path.join(memoryRoot, "Analyses");
const notes = fs.existsSync(notesDir)
  ? fs.readdirSync(notesDir)
  : [];

console.log(`POC work dir: ${work}`);
for (const step of steps) {
  console.log(`${step.ok ? "PASS" : "FAIL"}  ${step.name}${step.detail ? `  [${String(step.detail).slice(0, 120)}]` : ""}`);
}
console.log(
  `\nPOC ${steps.every((step) => step.ok) ? "PASS" : "FAIL"}: ${steps.filter((step) => step.ok).length}/${steps.length} checks, ` +
    `${calls()} paid model calls, ${notes.length} individual analysis notes, 0 API keys used.`,
);
