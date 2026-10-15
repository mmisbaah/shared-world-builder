import test from 'node:test';
import assert from 'node:assert/strict';

import { Authority } from '../server/authority.js';
import {
  OP, DENY, voxelKey, WORLD, COLUMN_VOLUME, CHUNK_AREA, voxelIndex,
  encodeCells, decodeCells, UNDO_DEPTH,
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
  assert.equal(a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0.5, y: 1, z: 0, mat: 1 }, ME).deny, DENY.OUT_OF_BOUNDS);
  assert.equal(a.apply({ id: ++seq, t: OP.REQUEST_LOCK, x: 0, y: 1.5, z: 0 }, ME).deny, DENY.OUT_OF_BOUNDS);
  assert.equal(a.chunks.size, 0, 'invalid coordinates must not create a chunk');
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

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------
//
// The property that matters is not "can a placement be reverted" but "can a
// placement be reverted without touching anyone else's work". This is a shared
// world: a client-side undo would be a client deciding to write an old value
// over a voxel it may no longer own, which is exactly the forgery this server
// is built to refuse. So the stack is the server's, keyed by builder, and the
// revision guard is what stops an undo from discarding somebody newer.

test('undo reverts your own last placement', () => {
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);
  assert.equal(a.getBlock(0, 1, 0), 1);

  const r = a.apply({ id: ++seq, t: OP.UNDO }, ME);
  assert.ok(r.ok, `undo must be accepted: ${r.reason}`);
  assert.equal(a.getBlock(0, 1, 0), 0, 'the placement is taken back');
  assert.deepEqual([r.result.x, r.result.y, r.result.z], [0, 1, 0],
    'the ack names the voxel so the sound can be spatialised');
  assert.equal(r.result.mat, 0);
});

test('undo puts back the block a removal lifted', () => {
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 2, y: 3, z: 1, mat: 6 }, ME);
  a.apply({ id: ++seq, t: OP.REMOVE_BLOCK, x: 2, y: 3, z: 1 }, ME);
  assert.equal(a.getBlock(2, 3, 1), 0);

  const r = a.apply({ id: ++seq, t: OP.UNDO }, ME);
  assert.ok(r.ok, `undo must be accepted: ${r.reason}`);
  assert.equal(a.getBlock(2, 3, 1), 6, 'the original material comes back, not a guess');
  assert.equal(r.result.mat, 6);
});

test('repeated undo walks back through edits instead of toggling', () => {
  // The failure this exists for: if an undo recorded what it overwrote, the
  // second press would revert the revert, and the player would stand in place
  // flipping one block while believing they were rewinding.
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 1, y: 1, z: 0, mat: 3 }, ME);
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 2, y: 1, z: 0, mat: 6 }, ME);

  assert.ok(a.apply({ id: ++seq, t: OP.UNDO }, ME).ok);
  assert.equal(a.getBlock(2, 1, 0), 0, 'the newest goes first');
  assert.equal(a.getBlock(1, 1, 0), 3, 'and the others are left alone');

  assert.ok(a.apply({ id: ++seq, t: OP.UNDO }, ME).ok, 'the second press moves on');
  assert.equal(a.getBlock(1, 1, 0), 0);
  assert.equal(a.getBlock(0, 1, 0), 1, 'rather than coming back around to the first');

  assert.ok(a.apply({ id: ++seq, t: OP.UNDO }, ME).ok);
  assert.equal(a.getBlock(0, 1, 0), 0);
  assert.equal(a.apply({ id: ++seq, t: OP.UNDO }, ME).deny, DENY.EMPTY, 'and now spent');
});

test('two edits to one voxel can both be walked back', () => {
  // The second entry guards on a revision the first undo has already moved. If
  // that were left stale, the second press would refuse over a change the player
  // themselves made a moment earlier.
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 3, y: 2, z: 3, mat: 1 }, ME);
  a.apply({ id: ++seq, t: OP.REMOVE_BLOCK, x: 3, y: 2, z: 3 }, ME);
  assert.equal(a.getBlock(3, 2, 3), 0);

  assert.ok(a.apply({ id: ++seq, t: OP.UNDO }, ME).ok, 'the removal is undone');
  assert.equal(a.getBlock(3, 2, 3), 1);

  const again = a.apply({ id: ++seq, t: OP.UNDO }, ME);
  assert.ok(again.ok, `the placement behind it must still be reachable: ${again.reason}`);
  assert.equal(a.getBlock(3, 2, 3), 0);
});

