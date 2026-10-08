/**
 * Server-side objective tracking.
 *
 * The whole point is that progress is *measured*, never reported. This module owns
 * the ladder's cursor, evaluates it against authoritative world state, and hands
 * the client a verdict it cannot influence.
 *
 * Design notes worth keeping:
 *
 * - Evaluation is a single world scan shared across all objectives (see
 *   `scanWorld`). At 1 Hz over a large world that matters.
 * - Progress is monotonic. An objective that is met stays met for the session even
 *   if the blocks are later removed. Retroactively un-completing a shared goal
 *   because one builder demolished the evidence feels like a bug to everyone
 *   watching, and there is no good reason for it: the achievement happened.
 * - Distinct-builder progress counts builders who ever committed an op, which is
 *   what "invite someone" actually means. Counting only currently-connected
 *   builders would make the objective flicker as people come and went.
 */

import { OBJECTIVES, scanWorld, evaluate, toWire } from '../shared/objectives.js';

export class ObjectiveTracker {
  /**
   * @param {import('./authority.js').Authority} authority
   */
  constructor(authority) {
    this.authority = authority;
    /** Index of the active objective in OBJECTIVES. */
    this.index = 0;
    /** Ids of objectives already completed, for the wire summary. */
    this.completed = [];
    /** Builder ids that have committed at least one accepted op. */
    this.contributors = new Set();
    /**
     * Objectives a *human* has contributed to since they became active.
     *
     * This is what stops the bots from carrying the ladder. Measured before it
     * existed: the swarm cleared six of eight objectives in about thirty seconds
     * with no human input, so a player arriving later found the game already
     * finished. It is also what unsticks solo play -- `distinctBuilders` needs
     * three humans, so without any human contribution at all the ladder
     * dead-ended at 6/8 with the bots idling, which reads as broken.
     *
     * The rule is deliberately "at least one human touch", not "mostly human
     * work". One block from a person is enough to unlock the objective; the bots
     * can then help finish it. Anything stricter stops being cooperative and
     * becomes busywork.
     */
    this.humanTouched = new Set();
    /** Last evaluation result, cached so a broadcast is a pointer copy. */
    this.wire = toWire(OBJECTIVES, 0, [], emptyScan(), { tallest: 0 });
    /** Callbacks fired when an objective completes, so the host can celebrate. */
    this.onComplete = null;
  }

  /** @param {string} builderId */
  noteContributor(builderId) {
    if (builderId) this.contributors.add(builderId);
  }

  /**
   * Record that a human builder committed something.
   *
   * Bots go through `commitAs` / `commitPropAs` and never reach this, which is
   * exactly the distinction the rule depends on.
   *
   * @param {string} builderId
   * @returns {string|null} the objective id that was touched, if any is active
   */
  noteHumanContribution(builderId) {
    this.noteContributor(builderId);
    const active = OBJECTIVES[this.index];
    if (!active) return null;
    this.humanTouched.add(active.id);
    return active.id;
  }

  /**
   * Whether an objective is satisfied *and* unlocked by a human.
   *
   * Both halves matter, and the UI needs to tell them apart: a metric that is met
   * but waiting on a person reads very differently from one that is genuinely
   * incomplete, and conflating them is why the client shows a full bar that nothing
   * happens to.
   */
  isUnlocked(objectiveId) {
    return this.humanTouched.has(objectiveId);
  }

  /** Every live prop across every chunk. */
  _props() {
    const out = [];
    for (const chunk of this.authority.chunks.values()) {
      for (const rec of chunk.props.values()) out.push(rec);
    }
    return out;
  }

  /**
   * Recompute the ladder and advance if the active objective is now satisfied.
   *
   * Advances in a loop rather than one step, so finishing two objectives in the
   * same tick (plausible: a six-lantern goal completed while a one-lantern goal
   * was already met) cannot leave the ladder stuck on an already-satisfied
   * objective.
   *
   * @returns {boolean} true if anything changed and clients need telling
   */
  evaluate() {
    const scan = scanWorld(this.authority.chunks.values(), this._props(), this.contributors);
    const changed = [];

    // Guard against a malformed ladder looping forever.
    for (let guard = 0; guard < OBJECTIVES.length; guard++) {
      if (this.index >= OBJECTIVES.length) break;
      const active = OBJECTIVES[this.index];
      const verdict = evaluate(active, scan, scan);

      // The metric alone is not enough. An objective also needs a human to have
      // touched it, so the bots cannot carry the ladder on their own and a solo
      // player is never permanently blocked.
      const unlocked = this.humanTouched.has(active.id);
      if (!verdict.done || !unlocked) {
        this.awaitingHuman = verdict.done && !unlocked;
        break;
      }
      this.awaitingHuman = false;

      this.completed.push(active.id);
      changed.push(active);
      this.index++;
      // A new objective starts locked until a human acts on it.
    }

    this.wire = toWire(OBJECTIVES, this.index, this.completed, scan, scan);

    for (const objective of changed) {
      this.onComplete?.(objective, scan);
    }
    return changed.length > 0;
  }

  /**
   * Wire payload. Includes the world stats the HUD shows alongside progress, so
   * the client can render "tallest 14" without re-deriving anything.
   */
  payload() {
    return {
      ...this.wire,
      tallest: this.wire.active[this.index]?.current ?? 0,
      contributors: this.contributors.size,
      /**
       * The metric is satisfied but no human has acted on this objective yet, so
       * the bots are deliberately holding off. The client shows this distinctly:
       * a full bar with nothing happening looks like a bug, whereas "waiting on
       * you" is a call to action.
       */
      awaitingHuman: !!this.awaitingHuman,
    };
  }

  /** @param {number} ms @param {Function} fn */
  static every(ms, fn) {
    const t = setInterval(fn, ms);
    if (t.unref) t.unref();
    return t;
  }
}

function emptyScan() {
  return {
    materialCounts: new Map(),
    propCounts: new Map(),
    tallest: 0,
    builders: new Set(),
  };
}
