/**
 * Objective ladder.
 *
 * The property that matters most here is unforgeability: progress must be a
 * function of authoritative world state, so a client cannot claim credit. That
 * rules out accumulating progress from op counts at request time -- instead these
 * tests build real chunk state and measure it, which is also what catches the
 * bugs that actually happen: index arithmetic across a column, and runs that
 * should or should not be contiguous.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OBJECTIVES, OBJECTIVE_IDS, METRIC, scanWorld, evaluate, toWire,
} from '../shared/objectives.js';
import { ObjectiveTracker } from '../server/objectives.js';
import { Authority } from '../server/authority.js';
import { PROPS, MATERIALS, isValidMaterial } from '../shared/materials.js';
import { CHUNK_SIZE, CHUNK_AREA, WORLD, voxelIndex, chunkKey } from '../shared/protocol.js';

// ---------------------------------------------------------------------------
// Chunk construction helpers
// ---------------------------------------------------------------------------

/** An empty column chunk with the same shape the server stores. */
function makeChunk(cx = 0, cz = 0) {
  return { cx, cz, key: chunkKey(cx, cz), cells: new Uint16Array(CHUNK_AREA * WORLD.MAX_Y), props: new Map() };
}

/** Write a world-space block into a chunk, via local coordinates like the server. */
function put(chunk, wx, wy, wz, mat) {
  const lx = wx - chunk.cx * CHUNK_SIZE;
  const lz = wz - chunk.cz * CHUNK_SIZE;
  chunk.cells[voxelIndex(lx, wy, lz)] = mat;
}

/** A prop record in the shape the tracker reads. */
function prop(key) { return { prop: key }; }

function scan(chunks, props = [], builders = []) {
  return scanWorld(chunks, props, builders);
}

// ---------------------------------------------------------------------------
// scanWorld: the measurement must agree with what was written
// ---------------------------------------------------------------------------

test('a scan sees blocks written at every height in a full-height column', () => {
  // Regression guard. The column layout is full-world-height, not CHUNK_SIZE tall,
  // so a write above y=15 has to be visible to a scan. When the world was wrongly
  // cubic, every write above y=15 silently no-op'd on a typed array and the entire
  // upper world read as air.
  const c = makeChunk();
  for (let y = WORLD.MIN_Y; y < WORLD.MAX_Y; y++) put(c, 0, y, 0, 1);

  const s = scan([c]);
  assert.equal(s.materialCounts.get('1'), WORLD.MAX_Y,
    'every level of the column should be counted');
  assert.equal(s.tallest, WORLD.MAX_Y, 'and the tallest run is the full column');
});

test('tallest measures the longest contiguous vertical run, not the highest block', () => {
  // A tower with a gap in it is two shorter things. Measuring "highest occupied y"
  // would call this 20 tall, which would let a stack of disconnected voxels satisfy
  // a height goal for free.
  const c = makeChunk();
  for (let y = 0; y < 10; y++) put(c, 0, y, 0, 1);   // run of 10
  for (let y = 12; y < 20; y++) put(c, 0, y, 0, 1);  // run of 8, above a gap

  const s = scan([c]);
  assert.equal(s.tallest, 10, 'the gap breaks the run; the longer half is 10');
  assert.notEqual(s.tallest, 20, 'not the span from the lowest to the highest block');
});

test('two separate columns do not add together', () => {
  const c = makeChunk();
  for (let y = 0; y < 6; y++) put(c, 0, y, 0, 1);
  for (let y = 0; y < 4; y++) put(c, 3, y, 5, 1);
  assert.equal(scan([c]).tallest, 6);
});

test('chunks are indexed independently, so a block in chunk 1,1 is found', () => {
  // The chunk-local offset is the classic off-by-one: writing with world
  // coordinates directly would put a block at 16,5,16 into the wrong slot of the
  // wrong chunk and it would never be counted.
  const a = makeChunk(0, 0);
  const b = makeChunk(1, 1);
  put(b, 17, 5, 19, 6);

  const s = scan([a, b]);
  assert.equal(s.materialCounts.get('6'), 1, 'the block in chunk 1,1 is counted');
  assert.equal(s.tallest, 1);
  assert.equal(b.cells[voxelIndex(1, 5, 3)], 6, 'and landed at the right local index');
});