test('undo cannot discard a newer edit by another builder', () => {
  // The case that justifies undo living on the server at all. Reverting my
  // placement here would write air over their gold block.
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 4, y: 2, z: 4, mat: 1 }, ME);
  a.apply({ id: ++seq, t: OP.REMOVE_BLOCK, x: 4, y: 2, z: 4, rev: a.getRevision(4, 2, 4) }, THEM);
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 4, y: 2, z: 4, mat: 5 }, THEM);

  const r = a.apply({ id: ++seq, t: OP.UNDO }, ME);
  assert.equal(r.ok, false, 'refused, because the voxel is no longer mine to set');
  assert.equal(r.deny, DENY.OCCUPIED);
  assert.equal(a.getBlock(4, 2, 4), 5, 'their block survives');
});

test('undo never reaches an edit the caller did not make', () => {
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, THEM);

  const r = a.apply({ id: ++seq, t: OP.UNDO }, ME);
  assert.equal(r.ok, false);
  assert.equal(r.deny, DENY.EMPTY, 'ME has no history of their own to spend');
  assert.equal(a.getBlock(0, 1, 0), 1, 'their block is untouched');
  // The request carries no coordinates, so there is no way to name one either.
  assert.equal(a.undoStacks.get(THEM.id).length, 1, 'their own stack is intact');
});

test('a refusal spends the entry, so the stack cannot freeze behind it', () => {
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 1, y: 1, z: 0, mat: 1 }, ME);
  // Somebody else takes the top entry's voxel out from under it.
  a.apply({ id: ++seq, t: OP.REMOVE_BLOCK, x: 1, y: 1, z: 0, rev: a.getRevision(1, 1, 0) }, THEM);

  assert.equal(a.apply({ id: ++seq, t: OP.UNDO }, ME).ok, false, 'top is unrevertible');

  const next = a.apply({ id: ++seq, t: OP.UNDO }, ME);
  assert.ok(next.ok, `the entry behind it must still be reachable: ${next.reason}`);
  assert.equal(a.getBlock(0, 1, 0), 0);
  assert.equal(a.getBlock(1, 1, 0), 0, 'the refused one was spent, not applied');
});

test('undo history is capped and drops the oldest edits first', () => {
  const a = makeWorld();
  const total = UNDO_DEPTH + 5;
  for (let i = 0; i < total; i++) {
    a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: i, y: 1, z: 0, mat: 1 }, ME);
  }
  assert.equal(a.undoStacks.get(ME.id).length, UNDO_DEPTH,
    'the stack is bounded no matter how long the session runs');

  for (let i = 0; i < UNDO_DEPTH; i++) {
    assert.ok(a.apply({ id: ++seq, t: OP.UNDO }, ME).ok, `undo ${i}`);
  }
  assert.equal(a.apply({ id: ++seq, t: OP.UNDO }, ME).deny, DENY.EMPTY);

  for (let i = 0; i < 5; i++) {
    assert.equal(a.getBlock(i, 1, 0), 1, 'fell off the bottom and was never undone');
  }
  for (let i = 5; i < total; i++) {
    assert.equal(a.getBlock(i, 1, 0), 0, 'undone');
  }
});

test('undoing a prop placement takes the prop, not the ground it stood on', () => {
  const a = makeWorld();
  // Props need solid ground beneath them.
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 0, z: 0, mat: 1 }, ME);
  const key = voxelKey(0, 1, 0);

  const put = a.apply({ id: ++seq, t: OP.PLACE_PROP, x: 0, y: 1, z: 0, prop: 'lantern', rot: 3 }, ME);
  assert.ok(put.ok, put.reason);
  assert.equal(a.chunk(0, 0).props.has(key), true);

  const takenBack = a.apply({ id: ++seq, t: OP.UNDO }, ME);
  assert.ok(takenBack.ok, `undoing a placement must work: ${takenBack.reason}`);
  assert.equal(a.chunk(0, 0).props.has(key), false, 'the lantern is taken back');
  assert.equal(a.getBlock(0, 0, 0), 1, 'the block it was standing on is untouched');
});

test('undoing a prop removal puts it back with its rotation', () => {
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 0, z: 0, mat: 1 }, ME);
  const key = voxelKey(0, 1, 0);
  a.apply({ id: ++seq, t: OP.PLACE_PROP, x: 0, y: 1, z: 0, prop: 'chair', rot: 3 }, ME);
  a.apply({ id: ++seq, t: OP.REMOVE_PROP, x: 0, y: 1, z: 0 }, ME);
  assert.equal(a.chunk(0, 0).props.has(key), false);

  const r = a.apply({ id: ++seq, t: OP.UNDO }, ME);
  assert.ok(r.ok, `undoing a removal must work: ${r.reason}`);
  const back = a.chunk(0, 0).props.get(key);
  assert.equal(back.prop, 'chair');
  assert.equal(back.rot, 3, 'orientation survives the round trip');
  assert.equal(back.by, ME.id, 'and so does attribution');
});

