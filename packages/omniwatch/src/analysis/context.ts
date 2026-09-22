/**
 * Conversation context construction (T1, D9).
 *
 * Rules this file exists to enforce:
 *   - a conversation is scoped to one source; turns from another video are never mixed;
 *   - when the user refers to an earlier answer ("rozwin drugi punkt"), that answer is
 *     part of the required set - it is never silently dropped for budget reasons;
 *   - two questions asked off the same parent are separate branches, so answering one
 *     does not drag the other branch's answer in;
 *   - when the required set alone does not fit the input budget, the caller gets a
 *     clear OmniWatchError telling the user to point at a fragment or start a new
 *     conversation.
 *
 * The caller passes only the turns it already scoped to this source (the store keys
 * turns by conversationId); this module still re-checks the conversationId.
 */

import { OmniWatchError } from "../contracts/errors.ts";
import { sha256Hex } from "../contracts/keys.ts";
import type { ConversationTurn, SourceRef } from "../contracts/types.ts";

export interface ConversationTurnSource {
  listTurns(conversationId: string, limit?: number): ConversationTurn[];
  getTurn?(turnId: string): ConversationTurn | null;
}

export interface ContextBudget {
  /** Estimated maximum tokens available for the conversation part of the input. */
  inputBudgetTokens: number;
  /** Rough estimator; the default is ~4 characters per token. */
  estimateTokens?: (text: string) => number;
  /** Upper bound on earlier turns considered at all. Default 20. */
  maxHistoryTurns?: number;
}

export interface ConversationContext {
  /** Included turns, oldest first; the referenced parent is present when set. */
  turns: ConversationTurn[];
  /** Stable key over the included turns; participates in analysisKey. */
  contextKey: string;
  estimatedTokens: number;
  budgetTokens: number;
  /** True when optional (non-referenced) history did not fit the budget. */
  trimmed: boolean;
}

export interface BuildContextInput {
  sourceRef: SourceRef;
  conversationId: string;
  question?: string | null;
  parentTurnId?: string | null;
  /** Turns already read for this conversation; may contain other conversations. */
  turns: ConversationTurn[];
  budget: ContextBudget;
}

const DEFAULT_MAX_HISTORY = 20;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Conversation id derived from a source, used when the caller has none yet. */
export function conversationIdForSource(source: SourceRef): string {
  const safe = `${source.platform}_${source.sourceId}`.replace(/[^\w.-]/g, "_").slice(0, 96);
  return `conv_${safe}`;
}

function byCreatedAt(a: ConversationTurn, b: ConversationTurn): number {
  if (a.createdAt === b.createdAt) return a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0;
  return a.createdAt < b.createdAt ? -1 : 1;
}

function contextUnavailable(message: string): OmniWatchError {
  return new OmniWatchError("invalid_input", message, {
    action: { label: "wskaz fragment albo zacznij nowa rozmowe", kind: "none" },
  });
}

/**
 * Select the turns the model must see: the referenced parent chain (required) plus as
 * much earlier history as the budget allows (optional).
 */
export function buildConversationContext(input: BuildContextInput): ConversationContext {
  const budgetTokens = Number(input.budget.inputBudgetTokens);
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    throw contextUnavailable("Brak zadeklarowanego limitu wejscia modelu dla kontekstu rozmowy.");
  }
  const estimate = input.budget.estimateTokens ?? estimateTokens;
  const maxHistory = input.budget.maxHistoryTurns ?? DEFAULT_MAX_HISTORY;

  const sameConversation = input.turns.filter((turn) => turn.conversationId === input.conversationId);
  const byId = new Map(sameConversation.map((turn) => [turn.turnId, turn]));
  const question = (input.question ?? "").trim();

  const required: ConversationTurn[] = [];
  if (input.parentTurnId) {
    if (!byId.has(input.parentTurnId)) {
      const elsewhere = input.turns.some((turn) => turn.turnId === input.parentTurnId);
      throw contextUnavailable(
        elsewhere
          ? "Odpowiedz, do ktorej sie odnosisz, nalezy do rozmowy o innym materiale."
          : "Odpowiedz, do ktorej sie odnosisz, nie jest juz dostepna.",
      );
    }
    let cursor: string | null = input.parentTurnId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor) && required.length < 50) {
      seen.add(cursor);
      const turn: ConversationTurn | undefined = byId.get(cursor);
      if (!turn) break;
      required.push(turn);
      cursor = turn.parentTurnId;
    }
    required.reverse(); // oldest first
  } else {
    // No explicit parent: a continuing question still refers to the newest answer, so
    // that answer is required. Nothing is guessed from the question text.
    const assistants = sameConversation.filter((turn) => turn.role === "assistant").sort(byCreatedAt);
    const newest = assistants[assistants.length - 1];
    if (newest) required.push(newest);
  }

  const requiredIds = new Set(required.map((turn) => turn.turnId));
  const requiredTokens = required.reduce((sum, turn) => sum + estimate(turn.text), 0) + estimate(question);
  if (requiredTokens > budgetTokens) {
    throw contextUnavailable(
      "Kontekst rozmowy przekracza limit wejscia modelu. Wskaz fragment materialu albo zacznij nowa rozmowe.",
    );
  }

  // With an explicit parent, only the ancestor chain is context: a sibling branch that
  // answered off the same parent is a different thread of the conversation and must not
  // leak into this answer. Without a parent, older turns are optional history.
  const others = input.parentTurnId
    ? []
    : sameConversation
      .filter((turn) => !requiredIds.has(turn.turnId))
      .sort(byCreatedAt)
      .slice(-maxHistory);

  const optional: ConversationTurn[] = [];
  let used = requiredTokens;
  let trimmed = false;
  for (let i = others.length - 1; i >= 0; i -= 1) {
    const turn = others[i];
    const cost = estimate(turn.text);
    if (used + cost <= budgetTokens) {
      optional.push(turn);
      used += cost;
    } else {
      // History is a contiguous recent window: once a turn does not fit, older ones
      // are not considered either, so the model never sees a gap.
      trimmed = true;
      break;
    }
  }
  optional.reverse(); // oldest first

  const turns = [...optional, ...required].sort(byCreatedAt);
  const signature = turns.map((turn) => `${turn.turnId}:${sha256Hex(turn.text).slice(0, 8)}`).join("|");
  return {
    turns,
    contextKey: signature ? `ctx_${sha256Hex(signature).slice(0, 16)}` : "ctx_none",
    estimatedTokens: used,
    budgetTokens,
    trimmed,
  };
}

/** Convenience wrapper over a store-like turn source. */
export function buildContextFromStore(
  source: ConversationTurnSource,
  input: Omit<BuildContextInput, "turns">,
): ConversationContext {
  const turns = source.listTurns(input.conversationId, 200);
  return buildConversationContext({ ...input, turns });
}