test('prop counts come from prop records, not voxels', () => {
  const s = scan([makeChunk()], [prop('lantern'), prop('lantern'), prop('torch')]);
  assert.equal(s.propCounts.get('lantern'), 2);
  assert.equal(s.propCounts.get('torch'), 1);
  assert.equal(s.propCounts.get('plant'), undefined);
});

test('contributing builders are de-duplicated', () => {
  const s = scan([makeChunk()], [], ['b1', 'b1', 'b2']);
  assert.equal(s.builders.size, 2);
});

// ---------------------------------------------------------------------------
// evaluate: each metric
// ---------------------------------------------------------------------------

test('MATERIAL_PRESENT is satisfied by one block and only counts to one', () => {
  const o = { metric: METRIC.MATERIAL_PRESENT, material: 6, goal: 1 };
  const none = scan([makeChunk()]);
  assert.equal(evaluate(o, none).done, false);

  const c = makeChunk(); put(c, 0, 0, 0, 6);
  const some = scan([c]);
  const v = evaluate(o, some);
  assert.equal(v.done, true);
  // Ten gold blocks against a goal of one should not show a 1000% bar.
  for (let i = 0; i < 9; i++) put(c, i, 0, 0, 6);
  assert.equal(evaluate(o, scan([c])).current, 1, 'clamped to the goal');
});

test('MATERIAL_COUNT sums only the listed materials', () => {
  const c = makeChunk();
  for (let i = 0; i < 5; i++) put(c, i, 0, 0, 5);
  for (let i = 0; i < 3; i++) put(c, i, 0, 1, 8);
  put(c, 0, 0, 2, 1);

  const v = evaluate({ metric: METRIC.MATERIAL_COUNT, material: [5, 8], goal: 8 }, scan([c]));
  assert.equal(v.current, 8, 'cyan + amber both count, stone does not');
  assert.equal(v.done, true);
});

test('MATERIAL_COUNT reports over-delivery in raw but clamps current', () => {
  const c = makeChunk();
  for (let i = 0; i < 20; i++) put(c, i, 0, 0, 6);
  const v = evaluate({ metric: METRIC.MATERIAL_COUNT, material: 6, goal: 10 }, scan([c]));
  assert.equal(v.raw, 20, 'raw preserves what actually exists');
  assert.equal(v.current, 10, 'current is what the bar renders');
});

test('PROP_COUNT needs the specific prop, not any prop', () => {
  const c = makeChunk();
  const props = [prop('lantern'), prop('lantern'), prop('chair'), prop('plant')];
  const v = evaluate({ metric: METRIC.PROP_COUNT, prop: 'lantern', goal: 6 }, scan([c], props));
  assert.equal(v.current, 2);
  assert.equal(v.done, false);
});

test('COLUMN_HEIGHT uses the measured tallest run', () => {
  const c = makeChunk();
  for (let y = 0; y < 14; y++) put(c, 0, y, 0, 1);
  // goal 12 against a real height of 14: done, with current clamped to the goal so
  // the progress bar cannot overflow.
  const v = evaluate({ metric: METRIC.COLUMN_HEIGHT, goal: 12 }, scan([c]));
  assert.equal(v.raw, 14, 'what actually exists');
  assert.equal(v.current, 12, 'clamped to the goal for the bar');
  assert.equal(v.done, true);
});

test('DISTINCT_BUILDERS counts people, not operations', () => {
  const o = { metric: METRIC.DISTINCT_BUILDERS, goal: 3 };
  assert.equal(evaluate(o, scan([makeChunk()], [], ['a', 'a', 'a'])).current, 1,
    'one builder spamming does not satisfy a three-builder goal');
  assert.equal(evaluate(o, scan([makeChunk()], [], ['a', 'b', 'c'])).done, true);
});

test('an unknown metric evaluates to zero rather than throwing', () => {
  assert.equal(evaluate({ metric: 'nonsense', goal: 5 }, scan([makeChunk()])).done, false);
});

