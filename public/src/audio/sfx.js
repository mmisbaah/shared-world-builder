/**
 * Procedural sound. No assets, no network, no decoding.
 *
 * Every sound is synthesised from oscillators and one shared noise buffer, which
 * keeps the whole audio system at a few hundred bytes of code and zero bytes of
 * download -- the right trade for a game that is already pushing a world over a
 * socket.
 *
 * Why procedural rather than samples: the useful variation here is *material*,
 * not realism. Driving the timbre off each material's own roughness (see
 * `voice.js`) means stone, brick, gold and glass are audibly different without
 * anyone authoring nine WAV files, and a material added to the catalogue later
 * sounds like itself for free.
 *
 * The decisions about *what* to play and *how loudly* are not here -- they live in
 * `voice.js`, which is pure and testable. This file only turns a decision into
 * sound.
 */

import {
  SFX, materialVoice, rolloff, panFor, AGENT_GAIN, INAUDIBLE,
  AMBIENCE_GAIN,
} from './voice.js';

const NOISE_SECONDS = 2;

/** Master level. Deliberately conservative: this mixes with nothing else. */
const MASTER = 0.55;

/**
 * Time constant for moving between two ambient states, in seconds.
 *
 * Slow on purpose. The camera crosses from shore to open water in a fraction of a
 * second while orbiting, and a bed that followed it immediately would chatter at
 * every shoreline -- a boundary the player did not intend to cross and cannot see.
 * At this constant a full crossfade takes about four seconds, which reads as the
 * world changing around you rather than as the mix jumping.
 */
const AMBIENCE_TAU = 1.8;

export class Sfx {
  /**
   * @param {object} [opts]
   * @param {(x:number,y:number,z:number)=>{x:number,dist:number}} [opts.locator]
   *   Projects a world point into view space for pan and distance. Supplied by
   *   the caller so this file needs no three.js and so the projection can be
   *   swapped in tests.
   */
  constructor(opts = {}) {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.bed = null;
    this.locator = opts.locator ?? null;
    this.muted = false;
    this.available = true;
    this.failure = null;
    this._seq = 0;
    this._ambientGain = null;

    /**
     * Called with a voice id once that voice has actually finished sounding.
     *
     * This exists so a voice budget can count *live* sound rather than sound it
     * hopes is live. Without it a budget tracking ids has nothing to decrement, so
     * its occupancy only ever rises and it degenerates into a lifetime counter that
     * eventually mutes everything.
     *
     * @type {((id:number)=>void)|null}
     */
    this.onVoiceEnd = opts.onVoiceEnd ?? null;
  }

  /**
   * Create or resume the context. Must be called from a user gesture.
   *
   * Browsers will not start an AudioContext without one, and a game cannot
   * quietly wait for a click it never announces, so this is wired to the first
   * pointer/key event rather than to load.
   *
   * Safe to call repeatedly: it is a no-op once running.
   *
   * @returns {Promise<boolean>} whether audio is actually running
   */
  async unlock() {
    if (!this.available) return false;
    try {
      if (!this.ctx) this._create();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this._startBed();
      return this.ctx.state === 'running';
    } catch (err) {
      // A missing or refused AudioContext must never take the game down with it.
      // Audio is an enhancement; silence is a valid outcome.
      this.available = false;
      this.failure = String(err?.message ?? err);
      return false;
    }
  }

  _create() {
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio is not available in this browser');
    this.ctx = new Ctor();

    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER;
    this.master.connect(this.ctx.destination);

    // One noise buffer for the lifetime of the context. Regenerating it per sound
    // is the obvious approach and the wrong one: allocating a few hundred KB
    // during a burst of placements is exactly the kind of thing that shows up as
    // a frame hitch.
    const n = Math.floor(this.ctx.sampleRate * NOISE_SECONDS);
    this.noise = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  }

