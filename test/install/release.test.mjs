/**
 * T16: release packaging and installer tests against synthetic hosts.
 *
 * Every host is created under the OS temp directory - the installer is never run
 * against a private Agent OS checkout, and the tarball is the exact artifact built
 * once by `scripts/release/build-core.mjs` (the same one used for both shells).
 *
 * Covered: fresh Agent OS install, fresh standalone install, bad checksum, missing
 * tool, missing shell file, user-modified file conflicts, interrupted install,
 * rollback that keeps user data, unsupported paused work, compatible paused work
 * with a byte-identical request snapshot, package hygiene, and that the registrar
 * leaves Director/Blueprint/assemble files alone.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { ANALYSIS_VERSION, computeAnalysisKey } from "../../packages/omniwatch/src/contracts/index.ts";
import { openSqliteStore } from "../../packages/omniwatch/src/storage/index.ts";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const BUILD = join(ROOT, "scripts", "release", "build-core.mjs");
const INSTALL = join(ROOT, "scripts", "release", "install.mjs");
const SHARED_RELEASE_DIR = process.env.OMNIWATCH_RELEASE_DIR ?? join(ROOT, "dist", "release");

const tempDirs = [];
let release = null;

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Build once and test exactly that artifact, in a private release directory.
 *
 * The private directory matters: two concurrent runs of this file (or the repo-wide
 * `scripts/test-all.mjs`) would otherwise delete and repack the same
 * `dist/release/*.tgz` while the other run is installing it. CI may set
 * OMNIWATCH_SKIP_BUILD=1 to reuse the artifact it just built, and then the manifest
 * must match the tarball on disk - a stale artifact is a failure, not a silent reuse.
 */