// ---------------------------------------------------------------------------
// The ladder itself
// ---------------------------------------------------------------------------

test('every objective is well formed', () => {
  for (const o of OBJECTIVES) {
    assert.ok(o.id, 'needs an id');
    assert.ok(o.title, `${o.id} needs a title`);
    assert.ok(o.brief, `${o.id} needs a brief`);
    assert.ok(Object.values(METRIC).includes(o.metric), `${o.id} has a known metric`);
    assert.ok(o.goal >= 1, `${o.id} needs a positive goal`);
    assert.ok(o.reward, `${o.id} needs a reward`);

    if (o.metric === METRIC.PROP_COUNT) {
      assert.ok(typeof o.prop === 'string', `${o.id} must name a prop`);
    }
    if (o.metric === METRIC.MATERIAL_PRESENT || o.metric === METRIC.MATERIAL_COUNT) {
      assert.ok(o.material !== undefined, `${o.id} must name a material`);
    }
  }
});

test('objective ids are unique', () => {
  assert.equal(new Set(OBJECTIVE_IDS).size, OBJECTIVE_IDS.length);
});

test('every objective references something that actually exists', () => {
  // Guards against an objective that can never be satisfied -- a prop key or
  // material id that is not in the catalogue. The ladder would then stall forever
  // on an impossible goal with no explanation anywhere.
  for (const o of OBJECTIVES) {
    if (o.metric === METRIC.PROP_COUNT) {
      assert.ok(PROPS[o.prop], `${o.id} references unknown prop "${o.prop}"`);
    }
    if (o.metric === METRIC.MATERIAL_PRESENT || o.metric === METRIC.MATERIAL_COUNT) {
      const ids = Array.isArray(o.material) ? o.material : [o.material];
      for (const id of ids) {
        assert.ok(MATERIALS[id], `${o.id} references unknown material ${id}`);
        assert.equal(isValidMaterial(id), true);
      }
    }
  }
});

test('the first objective is achievable without any special knowledge', () => {
  // The opening goal is the tutorial. It should need only one action that a new
  // player can discover from the UI, not a hidden material or an unusual prop.
  const first = OBJECTIVES[0];
  assert.equal(first.goal, 1, 'the first objective should take one action');
  assert.ok(first.brief.length > 20, 'and should say what to do');
});

/** Minimal stand-in for Authority: only what the tracker reads. */
function fakeAuthority(chunks = [makeChunk()]) {
  const map = new Map(chunks.map((c) => [c.key, c]));
  return { chunks: map };
}

// ---------------------------------------------------------------------------
// The human-contributor gate
// ---------------------------------------------------------------------------

test('an objective does not complete on bots alone', () => {
  // The bug this rule exists for: the swarm cleared six of eight objectives in
  // about thirty seconds with no human input, so a player arriving later found
  // the game already finished.
  const auth = fakeAuthority();
  const t = new ObjectiveTracker(auth);
  // Satisfy the first objective completely -- without any human ever touching it.
  auth.chunks.get('0,0').props.set('a', { prop: 'lantern' });

  assert.equal(t.evaluate(), false, 'bot-only progress does not advance the ladder');
  assert.equal(t.index, 0, 'and the objective stays active');
  assert.equal(t.awaitingHuman, true, 'flagged as waiting on a person');
});

test('one human touch unlocks the objective', () => {
  const auth = fakeAuthority();
  const t = new ObjectiveTracker(auth);
  auth.chunks.get('0,0').props.set('a', { prop: 'lantern' });

  assert.equal(t.noteHumanContribution('b1'), 'first_light', 'and reports which objective');
  assert.equal(t.isUnlocked('first_light'), true);
  assert.equal(t.evaluate(), true, 'now it completes');
  assert.equal(t.index, 1);
});

test('a human touch does not permanently unlock later objectives', () => {
  // Otherwise the gate is a one-time speed bump and the bots take over again.
  const auth = fakeAuthority();
  const t = new ObjectiveTracker(auth);
  t.noteHumanContribution('b1');
  assert.equal(t.isUnlocked('first_light'), true);

  // Advance past it so the next objective becomes active.
  auth.chunks.get('0,0').props.set('a', { prop: 'lantern' });
  t.evaluate();
  assert.equal(t.index, 1);
  assert.equal(t.isUnlocked('warm_the_plaza'), false, 'the next objective starts locked');
});

