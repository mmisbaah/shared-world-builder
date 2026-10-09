/**
 * Event-to-sound mapping.
 *
 * This is the part of the audio system that has real decisions in it, and every
 * test below is a bug that either happened or would have been hard to catch.
 *
 * There is no Web Audio here and no three.js: `play` is injected, so the tests
 * record what *would* have sounded. That is the whole reason the mapping was
 * pulled out of the frame loop -- inside a `requestAnimationFrame` closure it
 * could not be exercised at all, because rAF does not run headless.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { playEvents, classify } from '../public/src/audio/events.js';
import { SFX } from '../public/src/audio/voice.js';
import { OP } from '../shared/protocol.js';

const SELF = 'me';

/** Records every sound requested. */
function recorder() {
  const calls = [];
  return {
    calls,
    play(name, opts, who) { calls.push({ name, who, ...opts }); return true; },
    names: () => calls.map((c) => c.name),
    forWho: (who) => calls.filter((c) => c.who === who),
  };
}

const botIds = new Set(['bot_alex', 'bot_maya']);
const deps = (rec, over = {}) => ({
  play: rec.play, selfId: SELF, botIds, ...over,
});

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

test('an id is classified against the local player first', () => {
  assert.equal(classify(SELF, SELF, botIds), 'self');
  assert.equal(classify('bot_alex', SELF, botIds), 'bot');
  assert.equal(classify('someone_else', SELF, botIds), 'human');
});

test('a missing id is treated as an unattributed human, not as the player', () => {
  // Getting this backwards would attribute every unattributed change to you.
  assert.equal(classify(null, SELF, botIds), 'human');
  assert.equal(classify(undefined, SELF, botIds), 'human');
});

test('an unknown bot id still resolves as a bot', () => {
  // The roster is delivered by a separate message. A delta carrying a bot's id can
  // arrive first, and classifying it as a human plays it at full volume for a bot
  // that commits every second.
  assert.equal(classify('bot_not_yet_in_roster', SELF, new Set()), 'bot');
});

test('a roster entry wins over the prefix', () => {
  // A human whose chosen id happened to start with "bot_" would otherwise be
  // demoted. The explicit roster is the more authoritative signal.
  assert.equal(classify('bot_impostor', SELF, new Set(['bot_impostor'])), 'bot');
});

// ---------------------------------------------------------------------------
// The double-strike bug
// ---------------------------------------------------------------------------

test('my own placement sounds exactly once', () => {
  // This is the bug the whole double-play guard exists for. The server broadcasts
  // every delta to every client including its author, so a single placement
  // arrives as BOTH an `accepted` event and a `delta` carrying my own id. Sounding
  // both double-strikes the most common event in the game.
  const rec = recorder();
  playEvents([
    { type: 'accepted', opId: 1, x: 1, y: 2, z: 3, mat: 1, opType: OP.PLACE_BLOCK },
    { type: 'delta', cx: 0, cz: 0, by: SELF, count: 1, x: 1, y: 2, z: 3, mat: 1 },
  ], deps(rec));

  assert.equal(rec.calls.length, 1, `expected one sound, got ${rec.names()}`);
  assert.equal(rec.calls[0].name, SFX.PLACE);
  assert.equal(rec.calls[0].who, 'self');
});

test('a multi-voxel delta sounds once, not once per voxel', () => {
  // A bot laying a five-block run is one action. The delta is reported once with a
  // count, so it must be sounded once.
  const rec = recorder();
  playEvents([
    { type: 'delta', cx: 0, cz: 0, by: 'bot_alex', count: 5, x: 3, y: 4, z: 5, mat: 6 },
  ], deps(rec));
  assert.equal(rec.calls.length, 1);
});

test('another builder\'s placement sounds once, as remote', () => {
  const rec = recorder();
  playEvents([
    { type: 'accepted', opId: 1, x: 0, y: 1, z: 0, mat: 1, opType: OP.PLACE_BLOCK },
    { type: 'delta', cx: 0, cz: 0, by: 'friend', count: 1, x: 0, y: 1, z: 0, mat: 1 },
  ], deps(rec));

  // The `accepted` is ours and the delta is theirs: two genuinely different edits.
  assert.equal(rec.calls.length, 2);
  assert.deepEqual(rec.calls.map((c) => c.who).sort(), ['human', 'self']);
});

test('a bot intent announcement is silent', () => {
  // The server announces a bot's intent *before* it commits. The resulting delta is
  // the authoritative event, so sounding both would double every bot placement.
  const rec = recorder();
  playEvents([
    { type: 'bot', kind: 'intent', builderId: 'bot_alex', name: 'Alex_Voxel' },
    { type: 'bot', builderId: 'bot_alex', x: 1, y: 2, z: 3, mat: 1 },
  ], deps(rec));
  assert.equal(rec.calls.length, 0, 'intent announcements must not be heard');
});

