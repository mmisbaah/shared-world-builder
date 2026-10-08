/**
 * World persistence.
 *
 * Persistence is the one place where a bug destroys work rather than merely
 * breaking a feature, so these tests care about three things a happy-path save
 * test misses entirely:
 *
 *   1. **Round-trip fidelity** -- every block, prop and chunk revision survives.
 *   2. **Durability under failure** -- a truncated or version-mismatched save must
 *      not stop the server booting, and must not delete the only copy of the world.
 *   3. **Revision safety** -- restored revisions must not collide with new ones,
 *      or a client's optimistic-concurrency check passes against stale data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Persistence } from '../server/persistence.js';
import { ObjectiveTracker } from '../server/objectives.js';
import { Authority } from '../server/authority.js';
import { COLUMN_VOLUME, chunkKey, voxelIndex, CHUNK_SIZE } from '../shared/protocol.js';

/** Fresh temp dir per test so nothing leaks between them. */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swb-persist-'));
}

function makePair(dir) {
  const authority = new Authority();
  const objectives = new ObjectiveTracker(authority);
  const persistence = new Persistence({ authority, objectives, dir, intervalMs: 0 });
  return { authority, objectives, persistence };
}

/** Write a block the way the server does: through setBlock, via chunk-local index. */
function place(authority, x, y, z, mat) {
  authority.setBlock(x, y, z, mat);
  const { cx, cz } = { cx: Math.floor(x / CHUNK_SIZE), cz: Math.floor(z / CHUNK_SIZE) };
  return chunkKey(cx, cz);
}

