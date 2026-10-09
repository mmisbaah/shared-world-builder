/**
 * Audio decision layer: pure, dependency-free, and therefore testable.
 *
 * Everything here answers a *question* -- which sound, how loud, panned where,
 * or dropped entirely -- and nothing here touches Web Audio. The synthesis lives
 * in `sfx.js`. The split exists so the part that is easy to get wrong can be
 * checked: an oscillator graph is hard to assert on, but "a bot placing a block
 * 60 units away is dropped because it would be inaudible" is a one-line test.
 *
 * The design goal is attribution. In a co-op builder the single most useful thing
 * audio can tell you is *who just changed the world near me*. So a remote edit is
 * not a quieter copy of a local one, it is a different sound: panned to where the
 * edit happened, attenuated by distance, and detuned a few cents so it reads as a
 * different voice in the same key rather than as the same event played quieter.
 */

import { MATERIALS, isWaterMaterial } from '../../../shared/materials.js';
import { PALM_MAX_GROUND } from '../../../shared/atoll.js';
import { WORLD } from '../../../shared/protocol.js';

/** Every sound the game can make. */
export const SFX = {
  /** My own block landed. */
  PLACE: 'place',
  /** Somebody else's block landed, panned and attenuated. */
  PLACE_REMOTE: 'placeRemote',
  /** My own removal. */
  REMOVE: 'remove',
  /** Somebody else's removal. */
  REMOVE_REMOTE: 'removeRemote',
  /** A prop set down: lighter, more resonant than a block. */
  PROP: 'prop',
  PROP_REMOTE: 'propRemote',
  /** The server refused. Deliberately unpleasant but quiet. */
  DENY: 'deny',
  /** I lost a race to another builder. Urgent, because it is a surprise. */
  CONFLICT: 'conflict',
  /** A shared objective completed. */
  OBJECTIVE: 'objective',
  /** The scripted campaign is over. Longer and more resolved than OBJECTIVE. */
  VICTORY: 'victory',
  /** Interface feedback. */
  UI: 'ui',
  /** The world finished loading. */
  READY: 'ready',
};

/**
 * Convert a material into a voice.
 *
 * Driven by the material's own `roughness` rather than a hand-written table, so a
 * material added later still sounds like itself. Rough surfaces (brick 0.92,
 * stone 0.85) are dull and noisy; smooth ones (glass 0.08, neon 0.25) ring.
 * Roughness already controls how the material looks under specular light, so
 * reusing it means the sound cannot disagree with the surface.
 *
 * @param {number} mat material id
 * @returns {{freq:number, ring:number, noise:number, decay:number, tone:number}}
 */
export function materialVoice(mat) {
  const m = MATERIALS[mat];
  const rough = m ? m.roughness : 0.8;

  // Rougher -> lower and more damped. The exponent keeps mid-range materials
  // (wood 0.7, slate 0.8) clearly distinct instead of all sounding like stone.
  const freq = 620 * Math.pow(1 - rough, 1.35) + 120;

  // How much pitched ring sits on top of the transient.
  const ring = Math.pow(1 - rough, 1.6);

  // How much broadband noise the impact makes. Rough things thud, smooth things
  // click, so this rises with roughness.
  const noise = 0.25 + rough * 0.6;

  // Damping time. A glass block rings for a long time; a brick block does not.
  const decay = 0.07 + ring * 0.5;

  // Body: sine at the fundamental reads as "mass", triangle as "structure".
  const tone = ring > 0.55 ? 'triangle' : 'sine';

  return { freq: Math.round(freq), ring, noise, decay: Math.round(decay * 1000) / 1000, tone };
}

/**
 * Distance attenuation.
 *
 * Inverse-square over a reference distance, because that is the only falloff that
 * makes a lamp across the plaza read as *across* the plaza rather than as
 * immediately next to you. A linear ramp makes everything sound equidistant,
 * which throws away the position cue the whole design rests on.
 *
 * @param {number} dist world units
 * @returns {number} linear gain multiplier, 1 at zero distance
 */
export function rolloff(dist) {
  const d = Math.max(0, dist);
  const ref = 16;
  return 1 / (1 + (d / ref) * (d / ref));
}

/**
 * Below this gain a sound is dropped rather than played.
 *
 * Not only a saving: a dozen inaudible voices still cost scheduling and headroom,
 * and because bots commit every second or so, the tail of a long decay is most of
 * the voices that would otherwise be live. Cutting them is honest -- they could
 * not be heard anyway.
 */
export const INAUDIBLE = 0.012;

