/**
 * Manual browser fixture for ISSUE-010. No provider, account or user data is used.
 * Open the printed URL, submit https://youtu.be/SYNTHETIC01, then inspect the
 * unknown-outcome warning and choose the explicit retry. The stub answers on its
 * second call; the terminal prints exactly when each simulated call happens.
 */
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStandaloneServer } from "../../apps/standalone/server.mjs";
import { OmniWatchError } from "../../packages/omniwatch/src/contracts/errors.ts";
import { createFixtureSource } from "../../packages/omniwatch/src/runtime/poc.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(path.join(tmpdir(), "omniwatch-issue010-browser-"));
const appRoot = path.join(root, "app");
const dataDir = path.join(root, "data");
const cache = path.join(dataDir, "cache", "SYNTHETIC01");
mkdirSync(path.join(appRoot, "static"), { recursive: true });
mkdirSync(cache, { recursive: true });
for (const name of ["index.html", "i18n.json"]) {
  copyFileSync(path.join(repo, "apps/standalone/static", name), path.join(appRoot, "static", name));
}
for (const name of ["source.mp4", "info.json"]) {
  copyFileSync(path.join(repo, "test/fixtures/beta/legacy/.cache/SYNTHETIC01", name), path.join(cache, name));
}
writeFileSync(path.join(appRoot, ".env"), "DASHSCOPE_API_KEY=offline-fixture\nOMNI_LANG=pl\n");

let calls = 0;
const model = {
  modelName: "offline-issue010-stub",
  async call(request) {
    calls += 1;
    process.stdout.write(`offline model call ${calls}: ${request.operationId}\n`);
    if (calls === 1) throw new OmniWatchError("outcome_unknown", "Połączenie z modelem przerwano; wynik wywołania jest nieznany.");
    return {
      text: "## Odpowiedź\n- [0:05] Ponowienie świadomie potwierdzone; odpowiedź ze stubu.",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: null, costKnown: false },
      completed: true,
    };
  },
};

const port = Number(process.env.OMNIWATCH_ISSUE010_PORT || 18768);
const app = createStandaloneServer({
  appRoot, dataDir, model, port,
  source: createFixtureSource({ durationSeconds: 16, mediaFile: path.join(cache, "source.mp4") }),
  env: { OMNIWATCH_APP_ROOT: appRoot, OMNIWATCH_DATA_DIR: dataDir, OMNIWATCH_PORT: String(port) },
});
const address = await app.listen();
process.stdout.write(`ISSUE-010 browser fixture: ${address.url}\nUse https://youtu.be/SYNTHETIC01\nIsolated data: ${dataDir}\n`);
