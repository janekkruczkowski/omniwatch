/**
 * Canonical identity and analysis keys (T0).
 *
 * `analysisKey` covers source identity + input version, mode, focus/question,
 * language, analysis version and the conversation context actually used. It is a
 * unique index in the local database, not a title comparison (TECHNICAL).
 */

import { createHash } from "node:crypto";
import type { AnalysisRequest } from "./types.ts";

export function sha1Hex(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Non-YouTube identity used by the released Python beta: first 16 hex chars of
 * SHA-1 over the canonical URL. Kept byte-compatible so old files stay findable.
 */
export function legacyHashId(canonicalUrl: string): string {
  return sha1Hex(canonicalUrl).slice(0, 16);
}

/**
 * TypeScript-side short identity (djb2). Used by newer TS paths; the legacy ID
 * is preserved alongside it so migration never reports an old material as new.
 */
export function djb2Id(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

/**
 * Canonical representation of everything an analysis result depends on.
 * Changing the analysis version or the conversation context produces a new key,
 * which is exactly how "force recompute" and "new goal" become new generations.
 */
export function canonicalRequestKey(request: AnalysisRequest, conversationContextKey?: string | null): string {
  const payload = {
    contract: "omniwatch.analysis-key",
    platform: request.sourceRef.platform,
    sourceId: request.sourceRef.sourceId,
    sourceUrl: request.sourceRef.canonicalUrl,
    mode: request.mode,
    focus: normalizeText(request.focus),
    question: normalizeText(request.question),
    language: request.language.trim().toLowerCase(),
    analysisVersion: request.analysisVersion,
    parentTurnId: request.parentTurnId ?? null,
    conversationContext: conversationContextKey ?? null,
  };
  return JSON.stringify(payload);
}

export function computeAnalysisKey(request: AnalysisRequest, conversationContextKey?: string | null): string {
  return sha256Hex(canonicalRequestKey(request, conversationContextKey));
}

export function computeAnalysisId(analysisKey: string): string {
  return `omni_${analysisKey.slice(0, 16)}`;
}