/**
 * Stereo position for a world point, from -1 (left) to +1 (right).
 *
 * Returned by the caller as the view-space X divided by a reference distance.
 * Keeping this pure means the projection can be tested with plain numbers rather
 * than a camera, and it keeps this module free of a three.js dependency.
 *
 * @param {number} viewX metres to the right of the camera axis
 * @returns {number}
 */
export function panFor(viewX) {
  return Math.max(-1, Math.min(1, viewX / 12));
}

/**
 * Volume ceiling by who made the edit.
 *
 * Bots commit roughly once a second each. Four bots at full volume is a machine
 * gun, and it drowns the one thing audio is here to say: *your* edit landed
 * there. Remote humans are attenuated too, but much less aggressively, so a
 * friend building next to you stays clearly present.
 */
export const AGENT_GAIN = {
  self: 1.0,
  human: 0.62,
  bot: 0.24,
};

/**
 * The total number of voices allowed to sound at once.
 *
 * Chosen to cover a burst of your own edits (say 4 in half a second) plus the
 * remote activity you would actually want to hear, while still bounding the worst
 * case: four bots, each with a 0.6 s ring, is a ceiling the budget has to survive
 * without turning into mush.
 */
export const MAX_VOICES = 14;

/**
 * Per-sound minimum interval in ms.
 *
 * Two mechanisms, because they solve different problems. The *budget* bounds how
 * many sound at once; the cooldown bounds how fast one type can retrigger, which
 * is what stops a single long ring from being cut into a buzz when its tail is
 * still audible. Remote sounds are held longer than your own, because a burst of
 * remote activity is background and should never mask the foreground.
 */
export const COOLDOWN_MS = {
  self: 40,
  human: 90,
  bot: 220,
};

/**
 * Which sound plays for an edit.
 *
 * @param {'place'|'remove'|'prop'} kind
 * @param {boolean} mine
 * @returns {string} an SFX value
 */
export function editSound(kind, mine) {
  if (kind === 'remove') return mine ? SFX.REMOVE : SFX.REMOVE_REMOTE;
  if (kind === 'prop') return mine ? SFX.PROP : SFX.PROP_REMOTE;
  return mine ? SFX.PLACE : SFX.PLACE_REMOTE;
}

/**
 * A remote voice is detuned so it is recognisably not yours.
 *
 * Three cents is not a tuning choice, it is an identity choice: it is far below
 * the threshold anyone would notice as "wrong", but it decorrelates the two
 * waveforms enough that a dozen of them do not fuse into a single drone.
 */
export const REMOTE_DETUNE_CENTS = 3;

/**
 * How many semitones a bot's voice sits below your own.
 *
 * Bots are present but subordinate. Dropping them a fifth reads as "further
 * away in the room" even when they are not, which is exactly the impression you
 * want from something working steadily in its own district.
 */
export const BOT_OCTAVE_SHIFT = -0.5;

/**
 * Ambient bed layers, and how loud each one is at full presence.
 *
 * The bed used to be one low-passed noise floor that never changed, so standing on
 * a beach and standing in the lagoon sounded identical. The world is an atoll --
 * shore, open water, dry crown -- and being able to tell where you are by ear is
 * most of what makes ambient sound worth having.
 *
 * These are deliberately tiny. The bed sits under everything else in the mix and is
 * never meant to be listened to directly; it is the floor that stops silence
 * reading as "the audio broke".
 */
export const AMBIENCE_GAIN = {
  /** Wind over land and anything built. The default and the fallback. */
  wind: 0.016,
  /** Waves on the shore. The most present of the three, because it is the most events. */
  surf: 0.024,
  /** Open water: lower and softer than wind, no high content to fatigue on. */
  water: 0.013,
};

/** Layer names, in the order the synth builds them. */
export const AMBIENCE = Object.keys(AMBIENCE_GAIN);

/**
 * Which ambient layers should be audible under a given surface.
 *
 * Answers with absolute gains rather than a 0..1 mix so the caller never has to
 * know how loud "surf" is -- the level lives here next to the reasoning for it.
 *
 * Three cases, and they are meant to be mutually exclusive so the bed crossfades
 * between two states rather than smearing across all three:
 *
 * - **water** -- the top voxel is water, reef or coral, i.e. the camera is over the
 *   lagoon or the ocean. Wind is dropped entirely: there is nothing up here to blow
 *   across, and keeping it would make open water sound like a windy hill.
 * - **shore** -- wet sand, or bare sand at or below `PALM_MAX_GROUND`. That constant
 *   is the generator's own beach/crown split, so the ear and the terrain agree about
 *   where the beach ends instead of drifting apart with a second magic number.
 * - **land** -- everything else, including every material a player has built with.
 *
 * @param {number} mat top-most material id at the sampled column, 0 for air/unknown
 * @param {number} y its height
 * @returns {{wind:number, surf:number, water:number}}
 */
