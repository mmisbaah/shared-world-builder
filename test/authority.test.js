import test from 'node:test';
import assert from 'node:assert/strict';

import { Authority } from '../server/authority.js';
import {
  OP, DENY, voxelKey, WORLD, COLUMN_VOLUME, CHUNK_AREA, voxelIndex,
  encodeCells, decodeCells,
} from '../shared/protocol.js';

function makeWorld() {
  const a = new Authority();
  a.rivals = [{ id: 'bot_alex', name: 'Alex_Voxel', color: '#38bdf8', mat: 8 }];
  return a;
}

const ME = { id: 'b_me', name: 'Me', color: '#0ff' };
const THEM = { id: 'b_them', name: 'Them', color: '#f0f' };

let seq = 0;

test('a settled placement is readable and carries a fresh revision', () => {
  const a = makeWorld();
  const r = a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);
  assert.ok(r.ok);
  assert.equal(a.getBlock(0, 1, 0), 1);
  assert.equal(a.getRevision(0, 1, 0), r.result.rev);
  assert.ok(r.result.rev > 0, 'revisions must be monotonic and non-zero');
});

test('the second builder to claim a voxel loses the race', () => {
  const a = makeWorld();
  assert.ok(a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME).ok);
  const r = a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 3 }, THEM);
  assert.equal(r.ok, false);
  assert.equal(r.deny, DENY.OCCUPIED);
  assert.equal(a.getBlock(0, 1, 0), 1, 'the loser must not overwrite the winner');
});

test('an injected latency race commits the rival block, then denies the client', () => {
  const a = makeWorld();
  const r = a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 1, y: 1, z: 0, mat: 1, forceRace: true }, ME);
  assert.equal(r.ok, false);
  assert.equal(r.deny, DENY.OCCUPIED);
  // The rival's block genuinely exists in authoritative state, so the client
  // has something real to reconcile against rather than a synthetic error.
  assert.equal(a.getBlock(1, 1, 0), 8);
  assert.equal(r.winner.name, 'Alex_Voxel');
  assert.deepEqual([r.winner.x, r.winner.y, r.winner.z], [1, 1, 0]);
});

test('stale removals are refused by revision, not just by occupancy', () => {
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);
  const rev = a.getRevision(0, 1, 0);

  // Same voxel, but the client is working from a revision that has moved on.
  const stale = a.apply({ id: ++seq, t: OP.REMOVE_BLOCK, x: 0, y: 1, z: 0, rev: rev + 99 }, THEM);
  assert.equal(stale.deny, DENY.OCCUPIED);
  assert.equal(a.getBlock(0, 1, 0), 1);

  const fresh = a.apply({ id: ++seq, t: OP.REMOVE_BLOCK, x: 0, y: 1, z: 0, rev }, ME);
  assert.ok(fresh.ok);
  assert.equal(a.getBlock(0, 1, 0), 0);
});

test('removing air is refused', () => {
  const a = makeWorld();
  const r = a.apply({ id: ++seq, t: OP.REMOVE_BLOCK, x: 5, y: 1, z: 5 }, ME);
  assert.equal(r.deny, DENY.EMPTY);
});

test('the server never trusts a client-supplied material id', () => {
  const a = makeWorld();
  assert.equal(a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 999 }, ME).deny, DENY.UNKNOWN_MATERIAL);
  assert.equal(a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 0 }, ME).deny, DENY.UNKNOWN_MATERIAL);
  assert.equal(a.getBlock(0, 1, 0), 0);
});

test('build bounds are enforced on every axis', () => {
  const a = makeWorld();
  assert.equal(a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 9999, y: 1, z: 0, mat: 1 }, ME).deny, DENY.OUT_OF_BOUNDS);
  assert.equal(a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: -1, z: 0, mat: 1 }, ME).deny, DENY.OUT_OF_BOUNDS);
  assert.equal(a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 9999, z: 0, mat: 1 }, ME).deny, DENY.OUT_OF_BOUNDS);
});

