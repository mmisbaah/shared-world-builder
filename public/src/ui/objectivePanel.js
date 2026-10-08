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
    const total = p.total;
    const active = p.active?.[p.index] ?? null;
    const allDone = !active;
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

    const card = allDone
      ? `<div class="obj-card done">
           <div class="obj-kicker">Ladder complete</div>
           <h3>The plaza is finished</h3>
           <p>Every shared goal is met. Keep building &mdash; nothing here is capped.</p>
         </div>`
      : `<div class="obj-card${waiting ? ' waiting' : ''}">
           <div class="obj-kicker">Objective ${p.index + 1} of ${total} &middot; ${done} done</div>
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
    this.el.innerHTML = `
      <div class="obj-banner-kicker">Objective complete</div>
      <div class="obj-banner-title">${escapeHtml(objective.title)}</div>
      ${objective.reward ? `<div class="obj-banner-reward">${escapeHtml(objective.reward)}</div>` : ''}
    `;
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
    }, 4200);
  }
}
