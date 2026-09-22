/**
 * Node loader shim for the Agent OS host graph (T6/F).
 *
 * The host's modules import each other through the Next alias `@/...` and often omit
 * the file extension. Plain Node cannot resolve either, which is why the panel used to
 * fall back to an in-process worker. This loader maps `@/` onto the host `src/` tree
 * and tries the TypeScript extensions, so the SAME host code can run in a separate
 * worker process (D5: the scan must not depend on the panel staying open).
 *
 * Read-only: it resolves modules, it never rewrites host files.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOST_SRC = process.env.OMNIWATCH_HOST_SRC ?? null;
/**
 * Files the release adds on top of the host (for example `omniwatchMemory.ts`).
 * Resolved after the host tree so an existing host file is never shadowed.
 */
const OVERLAY_SRC = process.env.OMNIWATCH_OVERLAY_SRC ?? null;
const EXTENSIONS = ["", ".ts", ".tsx", ".mjs", ".js", ".json"];

function firstExisting(base) {
  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const index of ["index.ts", "index.tsx", "index.mjs", "index.js"]) {
    const candidate = path.join(base, index);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (HOST_SRC && specifier.startsWith("@/")) {
    const found = firstExisting(path.join(HOST_SRC, specifier.slice(2)));
    if (found) return next(pathToFileURL(found).href, context);
    if (OVERLAY_SRC) {
      const overlay = firstExisting(path.join(OVERLAY_SRC, specifier.slice(2)));
      if (overlay) return next(pathToFileURL(overlay).href, context);
    }
  }
  if (HOST_SRC && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    const parentPath = context.parentURL ? path.dirname(new URL(context.parentURL).pathname) : HOST_SRC;
    const found = firstExisting(path.resolve(parentPath, specifier));
    if (found) return next(pathToFileURL(found).href, context);
  }
  return next(specifier, context);
}
