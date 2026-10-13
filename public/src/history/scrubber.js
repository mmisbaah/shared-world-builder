/**
 * Walking the change log against a live world.
 *
 * A time-lapse here is not a sequence of stored worlds. There is one world -- the
 * present -- and a log of what changed to make it so. Showing the past means
 * putting back what was replaced, in reverse order, over the live data. Showing
 * the present again means re-applying it, in order.
 *
 * That is exact at every step, including through a cap or an age limit on the
 * log. Walking back from the present by every change after index `k` yields the
 * state at index `k` *whatever was dropped from the head*: nothing between here
 * and now was forgotten, so nothing here can be reconstructed wrongly. A cap
 * only bounds how far back the scrubber may go; it never makes an intermediate
 * frame a guess.
 *
 * Cursors are **indices, not timestamps**. Two changes in the same millisecond
 * are not ambiguous by index but are irreducibly ambiguous by time, and a
 * time-lapse that can skip a change because the clock did not move is not
 * showing the world that existed.
 *
 * It writes through `setAuthoritative` with no revision, which is what makes the
 * round trip safe: that call updates the material, keeps the occupancy count
 * straight, marks the chunk dirty for remeshing, and **leaves the revision array
 * alone**. Revisions are the authority's monotonic record of what happened and
 * belong to the present no matter what the cells currently show -- so while the
 * scrubber walks them backwards and forwards, they stay exactly right, and
 * restoring costs no bookkeeping at all.
 *
 * Pure and dependency-free apart from the world it is handed, so the walking can
 * be tested against a fake that only implements the four methods it uses.
 */

export class Scrubber {
  /**
   * @param {object} world anything with `setAuthoritative`, `setProp`, `removeProp`
   * @param {Array<{t:number, kind:string, x:number, y:number, z:number, from:*, to:*}>} entries
   *        oldest first, as served by `/api/history`
   */
  constructor(world, entries = []) {
    this.world = world;
    this.entries = entries;
    /**
     * Index of the next entry that has *not* been applied, so the frame on
     * screen is the state after `entries[0..cursor-1]`.
     *
     * It starts at the end: a scrubber opens on the present, because opening on
     * a twenty-minute-old island and silently holding it there until the player
     * notices is a great way to make them think the game is broken.
     */
    this.cursor = entries.length;
  }

  get length() { return this.entries.length; }

  /** Whether what is on screen is the world as it is now. */
  get atPresent() { return this.cursor === this.entries.length; }

  /**
   * Move the frame to `target`, applying only the difference.
   *
   * Only the difference, and that is the whole reason dragging a slider across
   * the entire history stays responsive: a full rewind from the present is
   * every change since the log began, but dragging one notch is one change.
   *
   * @param {number} target index in `[0, length]`
   * @returns {number} how many entries were applied -- zero if nothing moved
   */
  seek(target) {
    const t = Math.max(0, Math.min(target | 0, this.entries.length));
    if (t === this.cursor) return 0;

    if (t < this.cursor) {
      // Backwards: undo newest-first, or the second-to-last write would be
      // overwritten by the last one before it had a chance to be seen.
      for (let i = this.cursor - 1; i >= t; i--) this._write(this.entries[i], this.entries[i].from);
    } else {
      for (let i = this.cursor; i < t; i++) this._write(this.entries[i], this.entries[i].to);
    }

    const moved = Math.abs(t - this.cursor);
    this.cursor = t;
    return moved;
  }

  /** Put the world back and forget where it was. @returns {number} entries moved */
  restore() { return this.seek(this.entries.length); }

  /** Jump to the oldest frame this log still reaches. @returns {number} moved */
  rewind() { return this.seek(0); }

  /**
   * Wall-clock moment currently on screen, or `null` when it is the present.
   *
   * `null` rather than `now()`: the present is not a moment this log recorded,
   * and stamping it with the time of the last change would label a live world
   * with a time that has already moved on. At the very oldest frame the log
   * has nothing before it either, so the first change's own moment stands in --
   * it is the nearest thing the log knows.
   *
   * @returns {number|null}
   */
  shownTime() {
    if (this.atPresent) return null;
    return this.entries[Math.max(0, this.cursor - 1)].t;
  }

  /**
   * Put one entry into a given state.
   *
   * Both directions go through here, which is why there is no separate undo and
   * redo: a change knows what it replaced and what replaced it, and the only
   * difference between going back and coming forward is which of the two you
   * write.
   */
  _write(entry, value) {
    if (entry.kind === 'prop') {
      if (value) this.world.setProp(value);
      else this.world.removeProp(entry.x, entry.y, entry.z);
      return;
    }
    this.world.setAuthoritative(entry.x, entry.y, entry.z, value);
  }
}

/**
 * How long before now a moment was, in the coarsest unit that still reads.
 *
 * A time-lapse scrubber labels a frame with how far back it is rather than a
 * wall clock, because "2 minutes ago" is a fact about the frame and "14:32:07"
 * is a fact about the server.
 *
 * @param {number} time ms
 * @param {number} [now]
 * @returns {string}
 */
export function agoLabel(time, now = Date.now()) {
  const s = Math.max(0, Math.round((now - time) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
}
