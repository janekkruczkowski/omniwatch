/**
 * Discover and run every test file in the repo with one node --test invocation.
 *
 * Node 22 on this platform treats a bare directory positional as a module, so the
 * runner expands the file list itself instead of relying on shell globs (missing
 * directories would otherwise be passed through literally).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const roots = ["packages", "apps", "agent-os-module/test", "test"];
const files = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "fixtures" || entry.name === "dist") continue;
      walk(full);
    } else if (/\.test\.mjs$/.test(entry.name)) {
      files.push(full);
    }
  }
}

for (const root of roots) walk(root);

if (files.length === 0) {
  console.error("no test files discovered");
  process.exit(1);
}

console.log(`running ${files.length} test files`);
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files.sort()], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
