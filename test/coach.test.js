/**
 * First-run coaching.
 *
 * The behaviour worth testing is *when it advances*, and that is invisible when it is
 * wrong — a tutorial that advances too eagerly teaches nothing and a tutorial that
 * never advances is a permanent overlay. So the state machine is pure and lives apart
 * from the DOM, which is the only way to check the sequencing at all.
 *
 * Each test below is a way this could plausibly be wrong, not coverage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Coach, STEPS, STEP, stepById, isSatisfied, wasCoached, rememberCoached,
} from '../public/src/ui/coach.js';

/** A stand-in for localStorage, so persistence is actually tested rather than the
 *  try/catch fallback that Node would otherwise force. */
function fakeStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _map: m,
  };
}

const state = (o = {}) => ({
  accepted: 0, hasClaim: false, sawObjective: false, clicked: new Set(), ...o,
});

const click = (o = {}) => state({ clicked: new Set(o.anchors ?? []) });

// ---------------------------------------------------------------------------
// The ladder's first objective vs what a new player does
// ---------------------------------------------------------------------------

test('the first instruction asks for the action a new player already tries', () => {
  // The mismatch this whole module exists to fix: the ladder's first goal is "place a
  // lantern", which needs the decor palette. A new player's hand goes to "put a
  // block down". So the first step must be the block, or the tutorial's opening
  // instruction is effectively invisible.
  const first = STEPS[0];
  assert.equal(first.needs, 'place');
  assert.match(first.body, /click/i);
  assert.match(first.body, /build/i);
});

test('the first step takes one action and no more', () => {
  // Everything else is about context a player cannot have yet.
  assert.equal(STEPS[0].needs, 'place');
  assert.equal(STEPS[0].anchor, null, 'nothing to point at on the first step');
});

test('every step names the signal that completes it, except the last', () => {
  for (const s of STEPS.slice(0, -1)) {
    assert.ok(s.needs, `${s.id} has no completion signal`);
    assert.ok(s.body && s.body.length > 8, `${s.id} has no instruction`);
  }
  assert.equal(STEPS[STEPS.length - 1].needs, null, 'the final step waits for nothing');
});

test('no two consecutive steps wait for the same thing', () => {
  // If two steps wanted the same signal, the first would consume it and the second
  // would never fire -- a silent dead end partway through the tutorial.
  for (let i = 1; i < STEPS.length - 1; i++) {
    assert.notEqual(STEPS[i].needs, STEPS[i - 1].needs,
      `${STEPS[i - 1].id} and ${STEPS[i].id} both wait for ${STEPS[i].needs}`);
  }
});

test('every step waiting on a signal can actually be satisfied', () => {
  // The classic mismatch: a step names a requirement nothing ever reports, and the
  // tutorial hangs on it forever with no error anywhere. Asserted against the real
  // predicate rather than a list of strings, so adding a signal without teaching
  // isSatisfied about it fails here.
  for (const s of STEPS) {
    if (!s.needs) continue;
    const st = state();
    // Every signal must have a predicate that fires for *some* input.
    const fires = [
      { accepted: 1 }, { hasClaim: true }, click({ anchors: ['#builders'] }), click({ anchors: ['#objectives'] }),
    ].some((patch) => isSatisfied(s, state(patch)));
    assert.ok(fires, `${s.id} waits for "${s.needs}" and nothing can satisfy it`);
  }
});

test('no step depends on something the player cannot guarantee', () => {
  // The lesson of the second bug, and the one most likely to be reintroduced: the
  // "others are building" step originally completed on the swarm having committed a
  // block. On a world whose ladder is already finished the bots correctly stand down,
  // so that evidence never arrives and the coach waits forever -- for a player doing
  // everything right.
  //
  // Every requirement is now either a click the player makes or a key they can always
  // press. Anything derived from what *other agents* happen to be doing is banned.
  const playerActs = new Set(['place', 'clickBuilders', 'clickGoals', 'claim']);
  for (const s of STEPS) {
    if (!s.needs) continue;
    assert.ok(playerActs.has(s.needs),
      `${s.id} waits on "${s.needs}", which the player does not control`);
  }
});