  /**
   * The ambient bed: one layer per place the camera can be standing.
   *
   * All three read the *same* noise buffer through different filters, which is what
   * makes them distinguishable without authoring a single audio asset: wind is a low
   * drone, surf is a band with real high content in it, and open water sits between
   * the two with neither the wind's top end nor the surf's bite.
   *
   * They start silent and are raised by {@link setAmbience}, except wind, which fades
   * in on its own so a caller that never reports a position still gets a floor
   * instead of silence. Silence reads as "the game is broken", not as "the world is
   * quiet".
   */
  _startBed() {
    if (this.bed) return;
    const c = this.ctx;

    const spec = {
      wind: { type: 'lowpass', freq: 340, q: 0.6, driftHz: 0.06, drift: 120 },
      // Bandpass, not lowpass: the surf is the one layer with audible top end, and
      // that is exactly how you tell shore from land without looking.
      surf: { type: 'bandpass', freq: 640, q: 1.1, driftHz: 0.05, drift: 300 },
      water: { type: 'lowpass', freq: 190, q: 0.7, driftHz: 0.04, drift: 60 },
    };

    const bed = { layers: {}, nodes: [] };

    for (const [name, s] of Object.entries(spec)) {
      const src = c.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;

      const filter = c.createBiquadFilter();
      filter.type = s.type;
      filter.frequency.value = s.freq;
      filter.Q.value = s.q;

      // The level {@link setAmbience} moves. Held apart from the node that holds the
      // swell so the two automations never fight over one AudioParam.
      const target = c.createGain();
      target.gain.value = 0.0001;

      src.connect(filter).connect(target);

      if (name === 'surf') {
        // Waves arrive and leave. A surf layer held at constant level reads as hiss
        // rather than as a shore, and it is the swell rather than the filter that
        // makes it recognisable as water moving.
        const swell = c.createGain();
        swell.gain.value = 0.7;
        const wave = c.createOscillator();
        wave.frequency.value = 0.11;
        const depth = c.createGain();
        depth.gain.value = 0.3;
        wave.connect(depth).connect(swell.gain);
        wave.start();
        bed.nodes.push(wave);
        target.connect(swell).connect(this.master);
        bed.layers[name] = { filter, target, swell };
      } else {
        target.connect(this.master);
        bed.layers[name] = { filter, target, swell: null };
      }

      // Slow drift on the cutoff so the bed never sits perfectly still. A frozen
      // noise bed is surprisingly audible as an artefact -- it reads as a hum.
      const lfo = c.createOscillator();
      lfo.frequency.value = s.driftHz;
      const lfoGain = c.createGain();
      lfoGain.gain.value = s.drift;
      lfo.connect(lfoGain).connect(filter.frequency);

      src.start();
      lfo.start();
      bed.nodes.push(src, lfo);
    }

    this.bed = bed;
    this._ambientGain = bed.layers.wind.target.gain;

    // setTargetAtTime rather than a ramp, because setAmbience also uses it and the
    // two must compose: a later target takes over smoothly from wherever the fade
    // happens to be, where a ramp scheduled to run for two more seconds would keep
    // pushing against it.
    bed.layers.wind.target.gain.setTargetAtTime(AMBIENCE_GAIN.wind, c.currentTime, 1.0);
  }

  /**
   * Move the bed to whatever is under the camera.
   *
   * Called by the frame loop every few hundred milliseconds with the mix computed by
   * `voice.ambienceFor`. Missing keys fall back to that layer's nominal level rather
   * than to silence, so a partial mix cannot accidentally mute the bed -- the failure
   * mode there is subtle enough that it would look like the audio had simply stopped
   * and be very hard to find.
   *
   * @param {{wind?:number, surf?:number, water?:number}} [mix]
   * @returns {boolean} false when there is no bed to move (audio not unlocked)
   */
  setAmbience(mix) {
    if (!this.bed || !this.ctx) return false;
    const t = this.ctx.currentTime;
    for (const [name, layer] of Object.entries(this.bed.layers)) {
      const raw = Number.isFinite(mix?.[name]) ? mix[name] : AMBIENCE_GAIN[name];
      // Zero is not a usable target: an exponential approach to true zero is
      // undefined in Web Audio, and it would make the next move start from a
      // denormal. 0.0001 is far below hearing and has the same effect.
      layer.target.gain.setTargetAtTime(Math.max(0.0001, raw), t, AMBIENCE_TAU);
    }
    return true;
  }