test('an untouched objective reports not-waiting, not-waiting-on-you', () => {
  // The flag is about "has a person acted", not "is the metric met". An objective
  // nobody has started is simply not done, and must not claim it is waiting.
  const auth = fakeAuthority();
  const t = new ObjectiveTracker(auth);
  t.evaluate();
  assert.equal(t.index, 0);
  assert.equal(t.awaitingHuman, false, 'not waiting -- just not done');
});

test('the payload reports awaitingHuman so the UI can explain a stalled bar', () => {
  // A full progress bar that never completes and says nothing is the most
  // confusing state this UI can be in.
  const auth = fakeAuthority();
  const t = new ObjectiveTracker(auth);
  auth.chunks.get('0,0').props.set('a', { prop: 'lantern' });
  t.evaluate();

  const p = t.payload();
  assert.equal(p.awaitingHuman, true);
  assert.equal(p.active[p.index].current, p.active[p.index].goal, 'the bar really is full');

  t.noteHumanContribution('b1');
  t.evaluate();
  assert.equal(t.payload().awaitingHuman, false, 'and clears once a human acts');
});

test('a bot commit can never unlock an objective', () => {
  // Structural, not incidental: the gate depends on noteHumanContribution being
  // reachable only from the socket op handler. commitAs/commitPropAs are the bots'
  // path and neither touches the tracker.
  const auth = new Authority();
  const t = new ObjectiveTracker(auth);
  auth.chunk(0, 0);
  for (let i = 0; i < 40; i++) auth.chunks.get('0,0').props.set(`p${i}`, { prop: 'lantern' });

  auth.commitAs({ id: 'bot_x' }, 0, 1, 0, 1);
  auth.commitPropAs({ id: 'bot_x' }, 0, 2, 0, 'lantern');

  assert.equal(t.humanTouched.size, 0, 'a bot commit leaves the gate shut');
  t.evaluate();
  assert.equal(t.index, 0, 'and the ladder does not advance');
});

/**
 * A tracker with every objective already unlocked by a hypothetical human.
 *
 * The gate below means a bare tracker can never advance. That is the desired
 * behaviour, but these tests are about *ladder mechanics* -- multi-step advance,
 * monotonic completion, the exhaust guard -- and none of that should have to
 * re-assert the gate. Pre-seeding the unlock set keeps each test about one thing.
 */
function unlockedTracker(chunks) {
  const auth = fakeAuthority(chunks);
  const t = new ObjectiveTracker(auth);
  for (const id of OBJECTIVE_IDS) t.humanTouched.add(id);
  return { auth, t };
}

// ---------------------------------------------------------------------------
// ObjectiveTracker: the ladder advances correctly and only on real progress
// ---------------------------------------------------------------------------

test('the tracker does not advance before the goal is met', () => {
  const auth = fakeAuthority();
  const t = new ObjectiveTracker(auth);
  assert.equal(t.index, 0, 'first objective: place one lantern');
  t.evaluate();
  assert.equal(t.index, 0, 'an empty world satisfies nothing');
});

test('placing the required prop advances the ladder', () => {
  const { auth, t } = unlockedTracker();
  // No props in the chunks yet, so inject through the chunk prop map the tracker reads.
  auth.chunks.get('0,0').props.set('a,b,c', prop('lantern'));

  const advanced = t.evaluate();
  assert.equal(advanced, true);
  assert.equal(t.index, 1, 'moved to the next objective');
  assert.deepEqual(t.completed, ['first_light']);
});

test('the ladder advances past several already-met objectives in one pass', () => {
  // Six lanterns satisfy both "First Light" (1) and "Warm the Plaza" (6). A
  // single-step advance would leave the ladder sitting on an objective that is
  // already complete, which reads as a bug.
  const { auth, t } = unlockedTracker();
  for (let i = 0; i < 6; i++) {
    auth.chunks.get('0,0').props.set(`p${i}`, prop('lantern'));
  }
  t.evaluate();
  assert.equal(t.index, 2, 'both lantern objectives cleared');
  assert.deepEqual(t.completed, ['first_light', 'warm_the_plaza']);
});

