/**
 * Where the standalone shell finds the shared OmniWatch core (D4).
 *
 * The shell (launchers, HTTP adapter, CLI adapter) is installed next to the user's
 * data; the core is the ONE versioned artifact the installer unpacks under
 * `<appRoot>/vendor/omniwatch/releases/<version>-<sha>` and names in the
 * `vendor/omniwatch/current` pointer. The shell must load exactly that release - a
 * static `../../packages/...` import only works inside the source checkout, which is
 * why an installed app used to die with ERR_MODULE_NOT_FOUND (QA R2 H3).
 *
 * Resolution order:
 *
 *   1. `OMNIWATCH_CORE_ROOT` - an explicit core directory (custom install layouts);
 *   2. `<shellRoot>/vendor/omniwatch/current` - the installed release (the D4 path);
 *   3. `<shellRoot>/../../packages/omniwatch` - the source checkout (development).
 *
 * An installed release is loaded from its built JavaScript (`dist/`), so the user
 * never compiles TypeScript; the checkout loads the sources so a developer always
 * runs what they edit.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CORE_POINTER = path.join("vendor", "omniwatch", "current");

function describe(root, kind, extra = {}) {
  const hasDist = existsSync(path.join(root, "dist", "contracts", "index.js"));
  const hasSrc = existsSync(path.join(root, "src", "contracts", "index.ts"));
  // A checkout runs its sources; an installed or explicit core prefers the built JS.
  const flavor = kind === "checkout" ? (hasSrc ? "src" : null) : hasDist ? "dist" : hasSrc ? "src" : null;
  const extension = flavor === "dist" ? ".js" : ".ts";
  return {
    ok: flavor !== null,
    kind,
    root,
    flavor,
    ...extra,
    modulePath(rel) {
      return path.join(root, flavor ?? "dist", `${rel}${flavor ? extension : ".js"}`);
    },
    reason: flavor
      ? ""
      : `katalog rdzenia ${root} nie zawiera ani dist/contracts/index.js, ani src/contracts/index.ts`,
  };
}

/** Resolve the core for one shell directory without importing anything. */
export function resolveCore(options = {}) {
  const env = options.env ?? process.env;
  const shellRoot = path.resolve(options.shellRoot ?? HERE);
  const explicit = typeof env.OMNIWATCH_CORE_ROOT === "string" ? env.OMNIWATCH_CORE_ROOT.trim() : "";
  if (explicit) return describe(path.resolve(explicit), "env");

  const pointer = path.join(shellRoot, CORE_POINTER);
  if (existsSync(pointer)) {
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(pointer, "utf8"));
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed.release !== "string" || parsed.release.trim() === "") {
      return {
        ok: false,
        kind: "release",
        root: null,
        pointer,
        modulePath: (rel) => path.join(shellRoot, "vendor", "omniwatch", "<brak wydania>", `${rel}.js`),
        reason: `wskaznik wydania ${pointer} jest uszkodzony; uruchom instalator ponownie albo cofnij instalacje`,
      };
    }
    // `release` is recorded relative to the install root, which is this shell.
    return describe(path.resolve(shellRoot, parsed.release), "release", {
      pointer,
      version: parsed.version ?? null,
      sha256: parsed.sha256 ?? null,
    });
  }

  const checkout = path.resolve(shellRoot, "..", "..", "packages", "omniwatch");
  if (existsSync(path.join(checkout, "src"))) return describe(checkout, "checkout");

  return {
    ok: false,
    kind: null,
    root: null,
    pointer,
    modulePath: (rel) => path.join(shellRoot, "vendor", "omniwatch", "<brak wydania>", `${rel}.js`),
    reason:
      `brak zainstalowanego rdzenia OmniWatch (oczekiwany wskaznik ${pointer}); ` +
      "zainstaluj wydanie: node scripts/release/install.mjs --target standalone --root <katalog aplikacji>",
  };
}

/** A readable, actionable message for a missing core; never a stack trace. */
export function coreUnavailableMessage(core) {
  return [
    "Nie znaleziono wspolnego runtime OmniWatch (artefakt rdzenia).",
    core.reason,
    "Stary silnik Python nie jest uruchamiany awaryjnie.",
  ].join("\n");
}

/** Import one core module, e.g. `importCore("contracts/errors")`. */
export async function importCore(rel, options = {}) {
  const core = options.core ?? resolveCore(options);
  if (!core.ok) {
    const error = new Error(coreUnavailableMessage(core));
    error.code = "OMNIWATCH_CORE_UNAVAILABLE";
    throw error;
  }
  return import(pathToFileURL(core.modulePath(rel)).href);
}
