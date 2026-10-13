/**
 * The world-history transport bar.
 *
 * Deliberately dumb. It owns four elements and a callback per interaction, and
 * it holds no notion of what a frame is, what the log contains, or what
 * restoring the world involves -- all of that lives in `main.js` and in the
 * scrubber, because a panel that also understands the simulation is a second
 * place for the two to disagree.
 *
 * The one piece of state it does own is whether *it* is driving the slider.
 * Playback writes a cursor into the range every tick, and a range that is being
 * written while a finger is dragging it is a fight the drag always loses; the
 * `is-playing` class is how the two are told apart, and it is why playback
 * turns the thumb amber -- "this is moving on its own" is information the
 * player needs at a glance.
 */

export class HistoryPanel {
  /**
   * @param {object} cb
   * @param {(index:number) => void} cb.onSeek      the slider moved
   * @param {() => void} cb.onTogglePlay            play / pause
   * @param {() => void} cb.onExit                  back to the present
   */
  constructor({ onSeek, onTogglePlay, onExit }) {
    this.el = document.getElementById('history');
    this.panel = this.el.querySelector('.history-panel');
    this.when = document.getElementById('history-when');
    this.count = document.getElementById('history-count');
    // `playBtn`/`closeBtn`, not `play`/`close`: the latter two are method names
    // on this very class, and an instance field of the same name shadows the
    // method -- which fails only when something calls it, i.e. on the way out.
    this.playBtn = document.getElementById('history-play');
    this.closeBtn = document.getElementById('history-close');
    this.scrub = document.getElementById('history-scrub');

    this.playIcon = this.playBtn.querySelector('i');
    this.playLabel = this.playBtn.querySelector('span');

    // `input` rather than `change`: the whole point of a scrubber is that it
    // moves while you hold it, not that it lands somewhere when you let go.
    this.scrub.addEventListener('input', () => onSeek(Number(this.scrub.value)));
    this.playBtn.addEventListener('click', () => onTogglePlay());
    this.closeBtn.addEventListener('click', () => onExit());

    this.setPlaying(false);
    this.setCursor(0, null, 0);
  }

  get isOpen() { return !this.el.hidden; }

  /**
   * Show the bar, sized to a log.
   *
   * It opens on the newest frame, because a time-lapse that starts silently in
   * the past and waits for you to notice is a time-lapse that reads as a broken
   * game.
   *
   * @param {{length:number}} log
   */
  open({ length }) {
    const empty = length === 0;
    // An empty log is not a failure -- a world nobody has edited yet simply has
    // no history. The bar still opens and still says so, rather than refusing
    // to appear and leaving the player to guess whether the key did anything.
    this.scrub.disabled = empty;
    this.playBtn.disabled = empty;
    this.scrub.max = String(length);
    this.el.hidden = false;
    this.setPlaying(false);
    this.setCursor(length, null, length);
  }

  close() {
    this.el.hidden = true;
    this.setPlaying(false);
  }

  /** @param {boolean} playing */
  setPlaying(playing) {
    this.playing = playing;
    this.panel.classList.toggle('is-playing', playing);
    this.playIcon.className = playing ? 'fa-solid fa-pause' : 'fa-solid fa-play';
    this.playLabel.textContent = playing ? 'Pause' : 'Play';
    this.closeBtn.querySelector('span').textContent = playing ? 'Stop' : 'Present';
  }

  /**
   * Reflect a cursor back into the controls.
   *
   * Writing `value` back into the range is not redundant: playback moves the
   * cursor without the range having been touched, and a slider that claims to
   * be at the present while the world is three minutes old is worse than no
   * slider.
   *
   * @param {number} cursor  index of the next unapplied change
   * @param {string|null} whenLabel  how far back, or null for the present
   * @param {number} length  how many changes the log holds
   */
  setCursor(cursor, whenLabel, length) {
    this.scrub.value = String(cursor);
    this.when.textContent = whenLabel ?? 'the present';
    this.count.textContent = `${cursor} / ${length}`;
  }
}
