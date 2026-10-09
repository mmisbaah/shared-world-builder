/**
 * Audio decisions.
 *
 * Only `voice.js` is tested here. That is deliberate and it is the whole point of
 * the split: an oscillator graph cannot be asserted on -- you can count nodes and
 * read back a buffer, but neither tells you whether the mix is *right*. What can be
 * asserted, and what actually breaks, is the decision layer underneath: which sound
 * is chosen, how loud something is, whether it is dropped at all.
 *
 * Every test below is a real failure mode that has been fixed in this codebase or
 * would be found by playing the game, not a coverage exercise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SFX, materialVoice, rolloff, panFor, editSound, VoiceBudget,
  AGENT_GAIN, INAUDIBLE, COOLDOWN_MS, MAX_VOICES, REMOTE_DETUNE_CENTS,
  ambienceFor, surfaceUnder, AMBIENCE_GAIN, AMBIENCE,
} from '../public/src/audio/voice.js';
import { MATERIALS } from '../shared/materials.js';
import { PALM_MAX_GROUND } from '../shared/atoll.js';

// ---------------------------------------------------------------------------
// materialVoice: the timbre of a material
// ---------------------------------------------------------------------------

test('every material produces a usable voice', () => {
  // A material with no voice means silence when you build with it, which reads as
  // broken audio rather than as a missing sound.
  for (const m of Object.values(MATERIALS)) {
    const v = materialVoice(m.id);
    assert.ok(Number.isFinite(v.freq) && v.freq > 0, `${m.name} has no frequency`);
    assert.ok(v.decay > 0, `${m.name} has no decay`);
    assert.ok(v.noise > 0 && v.noise < 2, `${m.name} noise out of range`);
    assert.ok(['sine', 'triangle'].includes(v.tone), `${m.name} has an unplayable wave`);
  }
});

test('an unknown material still yields a voice', () => {
  // Materials arrive from the wire. A future server sending id 42 must not silence
  // the client, and must not throw inside the frame loop either.
  for (const id of [0, 99, -1, NaN, undefined, null]) {
    const v = materialVoice(id);
    assert.ok(Number.isFinite(v.freq) && v.freq > 0, `id ${id} produced no voice`);
  }
});

test('rougher materials are lower and quieter than smooth ones', () => {
  // This is the mapping that makes the sound agree with the surface under
  // specular light. If it inverts, brick rings like glass and reads as wrong.
  const glass = materialVoice(9); // Cyan Glass, roughness 0.08
  const slate = materialVoice(7); // Dark Slate, roughness 0.80
  const brick = materialVoice(2); // Red Brick, roughness 0.92

  assert.ok(glass.freq > slate.freq, 'glass rings higher than slate');
  assert.ok(slate.freq > brick.freq, 'slate rings higher than brick');

  assert.ok(glass.ring > brick.ring, 'glass rings longer than brick');
  assert.ok(brick.noise > glass.noise, 'brick makes more noise than glass');
  assert.ok(glass.decay > brick.decay, 'glass decays slower than brick');
});

test('the material ordering by roughness is strictly monotonic', () => {
  // Guards against the mapping being reshuffled into something non-monotonic by a
  // later tweak, which would be invisible in any single comparison.
  const byRough = Object.values(MATERIALS)
    .slice()
    .sort((a, b) => a.roughness - b.roughness);

  let prev = materialVoice(byRough[0].id);
  for (let i = 1; i < byRough.length; i++) {
    const v = materialVoice(byRough[i].id);
    assert.ok(v.freq <= prev.freq, `frequency rose from ${byRough[i - 1].name} to ${byRough[i].name}`);
    prev = v;
  }
});

// ---------------------------------------------------------------------------
// rolloff: distance
// ---------------------------------------------------------------------------

test('gain falls with distance and is highest at the source', () => {
  let prev = rolloff(0);
  for (const d of [1, 4, 8, 16, 32, 64, 128]) {
    const g = rolloff(d);
    assert.ok(g < prev, `gain should fall by ${d} units`);
    assert.ok(g > 0, 'gain must stay positive or distant edits vanish entirely');
    prev = g;
  }
});

test('rolloff never returns a gain above 1', () => {
  // A gain above 1 would make a nearby edit louder than the player, which inverts
  // the priority the whole mix is built around.
  for (const d of [0, 0.001, 1, 10, 100]) {
    assert.ok(rolloff(d) <= 1, `gain exceeded 1 at ${d}`);
  }
});

test('rolloff is stable for a negative distance', () => {
  // Not expected to happen, but a NaN here would silently zero every remote sound
  // and it costs one assertion to make the function total.
  assert.ok(Number.isFinite(rolloff(-5)));
  assert.equal(rolloff(-5), rolloff(0));
});

test('a bot one plaza away is audible but well below the player', () => {
  // The practical statement of the design: you hear the bots working, but they
  // never compete with your own edit.
  const botNear = AGENT_GAIN.bot * rolloff(16);
  const player = AGENT_GAIN.self * rolloff(0);
  assert.ok(botNear > INAUDIBLE, 'bots in the plaza should still be heard');
  assert.ok(botNear < player * 0.4, 'and clearly subordinate to the player');
});

// ---------------------------------------------------------------------------
// panFor: stereo position
// ---------------------------------------------------------------------------

test('pan is clamped to the stereo range', () => {
  // An unclamped value is not louder but *broken*: the panner clamps it itself on
  // some implementations and wraps it on others.
  assert.equal(panFor(0), 0);
  assert.equal(panFor(-999), -1);
  assert.equal(panFor(999), 1);
  assert.equal(panFor(12), 1);
  assert.equal(panFor(-12), -1);
});

test('pan is symmetric', () => {
  for (const x of [1, 3, 6, 11]) {
    assert.equal(panFor(x), -panFor(-x), `pan is not symmetric at ${x}`);
  }
});

test('a modest offset to the right is audible but not hard-panned', () => {
  // Everything hard-panned is the classic co-op-builder mistake: every remote
  // edit sounds like it came from a speaker.
  const p = panFor(4);
  assert.ok(p > 0.2 && p < 0.8, `expected a gentle offset, got ${p}`);
});

// ---------------------------------------------------------------------------
// editSound: attribution
// ---------------------------------------------------------------------------

test('mine and theirs are always different sounds', () => {
  // The entire point of the system. If these ever collapse to one sound, the
  // player cannot tell their own edit from a collaborator's, which is the single
  // thing this was built to do.
  for (const kind of ['place', 'remove', 'prop']) {
    const mine = editSound(kind, true);
    const theirs = editSound(kind, false);
    assert.notEqual(mine, theirs, `${kind}: mine and theirs are the same sound`);
    assert.ok(Object.values(SFX).includes(mine));
    assert.ok(Object.values(SFX).includes(theirs));
  }
});

test('the same action by the same actor is always the same sound', () => {
  // Stable mapping matters because the player learns it. A mapping that varied
  // would be noise rather than signal.
  for (const kind of ['place', 'remove', 'prop']) {
    assert.equal(editSound(kind, true), editSound(kind, true));
    assert.equal(editSound(kind, false), editSound(kind, false));
  }
});

// ---------------------------------------------------------------------------
// VoiceBudget: not turning into a machine gun
// ---------------------------------------------------------------------------

test('the budget lets the first sound through', () => {
  const b = new VoiceBudget();
  assert.equal(b.allow('place', 'self', 0), true);
});

test('a cooldown suppresses an immediate retrigger', () => {
  // Without this, a run of placements retriggers a long ring while its previous
  // tail is still audible, and the sound chops into a buzz.
  const b = new VoiceBudget();
  assert.equal(b.allow('place', 'self', 1000), true);
  assert.equal(b.allow('place', 'self', 1000 + 5), false, '5 ms later is too soon');
  assert.equal(b.allow('place', 'self', 1000 + COOLDOWN_MS.self + 1), true, 'past the cooldown');
});

test('bots are held off far longer than the player', () => {
  // Four bots committing every second or so is the load this has to survive.
  // If bots used the player's cooldown the mix would be continuous.
  assert.ok(COOLDOWN_MS.bot > COOLDOWN_MS.self * 3,
    'a bot cooldown this short lets bot activity become a drone');
});

test('the live ceiling is enforced', () => {
  const b = new VoiceBudget(4);
  const started = [];
  for (let i = 0; i < 10; i++) {
    // Distinct names so the cooldown never interferes with the ceiling test.
    if (b.allow(`s${i}`, 'self', i * 10_000)) {
      const id = i + 1;
      b.start(id);
      started.push(id);
    }
  }
  assert.equal(started.length, 4, 'exactly the ceiling should start');
  assert.equal(b.stats().dropped, 6, 'and the rest should be dropped, not queued');
});

test('a released voice frees its slot', () => {
  // The regression that matters: a budget with no release path degenerates into a
  // lifetime counter and permanently mutes audio after a busy minute.
  const b = new VoiceBudget(2);
  b.start(1); b.start(2);
  assert.equal(b.allow('x', 'self', 0), false, 'full');
  b.release(1);
  assert.equal(b.allow('x', 'self', 0), true, 'a finished voice must free its slot');
});

test('releasing twice cannot inflate the capacity', () => {
  // A double release must not let unbounded voices through, which would be worse
  // than being too strict. Tracking ids rather than a bare counter is what prevents
  // it: a counter would go negative here and every later voice would be admitted.
  const b = new VoiceBudget(2);
  b.start(1); b.start(2);
  assert.equal(b.allow('a', 'self', 0), false, 'full to begin with');

  b.release(1); b.release(1); b.release(1);

  // One slot is legitimately free now. What must not happen is the free slot
  // becoming two, or the ceiling growing. `tryStart` is used here because it pairs
  // the gate with the registration -- asking twice without registering in between
  // would describe a caller that does not exist.
  const a = b.tryStart('a', 'self', 0);
  assert.ok(a, 'the one free slot is usable');
  assert.equal(b.tryStart('b', 'self', 0), null, 'and there is still only one');
  assert.equal(b.stats().live, 2, 'occupancy is exactly the ceiling, not above it');
});

test('tryStart registers the voice it hands back', () => {
  // The point of the combined call: a caller cannot pass the gate and forget to
  // register, which would leave the ceiling understated and stop applying.
  const b = new VoiceBudget(3);
  const id = b.tryStart('place', 'self', 0);
  assert.ok(id, 'admitted');
  assert.equal(b.stats().live, 1, 'and counted');
  b.release(id);
  assert.equal(b.stats().live, 0);
});

test('tryStart hands back unique ids', () => {
  // Two live voices must not share a token, or releasing one frees both and the
  // ceiling drifts upward over a session.
  const b = new VoiceBudget(4);
  const a = b.tryStart('place', 'self', 0);
  const c = b.tryStart('placeRemote', 'self', 10);
  assert.notEqual(a, c, 'ids collided');
  b.release(a);
  assert.equal(b.stats().live, 1, 'releasing one left the other alone');
});

test('a cooldown is per sound, not global', () => {
  // A shared cooldown would let a burst of bot blocks mute the player's own edit,
  // which is exactly the wrong way round.
  const b = new VoiceBudget();
  b.allow('placeRemote', 'bot', 0);
  assert.equal(b.allow('place', 'self', 0), true, 'your own edit is not blocked by bot noise');
});

test('reset clears cooldowns so the next sound is instant', () => {
  const b = new VoiceBudget();
  b.allow('place', 'self', 1000);
  b.reset();
  assert.equal(b.allow('place', 'self', 1001), true);
});

test('a realistic bot burst stays inside the ceiling', () => {
  // The actual load: four bots, one commit a second each, for a minute, with the
  // player building steadily too. Voices must be released as they finish, so the
  // live count should hover rather than climb to the ceiling and stay there.
  //
  // The release call is the whole point of this test. An earlier version of it
  // retired voices from a local list without telling the budget, so occupancy only
  // rose and the budget eventually rejected everything -- which is exactly what
  // happened, and it looked like the budget was too tight rather than like a
  // missing release.
  const b = new VoiceBudget();
  const live = new Map();
  let maxLive = 0;

  for (let now = 0; now < 60_000; now += 16) {
    for (const [id, until] of [...live]) {
      if (until <= now) { live.delete(id); b.release(id); }
    }
    const actors = [...Array(4).fill('bot'), ...(now % 700 === 0 ? ['self'] : [])];
    for (const who of actors) {
      const name = who === 'self' ? 'place' : 'placeRemote';
      if (!b.allow(name, who, now)) continue;
      const id = `${now}-${who}-${b.played}`;
      b.start(id);
      live.set(id, now + 400);
    }
    maxLive = Math.max(maxLive, b.stats().live);
  }

  const s = b.stats();
  assert.ok(maxLive <= MAX_VOICES, `live voices peaked at ${maxLive}`);
  assert.ok(maxLive < MAX_VOICES, `occupancy saturated at the ceiling (${maxLive})`);
  assert.ok(s.dropped < s.played * 0.5,
    `a minute of bot activity should not be mostly drops (${s.dropped} of ${s.played})`);
});

// ---------------------------------------------------------------------------
// Constants that encode judgement calls
// ---------------------------------------------------------------------------

test('remote voices are detuned but not audibly out of tune', () => {
  // A few cents is invisible as a mistake and audible as "another voice". Anything
  // larger would sound like the wrong note rather than a different player.
  assert.ok(REMOTE_DETUNE_CENTS > 0, 'remote voices must be distinguishable');
  assert.ok(REMOTE_DETUNE_CENTS <= 8, 'and not far enough to sound wrong');
});

test('bots are quieter than remote humans, who are quieter than the player', () => {
  assert.ok(AGENT_GAIN.self > AGENT_GAIN.human, 'the player must dominate');
  assert.ok(AGENT_GAIN.human > AGENT_GAIN.bot, 'a friend must outrank a bot');
  assert.ok(AGENT_GAIN.bot > 0, 'a bot must not be silent by default');
});

test('the inaudibility cut-off is below hearing rather than at it', () => {
  // Cutting at a level the player can hear makes edits appear to happen in
  // silence, which is worse than not playing them.
  assert.ok(INAUDIBLE > 0 && INAUDIBLE < 0.05, `cut-off ${INAUDIBLE} is audible`);
});

test('every declared sound has a handler', () => {
  // A sound declared but never played is dead code; a sound played but never
  // declared is a typo. This catches the first.
  const handled = new Set([
    SFX.PLACE, SFX.PLACE_REMOTE, SFX.REMOVE, SFX.REMOVE_REMOTE,
    SFX.PROP, SFX.PROP_REMOTE, SFX.DENY, SFX.CONFLICT,
    SFX.OBJECTIVE, SFX.VICTORY, SFX.UNDO, SFX.UI, SFX.READY,
  ]);
  for (const name of Object.values(SFX)) {
    assert.ok(handled.has(name), `${name} is declared but nothing plays it`);
  }
});

// ---------------------------------------------------------------------------
// ambienceFor: the bed says where you are
// ---------------------------------------------------------------------------

test('open water drops the wind entirely', () => {
  // Standing over the lagoon must not sound like standing on a windy hill, and the
  // only way to tell the two apart by ear is that one of them has no wind in it.
  for (const id of [14, 15, 16, 17]) {
    const mix = ambienceFor(id, 3);
    assert.ok(mix.water > 0, `${MATERIALS[id]?.name} has no water bed`);
    assert.equal(mix.wind, 0, `${MATERIALS[id]?.name} still carries wind`);
    assert.equal(mix.surf, 0, `${MATERIALS[id]?.name} still carries surf`);
  }
});

test('the waterline band sounds like a shore', () => {
  const mix = ambienceFor(10, 4); // sand_wet: the generator's own waterline band
  assert.ok(mix.surf > 0, 'wet sand should break on the shore');
  assert.ok(mix.surf > mix.wind, 'and should read as surf rather than as wind');
  assert.equal(mix.water, 0, 'but it is not open water');
});

test('bare sand below the palm line is beach, above it is dry crown', () => {
  // Two columns of the same material on either side of the generator's own
  // beach/crown split. Without the height test the whole island would sound like a
  // beach, because the crown is mostly bare sand with scrub growing on it.
  const shore = ambienceFor(11, PALM_MAX_GROUND);
  const crown = ambienceFor(11, PALM_MAX_GROUND + 1);

  assert.ok(shore.surf > 0, 'at the palm line it is still shore');
  assert.equal(crown.surf, 0, 'one level up it is dry land');
  assert.ok(crown.wind > shore.wind, 'and it carries more wind than the beach does');
});

test('built materials read as land, not as shore or water', () => {
  // However far out the player builds, they are standing on the island while they
  // do it. A stone plaza that starts sounding like a beach would be the bug here.
  for (const id of [1, 2, 3, 5, 6, 7, 8, 9, 12, 13]) {
    const mix = ambienceFor(id, 12);
    assert.equal(mix.surf, 0, `${MATERIALS[id]?.name} reads as shore`);
    assert.equal(mix.water, 0, `${MATERIALS[id]?.name} reads as water`);
    assert.ok(mix.wind > 0, `${MATERIALS[id]?.name} has no bed at all`);
  }
});

test('no surface produces total silence', () => {
  // Silence reads as broken audio rather than as a quiet world. Every state has to
  // keep something audible, and no layer may exceed its own declared ceiling -- a
  // level that escaped its cap would quietly out-compete the edits the mix exists
  // to carry.
  const samples = [
    ...Object.values(MATERIALS).map((m) => [m.id, 6]),
    [0, 0], [99, 10], [NaN, undefined], [-1, 5],
  ];
  for (const [mat, y] of samples) {
    const mix = ambienceFor(mat, y);
    const audible = AMBIENCE.filter((k) => mix[k] > 0).length;
    assert.ok(audible > 0, `material ${mat} at y ${y} mutes the bed`);
    for (const k of AMBIENCE) {
      assert.ok(Number.isFinite(mix[k]) && mix[k] >= 0, `${k} is not a level`);
      assert.ok(mix[k] <= AMBIENCE_GAIN[k], `${k} exceeds its own ceiling`);
    }
  }
});

test('the bed sits under everything else in the mix', () => {
  // The bed is never meant to be listened to. It is the floor that stops silence,
  // so it has to stay far below the quietest edit.
  for (const [name, gain] of Object.entries(AMBIENCE_GAIN)) {
    assert.ok(gain > 0 && gain < 0.05, `${name} at ${gain} would compete with edits`);
  }
});

// ---------------------------------------------------------------------------
// surfaceUnder: finding the surface to ask about
// ---------------------------------------------------------------------------

test('surfaceUnder returns the top-most non-air voxel', () => {
  const column = { 3: 14, 4: 11, 5: 1, 6: 0 };
  const got = surfaceUnder((x, y, z) => column[y] ?? 0, 0, 0);
  assert.deepEqual(got, { mat: 1, y: 5 }, 'air above a block must not hide it');
});

test('surfaceUnder stops at the water surface, not at the sea floor', () => {
  // The generator emits exactly one water cell per column, sitting on top of the
  // seabed. Scanning past it would ask about the floor underneath and conclude the
  // player is standing on land in the middle of the lagoon.
  const got = surfaceUnder((x, y, z) => (y === 3 ? 14 : (y < 3 ? 17 : 0)), 4, -4);
  assert.deepEqual(got, { mat: 14, y: 3 });
});

test('surfaceUnder falls through to empty rather than throwing', () => {
  // Called from the frame loop over a world that may not have streamed in yet, and
  // over columns outside the playable disc entirely. An empty column is an answer.
  assert.deepEqual(surfaceUnder(() => 0, 0, 0), { mat: 0, y: 0 });
  assert.deepEqual(surfaceUnder(() => 0, 400, -400), { mat: 0, y: 0 });
});