function occupied(authority) {
  let n = 0;
  for (const c of authority.chunks.values()) {
    for (let i = 0; i < c.cells.length; i++) if (c.cells[i] !== 0) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test('blocks survive a save and load into a fresh authority', () => {
  const dir = tmpDir();
  const a = makePair(dir);
  place(a.authority, 0, 0, 0, 1);
  place(a.authority, 3, 7, 5, 6);
  place(a.authority, 15, 47, 15, 8);
  place(a.authority, -1, 20, -1, 2);

  assert.equal(a.persistence.save(), true);

  // A brand new authority, as if the process restarted.
  const b = makePair(dir);
  assert.equal(b.persistence.load(), true);

  assert.equal(b.authority.getBlock(0, 0, 0), 1);
  assert.equal(b.authority.getBlock(3, 7, 5), 6);
  assert.equal(b.authority.getBlock(15, 47, 15), 8, 'a block at the top of a column');
  assert.equal(b.authority.getBlock(-1, 20, -1), 2, 'negative coordinates');
  assert.equal(occupied(b.authority), occupied(a.authority));
});

test('negative and boundary coordinates round-trip', () => {
  const dir = tmpDir();
  const a = makePair(dir);
  const cases = [[-16, 0, -16], [15, 0, 15], [-1, 47, 16], [16, 0, -1]];
  for (const [x, y, z] of cases) place(a.authority, x, y, z, 5);
  a.persistence.save();

  const b = makePair(dir);
  b.persistence.load();
  for (const [x, y, z] of cases) {
    assert.equal(b.authority.getBlock(x, y, z), 5, `${x},${y},${z}`);
  }
});

test('empty chunks are not written', () => {
  // A save full of empty columns is pure waste; the file should hold only the
  // chunks with something in them.
  const dir = tmpDir();
  const a = makePair(dir);
  a.authority.chunk(0, 0);
  a.authority.chunk(9, 9); // created, never written to
  place(a.authority, 0, 0, 0, 1);
  a.persistence.save();

  const raw = JSON.parse(require_zlib().gunzipSync(fs.readFileSync(path.join(dir, 'world.json'))).toString());
  assert.equal(raw.chunks.length, 1, 'only the occupied chunk is stored');
});

test('props survive the round trip with their keys intact', () => {
  const dir = tmpDir();
  const a = makePair(dir);
  a.authority.chunk(0, 0);
  const key = '2,5,2';
  a.authority.chunks.get('0,0').props.set(key, {
    x: 2, y: 5, z: 2, prop: 'lantern', rot: 1, by: 'b7', rev: 4, color: 0xff8800,
  });
  a.persistence.save();

  const b = makePair(dir);
  b.persistence.load();
  const restored = b.authority.chunks.get('0,0').props.get(key);
  assert.ok(restored, 'prop key survives -- keys are what the client looks up by');
  assert.equal(restored.prop, 'lantern');
  assert.equal(restored.rot, 1);
  assert.equal(restored.by, 'b7');
  assert.equal(restored.color, 0xff8800);
});

// ---------------------------------------------------------------------------
// Revision safety
// ---------------------------------------------------------------------------

test('revCounter is restored above the highest chunk revision', () => {
  // If new revisions restarted below restored ones, a client's optimistic
  // concurrency check could compare equal against a value it already knows and
  // let a stale edit through.
  const dir = tmpDir();
  const a = makePair(dir);
  place(a.authority, 0, 0, 0, 1);
  place(a.authority, 1, 0, 0, 1);
  place(a.authority, 2, 0, 0, 1);
  const highest = Math.max(...[...a.authority.chunks.values()].map((c) => c.rev));
  a.persistence.save();

  const b = makePair(dir);
  b.persistence.load();
  assert.ok(b.authority.revCounter > highest,
    `revCounter ${b.authority.revCounter} must exceed the highest restored chunk rev ${highest}`);
});

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

test('objective progress survives, so completed goals do not silently reset', () => {
  // This is the point of persisting: losing the ladder would quietly hand every
  // player the same first objective again on their next visit.
  const dir = tmpDir();
  const a = makePair(dir);
  a.objectives.index = 4;
  a.objectives.completed = ['first_light', 'warm_the_plaza', 'something_gold', 'gold_ten'];
  a.objectives.noteContributor('b1');
  a.objectives.noteContributor('b2');
  a.persistence.save();

  const b = makePair(dir);
  b.persistence.load();
  assert.equal(b.objectives.index, 4);
  assert.deepEqual(b.objectives.completed, a.objectives.completed);
  assert.equal(b.objectives.contributors.size, 2);
  assert.ok(b.objectives.contributors.has('b1'));
});

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

test('loading with no save file is a clean first boot, not an error', () => {
  const dir = tmpDir();
  const { persistence } = makePair(dir);
  assert.equal(persistence.load(), false);
  assert.equal(persistence.stats.recovered, null);
});

test('a corrupt save is quarantined and the server still boots', () => {
  // Losing the world is bad. Refusing to start loses everything else too.
  const dir = tmpDir();
  const a = makePair(dir);
  place(a.authority, 0, 0, 0, 1);
  a.persistence.save();

  fs.writeFileSync(path.join(dir, 'world.json'), Buffer.from('{ this is not json'));
  const b = makePair(dir);
  const restored = b.persistence.load();

  assert.equal(restored, false, 'load reports failure rather than throwing');
  assert.ok(b.persistence.stats.recovered, 'and records why');
  assert.ok(fs.existsSync(path.join(dir, 'world.json.corrupt')),
    'the only copy of the world is moved aside, not deleted');
});

test('a truncated but valid-looking save does not half-load', () => {
  const dir = tmpDir();
  const a = makePair(dir);
  for (let i = 0; i < 20; i++) place(a.authority, i, 0, 0, 1);
  a.persistence.save();

  // Chop the file in half: parses as gzip failure or JSON failure, never as a
  // complete world.
  const full = fs.readFileSync(path.join(dir, 'world.json'));
  fs.writeFileSync(path.join(dir, 'world.json'), full.subarray(0, Math.floor(full.length / 2)));

  const b = makePair(dir);
  assert.equal(b.persistence.load(), false);
  assert.equal(occupied(b.authority), 0, 'no partial world is adopted');
});

test('an unsupported save version is moved aside rather than misread', () => {
  const dir = tmpDir();
  const a = makePair(dir);
  place(a.authority, 0, 0, 0, 1);
  a.persistence.save();

  const raw = JSON.parse(require_zlib().gunzipSync(fs.readFileSync(path.join(dir, 'world.json'))).toString());
  raw.version = 999;
  fs.writeFileSync(path.join(dir, 'world.json'), require_zlib().gzipSync(Buffer.from(JSON.stringify(raw))));

  const b = makePair(dir);
  assert.equal(b.persistence.load(), false);
  assert.ok(/version/.test(b.persistence.stats.recovered), 'and says so');
  assert.ok(fs.existsSync(path.join(dir, 'world.json.v999')));
});

test('a chunk with the wrong voxel count is skipped, not loaded', () => {
  // A chunk sized wrong means the save is inconsistent; adopting it would mean
  // every later index write into it lands nowhere.
  const dir = tmpDir();
  const a = makePair(dir);
  place(a.authority, 0, 0, 0, 1);
  a.persistence.save();

  const zlib = require_zlib();
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'world.json'))).toString());
  raw.chunks[0].cells = Buffer.from([1, 2, 3, 4]).toString('base64');
  fs.writeFileSync(path.join(dir, 'world.json'), zlib.gzipSync(Buffer.from(JSON.stringify(raw))));

  const b = makePair(dir);
  b.persistence.load();
  assert.equal(b.authority.chunks.size, 0, 'the bad chunk is not adopted');
  assert.ok(b.persistence.stats.recovered, 'and the problem is recorded');
});

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