before(() => {
  const skipBuild = process.env.OMNIWATCH_SKIP_BUILD === "1";
  const releaseDir = skipBuild ? SHARED_RELEASE_DIR : tempDir("omniwatch-release-");
  const manifests = existsSync(releaseDir)
    ? readdirSync(releaseDir).filter((entry) => entry.endsWith(".manifest.json"))
    : [];
  let manifestPath = manifests.length === 1 ? join(releaseDir, manifests[0]) : null;
  let needsBuild = !skipBuild || !manifestPath;
  if (!needsBuild) {
    const manifest = readJson(manifestPath);
    const tarballPath = join(releaseDir, manifest.artifact.filename);
    needsBuild = !existsSync(tarballPath) || sha256File(tarballPath) !== manifest.artifact.sha256;
  }
  if (!needsBuild && !Array.isArray(readJson(manifestPath).library?.declaredEntryPoints)) {
    needsBuild = true;
  }
  if (needsBuild) {
    assert.ok(!skipBuild, "OMNIWATCH_SKIP_BUILD=1 but the shared release artifact is missing or stale");
    execFileSync(process.execPath, [BUILD, "--out", releaseDir, "--json"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const built = readdirSync(releaseDir).filter((entry) => entry.endsWith(".manifest.json"));
    assert.equal(built.length, 1, "build must leave exactly one manifest");
    manifestPath = join(releaseDir, built[0]);
  }
  const manifest = readJson(manifestPath);
  release = {
    dir: releaseDir,
    manifestPath,
    manifest,
    tarballPath: join(releaseDir, manifest.artifact.filename),
  };
});

/** A synthetic Agent OS checkout with the anchors the registrar expects. */
function makeAgentOsHost() {
  const root = join(tempDir("omniwatch-agentos-"), "agent-os");
  mkdirSync(join(root, "source", "src", "components"), { recursive: true });
  mkdirSync(join(root, "source", "src", "app", "hermes"), { recursive: true });
  mkdirSync(join(root, "source", "src", "app", "api", "video", "auto", "assemble"), { recursive: true });
  mkdirSync(join(root, "source", "summaries"), { recursive: true });
  writeFileSync(
    join(root, "source", "src", "components", "Sidebar.tsx"),
    [
      'import { Eye, Radar } from "lucide-react";',
      "",
      "const NAV = [",
      '  { href: "/thumbnails", label: "Thumbnails" },',
      '  { href: "/video", label: "Video" },',
      "];",
      "",
      "const DEFAULT_ORDER = NAV.map((item) => item.href);",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "source", "src", "components", "TopBar.tsx"),
    [
      "type PageMeta = { numeral: string; label: string; title: string; sub: string };",
      "",
      "const TITLES: Record<string, PageMeta> = {",
      '  "/thumbnails": { numeral: "I.", label: "Thumbnails", title: "Thumbnails", sub: "x" },',
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "source", "src", "app", "hermes", "page.tsx"),
    [
      'import AstrosView from "@/components/AstrosView";',
      "",
      'type HermesTab = "oracle" | "astros";',
      'const allowed: HermesTab[] = ["oracle", "astros"];',
      "",
      "const TABS = [",
      '  { key: "astros",    label: "Hermes Astros", icon: <Sparkles size={14} /> },',
      "];",
      "",
      "export default function Page() {",
      "  return tab === \"oracle\" ? (",
      "        <OracleView />",
      "      " + ') : tab === "astros" ? (',
      "        <AstrosView />",
      "      " + ") : null;",
      "}",
      "",
    ].join("\n"),
  );
  // AstrosView carries the anchors the F12 link is registered against. The
  // assemble route below is the film project's file: this release must not touch it.
  writeFileSync(
    join(root, "source", "src", "components", "AstrosView.tsx"),
    [
      'import { Sparkles } from "lucide-react";',
      "",
      "export default function AstrosView({ t }: { t: Topic }) {",
      "  return (",
      '    <div className="asx-actions">',
      '                    <button className="asx-act nb" onClick={() => openNotebook(t)}>',
      "        NotebookLM",
      "      </button>",
      '      <button className="asx-act seo" onClick={() => openSeo(t)}>SEO</button>',
      "    </div>",
      "  );",
      "}",
      "",
      "const css = `",
      "        .asx-act.seo:hover{ box-shadow:0 0 18px rgba(255,216,107,.3); }",
      "`;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "source", "src", "app", "api", "video", "auto", "assemble", "route.ts"),
    [
      "// Body:",
      "//   { title, mode, scenes: [{ caption, narration_line, brollUrl? }] }",
      'import { writeFile } from "node:fs/promises";',
      "interface BrollClip { src: string; dur: number }",
      "export async function POST() {",
      "  const scenesIn = Array.isArray(body.scenes) ? body.scenes.slice(0, 12) : [];",
      "  return Response.json({ ok: true, scenes: scenesIn.length });",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

/** A synthetic standalone shell: the released beta launcher layout. */
function makeStandaloneHost() {
  const root = join(tempDir("omniwatch-standalone-"), "standalone");
  mkdirSync(join(root, "static"), { recursive: true });
  mkdirSync(join(root, "summaries"), { recursive: true });
  writeFileSync(join(root, "app.py"), 'print("standalone shell")\n');
  writeFileSync(join(root, "omniwatch.py"), 'print("standalone shell")\n');
  writeFileSync(join(root, "static", "i18n.json"), "{}\n");
  return root;
}

function runInstaller(args, options = {}) {
  // Always install from the artifact this run built (or the CI-built one), never from
  // a shared directory another test process may be repacking.
  const pinned =
    args.includes("--release-dir") || args.includes("--manifest") || args.includes("--tarball")
      ? []
      : ["--release-dir", release.dir];
  const result = spawnSync(process.execPath, [INSTALL, ...args, ...pinned, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
  });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout.trim());
  } catch {
    payload = null;
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    json: payload,
  };
}

/** A real SQLite operational snapshot, written by the core store itself. */
function seedOperation(dataDir, { analysisVersion, state = "running" }) {
  const path = join(dataDir, "state.sqlite");
  mkdirSync(dataDir, { recursive: true });
  const store = openSqliteStore({ path });
  try {
    const request = {
      sourceRef: {
        platform: "youtube",
        sourceId: "SYNTHETIC01",
        canonicalUrl: "https://youtu.be/SYNTHETIC01",
        legacyId: "SYNTHETIC01",
      },
      mode: "summary",
      focus: null,
      question: null,
      language: "pl",
      analysisVersion,
    };
    const claimed = store.claimOperation({
      request,
      analysisKey: computeAnalysisKey(request, null),
    });
    if (state !== "pending") store.setOperationState(claimed.operation.id, state);
    return claimed.operation.id;
  } finally {
    store.close();
  }
}

function operationRow(dataDir, operationId) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(join(dataDir, "state.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT * FROM operations WHERE id = ?").get(operationId);
  } finally {
    db.close();
  }
}

test("T16: build emits one tarball with a manifest and no secrets", () => {
  const { manifest, tarballPath } = release;
  assert.equal(manifest.schema, 1);
  assert.ok(manifest.fileCount > 0, "package has files");
  assert.equal(manifest.files.length, manifest.fileCount);
  assert.equal(sha256File(tarballPath), manifest.artifact.sha256, "manifest sha matches the artifact");
  const tarballs = readdirSync(release.dir).filter((entry) => entry.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "exactly one artifact in the release directory");
  const paths = manifest.files.map((file) => file.path);
  assert.ok(paths.includes("dist/contracts/index.js"), "built contracts are packaged");
  for (const path of paths) {
    assert.ok(!/(^|\/)\.env(\.|$)/.test(path), `no env file in package: ${path}`);
    assert.ok(!/(^|\/)node_modules\//.test(path), `no node_modules in package: ${path}`);
    assert.ok(!/(^|\/)fixtures?\//.test(path), `no fixtures in package: ${path}`);
    assert.ok(!/\.sqlite/.test(path), `no database in package: ${path}`);
  }
  assert.deepEqual(manifest.runtimeDependencies, {}, "the core has no npm runtime dependencies");
  const text = gunzipSync(readFileSync(tarballPath)).toString("utf8");
  assert.ok(!/DASHSCOPE_API_KEY\s*=\s*[A-Za-z0-9]/.test(text), "no provider key assignment");
  assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(text), "no API key literal");
  assert.ok(Array.isArray(manifest.library.declaredEntryPoints));
  for (const entry of manifest.library.declaredEntryPoints) {
    if (!entry.present) {
      assert.ok(
        manifest.warnings.some((warning) => warning.includes(entry.path)),
        `missing declared entry point ${entry.path} is reported in the manifest`,
      );
    }
  }
});

test("T16: the same tarball installs into a fresh Agent OS copy and a fresh standalone copy", async () => {
  const agentOs = makeAgentOsHost();
  const agentResult = runInstaller(["--target", "agent-os", "--root", agentOs]);
  assert.equal(agentResult.status, 0, agentResult.stderr);
  assert.equal(agentResult.json.sha256, release.manifest.artifact.sha256, "same artifact in both shells");
  assert.equal(agentResult.json.contracts.analysisVersion, release.manifest.contracts.analysisVersion);
  const installedRelease = join(agentOs, "omniwatch", "releases", release.manifest.library.version);
  assert.ok(existsSync(join(installedRelease, "dist", "contracts", "index.js")));
  const installedContracts = await import(
    `${pathToFileURL(join(installedRelease, "dist", "contracts", "index.js")).href}?v=${Date.now()}`
  );
  assert.equal(installedContracts.ANALYSIS_VERSION, release.manifest.contracts.analysisVersion);
  assert.equal(installedContracts.CONTRACT_VERSION, release.manifest.contracts.contractVersion);
  assert.ok(
    readFileSync(join(agentOs, "omniwatch", "current"), "utf8").includes(release.manifest.library.version),
  );
  assert.ok(
    readFileSync(join(agentOs, "source", "src", "components", "Sidebar.tsx"), "utf8").includes('"/omniwatch"'),
    "the Agent OS sidebar got the OmniWatch entry",
  );

  const standalone = makeStandaloneHost();
  const standaloneResult = runInstaller(["--target", "standalone", "--root", standalone]);
  assert.equal(standaloneResult.status, 0, standaloneResult.stderr);
  assert.equal(standaloneResult.json.sha256, release.manifest.artifact.sha256, "same artifact in both shells");
  assert.ok(
    existsSync(
      join(
        standalone,
        "vendor",
        "omniwatch",
        "releases",
        release.manifest.library.version,
        "dist",
        "contracts",
        "index.js",
      ),
    ),
  );
  assert.deepEqual(standaloneResult.json.navFiles, [], "standalone has no Agent OS navigation to register");
});

test("T16: a wrong checksum stops before any change", () => {
  const agentOs = makeAgentOsHost();
  const tampered = join(tempDir("omniwatch-badsum-"), "manifest.json");
  const manifest = { ...release.manifest, artifact: { ...release.manifest.artifact, sha256: "0".repeat(64) } };
  writeFileSync(tampered, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = runInstaller([
    "--target",
    "agent-os",
    "--root",
    agentOs,
    "--manifest",
    tampered,
    "--tarball",
    release.tarballPath,
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.json.code, "preflight");
  assert.match(result.json.message, /suma kontrolna/i);
  assert.ok(!existsSync(join(agentOs, "omniwatch")), "nothing was written before the checksum failed");
});

test("T16: a missing required tool stops before any change", () => {
  const agentOs = makeAgentOsHost();
  const result = runInstaller([
    "--target",
    "agent-os",
    "--root",
    agentOs,
    "--required-tools",
    "node,omniwatch-tool-that-does-not-exist",
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.json.message, /omniwatch-tool-that-does-not-exist/);
  assert.ok(!existsSync(join(agentOs, "omniwatch")), "no release directory was created");
});

test("T16: a shell that is not there yet fails with a clear preflight error", () => {
  const root = join(tempDir("omniwatch-noshell-"), "agent-os");
  mkdirSync(join(root, "source", "src", "components"), { recursive: true });
  writeFileSync(
    join(root, "source", "src", "components", "TopBar.tsx"),
    'const TITLES = {\n  "/thumbnails": {},\n};\n',
  );
  const result = runInstaller(["--target", "agent-os", "--root", root]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.json.message, /Sidebar\.tsx/);
  assert.match(result.json.message, /powloka nie jest gotowa/i);
  assert.ok(!existsSync(join(root, "omniwatch")), "the installer did not pretend to succeed");
});

test("T16: a host file the user modified is a conflict and is not overwritten", () => {
  const agentOs = makeAgentOsHost();
  const first = runInstaller(["--target", "agent-os", "--root", agentOs]);
  assert.equal(first.status, 0, first.stderr);
  const currentBefore = readFileSync(join(agentOs, "omniwatch", "current"));
  const sidebarPath = join(agentOs, "source", "src", "components", "Sidebar.tsx");
  const managedPath = join(
    agentOs,
    "omniwatch",
    "releases",
    release.manifest.library.version,
    "dist",
    "contracts",
    "index.js",
  );
  const managedBefore = readFileSync(managedPath);
  assert.ok(managedBefore.length > 0);

  // The user edits one owned file and one navigation file.
  writeFileSync(managedPath, `${managedBefore.toString("utf8")}\n// user edit\n`);
  writeFileSync(sidebarPath, `${readFileSync(sidebarPath, "utf8")}\n// user edit\n`);
  const sidebarAfterEdit = readFileSync(sidebarPath);

  const second = runInstaller(["--target", "agent-os", "--root", agentOs]);
  assert.equal(second.status, 3, second.stderr);
  assert.equal(second.json.code, "conflict");
  const conflicted = second.json.conflicts.map((item) => item.path);
  assert.ok(conflicted.some((path) => path.endsWith("dist/contracts/index.js")), JSON.stringify(conflicted));
  assert.ok(conflicted.includes("source/src/components/Sidebar.tsx"), JSON.stringify(conflicted));
  assert.deepEqual(readFileSync(sidebarPath), sidebarAfterEdit, "the user's sidebar edit is untouched");
  assert.ok(readFileSync(managedPath, "utf8").includes("// user edit"), "the user's file edit is untouched");
  assert.deepEqual(
    readFileSync(join(agentOs, "omniwatch", "current")),
    currentBefore,
    "the previously installed release is still current",
  );
});

test("T16: an interrupted install leaves the previous release usable", () => {
  const agentOs = makeAgentOsHost();
  const first = runInstaller(["--target", "agent-os", "--root", agentOs]);
  assert.equal(first.status, 0, first.stderr);
  const currentBefore = readFileSync(join(agentOs, "omniwatch", "current"));
  const markerPath = join(
    agentOs,
    "omniwatch",
    "releases",
    release.manifest.library.version,
    "package.json",
  );
  const markerBefore = sha256File(markerPath);

  const interrupted = runInstaller(["--target", "agent-os", "--root", agentOs], {
    env: { OMNIWATCH_TEST_CRASH: "before-switch" },
  });
  assert.equal(interrupted.signal, "SIGKILL", `expected a killed process, got status ${interrupted.status}`);
  assert.deepEqual(
    readFileSync(join(agentOs, "omniwatch", "current")),
    currentBefore,
    "the pointer still names the previous release",
  );
  assert.equal(sha256File(markerPath), markerBefore, "the previous release files are intact");

  const repair = runInstaller(["--target", "agent-os", "--root", agentOs]);
  assert.equal(repair.status, 0, repair.stderr);
  assert.equal(repair.json.ok, true);
});

test("T16: rollback restores the previous release and never deletes user data", () => {
  const agentOs = makeAgentOsHost();
  const userNote = join(agentOs, "source", "summaries", "old-analysis.md");
  writeFileSync(userNote, "# Stara analiza\n\nTresc uzytkownika.\n");
  const sidebarPath = join(agentOs, "source", "src", "components", "Sidebar.tsx");
  const sidebarBefore = readFileSync(sidebarPath);

  const first = runInstaller(["--target", "agent-os", "--root", agentOs]);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(readFileSync(sidebarPath, "utf8").includes('"/omniwatch"'));

  const rollback = runInstaller(["--target", "agent-os", "--root", agentOs, "--rollback"]);
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(rollback.json.action, "rollback");
  assert.ok(rollback.json.restoredFiles.includes("source/src/components/Sidebar.tsx"));
  assert.deepEqual(readFileSync(sidebarPath), sidebarBefore, "navigation restored to the pre-install content");
  assert.ok(
    !existsSync(join(agentOs, "omniwatch", "current")),
    "no release is current after the first install is rolled back",
  );
  assert.equal(readFileSync(userNote, "utf8"), "# Stara analiza\n\nTresc uzytkownika.\n", "user notes survive");
});

test("T16: a paused worker with an unsupported contract version blocks the update", () => {
  const agentOs = makeAgentOsHost();
  const dataDir = join(agentOs, ".omniwatch-data");
  const operationId = seedOperation(dataDir, { analysisVersion: "analysis-v0", state: "budget_paused" });
  const before = operationRow(dataDir, operationId);

  const result = runInstaller(["--target", "agent-os", "--root", agentOs, "--data-dir", dataDir]);
  assert.equal(result.status, 4, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.json.code, "compatibility");
  assert.match(result.json.message, /analysis-v0/);
  assert.match(result.json.message, /nie podstawiamy nowych promptow/i);
  assert.ok(!existsSync(join(agentOs, "omniwatch")), "the refusing install wrote nothing");
  assert.deepEqual({ ...operationRow(dataDir, operationId) }, { ...before }, "the snapshot is untouched");
});

test("T16: a compatible paused snapshot is preserved and reported", () => {
  const agentOs = makeAgentOsHost();
  const dataDir = join(agentOs, ".omniwatch-data");
  const operationId = seedOperation(dataDir, { analysisVersion: ANALYSIS_VERSION, state: "budget_paused" });
  const before = operationRow(dataDir, operationId);

  const result = runInstaller(["--target", "agent-os", "--root", agentOs, "--data-dir", dataDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.inFlight.decision, "compatible");
  assert.ok(result.json.inFlight.unfinished >= 1);
  assert.ok(result.json.inFlight.paused >= 1);
  assert.deepEqual(
    { ...operationRow(dataDir, operationId) },
    { ...before },
    "the recorded request snapshot is byte-identical",
  );
});

test("T16: the installer registers the Astros link but never touches Director or assemble files", () => {
  const agentOs = makeAgentOsHost();
  const astrosPath = join(agentOs, "source", "src", "components", "AstrosView.tsx");
  const assemblePath = join(agentOs, "source", "src", "app", "api", "video", "auto", "assemble", "route.ts");
  const assembleBefore = readFileSync(assemblePath);
  const astrosBefore = readFileSync(astrosPath);
  const result = runInstaller(["--target", "agent-os", "--root", agentOs]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(assemblePath), assembleBefore, "the film project's route is untouched");
  const astros = readFileSync(astrosPath, "utf8");
  assert.notDeepEqual(readFileSync(astrosPath), astrosBefore, "the Astros link was registered");
  assert.equal(astros.split("asx-act omni").length - 1, 1, "exactly one OmniWatch chip");
  const rendered = readFileSync(assemblePath, "utf8");
  assert.ok(!rendered.includes("seconds?: number"), "no Director/assemble seconds patch applied");
  assert.ok(!rendered.includes("omni-assemble-validate"), "no assemble validation patch applied");
});

test("T16: the Astros link opens OmniWatch for that video and is registered exactly once", () => {
  const agentOs = makeAgentOsHost();
  const astrosPath = join(agentOs, "source", "src", "components", "AstrosView.tsx");

  const first = runInstaller(["--target", "agent-os", "--root", agentOs]);
  assert.equal(first.status, 0, first.stderr);
  const firstText = readFileSync(astrosPath, "utf8");
  assert.equal(firstText.split("asx-act omni").length - 1, 1, "exactly one chip after the first install");
  assert.ok(
    firstText.includes("href={`/omniwatch?url=${encodeURIComponent(t.competitor.url)}`}"),
    "the chip opens OmniWatch for that video instead of starting another paid analysis",
  );
  assert.ok(firstText.includes(".asx-act.omni{"), "the chip style is registered too");
  assert.ok(
    firstText.includes('<button className="asx-act nb"'),
    "the existing Astros actions are preserved",
  );
  assert.ok(
    firstText.includes('import { Sparkles, MonitorPlay } from "lucide-react";') ||
      /MonitorPlay/.test(firstText),
    "the MonitorPlay icon is imported",
  );
  const astrosFiles = first.json.navFiles.filter((path) => path.endsWith("AstrosView.tsx"));
  assert.deepEqual(astrosFiles, ["source/src/components/AstrosView.tsx"]);

  // A second install (and a second registrar run) must not duplicate the chip.
  const second = runInstaller(["--target", "agent-os", "--root", agentOs]);
  assert.equal(second.status, 0, second.stderr);
  const secondText = readFileSync(astrosPath, "utf8");
  assert.equal(secondText.split("asx-act omni").length - 1, 1, "still exactly one chip");
  assert.deepEqual(secondText, firstText, "the second run is a no-op for the Astros file");

  const direct = spawnSync(
    "python3",
    [
      join(ROOT, "agent-os-module", "register-nav.py"),
      join(agentOs, "source"),
      "--only",
      "astros",
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(direct.status, 0, direct.stderr);
  const report = JSON.parse(direct.stdout.trim());
  assert.equal(report.files[0].action, "already added");
  assert.equal(report.files[0].changed, false);
  assert.equal(readFileSync(astrosPath, "utf8").split("asx-act omni").length - 1, 1);
});

test("T16: a missing Astros anchor is a clean conflict with no writes", () => {
  const agentOs = makeAgentOsHost();
  const astrosPath = join(agentOs, "source", "src", "components", "AstrosView.tsx");
  // An Agent OS whose Astros view was rewritten: the anchor this release knows is gone.
  writeFileSync(
    astrosPath,
    'export default function AstrosView() { return <div className="rewritten" />; }\n',
  );
  const before = readFileSync(astrosPath);
  const sidebarPath = join(agentOs, "source", "src", "components", "Sidebar.tsx");
  const sidebarBefore = readFileSync(sidebarPath);

  const result = runInstaller(["--target", "agent-os", "--root", agentOs]);
  assert.equal(result.status, 3, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.json.code, "conflict");
  const conflicted = result.json.conflicts.map((item) => item.path);
  assert.ok(conflicted.includes("source/src/components/AstrosView.tsx"), JSON.stringify(conflicted));
  assert.match(
    result.json.conflicts.find((item) => item.path.endsWith("AstrosView.tsx")).reason,
    /kotwica/,
  );
  assert.deepEqual(readFileSync(astrosPath), before, "the Astros file is left untouched");
  assert.deepEqual(readFileSync(sidebarPath), sidebarBefore, "nothing else was written either");
  assert.ok(!existsSync(join(agentOs, "omniwatch")), "no release directory was created");
});

test("T16: --check reports the plan and writes nothing", () => {
  const agentOs = makeAgentOsHost();
  const result = runInstaller(["--target", "agent-os", "--root", agentOs, "--check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.checkOnly, true);
  assert.ok(result.json.plannedFiles.length > 0);
  assert.ok(!existsSync(join(agentOs, "omniwatch")), "--check made no changes");
});

test("T16: the Agent OS shell wrapper is a thin call into the same installer", () => {
  const wrapper = join(ROOT, "agent-os-module", "install.sh");
  assert.ok(existsSync(wrapper));
  const agentOs = makeAgentOsHost();
  const run = (args) =>
    spawnSync("bash", [wrapper, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env },
    });

  const install = run([agentOs, "--json", "--release-dir", release.dir]);
  assert.equal(install.status, 0, install.stderr);
  const installed = JSON.parse(install.stdout.trim());
  assert.equal(installed.sha256, release.manifest.artifact.sha256, "wrapper installs the same tarball");
  assert.ok(install.stderr.includes("OmniWatch"), "human progress stays on stderr");

  const rollback = run([agentOs, "--rollback", "--json", "--release-dir", release.dir]);
  assert.equal(rollback.status, 0, rollback.stderr);
  const rolledBack = JSON.parse(rollback.stdout.trim());
  assert.equal(rolledBack.action, "rollback");
  assert.ok(!existsSync(join(agentOs, "omniwatch", "current")));
  assert.ok(
    !readFileSync(join(agentOs, "source", "src", "components", "Sidebar.tsx"), "utf8").includes("/omniwatch"),
  );
});
