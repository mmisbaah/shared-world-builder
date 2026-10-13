import test from 'node:test';
import assert from 'node:assert/strict';

import { WorldHistory } from '../server/history.js';
import { Scrubber, agoLabel } from '../public/src/history/scrubber.js';

// ---------------------------------------------------------------------------
// A world with just enough surface for the scrubber to drive.
//
// Only the four methods it calls. Anything more would be testing the world
// rather than the walking, and the world already has its own file.
// ---------------------------------------------------------------------------

function fakeWorld() {
  const cells = new Map();
  const props = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  return {
    cells,
    props,
    setAuthoritative(x, y, z, mat) {
      const k = key(x, y, z);
      const was = cells.get(k) ?? 0;
      cells.set(k, mat);
      return was !== mat;
    },
    setProp(record) { props.set(key(record.x, record.y, record.z), record); },
    removeProp(x, y, z) { return props.delete(key(x, y, z)); },
  };
}

/**
 * Every voxel and prop, in a form deepEqual can compare.
 *
 * Air is air whether or not the map happens to hold an entry for it: the
 * scrubber writes a `0` where the oracle never wrote at all, and `setAuthoritative`
 * short-circuits the second time over an already-air voxel, so the two worlds
 * are identical in every way the game can observe. Comparing the raw maps
 * would fail on them anyway.
 */
function snapshot(w) {
  const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return {
    cells: [...w.cells.entries()].filter(([, mat]) => mat !== 0).sort(byKey),
    props: [...w.props.entries()].sort(byKey),
  };
}

function history(opts) {
  const h = new WorldHistory(opts);
  h.start();
  return h;
}

// ---------------------------------------------------------------------------
// Recording: off until boot is over
// ---------------------------------------------------------------------------

test('nothing is recorded before the history is started', () => {
  // Island generation writes thousands of cells through this exact path. A log
  // that started earlier would open on terrain nobody built and reach the first
  // thing a person actually did roughly ten thousand entries later.
  const h = new WorldHistory();
  assert.equal(h.record({ t: 1, kind: 'block', x: 0, y: 0, z: 0, from: 0, to: 1, by: null }), false);
  assert.equal(h.length, 0);
  assert.equal(h.active, false);
});

test('a real change is recorded once the history is live', () => {
  const h = history();
  assert.equal(h.record({ t: 1, kind: 'block', x: 0, y: 0, z: 0, from: 0, to: 1, by: 'a' }), true);
  assert.equal(h.length, 1);
  assert.equal(h.at(0).by, 'a');
});

test('a write that changes nothing is not recorded', () => {
  // It would undo to itself, so the scrubber could never show it either way --
  // while still costing a slot in the log and an application on every drag.
  const h = history();
  assert.equal(h.record({ t: 1, kind: 'block', x: 0, y: 0, z: 0, from: 3, to: 3, by: 'a' }), false);
  assert.equal(h.length, 0);
});

