/**
 * Shell integration bundle (T8).
 *
 * The core tarball is the shared library. On top of it, the Agent OS integration
 * needs the NEW route handlers, UI components and libs that make `/omniwatch` use
 * the shared engine. Without them the installer produced a working library and an
 * unchanged panel - QA found the default view still starting at teardown.
 *
 * This module declares exactly which files belong to the integration, so the
 * installer can place them, record ownership, detect host/user modifications and
 * roll the whole set back. Film-production routes (produce, clone, compose, ...)
 * are deliberately NOT part of the set: the analysis release must not overwrite
 * the other project.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Files the analysis integration owns inside the Agent OS shell. */
export const AGENT_OS_INTEGRATION_FILES = [
  // route handlers + the thin routes that delegate to them
  "src/app/api/omniwatch/jobs/route.ts",
  "src/app/api/omniwatch/jobs/handler.ts",
  "src/app/api/omniwatch/channel/route.ts",
  "src/app/api/omniwatch/channel/handler.ts",
  "src/app/api/omniwatch/scout/route.ts",
  "src/app/api/omniwatch/scout/handler.ts",
  "src/app/api/omniwatch/status/route.ts",
  "src/app/api/omniwatch/status/handler.ts",
  "src/app/api/omniwatch/media/[...path]/route.ts",
  "src/app/api/omniwatch/media/[...path]/handler.ts",
  "src/app/api/omniwatch/i18n/route.ts",
  "src/app/api/omniwatch/i18n/handler.ts",
  // the analysis library in the host Vault: search + grounded answers (F5, D7)
  "src/app/api/omniwatch/library/route.ts",
  "src/app/api/omniwatch/library/handler.ts",
  // UI
  "src/components/OmniWatchView.tsx",
  "src/components/ChannelScan.tsx",
  "src/components/ScoutView.tsx",
  "src/components/OmniMarkdown.tsx",
  "src/components/OmniLibrary.tsx",
  "src/components/OmniVaultLabel.tsx",
  // analysis libs the integration needs
  "src/lib/omniwatchMemory.ts",
  "src/lib/omniwatchHost.ts",
  "src/lib/omniwatchHostWorker.ts",
  "src/lib/omniwatchPanelRuntime.ts",
  "src/lib/omniwatchLegacyAdapter.ts",
  "src/lib/omniwatchJobs.ts",
  // R5: the card's progress comes from real events (live progress + journal)
  "src/lib/omniwatchProgress.ts",
  "src/lib/omniwatchI18n.ts",
  "src/lib/omniwatchPresets.ts",
  // panel-independent worker (D5) - sits next to the module root, not inside src/
  "@module/omniwatch-host-worker.mjs",
  "@module/omniwatch-host-loader.mjs",
];

/**
 * Host files that exist before OmniWatch and must NOT be overwritten: they carry
 * the film project's own behaviour. The installer reports them instead.
 */
export const AGENT_OS_PROTECTED_FILES = [
  "src/lib/omniwatch.ts",
  "src/lib/omniwatchBlueprint.ts",
  "src/lib/omniwatchChannel.ts",
  "src/lib/omniwatchScout.ts",
  "src/lib/omniwatchX.ts",
  "src/lib/omniwatchAds.ts",
];

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Collect the bundle from the module tree. `moduleRoot` is `agent-os-module/`.
 * Returned paths are relative to the Agent OS ROOT (i.e. they start with `source/`),
 * so the installer joins them with the root directly.
 */
export function collectAgentOsIntegration(moduleRoot) {
  const entries = [];
  const missing = [];
  for (const rel of AGENT_OS_INTEGRATION_FILES) {
    const atModuleRoot = rel.startsWith("@module/");
    const sourcePath = atModuleRoot
      ? path.join(moduleRoot, rel.slice("@module/".length))
      : path.join(moduleRoot, rel);
    if (!existsSync(sourcePath) || statSync(sourcePath).isDirectory()) {
      missing.push(rel);
      continue;
    }
    const hostRel = atModuleRoot
      ? path.posix.join("source", path.relative(moduleRoot, sourcePath))
      : path.posix.join("source", rel);
    void hostRel;
    entries.push({
      path: hostRel,
      bytes: readFileSync(sourcePath).length,
      sha256: sha256File(sourcePath),
      mode: 0o644,
    });
  }
  return { entries, missing };
}

/**
 * The standalone shell the installer places in `<appRoot>` (QA R2 H2/H3). These are
 * the thin launchers (`app.py`/`omniwatch.py`, the beta's commands), the Node HTTP/CLI
 * adapters and the frontend. They travel INSIDE the release tarball under
 * `shells/standalone/`, so an installed app never reads from a source checkout.
 */
export const STANDALONE_SHELL_FILES = [
  "app.py",
  "omniwatch.py",
  "server.mjs",
  "cli.mjs",
  "config.mjs",
  "legacy.mjs",
  "core.mjs",
  "static/index.html",
  "static/i18n.json",
];

/** Where each shell lives inside the release tarball (below `package/`). */
export const SHELL_ARTIFACT_PREFIX = {
  "agent-os": "shells/agent-os",
  standalone: "shells/standalone",
};

/** Collect the standalone shell from `apps/standalone`. */
export function collectStandaloneShell(appRoot) {
  const entries = [];
  const missing = [];
  for (const rel of STANDALONE_SHELL_FILES) {
    const sourcePath = path.join(appRoot, ...rel.split("/"));
    if (!existsSync(sourcePath) || statSync(sourcePath).isDirectory()) {
      missing.push(rel);
      continue;
    }
    const executable = (statSync(sourcePath).mode & 0o111) !== 0;
    entries.push({
      path: rel,
      bytes: readFileSync(sourcePath).length,
      sha256: sha256File(sourcePath),
      mode: executable ? 0o755 : 0o644,
      sourcePath,
    });
  }
  return { entries, missing };
}

/** Reads the bundle bytes for one entry (installer convenience). */
export function readIntegrationFile(moduleRoot, hostRel) {
  const withoutSource = hostRel.replace(/^source\//, "");
  const direct = path.join(moduleRoot, withoutSource);
  if (existsSync(direct)) return readFileSync(direct);
  return readFileSync(path.resolve(moduleRoot, "../", withoutSource));
}

/** Route-level directories that must never be shipped from the film project. */
export const EXCLUDED_FILM_ROUTES = [
  "produce",
  "clone",
  "compose",
  "measure",
  "verify",
  "ground",
  "captions",
  "graphic",
  "episode",
  "formats",
  "assets",
  "broll",
  "clip",
  "recreate",
  "voiceover",
];

export function walkFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const next = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(full, next);
      else out.push(next);
    }
  };
  walk(root, "");
  return out;
}