test('completion is monotonic -- removing the evidence does not un-complete it', () => {
  const { auth, t } = unlockedTracker();
  auth.chunks.get('0,0').props.set('a', prop('lantern'));
  t.evaluate();
  assert.equal(t.index, 1);

  // Tear it back out and re-evaluate.
  auth.chunks.get('0,0').props.clear();
  t.evaluate();
  assert.equal(t.index, 1, 'the achievement happened; it stays');
  assert.deepEqual(t.completed, ['first_light']);
});

test('contributors only count once they have committed an op', () => {
  const t = new ObjectiveTracker(fakeAuthority());
  t.noteContributor('b1');
  t.noteContributor('b1');
  t.noteContributor('b2');
  assert.equal(t.contributors.size, 2);
  t.noteContributor(null);
  assert.equal(t.contributors.size, 2, 'a missing id does not count as a builder');
});

test('reaching the end of the ladder stops advancing and does not hang', () => {
  // Everything satisfied: the advance loop must be bounded, or it spins forever.
  const { auth, t } = unlockedTracker();
  const c = auth.chunks.get('0,0');
  for (let i = 0; i < 40; i++) {
    c.props.set(`l${i}`, prop('lantern'));
    c.props.set(`p${i}`, prop('plant'));
  }
  for (let y = 0; y < 20; y++) put(c, 0, y, 0, 1);
  put(c, 1, 0, 0, 6);
  for (let i = 0; i < 10; i++) put(c, i, 0, 1, 6);
  for (let i = 0; i < 8; i++) put(c, i, 0, 2, 5);
  // `distinctBuilders` measures the contributor set, which in production is
  // populated by noteHumanContribution. The unlock gate and this metric are
  // separate inputs and both have to be satisfied.
  t.noteContributor('a'); t.noteContributor('b'); t.noteContributor('c');

  const advanced = t.evaluate();
  assert.equal(advanced, true);
  assert.equal(t.index, OBJECTIVES.length, 'ladder exhausted');
  // A second evaluation must be a no-op rather than a loop.
  assert.equal(t.evaluate(), false);
  assert.equal(t.index, OBJECTIVES.length);
});

test('the payload reports the active objective and a completion count', () => {
  const { t } = unlockedTracker();
  t.evaluate();
  const p = t.payload();
  assert.equal(p.index, 0);
  assert.equal(p.total, OBJECTIVES.length);
  assert.equal(p.active.length, OBJECTIVES.length, 'definitions travel for rendering');
  assert.ok(p.active[0].title, 'with text the client can display');
  assert.equal(typeof p.active[0].current, 'number');
});

test('the onComplete hook fires once per objective, in order', () => {
  const { auth, t } = unlockedTracker();
  const seen = [];
  t.onComplete = (o) => seen.push(o.id);
  for (let i = 0; i < 6; i++) auth.chunks.get('0,0').props.set(`p${i}`, prop('lantern'));

  t.evaluate();
  assert.deepEqual(seen, ['first_light', 'warm_the_plaza']);

  t.evaluate();
  assert.deepEqual(seen, ['first_light', 'warm_the_plaza'], 'no repeats on a re-evaluate');
});

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

test('toWire carries definitions and verdicts but no authority', () => {
  const c = makeChunk();
  for (let y = 0; y < 12; y++) put(c, 0, y, 0, 1);
  const s = scan([c], [], ['a']);
  const wire = toWire(OBJECTIVES, 0, [], s, s);

  assert.equal(wire.total, OBJECTIVES.length);
  assert.equal(wire.completed.length, 0);
  for (const o of wire.active) {
    assert.ok(o.id && o.title && o.brief);
    assert.equal(typeof o.done, 'boolean');
    assert.equal(typeof o.current, 'number');
  }
  // JSON round-trip: this goes over a socket, so it must survive serialisation.
  assert.deepEqual(JSON.parse(JSON.stringify(wire)).total, OBJECTIVES.length);
});