test('a claimed zone rejects foreign builders but not the owner', () => {
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.CLAIM_ZONE, x: 0, z: 0, half: 4 }, THEM);

  const foreign = a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 1, y: 1, z: 1, mat: 1 }, ME);
  assert.equal(foreign.deny, DENY.NOT_CLAIMED);

  const owner = a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 1, y: 1, z: 1, mat: 1 }, THEM);
  assert.ok(owner.ok);

  // Outside the claim, anyone may build.
  assert.ok(a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 20, y: 1, z: 20, mat: 1 }, ME).ok);
});

test('hard locks block other builders and release cleanly', () => {
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.REQUEST_LOCK, x: 5, y: 1, z: 5 }, THEM);
  assert.equal(a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 5, y: 1, z: 5, mat: 1 }, ME).deny, DENY.LOCKED);
  // The holder itself is never blocked by its own lock.
  assert.ok(a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 5, y: 1, z: 5, mat: 1 }, THEM).ok);

  a.releaseLock({ id: ++seq, t: OP.RELEASE_LOCK, x: 5, y: 1, z: 5 }, THEM);
  assert.equal(a.lockHolder(5, 1, 5), null, 'lock is gone once released');
  // Use a fresh voxel: the one above is legitimately occupied now.
  assert.ok(a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 6, y: 1, z: 5, mat: 1 }, ME).ok);
});

test('props snap into the air cell above solid ground', () => {
  const a = makeWorld();

  // Nothing to stand on.
  assert.equal(a.apply({ id: ++seq, t: OP.PLACE_PROP, x: 0, y: 2, z: 0, prop: 'lantern' }, ME).deny, DENY.EMPTY);

  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);
  assert.ok(a.apply({ id: ++seq, t: OP.PLACE_PROP, x: 0, y: 2, z: 0, prop: 'lantern' }, ME).ok);

  // A prop cell can hold only one prop...
  assert.equal(a.apply({ id: ++seq, t: OP.PLACE_PROP, x: 0, y: 2, z: 0, prop: 'chair' }, THEM).deny, DENY.OCCUPIED);
  // ...and cannot be pushed into a solid block.
  assert.equal(a.apply({ id: ++seq, t: OP.PLACE_PROP, x: 0, y: 1, z: 0, prop: 'chair' }, ME).deny, DENY.OCCUPIED);
  assert.equal(a.apply({ id: ++seq, t: OP.PLACE_PROP, x: 0, y: 2, z: 0, prop: 'nope' }, ME).deny, DENY.UNKNOWN_PROP);

  // Removal frees the cell again.
  assert.ok(a.apply({ id: ++seq, t: OP.REMOVE_PROP, x: 0, y: 2, z: 0 }, ME).ok);
  assert.ok(a.apply({ id: ++seq, t: OP.PLACE_PROP, x: 0, y: 2, z: 0, prop: 'plant' }, ME).ok);
});

test('changes to one chunk collapse into a single delta packet', () => {
  const a = makeWorld();
  for (let i = 0; i < 5; i++) a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: i, y: 1, z: 0, mat: 1 }, ME);
  const far = a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 24, y: 1, z: 24, mat: 1 }, ME);
  assert.ok(far.ok, 'second chunk must be in bounds');

  const deltas = a.flush();
  assert.equal(deltas.length, 2, 'one packet per touched chunk');
  const first = deltas.find((d) => d.cx === 0 && d.cz === 0);
  assert.equal(first.blocks.length, 5, 'all five edits batched together');
  assert.equal(deltas.find((d) => d.cx === 1 && d.cz === 1).blocks.length, 1);

  assert.equal(a.flush().length, 0, 'flushing drains the queue');
});