test('a step with no requirement is never satisfied', () => {
  // The final step is reached by advancing past the one before it, not by its own
  // condition -- so it must not also be pumpable, or it would be skipped instantly.
  const last = STEPS[STEPS.length - 1];
  assert.equal(last.needs, null);
  assert.equal(isSatisfied(last, state({ accepted: 9, hasClaim: true, sawObjective: true, clicked: new Set(['#builders', '#objectives']) })), false);
});

// ---------------------------------------------------------------------------
// Advancing
// ---------------------------------------------------------------------------

test('the coach starts on the first step', () => {
  const c = new Coach();
  assert.equal(c.active, true);
  assert.equal(c.step, STEP.WELCOME);
  assert.equal(c.current().needs, 'place');
});

test('the right signal advances exactly one step', () => {
  const c = new Coach();
  const r = c.advance('place');
  assert.equal(r.changed, true);
  assert.equal(c.step, STEP.PLACE);
  assert.notEqual(c.step, STEP.WELCOME);
});

test('a wrong signal changes nothing', () => {
  // Spamming clicks must not blow through the tutorial: a player who skips four
  // steps ends up believing they have been taught something.
  const c = new Coach();
  for (const sig of ['claim', 'clickBuilders', 'clickGoals', 'observeBots', 'ackGoal', 'nonsense', null, undefined]) {
    assert.equal(c.advance(sig).changed, false, `"${sig}" should not advance`);
  }
  assert.equal(c.step, STEP.WELCOME);
});

test('the whole sequence runs in order and ends finished', () => {
  const c = new Coach();
  const order = [c.step];
  for (const s of STEPS.slice(0, -1)) {
    const r = c.advance(s.needs);
    assert.equal(r.changed, true, `stuck at ${c.step}`);
    order.push(c.step);
  }
  assert.deepEqual(order, STEPS.map((s) => s.id));
  assert.equal(c.active, false);
});

test('advancing after finishing does nothing', () => {
  const c = new Coach();
  for (const s of STEPS.slice(0, -1)) c.advance(s.needs);
  assert.equal(c.active, false);
  assert.equal(c.advance('place').changed, false);
  assert.equal(c.advance('claim').changed, false);
  assert.equal(c.step, STEP.DONE, 'and stays put');
});

test('finishing reports that it finished, exactly once', () => {
  // The toast and the sound fire on this signal, so a repeated `true` here means
  // they fire repeatedly.
  const c = new Coach();
  let finishedCount = 0;
  for (const s of STEPS.slice(0, -1)) {
    const r = c.advance(s.needs);
    if (r.finished) finishedCount++;
  }
  assert.equal(finishedCount, 1);
});

test('the coach can only advance, never skip backwards', () => {
  const c = new Coach();
  c.advance('place');
  const at = c.step;
  // Anything not matching the current step's need must be inert, including the
  // signal that got us here.
  c.advance('place');
  assert.equal(c.step, at, 'a repeated signal does not re-advance');
});

// ---------------------------------------------------------------------------
// Returning players
// ---------------------------------------------------------------------------

test('a player who has been here before is not coached', () => {
  const c = new Coach({ started: true });
  assert.equal(c.active, false);
  assert.equal(c.step, STEP.DONE);
});

test('dismissing ends it without reaching the end', () => {
  const c = new Coach();
  c.advance('place');
  assert.equal(c.dismiss(), true);
  assert.equal(c.active, false);
  assert.notEqual(c.step, STEP.DONE, 'skipped, not completed');
});

test('dismissing twice is harmless', () => {
  const c = new Coach();
  c.dismiss();
  assert.equal(c.dismiss(), false);
});

test('dismissing an already-finished coach is harmless', () => {
  const c = new Coach();
  for (const s of STEPS.slice(0, -1)) c.advance(s.needs);
  assert.equal(c.dismiss(), false);
});

