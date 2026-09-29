// omniwatchNode.ts — one shape for a step that checks its own output and tries again.
//
// Four gates already existed before this file did, each written by hand the day it was
// needed: the board scan that walks frames until it sees enough rows, the caption band that
// re-measures at another moment when the first one didn't answer, the insert span that walks
// a clip and keeps only what it actually saw, the image slot that asks its provider again
// after a refusal. Each one already followed the same three rules — declare what success
// means as a condition on the VALUE, treat a failed check as a hole rather than the input's
// own guess, change the input on a retry rather than the wording — but each wrote that shape
// out separately, in its own style, with nothing recording what happened beyond a line
// appended to `notes`.
//
// This file names that shape once. Converting a gate onto it changes nothing about what it
// accepts or how it retries — it only makes the shape visible, and it gives every gate a
// place to write down its attempts so a run report (the next piece of this plan) has
// something structured to read instead of grepping `notes` for the word "measured".
//
// See docs/GRAPH-PLAN.md §1 and §4 for where this comes from.

/** A step that may need more than one try before it has a value worth keeping.
 *
 *  `In` and `Out` are deliberately generic: a node's input is whatever a retry can change
 *  about the next attempt (a moment in time, a frame index), and its output is whatever the
 *  node is trying to measure. */
export interface Node<In, Out> {
  name: string;
  /** One try. Returning null means this attempt produced nothing to judge — a decode that
   *  failed, a call that errored — which is different from a value that `accepts` rejects. */
  run(input: In, attempt: number): Promise<Out | null>;
  /** Whether this result may go downstream. A condition on the VALUE, never "it did not throw". */
  accepts(out: Out): boolean;
  /** What to change about the INPUT before trying again, or null when nothing is left to change. */
  retry?(input: In, attempt: number): In | null;
  /** What stands when nothing was ever accepted: a degraded value, or null for a hole. */
  onGiveUp?(input: In): Out | null;
  /** A short human string for what an attempt tried, e.g. "t=8.50" — for the record, not for
   *  control flow. Defaults to String(input). */
  describe?(input: In): string;
  /** A short human string for what an attempt came back with, for the record. Defaults to "". */
  detail?(out: Out | null): string;
}

/** One try, and what came of it. `input` is the short string from `describe`, not the whole
 *  object that was tried — this is meant to be read, not deserialized. */
export interface GateAttempt {
  attempt: number;
  input: string;
  verdict: "accepted" | "rejected" | "failed";
  detail: string;
}

/** What one node did over a run: every attempt it made, and how it ended. "accepted" means the
 *  last attempt passed `accepts`; "degraded" means nothing was accepted but `onGiveUp` produced
 *  a stand-in value; "hole" means it produced nothing at all. */
export interface GateRecord {
  node: string;
  attempts: GateAttempt[];
  outcome: "accepted" | "degraded" | "hole";
}

/** Drive a node's retry loop and append the one GateRecord it produces to `log`.
 *
 *  Returns the accepted value, the degraded stand-in from `onGiveUp`, or null — the same hole
 *  a caller already had to handle before this file existed, now with a record of how it got
 *  there instead of silence. */
export async function runNode<In, Out>(
  node: Node<In, Out>,
  input: In,
  log: GateRecord[],
): Promise<Out | null> {
  const describe = node.describe ?? ((x: In) => String(x));
  const detail = node.detail ?? (() => "");
  const attempts: GateAttempt[] = [];
  let current = input;
  let attempt = 1;
  let accepted: Out | null = null;

  for (;;) {
    const out = await node.run(current, attempt);
    if (out !== null && node.accepts(out)) {
      attempts.push({ attempt, input: describe(current), verdict: "accepted", detail: detail(out) });
      accepted = out;
      break;
    }
    attempts.push({
      attempt,
      input: describe(current),
      verdict: out === null ? "failed" : "rejected",
      detail: detail(out),
    });
    const next = node.retry ? node.retry(current, attempt) : null;
    if (next === null) break;
    current = next;
    attempt += 1;
  }

  if (accepted !== null) {
    log.push({ node: node.name, attempts, outcome: "accepted" });
    return accepted;
  }
  const given = node.onGiveUp ? node.onGiveUp(current) : null;
  log.push({ node: node.name, attempts, outcome: given === null ? "hole" : "degraded" });
  return given;
}