test('undo cannot delete a prop somebody else put in the same spot', () => {
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 0, z: 0, mat: 1 }, ME);
  const key = voxelKey(0, 1, 0);
  a.apply({ id: ++seq, t: OP.PLACE_PROP, x: 0, y: 1, z: 0, prop: 'lantern', rot: 0 }, ME);

  // Mine comes out, theirs goes in.
  a.apply({ id: ++seq, t: OP.REMOVE_PROP, x: 0, y: 1, z: 0 }, ME);
  const theirs = a.apply({ id: ++seq, t: OP.PLACE_PROP, x: 0, y: 1, z: 0, prop: 'chair', rot: 1 }, THEM);
  assert.ok(theirs.ok);

  const r = a.apply({ id: ++seq, t: OP.UNDO }, ME);
  assert.equal(r.ok, false, 'it is no longer my lantern');
  assert.equal(a.chunk(0, 0).props.get(key).prop, 'chair', 'their chair stands');
});

// ---------------------------------------------------------------------------
// Contribution tally (attribution on screen)
// ---------------------------------------------------------------------------

test('every edit counts, for whoever made it', () => {
  const a = makeWorld();
  assert.equal(a.edits.size, 0, 'a world nobody has touched credits nobody');

  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);
  assert.equal(a.edits.get(ME.id), 1);

  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 1, y: 1, z: 0, mat: 1 }, ME);
  a.apply({ id: ++seq, t: OP.REMOVE_BLOCK, x: 1, y: 1, z: 0 }, ME);
  assert.equal(a.edits.get(ME.id), 3, 'a removal is work too');

  // Props need solid ground beneath them, so that is two more edits before the
  // prop itself: the ground counts as much as the chair standing on it.
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 5, y: 0, z: 0, mat: 1 }, ME);
  const put = a.apply({ id: ++seq, t: OP.PLACE_PROP, x: 5, y: 1, z: 0, prop: 'chair', rot: 0 }, ME);
  assert.ok(put.ok, put.reason);
  assert.equal(a.edits.get(ME.id), 5);
});

test('two builders writing in one tick are counted separately', () => {
  // The hazard: deltas are cumulative across the tick, so both of these share a
  // packet. Without clearing the writer first, the second edit would never be
  // observed at all and the first would be credited for both.
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 1, y: 1, z: 0, mat: 1 }, THEM);
  assert.equal(a.edits.get(ME.id), 1, 'not credited for their edit');
  assert.equal(a.edits.get(THEM.id), 1, 'and not skipped either');
});

test('a record that never names a writer credits nobody', () => {
  // A future call site that forgot `d.by` must contribute nothing rather than
  // silently crediting whoever wrote into that packet before it.
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);
  assert.equal(a.edits.get(ME.id), 1);

  a.record(0, 0, (d) => { d.blocks.push([1, 1, 99]); });
  assert.equal(a.edits.get(ME.id), 1, 'and cannot inflate an unrelated builder');
  assert.equal(a.edits.size, 1);
});

test('bot commits are counted like anybody else', () => {
  // They never produce an operation, so a tally hung off `apply()` would leave
  // the four busiest hands in this world out of the attribution entirely.
  const a = makeWorld();
  const bot = a.rivals[0];
  assert.ok(a.commitAs(bot, 0, 1, 0, 1));
  assert.ok(a.commitAs(bot, 1, 1, 0, 1));
  assert.ok(a.removeAs(bot, 0, 1, 0));
  assert.equal(a.edits.get(bot.id), 3);
});

test('undo is an edit and is counted like any other', () => {
  const a = makeWorld();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);
  a.apply({ id: ++seq, t: OP.UNDO }, ME);
  assert.equal(a.edits.get(ME.id), 2, 'reverting is still touching the world');
});

// ---------------------------------------------------------------------------
// Time-lapse recording
//
// These are the only tests that exercise `history.start()`, and that is the
// point: a fresh Authority has recording off, so a test that forgets to start
// it gets an empty log and cannot tell the difference between "broken" and
// "not asked".
// ---------------------------------------------------------------------------

/** A fresh Authority with recording switched on, as the server does at boot. */
function makeRecording() {
  const a = makeWorld();
  a.history.start();
  return a;
}