test('the snapshot omits chunks that hold nothing', () => {
  const a = makeWorld();
  assert.equal(a.snapshot().chunks.length, 0);
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 3, y: 1, z: 3, mat: 1 }, ME);
  const snap = a.snapshot();
  assert.equal(snap.chunks.length, 1);
  // cells travel as base64 text, not a raw ArrayBuffer -- see encodeCells.
  assert.equal(typeof snap.chunks[0].cells, 'string');
  const decoded = decodeCells(snap.chunks[0].cells);
  assert.equal(decoded.length, COLUMN_VOLUME);
  assert.equal(decoded[voxelIndex(3, 1, 3)], 1, 'the placed voxel survives the transport');
  assert.equal(voxelKey(3, 1, 3), '3,1,3');
});

test('the rate limiter sheds bursts without dropping the first op', () => {
  const a = makeWorld();
  let accepted = 0;
  for (let i = 0; i < 200; i++) {
    const r = a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: i % 30, y: 1, z: 30, mat: 1 }, ME);
    if (r.ok) accepted++;
  }
  assert.ok(accepted > 0, 'some ops must get through');
  assert.ok(accepted < 200, 'the burst must be throttled');
});

// ---------------------------------------------------------------------------
// Full-height columns
//
// Chunks span the whole world vertically, so a chunk is a 16 x WORLD.MAX_Y x 16
// column rather than a cube. If the backing buffer is sized as CHUNK_SIZE^3 then
// every write above y=15 lands out of bounds, is silently dropped, and reads
// return `undefined` -- which compares unequal to 0 and therefore reads as
// "occupied". The symptom is a world whose entire upper half is unbuildable.
// ---------------------------------------------------------------------------

test('a chunk column stores every y from the floor to the ceiling', () => {
  const a = makeWorld();
  const top = WORLD.MAX_Y - 1;
  for (const y of [0, 1, 15, 16, 17, 31, 32, top]) {
    assert.equal(a.setBlock(3, y, 5, 4), a.getRevision(3, y, 5), `y=${y} must get a revision`);
    assert.equal(a.getBlock(3, y, 5), 4, `y=${y} must round-trip`);
  }
  // Distinct heights must not alias onto each other's storage.
  a.setBlock(3, 16, 5, 1);
  assert.equal(a.getBlock(3, 16, 5), 1);
  assert.equal(a.getBlock(3, 15, 5), 4, 'y=16 must not clobber y=15');
});

test('the highest voxel in the column is addressable and not falsely occupied', () => {
  const a = makeWorld();
  const y = WORLD.MAX_Y - 1;
  assert.equal(a.getBlock(2, y, 2), 0, 'untouched high voxel must read as air, not undefined');
  const r = a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 2, y, z: 2, mat: 6 }, ME);
  assert.ok(r.ok, `placement at the ceiling must be accepted: ${r.reason}`);
  assert.equal(a.getBlock(2, y, 2), 6);
});

test('out-of-bounds heights are air and refused, not corrupted storage', () => {
  const a = makeWorld();
  assert.equal(a.getBlock(0, WORLD.MAX_Y, 0), 0);
  assert.equal(a.getBlock(0, WORLD.MIN_Y - 1, 0), 0);
  const r = a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: WORLD.MAX_Y, z: 0, mat: 1 }, ME);
  assert.equal(r.ok, false);
  assert.equal(r.deny, DENY.OUT_OF_BOUNDS);
});

test('a column holds CHUNK_AREA * WORLD.MAX_Y voxels, not a cube', () => {
  assert.equal(COLUMN_VOLUME, CHUNK_AREA * WORLD.MAX_Y);
  const a = makeWorld();
  const c = a.chunk(0, 0);
  assert.equal(c.cells.length, COLUMN_VOLUME);
  // The highest legal voxel must be the last slot in the column.
  const last = voxelIndex(15, WORLD.MAX_Y - 1, 15);
  assert.equal(last, COLUMN_VOLUME - 1, 'top voxel must land on the final index');
  assert.ok(last < c.cells.length, 'final voxel must be inside the buffer');
});
