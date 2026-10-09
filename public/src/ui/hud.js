/**
 * DOM binding.
 *
 * Kept deliberately dumb: it reads state that main.js hands it and writes text.
 * No rendering decisions live here, and nothing in the render path calls into it
 * except the once-per-frame update.
 *
 * The per-frame writes are guarded so a stat only touches the DOM when its
 * rendered value actually changes. At 60 Hz that is the difference between a
 * handful of node writes and sixty layout-invalidating ones per second.
 */

import { QUALITY_ORDER, PALETTES, MATERIALS } from '../config.js';

const $ = (id) => document.getElementById(id);

/** Write only when the value differs, so unchanged stats cost nothing. */
function setText(el, value) {
  if (!el) return;
  const s = String(value);
  if (el.textContent !== s) el.textContent = s;
}

export class HUD {
  constructor() {
    this.el = {
      chunks: $('stat-chunks'),
      quads: $('stat-quads'),
      verts: $('stat-verts'),
      fps: $('stat-fps'),
      ping: $('stat-ping'),
      inflight: $('stat-inflight'),
      netDot: $('net-dot'),
      netText: $('net-text'),
      builders: $('builders'),
      log: $('log'),
      passes: $('passes'),
      palette: $('palette'),
      toasts: $('toasts'),
      stats: $('stats'),
      boot: $('boot'),
      bootStatus: $('boot-status'),
      bootBar: $('boot-bar-fill'),
      qualityText: $('quality-text'),
      botsText: $('bots-text'),
    };

    this.logLines = [];
    this.maxLog = 40;
    this.showStats = false;
    this.fpsSamples = [];
    this._lastPasses = '';
  }

  // -------------------------------------------------------------------------
  // Boot gate
  // -------------------------------------------------------------------------

  /** @param {number} progress 0..1 @param {string} message */
  boot(progress, message) {
    if (this.el.bootStatus) this.el.bootStatus.textContent = message;
    if (this.el.bootBar) this.el.bootBar.style.width = `${Math.round(progress * 100)}%`;
  }

  bootDone() {
    this.el.boot?.classList.add('done');
    setTimeout(() => this.el.boot?.remove(), 700);
  }