test('a placement is recorded with what it replaced', () => {
  const a = makeRecording();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);

  assert.equal(a.history.length, 1);
  assert.deepEqual(
    (({ t, kind, x, y, z, from, to, by }) => ({ kind, x, y, z, from, to, by }))(a.history.at(0)),
    { kind: 'block', x: 0, y: 1, z: 0, from: 0, to: 1, by: ME.id },
  );
});

test('every change records what it replaced, in both directions', () => {
  // A voxel can only be written when it is empty, so "overwriting" is really
  // place, lift, place again -- and each of the three has to carry its own
  // `from`. Miss one and the time-lapse can still play forwards while having
  // no idea what to put back, which is the only direction that matters.
  const a = makeRecording();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);
  a.apply({ id: ++seq, t: OP.REMOVE_BLOCK, x: 0, y: 1, z: 0 }, ME);
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 3 }, THEM);

  assert.equal(a.history.length, 3, 'a refusal records nothing, so all three landed');
  assert.deepEqual(
    a.history.slice(0, 3).map((e) => [e.from, e.to, e.by]),
    [[0, 1, ME.id], [1, 0, ME.id], [0, 3, THEM.id]],
    'each change names what was there, what replaced it, and who',
  );
});

test('each builder is recorded as themselves', () => {
  const a = makeRecording();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 1, y: 1, z: 0, mat: 1 }, THEM);
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 2, y: 1, z: 0, mat: 1 }, ME);

  assert.deepEqual(
    a.history.slice(0, 3).map((e) => e.by),
    [ME.id, THEM.id, ME.id],
  );
});

test('a refusal records nothing', () => {
  const a = makeRecording();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 3 }, THEM);
  assert.equal(a.history.length, 1, 'a denied write never touched a voxel');
});

test('an undo is recorded as the change it is', () => {
  // Reverting is still touching the world, and a time-lapse that skipped it
  // would show a block vanishing with no explanation of when or why.
  const a = makeRecording();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);
  a.apply({ id: ++seq, t: OP.UNDO }, ME);

  assert.equal(a.history.length, 2);
  assert.deepEqual(
    (({ kind, x, y, z, from, to, by }) => ({ kind, x, y, z, from, to, by }))(a.history.at(1)),
    { kind: 'block', x: 0, y: 1, z: 0, from: 1, to: 0, by: ME.id },
  );
});

test('a prop is recorded with the record itself, in both directions', () => {
  const a = makeRecording();
  // Props need solid ground beneath, so the plinth goes down first. It is
  // deliberately left standing: the two frames checked here are about the
  // prop, and a ground block that vanished mid-test would make the assertion
  // pass for the wrong reason.
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 1, z: 0, mat: 1 }, ME);

  a.apply({ id: ++seq, t: OP.PLACE_PROP, x: 0, y: 2, z: 0, prop: 'lantern', rot: 2 }, ME);
  const placed = a.history.at(1);
  assert.equal(placed.kind, 'prop');
  assert.equal(placed.from, null, 'there was nothing here');
  assert.equal(placed.to.prop, 'lantern');
  assert.equal(placed.to.rot, 2, 'the rotation has to survive, or the frame is wrong');
  assert.equal(placed.to.by, ME.id);

  a.apply({ id: ++seq, t: OP.REMOVE_PROP, x: 0, y: 2, z: 0 }, THEM);
  const removed = a.history.at(2);
  assert.equal(removed.from.prop, 'lantern', 'the record is what comes back');
  assert.equal(removed.from.rot, 2);
  assert.equal(removed.to, null);
  assert.equal(removed.by, THEM.id);
});

test('nothing is recorded before the history is started', () => {
  // Island generation writes thousands of cells through this exact path. A log
  // that began earlier would open on terrain nobody built and spend roughly ten
  // thousand entries before reaching the first thing a person actually did.
  const a = makeWorld();
  for (let y = 1; y <= 4; y++) a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y, z: 0, mat: 1 }, ME);
  assert.equal(a.history.length, 0);

  a.history.start();
  a.apply({ id: ++seq, t: OP.PLACE_BLOCK, x: 0, y: 5, z: 0, mat: 1 }, ME);
  assert.equal(a.history.length, 1, 'and it starts from exactly here');
  assert.equal(a.history.at(0).y, 5);
});

test('a write that changes nothing is not recorded', () => {
  // It would undo to itself, so the scrubber could never show it either way --
  // while still spending a slot and costing an application on every drag.
  const a = makeRecording();
  a.setBlock(0, 1, 0, 2, ME.id);
  assert.equal(a.history.length, 1);
  a.setBlock(0, 1, 0, 2, ME.id);
  assert.equal(a.history.length, 1, 'the same material in as out is not a change');
});
