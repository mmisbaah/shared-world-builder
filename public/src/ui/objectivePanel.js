/**
 * Objective ladder panel.
 *
 * Renders the server's verdict. Deliberately contains no game rules: it is handed
 * an already-evaluated payload and displays it, so the panel can never disagree
 * with the server about whether something is done.
 *
 * The one piece of logic is presentation -- which objective to show, and whether
 * the ladder has run out. Both are derived from `index`, which is also
 * server-owned.
 */

import { escapeHtml } from './hud.js';
import { roundOf } from '../../../shared/objectives.js';

export class ObjectivePanel {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.payload = null;
    this.lastCompletedId = null;
  }

  /**
   * @param {object} payload from EV.OBJECTIVES
   * @returns {string|null} id of an objective completed in this update
   */
  update(payload) {
    if (!payload) return null;

    const previousActive = this.payload?.active?.[this.payload?.index]?.id ?? null;
    this.payload = payload;

    const nowActive = payload.active?.[payload.index]?.id ?? null;
    const completedNow = previousActive && previousActive !== nowActive ? previousActive : null;

    this._render();
    return completedNow;
  }

  _render() {
    const p = this.payload;
    if (!p) {
      this.root.innerHTML = '';
      return;
    }

    const done = p.completed.length;
    const active = p.active?.[p.index] ?? null;
    const allDone = !active;
    /**
     * Two phases, and they want different things said.
     *
     * During the campaign "Objective 4 of 8" means something, because 8 is a
     * finish line. Past it the tail is generated only a few objectives ahead, so
     * `total` really means "defined so far" -- printing "Objective 12 of 15"
     * would promise an ending that moves every time you get near it. So the
     * campaign counts down to a number and the tail reports a round instead,
     * which is honest about having none.
     */
    const campaign = typeof p.campaign === 'number' ? p.campaign : (p.active?.length ?? 0);
    const inTail = p.index >= campaign;
    const kicker = inTail
      ? `Endless &middot; round ${roundOf(p.index)} &middot; objective ${p.index + 1} &middot; ${done} done`
      : `Objective ${p.index + 1} of ${Math.min(p.total, campaign)} &middot; ${done} done`;
    /**
     * Server says the metric is met but no human has touched this objective, so
     * it is deliberately being held. Showing a full bar with no completion and no
     * explanation is the single most confusing thing this panel could do.
     */
    const waiting = !!p.awaitingHuman && !allDone;

    // The ladder rail: one pip per objective, filled as they are finished. Cheap,
    // and it makes progress across the session legible at a glance rather than
    // only showing the current task.
    const rail = p.active.map((o, i) => {
      const cls = i < p.index ? 'pip done' : i === p.index ? 'pip active' : 'pip';
      return `<i class="${cls}" title="${escapeHtml(o.title)}"></i>`;
    }).join('');

    // Only reachable if a payload arrives without an entry at the cursor --
    // the ladder is always generated a few ahead of it, so in normal operation
    // there is always a next goal. Kept because an empty panel would be a
    // silent failure, and this says what happened instead.
    const card = allDone
      ? `<div class="obj-card done">
           <div class="obj-kicker">Ladder complete</div>
           <h3>The plaza is finished</h3>
           <p>Every shared goal is met. Keep building &mdash; nothing here is capped.</p>
         </div>`
      : `<div class="obj-card${waiting ? ' waiting' : ''}">
           <div class="obj-kicker">${kicker}</div>
           <h3>${escapeHtml(active.title)}</h3>
           <p>${escapeHtml(active.brief)}</p>
           <div class="obj-bar" role="progressbar" aria-valuenow="${active.current}"
                aria-valuemin="0" aria-valuemax="${active.goal}"
                aria-label="${escapeHtml(active.title)} progress">
             <i style="width:${Math.round((active.current / Math.max(1, active.goal)) * 100)}%"></i>
           </div>
           <div class="obj-count">${active.current} / ${active.goal}</div>
           ${waiting
             ? `<div class="obj-hold">Build anything here to unlock &mdash; the bots are holding off.</div>`
             : ''}
           ${active.reward ? `<div class="obj-reward">Reward: ${escapeHtml(active.reward)}</div>` : ''}
         </div>`;

    // Recently finished goals, so a completion is still visible after it scrolls
    // out of the active slot.
    const recent = p.completed.slice(-3).reverse().map((id) => {
      const o = p.active.find((x) => x.id === id);
      return o ? `<li><span class="tick">&#10003;</span>${escapeHtml(o.title)}</li>` : '';
    }).join('');

    this.root.innerHTML = `
      <div class="obj-rail" aria-label="objective progress">${rail}</div>
      ${card}
      ${recent ? `<ul class="obj-done">${recent}</ul>` : ''}
    `;
  }
}

/**
 * A transient banner for a completed objective.
 *
 * Separate from the panel because a completion needs to interrupt -- it is the
 * one moment the player should not miss -- and a panel update is not enough of an
 * interruption on its own.
 */
export class ObjectiveBanner {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'obj-banner';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.timer = null;
  }

  /** @param {object} objective @param {(o:object)=>string} byId */
  show(objective, byId) {
    if (!objective) return;
    this._show(`
      <div class="obj-banner-kicker">Objective complete</div>
      <div class="obj-banner-title">${escapeHtml(objective.title)}</div>
      ${objective.reward ? `<div class="obj-banner-reward">${escapeHtml(objective.reward)}</div>` : ''}
    `, 4200);
  }

  /**
   * The scripted ladder is finished and the endless tail has begun.
   *
   * Deliberately shown *after* the final objective's own banner rather than
   * instead of it. The last campaign goal still deserves to be read as a goal,
   * and two banners fighting for the same slot would mean neither sentence
   * landed -- so the caller waits one banner's worth of time before calling
   * this. Longer duration too: it is the only one of these that is not
   * followed by another one in about a minute.
   */
  showCampaign() {
    this._show(`
      <div class="obj-banner-kicker">Campaign complete</div>
      <div class="obj-banner-title">The plaza is finished</div>
      <div class="obj-banner-reward">Every scripted goal is met. Endless objectives begin now &mdash; nothing here is capped.</div>
    `, 7000);
  }

  /** @param {string} html @param {number} ms time on screen before it retires */
  _show(html, ms) {
    this.el.innerHTML = html;
    this.el.hidden = false;
    // Restart the animation: without forcing a reflow, re-showing an already-visible
    // element does not replay the CSS entry transition.
    this.el.classList.remove('show');
    void this.el.offsetWidth;
    this.el.classList.add('show');

    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.el.classList.remove('show');
      setTimeout(() => { this.el.hidden = true; }, 400);
    }, ms);
  }
}