export function ambienceFor(mat, y) {
  const key = MATERIALS[mat]?.key;

  if (isWaterMaterial(mat) || key === 'reef' || key === 'coral') {
    return { wind: 0, surf: 0, water: AMBIENCE_GAIN.water };
  }

  // `sand_wet` is the generator's waterline band; bare `sand` above the palm line is
  // the dry crown, which is why height is part of the test and not just the material.
  const shore = key === 'sand_wet'
    || (key === 'sand' && Number.isFinite(y) && y <= PALM_MAX_GROUND);

  if (shore) {
    return {
      wind: AMBIENCE_GAIN.wind * 0.35,
      surf: AMBIENCE_GAIN.surf,
      water: 0,
    };
  }

  return { wind: AMBIENCE_GAIN.wind, surf: 0, water: 0 };
}

/**
 * Top-most non-air voxel of a column, scanning down.
 *
 * Only the surface matters to the ambience, and one column is at most `MAX_Y`
 * reads against a per-column array -- cheap enough to do a few times a second and
 * far too expensive to do per frame for a value that changes a few times a minute.
 *
 * Takes the read function rather than a world so it stays pure, and so a test can
 * feed it a stub instead of standing up chunk storage. Out-of-range and unloaded
 * columns read as air, so sampling off the edge of the world falls through to the
 * default rather than throwing inside the frame loop.
 *
 * @param {(x:number,y:number,z:number)=>number} getVoxel
 * @param {number} x
 * @param {number} z
 * @param {number} [maxY] exclusive upper bound, `WORLD.MAX_Y`
 * @returns {{mat:number, y:number}} `{mat: 0, y: 0}` when the column is empty
 */
export function surfaceUnder(getVoxel, x, z, maxY = WORLD.MAX_Y) {
  for (let y = maxY - 1; y >= 0; y--) {
    const mat = getVoxel(x, y, z);
    if (mat) return { mat, y };
  }
  return { mat: 0, y: 0 };
}

/**
 * Track live voices and decide what may sound.
 *
 * `release` is called by the owner when a voice ends, so the count reflects
 * actual sound rather than an optimistic guess -- which matters, because a budget
 * that over-reports drops voices that were about to fall silent anyway.
 */
export class VoiceBudget {
  constructor(max = MAX_VOICES) {
    this.max = max;
    this.live = new Set();
    this.lastAt = new Map();
    this.dropped = 0;
    this.played = 0;
    this._seq = 0;
  }

  /**
   * Ask whether a sound may play now.
   *
   * Order matters: the cooldown is checked first because it is the cheaper test
   * and the more common rejection. A rejected cooldown still counts as "handled",
   * so this returns false rather than a third outcome.
   *
   * Prefer {@link VoiceBudget#tryStart}, which pairs this with the registration.
   *
   * @param {string} name
   * @param {'self'|'human'|'bot'} who
   * @param {number} now ms
   * @returns {boolean}
   */
  allow(name, who, now) {
    const cooldown = COOLDOWN_MS[who] ?? COOLDOWN_MS.human;
    const last = this.lastAt.get(name);
    if (last !== undefined && now - last < cooldown) return false;

    if (this.live.size >= this.max) {
      this.dropped++;
      return false;
    }

    this.lastAt.set(name, now);
    this.played++;
    return true;
  }

  /**
   * Gate and register in one step.
   *
   * `allow()` followed by a separate `start()` is a two-step protocol with a real
   * footgun in it: a caller that passes the gate and forgets to register leaves the
   * live count understated, so the ceiling stops applying and the mix quietly gets
   * busier and busier. Worse, the bug is invisible until the mix sounds wrong,
   * because a smaller live count is indistinguishable from quiet.
   *
   * So the common path is a single call. `id` is what gets handed to `release`,
   * and it is also what {@link Sfx} reports back through `onVoiceEnd`.
   *
   * @param {string} name
   * @param {'self'|'human'|'bot'} who
   * @param {number} now ms
   * @returns {string|null} the voice id, or null if it was refused
   */
  tryStart(name, who, now) {
    if (!this.allow(name, who, now)) return null;
    const id = `${name}#${++this._seq}`;
    this.live.add(id);
    return id;
  }

  /** Register a starting voice. Only for callers not using {@link tryStart}. */
  start(id) {
    this.live.add(id);
  }

  /** Retire a finished voice. Ignores an unknown id. */
  release(id) {
    this.live.delete(id);
  }

  /** Forget cooldowns, e.g. after a long silence so the next sound is instant. */
  reset() {
    this.lastAt.clear();
  }

  stats() {
    return { live: this.live.size, max: this.max, played: this.played, dropped: this.dropped };
  }
}