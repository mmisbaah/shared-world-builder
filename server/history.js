/**
 * What changed in this world, and when.
 *
 * The time-lapse scrubs along this log rather than along stored world states.
 * A snapshot every N seconds would cost roughly a megabyte each and still leave
 * the scrubber interpolating between two points that were never actually the
 * world; storing *changes* costs about sixty bytes each, is exact at every
 * step, and -- because each change carries the value it replaced -- walks
 * backwards as readily as forwards.
 *
 * The property that makes truncation safe: walking back from the present by
 * every change after index `k` yields the state at index `k`, no matter what
 * has been dropped from the head of the log. A cap or an age limit only bounds
 * how far back the scrubber can go; it can never make an intermediate state
 * wrong, because nothing between here and the present was forgotten.
 *
 * Scrubbing is by **index**, not by timestamp. Two changes in the same
 * millisecond are not ambiguous by index but are irreducibly ambiguous by
 * time, and a time-lapse that can skip a change because the clock did not move
 * is not showing the world that existed.
 *
 * Pure and dependency-free, so walking it can be tested without a server.
 */

export class WorldHistory {
  /**
   * @param {object} [opts]
   * @param {number} [opts.cap]     most changes retained
   * @param {number} [opts.maxAgeMs] nothing older than this is retained
   */
  constructor({ cap = 8000, maxAgeMs = 60 * 60 * 1000 } = {}) {
    this.cap = cap;
    this.maxAgeMs = maxAgeMs;
    /**
     * Oldest first, appended in wall-clock order -- which is what lets
     * `indexAt` binary search it.
     *
     * @type {Array<{t:number, kind:'block'|'prop', x:number, y:number, z:number,
     *               from:*, to:*, by:string|null}>}
     */
    this.log = [];
    /**
     * Off until boot has finished writing the island and any restored save.
     *
     * Both of those write thousands of cells in the first few milliseconds, and
     * recording them would put the generated terrain at the start of a history
     * that is supposed to show what people built.
     */
    this.active = false;
  }

  /** Begin recording. Everything before this call is deliberately forgotten. */
  start() { this.active = true; }

  /** Stop recording; the log gathered so far is kept. */
  stop() { this.active = false; }

  /**
   * Append one change.
   *
   * A no-op write (same value in as out) is dropped rather than recorded: it
   * would undo to itself and so be invisible to the scrubber either way, while
   * still occupying budget and costing an application on every drag.
   *
   * @param {object} entry
   * @returns {boolean} whether it was kept
   */
  record(entry) {
    if (!this.active) return false;
    if (entry.from === entry.to) return false;

    this.log.push(entry);

    // Age first, then size. Both are cheap because the head only ever moves
    // forward, and both trim exactly rather than by a safety margin: an
    // `Array#shift` of a few thousand entries is microseconds, the edits being
    // recorded do far more work than that to get here in the first place, and a
    // log that quietly held 25% more than it claimed would make the documented
    // bound a lie for no measurable gain.
    const cutoff = entry.t - this.maxAgeMs;
    while (this.log.length > 1 && this.log[0].t < cutoff) this.log.shift();
    if (this.log.length > this.cap) this.log.shift();

    return true;
  }

  get length() { return this.log.length; }

  /** How far back this log reaches. @returns {{oldest:number,newest:number}|null} */
  span() {
    if (this.log.length === 0) return null;
    return { oldest: this.log[0].t, newest: this.log[this.log.length - 1].t };
  }

  /** @returns {object|null} */
  at(i) {
    if (i < 0 || i >= this.log.length) return null;
    return this.log[i];
  }

  /**
   * Entries in `[from, to)`, oldest first, clamped to what exists.
   *
   * Direction is the caller's business: reading it forwards redoes, reading it
   * in reverse undoes. Both directions use this one slice, which is why there
   * is no `changesAfter` to keep in step with it.
   */
  slice(from, to) {
    const a = Math.max(0, Math.min(from, this.log.length));
    const b = Math.max(a, Math.min(to, this.log.length));
    return this.log.slice(a, b);
  }

  /**
   * Index of the first change at or after `time`.
   *
   * For labelling ("changes since you joined") and for jumping the scrubber to
   * a wall clock; the scrubber itself moves by index.
   *
   * @returns {number} `0` when everything is newer, `length` when everything is older
   */
  indexAt(time) {
    let lo = 0;
    let hi = this.log.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.log[mid].t < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