// ---------------------------------------------------------------------------
// isSatisfied: reading real state
// ---------------------------------------------------------------------------

test('nothing has happened yet, so the first step is not satisfied', () => {
  assert.equal(isSatisfied(STEPS[0], state()), false);
});

test('the first accepted build satisfies the first step', () => {
  assert.equal(isSatisfied(STEPS[0], state({ accepted: 1 })), true);
});

test('clicking the builders panel is what satisfies that step', () => {
  // Replaces a requirement on the swarm having committed a block, which is exactly
  // what does *not* happen on a world whose ladder is already finished -- the bots
  // correctly stand down, so the coach waited forever. Every step now asks for
  // something the player can always do.
  const step = STEPS.find((s) => s.needs === 'clickBuilders');
  assert.ok(step, 'the builders step exists');
  assert.equal(isSatisfied(step, state({ accepted: 5 })), false);
  assert.equal(isSatisfied(step, click({ anchors: ['#builders'] })), true);
  assert.equal(isSatisfied(step, click({ anchors: ['#objectives'] })), false,
    'clicking a different panel does not count');
});
test('clicking the goals panel is what satisfies that step', () => {
  const step = STEPS.find((s) => s.needs === 'clickGoals');
  assert.equal(isSatisfied(step, state({ sawObjective: true })), false,
    'the payload arriving is not the player having looked at it');
  assert.equal(isSatisfied(step, click({ anchors: ['#objectives'] })), true);
});
test('each step is judged only on its own requirement', () => {
  // The fix for the stall. A state that satisfies a *later* step must not satisfy an
  // earlier one, or the sequence collapses; and an earlier step's evidence must not
  // satisfy a later one, or it stalls waiting for something already done.
  const byNeed = Object.fromEntries(STEPS.map((s) => [s.needs, s]));
  assert.equal(isSatisfied(byNeed.place, click({ anchors: ['#builders'] })), false,
    'clicking a panel is not evidence you built anything');
  assert.equal(isSatisfied(byNeed.clickBuilders, state({ accepted: 5 })), false,
    'your own building is not evidence you clicked the panel');
  assert.equal(isSatisfied(byNeed.claim, state({ accepted: 5 })), false,
    'building is not evidence you hold ground');
});

// ---------------------------------------------------------------------------
// pump: the real entry point
// ---------------------------------------------------------------------------

test('pump advances only when the current step is satisfied', () => {
  const c = new Coach();
  assert.equal(c.pump(state()).changed, false);
  assert.equal(c.pump(click({ anchors: ['#objectives'] })).changed, false, 'a click on a later step does not count');
  assert.equal(c.step, STEP.WELCOME);
  assert.equal(c.pump(state({ accepted: 1 })).changed, true);
  assert.equal(c.step, STEP.PLACE);
});

test('each step id matches what it waits for', () => {
  // The step table is hand-written and the two halves drifted apart once: the step
  // titled "Others are building" waited on a claim, and the step about holding ground
  // waited on the goal panel. Nothing errored -- the coach just sat on a step whose
  // evidence could never arrive, which looks like a tutorial that works for most
  // people and then silently stops.
  //
  // Asserted against the ids rather than the prose, since the prose can be reworded.
  const expect = {
    [STEP.WELCOME]: 'place',
    [STEP.PLACE]: 'clickBuilders',
    [STEP.BOTS]: 'clickGoals',
    [STEP.GOAL]: 'claim',
    [STEP.DONE]: null,
  };
  for (const [id, needs] of Object.entries(expect)) {
    const step = STEPS.find((s) => s.id === id);
    assert.ok(step, `step ${id} is missing`);
    assert.equal(step.needs, needs, `${id} should wait for ${needs}`);
  }
});