test('a clean world is not rewritten on every tick', () => {
  // Bots commit constantly. If an unchanged world still wrote on the timer, a
  // long-running server would do continuous disk I/O for no reason.
  const dir = tmpDir();
  const { persistence } = makePair(dir);
  persistence.save();
  const before = persistence.stats.saves;

  persistence.maybeSave(Date.now());
  persistence.maybeSave(Date.now());
  assert.equal(persistence.stats.saves, before, 'not dirty, so no write');
});

test('markDirty makes the next tick save', () => {
  const dir = tmpDir();
  const { authority, persistence } = makePair(dir);
  persistence.save();
  const before = persistence.stats.saves;

  place(authority, 0, 0, 0, 1);
  persistence.markDirty();
  assert.equal(persistence.maybeSave(Date.now()), true);
  assert.equal(persistence.stats.saves, before + 1);
  assert.equal(persistence.dirty, false, 'and the flag clears');
});

test('the debounce suppresses a second write inside the interval', () => {
  // This needs a real interval -- makePair uses 0 so every other test writes
  // immediately, which would make the debounce untestable.
  const dir = tmpDir();
  const authority = new Authority();
  const persistence = new Persistence({ authority, dir, intervalMs: 60_000 });
  place(authority, 0, 0, 0, 1);
  persistence.markDirty();
  persistence.save(); // resets lastSaveAt

  place(authority, 1, 0, 0, 1);
  persistence.markDirty();
  assert.equal(persistence.maybeSave(Date.now()), false, 'inside the interval');
  assert.equal(persistence.maybeSave(Date.now() + 120_000), true, 'outside it');
});

test('saveNow bypasses the debounce, so shutdown does not lose the last edits', () => {
  const dir = tmpDir();
  const { authority, persistence } = makePair(dir);
  persistence.save();

  place(authority, 5, 3, 5, 6);
  persistence.markDirty();
  assert.equal(persistence.saveNow(), true);
  assert.equal(persistence.dirty, false);
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

test('no temp file is left behind after a successful save', () => {
  // The save is written to a temp path then renamed. A leftover temp means the
  // rename did not happen and the next save could pick up a stale file.
  const dir = tmpDir();
  const { authority, persistence } = makePair(dir);
  place(authority, 0, 0, 0, 1);
  persistence.save();
  assert.equal(fs.existsSync(path.join(dir, 'world.json.tmp')), false);
});

test('the live save is replaced whole, never appended to', () => {
  const dir = tmpDir();
  const a = makePair(dir);
  for (let i = 0; i < 30; i++) place(a.authority, i, 0, 0, 1);
  a.persistence.save();
  const firstSize = fs.statSync(path.join(dir, 'world.json')).size;

  a.authority.chunks.clear(); // a much smaller world
  a.persistence.save();
  const secondSize = fs.statSync(path.join(dir, 'world.json')).size;

  assert.ok(secondSize < firstSize, 'the file shrank, so it was replaced not appended');
  const b = makePair(dir);
  b.persistence.load();
  assert.equal(occupied(b.authority), 0, 'and reflects the smaller world');
});

// ---------------------------------------------------------------------------

function require_zlib() {
  return zlibModule;
}
import * as zlibModule from 'node:zlib';