  /** Fatal: replace the boot card with the reason instead of a blank screen. */
  fatal(message, detail) {
    if (!this.el.boot) return;
    this.el.boot.classList.add('fatal');
    this.el.boot.innerHTML = `
      <div class="boot-card">
        <div class="boot-mark"><i class="fa-solid fa-triangle-exclamation"></i></div>
        <h1>Cannot start</h1>
        <p id="boot-status">${escapeHtml(message)}</p>
        ${detail ? `<pre class="mono boot-detail">${escapeHtml(detail)}</pre>` : ''}
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  /**
   * @param {object} s snapshot of engine + net state
   * @param {number} dtMs frame time
   */
  update(s, dtMs) {
    // Rolling average over half a second; an instantaneous 1/dt is unreadable.
    this.fpsSamples.push(dtMs);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
    const fps = avg > 0 ? Math.round(1000 / avg) : 0;

    setText(this.el.chunks, s.chunks);
    setText(this.el.quads, s.quads.toLocaleString());
    setText(this.el.verts, s.verts.toLocaleString());
    setText(this.el.fps, `${fps} fps`);
    setText(this.el.ping, s.connected ? `${s.ping} ms` : '—');
    setText(this.el.inflight, s.inflight);

    const dot = this.el.netDot;
    if (dot) {
      const cls = s.connected ? (s.inflight > 0 ? 'pending' : 'online') : 'offline';
      if (dot.dataset.state !== cls) {
        dot.dataset.state = cls;
        dot.className = `dot ${cls}`;
      }
      setText(this.el.netText, s.connected ? s.name : 'reconnecting…');
    }

    const passText = s.passes.map((p) => `${p.name}<b>${p.on ? '' : 'off'}</b>`).join('');
    // The pass list lives in the F-key overlay now. It was a permanent rail panel
    // and it never changed during play, so it was rail space spent on a static
    // string while the delta log below it got squeezed to a couple of lines.
    if (passText !== this._lastPasses) {
      this._lastPasses = passText;
      this._passText = passText;
      if (this.showStats) this._writeStats();
    }

    // Always cache the payload, render only when the overlay is open. Caching inside
    // the `showStats` branch meant `_lastStats` was still undefined on the very
    // first F press, so `_writeStats` bailed out and the overlay came up blank
    // until the following frame.
    this._lastStats = { s, avg };
    if (this.showStats && this.el.stats) this._writeStats();
  }

  /**
   * Write the stats overlay.
   *
   * Split out from the per-frame update so opening the overlay with F paints
   * immediately, rather than waiting for the next frame that happens to pass the
   * numbers in. Kept as its own step because the overlay now also carries the
   * pipeline pass list, which is refreshed on a completely different cadence.
   */
  _writeStats() {
    if (!this._lastStats || !this.el.stats) return;
    const { s, avg } = this._lastStats;
    const passes = this._passText ?? '';
    this.el.stats.innerHTML = this.renderFrameStats(s, avg) +
      (passes ? `<div class="stats-passes">${passes}</div>` : '');
  }

  renderFrameStats(s, avgMs) {
    const rows = [
      ['frame', `${avgMs.toFixed(2)} ms`],
      ['draws', s.drawCalls],
      ['tris', s.triangles.toLocaleString()],
      ['columns', s.chunks],
      ['quads', s.quads.toLocaleString()],
      ['props', `${s.props} (cap ${s.propCapacity})`],
      ['lights', `${s.lights} clustered`],
      ['lights dropped', s.lightsDropped],
      ['voxels', s.occupied.toLocaleString()],
      ['predicted', s.predictions],
      ['mesh jobs', `${s.meshBusy} busy / ${s.meshDispatched} sent`],
      ['stale dropped', s.meshStale],
      ['last build', `${s.meshMs} ms`],
      ['rtt', `${s.ping} ms`],
      ['in-flight', s.inflight],
      ['accepted', s.accepted],
      ['denied', s.denied],
      ['timed out', s.timedOut],
      ['conflicts', s.conflicts],
      ['deltas', `${s.deltas} (${s.deltasVoxels} voxels)`],
      ['adapter', s.adapter],
    ];
    return rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  }

  toggleStats() {
    this.showStats = !this.showStats;
    this.el.stats?.classList.toggle('hidden', !this.showStats);
    // Paint on open rather than waiting for the next frame to hand over the
    // numbers -- otherwise pressing F appears to do nothing.
    if (this.showStats) this._writeStats();
  }

  // -------------------------------------------------------------------------
  // Presence, log, toasts
  // -------------------------------------------------------------------------

  setPresence(builders, bots, selfId) {
    const el = this.el.builders;
    if (!el) return;
    // Contribution is the on-screen half of the audio's stated design goal. The
    // sound tells you who changed the world *near you*; this tells you who has
    // been changing it at all. Counted on the server for players and bots alike
    // and re-sent when it moves, so two people looking at the same panel never
    // see two different numbers for the same fact.
    const badge = (b) => {
      const n = Number.isFinite(b.edits) ? Math.max(0, Math.floor(b.edits)) : 0;
      return `<span class="count" title="${n} edit${n === 1 ? '' : 's'} committed this session">${n}</span>`;
    };
    const rows = [];
    for (const b of builders) {
      const you = b.id === selfId ? ' <em>(you)</em>' : '';
      rows.push(
        `<div class="row${b.id === selfId ? ' me' : ''}">`
        + `<i class="swatch" style="background:${escapeHtml(b.color)}"></i>`
        + `<span>${escapeHtml(b.name)}${you}</span>${badge(b)}</div>`,
      );
    }
    // Bots show what they are working on. Three bots named and coloured like
    // players, with no stated intent, read as idle chatter; three bots visibly
    // pulling on the same shared objective read as collaborators -- and it is the
    // cheapest way to make an otherwise idle world look purposeful.
    for (const b of bots) {
      const intent = b.intent
        ? `<span class="bot-intent">${escapeHtml(b.intent)}</span>`
        : '';
      const role = b.specialism ? `<small>${escapeHtml(b.specialism)}</small>` : '<small>bot</small>';
      rows.push(
        `<div class="row dim"><i class="swatch" style="background:${escapeHtml(b.color)}"></i>`
        + `<span class="bot-body">${escapeHtml(b.name)} ${role}${intent}</span>${badge(b)}</div>`,
      );
    }
    el.innerHTML = rows.join('') || '<div class="row dim">alone in here</div>';
  }

  log(text, kind = '') {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    this.logLines.unshift({ time, text, kind });
    if (this.logLines.length > this.maxLog) this.logLines.pop();
    if (!this.el.log) return;
    this.el.log.innerHTML = this.logLines
      .map((l) => `<div class="row ${l.kind}"><span class="t">${l.time}</span>${escapeHtml(l.text)}</div>`)
      .join('');
  }

  toast(text, kind = '') {
    if (!this.el.toasts) return;
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.textContent = text;
    this.el.toasts.appendChild(node);
    setTimeout(() => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 400);
    }, 2600);
  }

  // -------------------------------------------------------------------------
  // Tool palette
  // -------------------------------------------------------------------------

  /**
   * @param {(entry: object, tool: string) => void} onPick called with the current
   *        selection *and* tool whenever either changes
   * @returns {{tool:string, selection:object, setTool:(t:string)=>void}}
   */
  buildPalette(onPick) {
    let tool = 'build';
    let selected = PALETTES.build[0]?.id ?? 1;

    const render = () => {
      const items = tool === 'decor' ? PALETTES.decor : PALETTES.build;
      const rows = items.map((item) => {
        // The selection is stored as whatever the click set it to -- for blocks that is
        // `btn.dataset.id`, a *string* -- while `item.id` in the palette is a *number*.
        // A plain `===` comparison is therefore false the moment a button is clicked, so
        // the active ring appeared on load and then vanished on first use, leaving the
        // player unable to see which block they had picked. Compare both as strings.
        const chosen = String(item.id) === String(selected);
        if (item.kind === 'block') {
          const hex = `#${MATERIALS[item.id].color.toString(16).padStart(6, '0')}`;
          const glow = item.glow ? ' glow' : '';
          return `<button class="swatch-btn${chosen ? ' active' : ''}${glow}" `
            + `data-id="${item.id}" title="${escapeHtml(item.name)}" `
            + `style="--c:${hex}"></button>`;
        }
        return `<button class="swatch-btn icon${chosen ? ' active' : ''}" `
          + `data-id="${escapeHtml(item.id)}" title="${escapeHtml(item.name)}">`
          + `<i class="fa-solid ${escapeHtml(item.icon)}"></i></button>`;
      });
      if (this.el.palette) this.el.palette.innerHTML = rows.join('');

      this.el.palette?.querySelectorAll('.swatch-btn').forEach((btn) => {
        btn.onclick = () => {
          selected = btn.dataset.id;
          render();
          notify();
        };
      });
    };

    const current = () => {
      const items = tool === 'decor' ? PALETTES.decor : PALETTES.build;
      const found = items.find((i) => String(i.id) === String(selected));
      // Switching tools can leave `selected` pointing at an entry the other
      // palette does not contain, so fall back to the first valid one.
      if (!found) {
        selected = items[0].id;
        return items[0];
      }
      return found;
    };

    /**
     * Report tool and selection together.
     *
     * Both are reported on every change because the caller needs them in sync:
     * keeping `tool` only inside this closure meant a tool button click updated
     * the palette but not the app, so Build and Destroy behaved identically until
     * the keyboard shortcuts were used. One callback carrying both values makes
     * it impossible for the two to disagree.
     */
    const notify = () => onPick(current(), tool);

    /**
     * Switch tool, update the button highlight, and redraw the palette.
     *
     * Declared as a named function *before* the click handlers so they can call
     * it directly. It previously only existed as a method on the returned
     * object, so the handlers referenced an undefined identifier, threw a
     * ReferenceError, and the tool silently never changed.
     */
    function setTool(t) {
      tool = t;
      for (const b of document.querySelectorAll('[data-tool]')) {
        b.classList.toggle('active', b.dataset.tool === t);
      }
      // A tool switch can invalidate the selection (a block id means nothing in
      // the decor palette), so the palette is redrawn from the new tool.
      render();
    }

    for (const btn of document.querySelectorAll('[data-tool]')) {
      btn.onclick = () => {
        setTool(btn.dataset.tool);
        notify();
      };
    }

    render();
    return {
      get tool() { return tool; },
      get selection() { return current(); },
      setTool,
      cycleQuality() {
        return QUALITY_ORDER;
      },
    };
  }

  setQualityLabel(key, label) {
    setText(this.el.qualityText, `Quality: ${label}`);
    if (this.el.qualityText) this.el.qualityText.dataset.key = key;
  }

  setBotsLabel(text) {
    setText(this.el.botsText, text);
  }

  /**
   * Reflect the audio state on the button.
   *
   * The icon carries the state and the accessible name carries it as text, rather
   * than relying on the icon alone -- a crossed-out speaker is a convention, not
   * something a screen reader will announce.
   */
  setAudioLabel(muted) {
    const btn = document.getElementById('btn-audio');
    if (!btn) return;
    const icon = btn.querySelector('i');
    const text = btn.querySelector('span');
    if (icon) {
      icon.className = muted
        ? 'fa-solid fa-volume-xmark'
        : 'fa-solid fa-volume-high';
    }
    if (text) setText(text, muted ? 'Audio off' : 'Audio on');
    btn.classList.toggle('btn-indigo', muted);
    btn.title = muted
      ? 'Audio is muted. Press M or click to unmute.'
      : 'Press M or click to mute.';
    btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export { escapeHtml };