test('a caught-up player steps through rather than blinking past everything', () => {
  // Someone who already holds ground and has already built satisfies every
  // requirement at once. Advancing all of them in a single pump would make the whole
  // tutorial flash and vanish in one frame, which reads as a glitch rather than as
  // anything having been taught. One step per pump is what lets it be read, and it is
  // also how the frame loop wants to use it.
  const c = new Coach();
  const everything = state({
    accepted: 1, hasClaim: true, sawObjective: true,
    clicked: new Set(['#builders', '#objectives']),
  });

  const first = c.pump(everything);
  assert.equal(first.changed, true);
  assert.equal(c.step, STEP.PLACE, 'advanced exactly one step, not all of them');
  assert.equal(c.active, true, 'and the tutorial is still going');

  // Four remaining steps, four pumps. The first pump above already moved us off
  // `welcome`, so this loop only has to cover what is left.
  let guard = 0;
  while (c.active && guard++ < 10) c.pump(everything);
  assert.equal(c.active, false);
  assert.equal(guard + 1, STEPS.length - 1,
    'exactly one pump per step: the one above plus the ones here');
});
test('the sequence runs in order under real state progression', () => {
  const c = new Coach();
  const visited = [c.step];
  const progression = [
    state({ accepted: 1 }),
    click({ anchors: ['#builders'] }),
    click({ anchors: ['#builders', '#objectives'] }),
    state({ accepted: 1, hasClaim: true, clicked: new Set(['#builders', '#objectives']) }),
  ];
  for (const st of progression) {
    if (c.pump(st).changed) visited.push(c.step);
  }
  assert.deepEqual(visited, [STEP.WELCOME, STEP.PLACE, STEP.BOTS, STEP.GOAL, STEP.DONE]);
  assert.equal(c.active, false);
});

test('state that matches an already-passed step does not rewind', () => {
  // The subtle one. After the coach moves on, the bots keep committing, so the
  // bot signal is true on every pump from then on. It must be inert.
  const c = new Coach();
  c.pump(state({ accepted: 1 }));
  c.pump(state({ accepted: 1 }));
  c.pump(click({ anchors: ['#builders'] }));
  assert.equal(c.step, STEP.BOTS);
  // The builders click stays true forever. It must be inert on every later pump.
  for (let i = 0; i < 5; i++) {
    assert.equal(c.pump(state({ accepted: 1, clicked: new Set(['#builders']) })).changed, false);
  }
  assert.equal(c.step, STEP.BOTS, 'still waiting for the goals click');
});

test('pumping after finishing does nothing', () => {
  const c = new Coach();
  for (let i = 0; i < 10 && c.active; i++) {
    c.pump(state({ accepted: 1, hasClaim: true, sawObjective: true, clicked: new Set(['#builders', '#objectives']) }));
  }
  assert.equal(c.active, false);
  assert.equal(c.pump(state({ accepted: 9, hasClaim: true })).changed, false);
});

test('pumping a dismissed coach does nothing', () => {
  const c = new Coach();
  c.dismiss();
  assert.equal(c.pump(state({ accepted: 1, hasClaim: true, sawObjective: true, clicked: new Set(['#builders', '#objectives']) })).changed, false);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('the coached flag survives a reload', () => {
  // With an injected store. Reaching for the real localStorage here would only ever
  // test the try/catch fallback, because Node has none -- a test that passes while
  // proving nothing.
  const store = fakeStore();
  assert.equal(wasCoached(store), false, 'clean slate');
  rememberCoached(store);
  assert.equal(wasCoached(store), true);
  // And a new Coach built from it does not start.
  assert.equal(new Coach({ started: wasCoached(store) }).active, false);
});

test('an absent store is survivable', () => {
  // Private mode throws rather than returning null, and a tutorial that crashes the
  // game on load is worse than one that repeats.
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(wasCoached(throwing), false);
  assert.equal(rememberCoached(throwing), false);
  assert.equal(wasCoached(null), false);
  assert.equal(rememberCoached(null), false);
});

test('an unknown step id falls back rather than returning nothing', () => {
  // The panel renders whatever comes back, so an undefined here would throw mid-frame
  // for a cosmetic reason.
  const s = stepById('no_such_step');
  assert.ok(s);
  assert.ok(s.title);
  assert.ok(s.body);
});