// ---------------------------------------------------------------------------
// Block versus prop
// ---------------------------------------------------------------------------

test('a prop placement makes a different sound from a block', () => {
  // Both events arrive with no `mat` -- a prop has no material -- so without
  // opType a lantern and a cube would sound identical.
  const rec = recorder();
  playEvents([
    { type: 'accepted', opId: 1, x: 0, y: 1, z: 0, opType: OP.PLACE_PROP },
    { type: 'accepted', opId: 2, x: 1, y: 1, z: 0, mat: 6, opType: OP.PLACE_BLOCK },
  ], deps(rec));

  assert.equal(rec.calls[0].name, SFX.PROP);
  assert.equal(rec.calls[1].name, SFX.PLACE);
});

test('a prop delta is recognised as a prop', () => {
  const rec = recorder();
  playEvents([
    { type: 'delta', cx: 0, cz: 0, by: 'friend', count: 0, propCount: 1, x: 2, y: 3, z: 4 },
  ], deps(rec));
  assert.equal(rec.calls[0].name, SFX.PROP_REMOTE);
});

test('a delta carrying both blocks and props is sounded as a prop', () => {
  // Whichever dominates, one sound is correct. A prop is the rarer and more
  // distinctive event, so it wins.
  const rec = recorder();
  playEvents([
    { type: 'delta', cx: 0, cz: 0, by: 'friend', count: 3, propCount: 1, x: 0, y: 0, z: 0 },
  ], deps(rec));
  assert.equal(rec.calls[0].name, SFX.PROP_REMOTE);
});

test('the remote placement carries a position for panning', () => {
  // Without coordinates the remote sound cannot be panned or attenuated, which
  // loses the entire point of distinguishing it from your own.
  const rec = recorder();
  playEvents([
    { type: 'delta', cx: 0, cz: 0, by: 'friend', count: 1, x: 11, y: 4, z: -7, mat: 2 },
  ], deps(rec));
  const c = rec.calls[0];
  assert.equal(c.x, 11); assert.equal(c.y, 4); assert.equal(c.z, -7);
  assert.equal(c.mat, 2, 'and the material, so the timbre is right');
});

// ---------------------------------------------------------------------------
// Denials and conflicts
// ---------------------------------------------------------------------------

test('a plain denial sounds the quiet refusal', () => {
  const rec = recorder();
  playEvents([
    { type: 'denied', opId: 1, x: 0, y: 1, z: 0, deny: 'occupied', reason: 'occupied' },
  ], deps(rec));
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].name, SFX.DENY);
});

test('losing a race sounds the urgent conflict, once', () => {
  // The double-sound hazard here is that `conflict` and `denied` are pushed as two
  // separate events for the same lost race. Only `denied` knows whether a winner was
  // named, so only it may sound it.
  const rec = recorder();
  playEvents([
    { type: 'denied', opId: 1, x: 5, y: 6, z: 7, deny: 'occupied', reason: 'occupied', conflict: true, winner: { name: 'Rivet', mat: 1 } },
    { type: 'conflict', x: 5, y: 6, z: 7, mat: 1, by: 'Rivet' },
  ], deps(rec));

  assert.equal(rec.calls.length, 1, `expected one sound, got ${rec.names()}`);
  assert.equal(rec.calls[0].name, SFX.CONFLICT);
});