  /** Duck the bed while muted without tearing it down and rebuilding it. */
  setMuted(muted) {
    this.muted = !!muted;
    if (this.master && this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), t);
      this.master.gain.exponentialRampToValueAtTime(this.muted ? 0.0001 : MASTER, t + 0.12);
    }
    return this.muted;
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running' && !this.muted;
  }

  // -------------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------------

  /**
   * Percussive envelope.
   *
   * Exponential ramps are used because a linear one sounds mechanical on a
   * percussive hit, but an exponential ramp cannot reach zero -- the curve is
   * undefined there and Web Audio throws. 0.0001 is far below hearing and is the
   * conventional stand-in.
   */
  _env(t, peak, attack, decay) {
    const g = this.ctx.createGain();
    const p = Math.max(0.0002, peak);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(p, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  /** A single tone with a percussive envelope. */
  _tone(t, { freq, type = 'sine', peak, attack = 0.004, decay = 0.12, detune = 0 }) {
    const c = this.ctx;
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const g = this._env(t, peak, attack, decay);
    osc.connect(g);
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
    return { osc, g, end: t + attack + decay + 0.05 };
  }

  /** A filtered noise burst: the impact transient. */
  _noise(t, { freq, q = 1, peak, attack = 0.002, decay = 0.08, type = 'lowpass' }) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    // Randomised read offset so repeated hits are not bit-identical. Without this
    // a run of placements sounds like a machine gun playing the same sample.
    const offset = Math.random() * (NOISE_SECONDS - 0.5);

    const filter = c.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;

    const g = this._env(t, peak, attack, decay);
    src.connect(filter).connect(g);
    src.start(t, offset, attack + decay + 0.05);
    return { src, g, end: t + attack + decay + 0.05 };
  }

  /** Route a set of voices into a panner and release it when the last one ends. */
  _emit(voices, pan) {
    const c = this.ctx;
    let panner = null;
    let sink = this.master;

    if (pan !== 0) {
      panner = c.createStereoPanner();
      panner.pan.value = pan;
      panner.connect(this.master);
      sink = panner;
    }

    let last = 0;
    for (const v of voices) {
      v.g.connect(sink);
      if (v.end > last) last = v.end;
    }

    // Explicit teardown. Nodes are garbage collected once they finish and become
    // unreachable, but holding them until then is what turns a long session into
    // a slow leak, so it is worth doing deliberately.
    const stopAt = last;
    const id = ++this._seq;
    const timer = setTimeout(() => {
      for (const v of voices) {
        try { v.osc?.stop(); } catch { /* already stopped */ }
        try { v.osc?.disconnect(); } catch { /* already disconnected */ }
        try { v.g.disconnect(); } catch { /* already disconnected */ }
      }
      try { panner?.disconnect(); } catch { /* already disconnected */ }
      this._timers?.delete(timer);
      try { this.onVoiceEnd?.(id); } catch { /* a budget must not break audio */ }
    }, Math.max(0, (stopAt - c.currentTime) * 1000) + 60);

    // Tracked so dispose() can clear them. An untracked setTimeout in a module
    // that creates several per second will keep the whole context alive past the
    // point where it should be gone.
    this._timers = this._timers ?? new Set();
    this._timers.add(timer);

    return id;
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------

  /**
   * A block landing.
   *
   * Three layers, each doing one job: a low thud for mass, a filtered noise
   * transient for contact, and a pitched ring for the material itself. The mix
   * between them comes from roughness, so this single function covers nine
   * materials without a switch.
   */
  _place(t, { mat, gain, pan, detune = 0, pitch = 1, decayScale = 1 }) {
    const v = materialVoice(mat);
    const decay = v.decay * decayScale;
    const voices = [];

    // Mass: the low thud. Scaled down for smooth materials, which have no body.
    voices.push(this._tone(t, {
      freq: (v.freq * 0.5) * pitch,
      type: 'sine',
      peak: gain * 0.5 * (1 - v.ring * 0.5),
      attack: 0.003,
      decay: decay * 0.7,
      detune,
    }));

    // Contact: broadband noise through a lowpass at the material's own frequency.
    voices.push(this._noise(t, {
      freq: v.freq * 3 * pitch,
      q: 1.2,
      peak: gain * v.noise * 0.42,
      decay: 0.05 * decayScale,
    }));

    // Ring: the pitched tail. Small but present -- this is the layer that makes
    // gold sound like metal rather than like a louder stone.
    if (v.ring > 0.15) {
      voices.push(this._tone(t, {
        freq: v.freq * 2 * pitch,
        type: v.tone,
        peak: gain * v.ring * 0.3,
        attack: 0.002,
        decay,
        detune,
      }));
    }

    return this._emit(voices, pan);
  }

  /** A removal reads as a downward gesture: lower, shorter, no contact ring. */
  _remove(t, { mat, gain, pan, detune = 0, pitch = 1 }) {
    return this._place(t, {
      mat, gain: gain * 0.82, pan, detune,
      pitch: pitch * 0.82,
      decayScale: 0.55,
    });
  }

  /** A prop set down: lighter and more resonant, because props are small. */
  _prop(t, { gain, pan, detune = 0, pitch = 1 }) {
    const voices = [
      this._noise(t, { freq: 2600 * pitch, q: 0.9, peak: gain * 0.14, decay: 0.035 }),
      this._tone(t, {
        freq: 880 * pitch, type: 'triangle', peak: gain * 0.2,
        attack: 0.003, decay: 0.34, detune,
      }),
      this._tone(t, {
        freq: 1320 * pitch, type: 'sine', peak: gain * 0.11,
        attack: 0.003, decay: 0.2, detune,
      }),
    ];
    return this._emit(voices, pan);
  }

  /**
   * The server said no.
   *
   * Low, short and unpleasant, but *quiet*. A refusal is informational; the player
   * has other feedback for it and needs to keep hearing the world. Making it
   * louder than a successful placement would invert the priority.
   */
  _deny(t, { gain, pan }) {
    const voices = [
      this._tone(t, { freq: 148, type: 'square', peak: gain * 0.16, attack: 0.004, decay: 0.1 }),
      this._tone(t, { freq: 155, type: 'square', peak: gain * 0.13, attack: 0.004, decay: 0.1 }),
    ];
    return this._emit(voices, pan);
  }

  /**
   * Losing a race.
   *
   * A falling minor second. It is the only sound allowed to be startling, because
   * it is the only one that reports something you did not do: somebody else took
   * the cell you were pointing at. It resolves downward rather than upward so it
   * cannot be confused with the objective chime, which also falls.
   */
  _conflict(t, { gain, pan }) {
    const voices = [
      this._tone(t, { freq: 520, type: 'sawtooth', peak: gain * 0.14, attack: 0.002, decay: 0.16 }),
      this._tone(t + 0.055, { freq: 466, type: 'sawtooth', peak: gain * 0.15, attack: 0.002, decay: 0.24 }),
      this._noise(t, { freq: 1500, q: 0.7, peak: gain * 0.1, decay: 0.09, type: 'bandpass' }),
    ];
    return this._emit(voices, pan);
  }

  /**
   * An objective completed.
   *
   * Four notes up a major triad, bell-like, and long. It has to be the most
   * rewarding sound in the set and it has to be unmistakable -- it is the only
   * one triggered by something the player did not do directly, so it needs its
   * own register rather than a louder version of a placement.
   */
  _objective(t, { gain, pan = 0 }) {
    const root = 523.25; // C5
    const steps = [0, 4, 7, 12];
    const voices = [];
    steps.forEach((semi, i) => {
      const f = root * Math.pow(2, semi / 12);
      voices.push(this._tone(t + i * 0.085, {
        freq: f, type: 'sine', peak: gain * 0.17, attack: 0.006, decay: 0.9,
      }));
      voices.push(this._tone(t + i * 0.085, {
        freq: f * 2, type: 'triangle', peak: gain * 0.06, attack: 0.006, decay: 0.5,
      }));
    });
    return this._emit(voices, pan);
  }

  /**
   * The scripted campaign is over.
   *
   * Deliberately not a louder `_objective`. That plays a four-note arpeggio,
   * which reads as a *step* -- right for a rolling goal that will happen many
   * more times, wrong for the one boundary the whole ladder builds toward. This
   * resolves instead: a bass note held under the entire figure so the first beat
   * lands as a chord rather than as a tempo, and a long decay so the last note
   * has somewhere to go. It is the only voice in the game that is not reporting
   * something a builder just did.
   */
  _victory(t, { gain, pan = 0 }) {
    const root = 523.25; // C5
    // C5 E5 G5 C6 G5 C6 -- arches back through the fifth before the octave, so
    // the ending sits on the tonic twice instead of simply running out of notes.
    const steps = [0, 4, 7, 12, 7, 12];
    const voices = [];
    voices.push(this._tone(t, {
      freq: root / 2, type: 'sine', peak: gain * 0.10, attack: 0.02, decay: 2.0,
    }));
    steps.forEach((semi, i) => {
      const f = root * Math.pow(2, semi / 12);
      voices.push(this._tone(t + i * 0.115, {
        freq: f, type: 'sine', peak: gain * 0.16, attack: 0.006, decay: 1.0,
      }));
      voices.push(this._tone(t + i * 0.115, {
        freq: f * 2, type: 'triangle', peak: gain * 0.055, attack: 0.006, decay: 0.6,
      }));
    });
    return this._emit(voices, pan);
  }

  _ui(t, { gain = 0.5, pitch = 1 }) {
    return this._emit([
      this._tone(t, { freq: 660 * pitch, type: 'sine', peak: gain * 0.09, attack: 0.002, decay: 0.06 }),
    ], 0);
  }

  _ready(t, { gain = 0.6 }) {
    return this._emit([
      this._tone(t, { freq: 392, type: 'sine', peak: gain * 0.12, attack: 0.01, decay: 0.5 }),
      this._tone(t + 0.1, { freq: 587, type: 'sine', peak: gain * 0.11, attack: 0.01, decay: 0.6 }),
    ], 0);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Play a world event.
   *
   * @param {string} name an SFX value
   * @param {object} [o]
   * @param {number} [o.x] world x
   * @param {number} [o.y] world y
   * @param {number} [o.z] world z
   * @param {number} [o.mat] material id, for place/remove
   * @param {'self'|'human'|'bot'} [o.who]
   * @param {number} [o.gain] override the computed level
   * @returns {number|null} the voice id, so the caller can track it, or null if
   *   nothing sounded
   */
  play(name, o = {}) {
    if (!this.running) return null;
    const c = this.ctx;
    const t = c.currentTime + 0.001;

    // ---- spatial and level ------------------------------------------------
    let gain = o.gain ?? 1;
    let pan = 0;
    let pitch = 1;

    if (this.locator && Number.isFinite(o.x)) {
      const p = this.locator(o.x, o.y ?? 0, o.z ?? 0);
      const who = o.who ?? 'self';
      gain *= AGENT_GAIN[who] ?? 1;
      gain *= rolloff(p.dist);
      // Panning is what carries attribution, so it is applied even when the gain
      // is low -- but a sound too quiet to hear does not need the headroom.
      if (gain < INAUDIBLE) return null;
      pan = panFor(p.x);
      // Bots sit a fifth down, which reads as "further off" without changing gain.
      if (who === 'bot') pitch *= Math.pow(2, -0.5);
    }

    switch (name) {
      case SFX.PLACE:
      case SFX.PLACE_REMOTE:
        return this._place(t, { mat: o.mat ?? 1, gain, pan, detune: this._detune(o) });
      case SFX.REMOVE:
      case SFX.REMOVE_REMOTE:
        return this._remove(t, { mat: o.mat ?? 1, gain, pan, detune: this._detune(o) });
      case SFX.PROP:
      case SFX.PROP_REMOTE:
        return this._prop(t, { gain, pan, detune: this._detune(o), pitch });
      case SFX.DENY:
        return this._deny(t, { gain, pan });
      case SFX.CONFLICT:
        return this._conflict(t, { gain, pan });
      case SFX.OBJECTIVE:
        return this._objective(t, { gain });
      case SFX.VICTORY:
        return this._victory(t, { gain });
      case SFX.UI:
        return this._ui(t, { gain, pitch });
      case SFX.READY:
        return this._ready(t, { gain });
      default:
        return null;
    }
  }

  /** Remote voices are detuned slightly so they are not mistaken for your own. */
  _detune(o) {
    return (o.who ?? 'self') === 'self' ? 0 : 3;
  }

  /**
   * Insert an analyser after the master bus, for measurement.
   *
   * Verification-only, and opt-in, because it is the one thing in this file that
   * costs per-sample work on every voice for no benefit to a player. But it is the
   * difference between "the graph is wired up" and "sound is coming out": without
   * it the only way to know a sound played is to listen, and a headless environment
   * cannot do that. Reading the time-domain buffer back gives a real RMS.
   *
   * @returns {AnalyserNode|null}
   */
  tap() {
    if (!this.ctx || !this.master) return null;
    if (this.analyser) return this.analyser;
    const a = this.ctx.createAnalyser();
    a.fftSize = 2048;
    this.master.connect(a);
    this.analyser = a;
    this._probe = new Float32Array(a.fftSize);
    return a;
  }

  /**
   * Peak amplitude of the master bus over the analysis window.
   *
   * @returns {number} 0..1, where 0 means genuinely silent
   */
  level() {
    const a = this.tap();
    if (!a) return 0;
    a.getFloatTimeDomainData(this._probe);
    let peak = 0;
    for (let i = 0; i < this._probe.length; i++) {
      const v = Math.abs(this._probe[i]);
      if (v > peak) peak = v;
    }
    return peak;
  }

  /** Release the bed and everything else. */
  dispose() {
    if (this.bed) {
      const t = this.ctx.currentTime;
      // Every source and oscillator is stopped together rather than one at a time:
      // three layers means six or seven nodes now, and stopping them individually
      // inside one try block would let a single already-stopped node abandon the rest.
      for (const layer of Object.values(this.bed.layers)) {
        try {
          layer.target.gain.cancelScheduledValues(t);
          layer.target.gain.setTargetAtTime(0.0001, t, 0.03);
        } catch { /* already stopped */ }
      }
      for (const node of this.bed.nodes) {
        try { node.stop(t + 0.15); } catch { /* already stopped */ }
        try { node.disconnect(); } catch { /* already disconnected */ }
      }
      this.bed = null;
      this._ambientGain = null;
    }
    for (const timer of this._timers ?? []) clearTimeout(timer);
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null;
  }
}

export { SFX };
