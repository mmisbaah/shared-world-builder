/**
 * Territory readout: what you hold, and how long you have.
 *
 * The panel exists because decay without a visible clock is not a mechanic, it is a
 * punishment. A player who comes back to a stolen quarter with no warning has learned
 * nothing except that the game is unfair.
 *
 * Two rules it obeys:
 *
 * - **It never counts down locally.** The remaining time comes from the server on
 *   every zones broadcast. A local timer would drift, and would be wrong on every
 *   client that happened to load a moment later. It also renders the *state*
 *   (`live` / `fading`) rather than re-deriving it, so the panel cannot disagree with
 *   the colour of the wall in the world.
 * - **It updates in place.** Rebuilding innerHTML on every 5 s broadcast would reset
 *   text selection and make the bar jump; the width is the only thing that changes.
 */

import { WORLD } from '../../../shared/protocol.js';
import { escapeHtml } from './hud.js';

export class ClaimPanel {
  /** @param {HTMLElement|null} host */
  constructor(host) {
    this.host = host;
    this.lastKey = '';
    if (!host) return;

    host.innerHTML = `
      <div class="claim-row">
        <div class="claim-head">
          <span class="claim-label">Territory</span>
          <span class="claim-state" data-claim="state">none</span>
        </div>
        <div class="claim-bar"><i data-claim="fill"></i></div>
        <div class="claim-note" data-claim="note">Press <kbd>C</kbd> to claim the ground you are looking at.</div>
      </div>
    `;
    this.el = {
      state: host.querySelector('[data-claim="state"]'),
      fill: host.querySelector('[data-claim="fill"]'),
      note: host.querySelector('[data-claim="note"]'),
    };
  }

  /**
   * @param {object|null} claim our zone from the server, or null
   * @param {number} neighbors how many other claims are live, for context
   */
  update(claim, neighbors = 0) {
    if (!this.host || !this.el.state) return;

    if (!claim) {
      // Only rebuild when the state actually changes, so this is not thrashing the
      // DOM on every broadcast.
      if (this.lastKey === 'none') {
        this.el.fill.style.width = '0%';
        return;
      }
      this.lastKey = 'none';
      this.el.state.textContent = 'none';
      this.el.state.className = 'claim-state';
      this.el.fill.style.width = '0%';
      this.el.note.innerHTML = neighbors > 0
        ? `Press <kbd>C</kbd> to claim ground. ${neighbors} other ${neighbors === 1 ? 'claim' : 'claims'} held.`
        : 'Press <kbd>C</kbd> to claim the ground you are looking at.';
      return;
    }

    const fading = claim.state === 'fading' || claim.state === 'expiring';
    const pct = Math.max(0, Math.min(100, Math.round((claim.msLeft / WORLD.ZONE_TTL_MS) * 100)));
    const key = `${claim.id}:${claim.state}:${pct}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.el.state.textContent = fading ? 'fading' : `${claim.half * 2}x${claim.half * 2}`;
    this.el.state.className = `claim-state${fading ? ' fading' : ''}`;
    this.el.fill.style.width = `${pct}%`;
    this.el.fill.className = fading ? 'fading' : '';

    if (fading) {
      const secs = Math.max(0, Math.round(claim.msLeft / 1000));
      // Names the remedy, because "your claim is fading" is a symptom and "build
      // something there" is an instruction.
      this.el.note.innerHTML = claim.msLeft <= 0
        ? 'Expired &mdash; <kbd>C</kbd> to claim it back.'
        : `Decaying in ${secs}s. Build anything inside to hold it.`;
    } else {
      const mins = Math.round(claim.msLeft / 60000);
      this.el.note.innerHTML = `Held at ${claim.cx},${claim.cz} &middot; ${mins} min left. Building renews it.`;
    }
  }
}