test('both denial branches report to the log and toast', () => {
  const logs = [];
  const toasts = [];
  const rec = recorder();
  playEvents([
    { type: 'denied', opId: 1, x: 0, y: 0, z: 0, reason: 'outside bounds' },
    { type: 'denied', opId: 2, x: 1, y: 1, z: 1, reason: 'occupied', conflict: true, winner: { name: 'Rivet' } },
    { type: 'conflict', x: 1, y: 1, z: 1, mat: 1, by: 'Rivet' },
  ], deps(rec, { log: (t, k) => logs.push([t, k]), toast: (t, k) => toasts.push([t, k]) }));

  assert.equal(logs.length, 3, 'both denials and the conflict are logged');
  assert.equal(toasts.length, 1, 'but only the conflict produces a toast');
  assert.match(toasts[0][0], /Rivet/);
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test('an empty batch is a no-op', () => {
  const rec = recorder();
  assert.equal(playEvents([], deps(rec)).sounded, 0);
  assert.equal(rec.calls.length, 0);
});

test('unknown event types are ignored rather than throwing', () => {
  // The server is free to add an event type. An unknown one must not stop the
  // remaining events in the batch from sounding, and must not throw inside the
  // frame loop, where the failure would be silent and would stop audio for the
  // rest of the session.
  const rec = recorder();
  const result = playEvents([
    { type: 'somethingNewInFuture', x: 1 },
    { type: 'accepted', opId: 1, x: 0, y: 1, z: 0, mat: 1, opType: OP.PLACE_BLOCK },
  ], deps(rec));
  assert.equal(rec.calls.length, 1);
  assert.equal(result.sounded, 1);
});

test('a refused sound does not inflate the tally', () => {
  // The budget refuses distant inaudible sounds. Those must not be counted as
  // having sounded, or the tally stops describing what the player heard.
  const refused = { calls: [], play() { return false; } };
  const result = playEvents([
    { type: 'accepted', opId: 1, x: 0, y: 1, z: 0, mat: 1, opType: OP.PLACE_BLOCK },
  ], deps(refused));
  assert.equal(result.sounded, 0);
});

test('the tally separates self, remote and bot activity', () => {
  // This is what tells you whether the mix is behaving: if `self` is not the
  // largest number over a session, the attribution is inverted.
  const rec = recorder();
  const result = playEvents([
    { type: 'accepted', opId: 1, x: 0, y: 1, z: 0, mat: 1, opType: OP.PLACE_BLOCK },
    { type: 'delta', cx: 0, cz: 0, by: 'friend', count: 1, x: 1, y: 1, z: 0, mat: 1 },
    { type: 'delta', cx: 0, cz: 0, by: 'bot_alex', count: 1, x: 2, y: 1, z: 0, mat: 1 },
    { type: 'delta', cx: 0, cz: 0, by: 'bot_maya', count: 1, x: 3, y: 1, z: 0, mat: 1 },
    { type: 'denied', opId: 2, x: 0, y: 0, z: 0, reason: 'occupied' },
  ], deps(rec));

  assert.deepEqual(result, { sounded: 5, self: 1, remote: 1, bots: 2, denied: 1 });
});

test('a session of mixed traffic keeps the player dominant', () => {
  // Four bots committing steadily is the real background load. Over a session the
  // player's own edits must still be the loudest category by count, otherwise the
  // mix has inverted and the game sounds like a workshop rather than your world.
  const rec = recorder();
  const events = [];
  for (let i = 0; i < 60; i++) {
    events.push({ type: 'accepted', opId: i, x: i, y: 1, z: 0, mat: 1, opType: OP.PLACE_BLOCK });
    for (const b of ['bot_alex', 'bot_maya', 'bot_zen', 'bot_ivy']) {
      events.push({ type: 'delta', cx: 0, cz: 0, by: b, count: 1, x: i, y: 2, z: 0, mat: 1 });
    }
  }
  const r = playEvents(events, deps(rec));

  assert.equal(r.self, 60);
  assert.equal(r.bots, 240);
  assert.equal(r.remote, 0);
  // Four bot sounds per player sound is the *event* ratio; the level ceiling and
  // the longer bot cooldown are what stop it being the loudest *contribution*.
  assert.equal(rec.forWho('bot').length / rec.forWho('self').length, 4);
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

test('an accepted undo sounds its own voice rather than a placement', () => {
  // Without the opType branch an undo plays the arrival of a block, and the
  // player hears "something was built" for every edit they take back.
  const rec = recorder();
  playEvents([
    { type: 'accepted', opId: 1, x: 3, y: 2, z: 1, mat: 0, opType: OP.UNDO },
  ], deps(rec));
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].name, SFX.UNDO);
  assert.equal(rec.calls[0].x, 3, 'and stays spatialised to the voxel it reverted');
  assert.equal(rec.calls[0].who, 'self');
});

test('a plain placement still sounds like a placement', () => {
  // The branch must not swallow the ordinary case on the way to the new one.
  const rec = recorder();
  playEvents([
    { type: 'accepted', opId: 2, x: 3, y: 2, z: 1, mat: 4, opType: OP.PLACE_BLOCK },
  ], deps(rec));
  assert.equal(rec.calls[0].name, SFX.PLACE);
});

test('a refused undo says why, because nothing else will', () => {
  // An undo that does not happen produces no delta and no visible change, so
  // the refusal is the entire feedback the player gets for the keypress.
  const toasts = [];
  const rec = recorder();
  playEvents([
    { type: 'denied', opId: 3, opType: OP.UNDO, deny: 'empty', reason: 'nothing to undo' },
  ], deps(rec, { toast: (t, k) => toasts.push([t, k]) }));

  assert.equal(toasts.length, 1, 'the player is told why');
  assert.equal(toasts[0][0], 'nothing to undo');
  assert.equal(toasts[0][1], 'warn');
  assert.equal(rec.calls[0].name, SFX.DENY, 'and hears the refusal too');
});

test('a conflict toast never fires for an undo, which cannot lose a race', () => {
  // Undo carries no coordinates, so a "beat you to it" line would name nothing.
  const toasts = [];
  const rec = recorder();
  playEvents([
    { type: 'denied', opId: 4, opType: OP.UNDO, deny: 'occupied', reason: 'changed since you edited it' },
  ], deps(rec, { toast: (t, k) => toasts.push([t, k]) }));

  assert.deepEqual(toasts, [['changed since you edited it', 'warn']]);
  assert.equal(rec.calls[0].name, SFX.DENY, 'and no conflict sound is the right one');
});