test('stopping keeps what was gathered and records nothing more', () => {
  const h = history();
  h.record({ t: 1, kind: 'block', x: 0, y: 0, z: 0, from: 0, to: 1, by: null });
  h.stop();
  h.record({ t: 2, kind: 'block', x: 1, y: 0, z: 0, from: 0, to: 1, by: null });
  assert.equal(h.length, 1, 'the earlier work survives a pause');
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test('the log never holds more than its cap, and keeps the newest', () => {
  const h = history({ cap: 10 });
  for (let i = 0; i < 100; i++) {
    h.record({ t: i, kind: 'block', x: 0, y: 0, z: 0, from: 0, to: 1, by: null });
  }
  assert.equal(h.length, 10);
  assert.equal(h.at(9).t, 99, 'the newest is the last entry');
  assert.equal(h.at(0).t, 90, 'and the oldest survivors are the most recent ones');
});

test('nothing older than the age limit is kept', () => {
  const h = history({ maxAgeMs: 1000 });
  h.record({ t: 0, kind: 'block', x: 0, y: 0, z: 0, from: 0, to: 1, by: null });
  h.record({ t: 500, kind: 'block', x: 0, y: 0, z: 0, from: 1, to: 2, by: null });
  assert.equal(h.length, 2, 'both are within a second of each other');
  h.record({ t: 5000, kind: 'block', x: 0, y: 0, z: 0, from: 2, to: 3, by: null });
  assert.equal(h.length, 1);
  assert.equal(h.at(0).t, 5000);
});

test('span is null when empty and exact when not', () => {
  const h = history();
  assert.equal(h.span(), null);
  h.record({ t: 10, kind: 'block', x: 0, y: 0, z: 0, from: 0, to: 1, by: null });
  h.record({ t: 40, kind: 'block', x: 0, y: 0, z: 0, from: 1, to: 2, by: null });
  assert.deepEqual(h.span(), { oldest: 10, newest: 40 });
});

test('slice clamps to what exists and is a copy, not the live array', () => {
  // The world keeps being edited while this response is in flight, so handing
  // out the array itself would let a response mutate underneath its reader.
  const h = history();
  for (let i = 0; i < 5; i++) {
    h.record({ t: i, kind: 'block', x: 0, y: 0, z: 0, from: 0, to: 1, by: null });
  }
  const out = h.slice(1, 3);
  assert.equal(out.length, 2);
  assert.equal(out[0].t, 1);
  assert.equal(out[1].t, 2);

  out.length = 0;
  assert.equal(h.length, 5, 'emptying the copy leaves the log alone');

  assert.equal(h.slice(-5, 99).length, 5, 'out-of-range bounds are clamped');
  assert.equal(h.slice(3, 1).length, 0, 'an inverted range is empty, not thrown');
});

test('indexAt finds the first change at or after a time', () => {
  const h = history();
  // Seeded in ascending time on purpose: the log is monotonic by construction
  // (it is appended in wall-clock order), so feeding it out of order would be
  // testing a shape the class can never actually hold.
  for (const t of [10, 20, 20, 30]) {
    h.record({ t, kind: 'block', x: 0, y: 0, z: 0, from: 0, to: 1, by: null });
  }
  assert.equal(h.indexAt(0), 0, 'everything is newer');
  assert.equal(h.indexAt(10), 0, 'an exact hit is inclusive');
  assert.equal(h.indexAt(21), 3, 'a time between two changes finds the next one');
  assert.equal(h.indexAt(30), 3, 'and a duplicate timestamp resolves to the first');
  assert.equal(h.indexAt(999), 4, 'everything is older');
});

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

test('a scrubber opens on the present', () => {
  const s = new Scrubber(fakeWorld(), [{ t: 1, kind: 'block', x: 0, y: 0, z: 0, from: 0, to: 1, by: null }]);
  assert.equal(s.cursor, 1);
  assert.equal(s.atPresent, true);
  assert.equal(s.shownTime(), null, 'the present is a null moment, not the last change');
});

test('walking back through every index is exact, and forward again', () => {
  // The property the whole feature rests on. The same voxel is written twice,
  // deliberately: undoing in the wrong order would restore the first write over
  // the second and look correct at both endpoints while being wrong at every
  // frame between them.
  const w = fakeWorld();
  w.setAuthoritative(1, 2, 3, 5); // the world before the log begins

  const entries = [
    { t: 1, kind: 'block', x: 1, y: 2, z: 3, from: 5, to: 1, by: 'a' },
    { t: 2, kind: 'block', x: 1, y: 2, z: 3, from: 1, to: 7, by: 'b' },
    { t: 3, kind: 'block', x: 9, y: 9, z: 9, from: 0, to: 2, by: 'a' },
  ];

  // The truth, built without the scrubber: what the world is after the first k
  // entries, for every k. Asserting the scrubber against this rather than
  // against a hand-written "before" is what makes it a real check -- the two
  // agree at k=0 and k=length trivially, so only the frames in between can
  // actually fail, and those are exactly the ones that are easy to get wrong.
  const truth = [snapshot(w)];
  const oracle = fakeWorld();
  oracle.setAuthoritative(1, 2, 3, 5);
  for (const e of entries) {
    oracle.setAuthoritative(e.x, e.y, e.z, e.to);
    truth.push(snapshot(oracle));
  }
  const present = truth[entries.length];

  // The scrubber is handed a world that is already at the present, which is
  // the only state it is ever constructed over: it fetches the log from a
  // server whose world it is also looking at.
  for (const e of entries) w.setAuthoritative(e.x, e.y, e.z, e.to);

  const s = new Scrubber(w, entries);
  assert.deepEqual(snapshot(w), present, 'a scrubber opens on the present');

  let prev = entries.length;
  for (let k = entries.length; k >= 0; k--) {
    assert.equal(s.seek(k), prev - k, `index ${k} moves exactly ${prev - k} entries`);
    prev = k;
    assert.deepEqual(snapshot(w), truth[k], `index ${k} must be the state after the first ${k} entries`);
    assert.equal(s.atPresent, k === entries.length);
  }

  assert.equal(s.restore(), entries.length);
  assert.deepEqual(snapshot(w), present, 'and the present comes back byte for byte');
});

test('seeking applies only the difference', () => {
  // A full rewind is every change since the log began; dragging one notch is
  // one change. Without this a slider would re-apply the world on every pixel.
  const w = fakeWorld();
  const entries = [
    { t: 1, kind: 'block', x: 0, y: 0, z: 0, from: 0, to: 1, by: null },
    { t: 2, kind: 'block', x: 1, y: 0, z: 0, from: 0, to: 1, by: null },
    { t: 3, kind: 'block', x: 2, y: 0, z: 0, from: 0, to: 1, by: null },
  ];
  for (const e of entries) w.setAuthoritative(e.x, e.y, e.z, e.to);

  const s = new Scrubber(w, entries);
  assert.equal(s.seek(2), 1, 'one notch back is one entry');
  assert.equal(w.cells.get('2,0,0'), 0, 'and it is the newest one that went away');
  assert.equal(w.cells.get('1,0,0'), 1, 'the older two are untouched');

  assert.equal(s.seek(0), 2);
  assert.equal(s.seek(3), 3);
  assert.equal(s.seek(3), 0, 'a no-op seek does no work');
});

test('out-of-range seeks clamp instead of throwing', () => {
  const s = new Scrubber(fakeWorld(), [{ t: 1, kind: 'block', x: 0, y: 0, z: 0, from: 0, to: 1, by: null }]);
  assert.equal(s.seek(-99), 1, 'below zero means the oldest frame');
  assert.equal(s.cursor, 0);
  assert.equal(s.seek(99), 1, 'past the end means the present');
  assert.equal(s.cursor, 1);
});

test('props are walked by writing and deleting the record itself', () => {
  const w = fakeWorld();
  const bench = { x: 4, y: 1, z: 4, prop: 'bench', rot: 2, by: 'a', rev: 9 };
  const entries = [{ t: 1, kind: 'prop', x: 4, y: 1, z: 4, from: null, to: bench, by: 'a' }];

  w.setProp(bench);
  const s = new Scrubber(w, entries);

  s.seek(0);
  assert.equal(w.props.has('4,1,4'), false, 'the bench is gone in the past');

  s.restore();
  const back = w.props.get('4,1,4');
  assert.equal(back.prop, 'bench');
  assert.equal(back.rot, 2, 'rotation comes back too');
  assert.equal(back.by, 'a', 'and so does who placed it');
});

test('a prop that was *removed* returns when the scrubber goes back', () => {
  // The other direction, and the one that would be easy to get backwards: the
  // entry's `from` is the record and its `to` is nothing.
  const w = fakeWorld();
  const lantern = { x: 0, y: 1, z: 0, prop: 'lantern', rot: 0, by: 'b', rev: 3 };
  const entries = [{ t: 1, kind: 'prop', x: 0, y: 1, z: 0, from: lantern, to: null, by: 'b' }];

  const s = new Scrubber(w, entries);
  s.seek(0);
  assert.equal(w.props.get('0,1,0').prop, 'lantern', 'undoing the removal puts it back');
  s.restore();
  assert.equal(w.props.has('0,1,0'), false);
});

test('truncation bounds how far back you can go and never makes a frame wrong', () => {
  // The head of this log was dropped by the cap, so index 0 is *not* the start
  // of the world. Walking back from the present must still be exact at every
  // index the log reaches, because nothing between here and now was forgotten.
  const w = fakeWorld();
  w.setAuthoritative(0, 0, 0, 9);
  const dropped = [
    { t: 1, kind: 'block', x: 7, y: 7, z: 7, from: 0, to: 4, by: null },
    { t: 2, kind: 'block', x: 8, y: 8, z: 8, from: 0, to: 4, by: null },
  ];
  for (const e of dropped) w.setAuthoritative(e.x, e.y, e.z, e.to);

  const retained = [
    { t: 3, kind: 'block', x: 0, y: 0, z: 0, from: 9, to: 1, by: null },
    { t: 4, kind: 'block', x: 0, y: 0, z: 0, from: 1, to: 6, by: null },
  ];
  for (const e of retained) w.setAuthoritative(e.x, e.y, e.z, e.to);

  const s = new Scrubber(w, retained);
  s.seek(0);
  assert.equal(w.cells.get('0,0,0'), 9, 'back to the oldest frame the log reaches');
  assert.equal(w.cells.get('7,7,7'), 4, 'the dropped changes are correctly still applied');
  assert.equal(w.cells.get('8,8,8'), 4);

  s.restore();
  assert.equal(w.cells.get('0,0,0'), 6);
});

test('a scrubber over an empty log is inert', () => {
  const w = fakeWorld();
  w.setAuthoritative(0, 0, 0, 3);
  const s = new Scrubber(w, []);
  assert.equal(s.rewind(), 0);
  assert.equal(s.restore(), 0);
  assert.equal(w.cells.get('0,0,0'), 3);
  assert.equal(s.shownTime(), null);
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test('agoLabel picks the coarsest unit that still reads', () => {
  const now = 1_000_000;
  assert.equal(agoLabel(now, now), '0s ago');
  assert.equal(agoLabel(now - 12_000, now), '12s ago');
  assert.equal(agoLabel(now - 90_000, now), '2 min ago');
  assert.equal(agoLabel(now - 3_000_000, now), '50 min ago');
  assert.equal(agoLabel(now - 3_600_000, now), '1 h ago');
  assert.equal(agoLabel(now - 7_200_000, now), '2 h ago');
  assert.equal(agoLabel(now + 5_000, now), '0s ago', 'a clock that ran backwards reads as now');
});
