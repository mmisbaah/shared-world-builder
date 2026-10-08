import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../public/src/world/world.js';
import { raycastVoxels, raycastProps, raySlab, pick, placementCell } from '../public/src/interact/picking.js';
import { WORLD } from '../shared/protocol.js';

const STONE = 1;
const GLASS = 9;

const dir = (x, y, z) => {
  const len = Math.hypot(x, y, z);
  return { x: x / len, y: y / len, z: z / len };
};

function flatWorld() {
  const w = new World();
  w.column(0, 0);
  // A single block floating at y = 5 in cell (3, 3).
  w.setAuthoritative(3, 5, 3, STONE, 1);
  return w;
}

// ---------------------------------------------------------------------------
// Block traversal
// ---------------------------------------------------------------------------

test('a ray straight down hits the top face of a block', () => {
  const w = flatWorld();
  const hit = raycastVoxels(w, { x: 3.5, y: 12, z: 3.5 }, dir(0, -1, 0));
  assert.ok(hit, 'must hit the block');
  assert.deepEqual([hit.x, hit.y, hit.z], [3, 5, 3]);
  assert.deepEqual([hit.nx, hit.ny, hit.nz], [0, 1, 0], 'entered through the top face');
  assert.equal(hit.mat, STONE);
  assert.equal(hit.distance, 6, '12 - 6 (top of the block) = 6');
});

test('a ray straight up hits the bottom face', () => {
  const w = flatWorld();
  const hit = raycastVoxels(w, { x: 3.5, y: 1, z: 3.5 }, dir(0, 1, 0));
  assert.ok(hit);
  assert.deepEqual([hit.nx, hit.ny, hit.nz], [0, -1, 0]);
});

test('each entry face reports the axis it crossed', () => {
  const w = flatWorld();
  const cases = [
    { from: { x: 3.5, y: 5.5, z: 10 }, d: dir(0, 0, -1), n: [0, 0, 1] },
    { from: { x: 10, y: 5.5, z: 3.5 }, d: dir(-1, 0, 0), n: [1, 0, 0] },
    { from: { x: 3.5, y: 5.5, z: -4 }, d: dir(0, 0, 1), n: [0, 0, -1] },
    { from: { x: -4, y: 5.5, z: 3.5 }, d: dir(1, 0, 0), n: [-1, 0, 0] },
  ];
  for (const c of cases) {
    const hit = raycastVoxels(w, c.from, c.d);
    assert.ok(hit, `from ${JSON.stringify(c.from)}`);
    assert.deepEqual([hit.x, hit.y, hit.z], [3, 5, 3]);
    assert.deepEqual([hit.nx, hit.ny, hit.nz], c.n);
  }
});

test('a ray that starts inside a block reports zero distance and no face', () => {
  const w = flatWorld();
  const hit = raycastVoxels(w, { x: 3.5, y: 5.5, z: 3.5 }, dir(1, 0, 0));
  assert.ok(hit);
  assert.equal(hit.distance, 0);
  assert.deepEqual([hit.nx, hit.ny, hit.nz], [0, 0, 0], 'no face was entered through');
});

test('a ray that misses everything returns null', () => {
  const w = flatWorld();
  assert.equal(raycastVoxels(w, { x: 12.5, y: 12, z: 12.5 }, dir(0, -1, 0)), null);
  assert.equal(raycastVoxels(w, { x: 3.5, y: 12, z: 3.5 }, dir(0, 1, 0)), null);
});

test('maxDist cuts the ray short', () => {
  const w = flatWorld();
  assert.ok(raycastVoxels(w, { x: 3.5, y: 12, z: 3.5 }, dir(0, -1, 0), { maxDist: 10 }));
  assert.equal(
    raycastVoxels(w, { x: 3.5, y: 12, z: 3.5 }, dir(0, -1, 0), { maxDist: 5 }),
    null,
    'the block is 6 units away, so a 5 unit ray must not reach it',
  );
});

test('a ray leaving the world stops instead of running forever', () => {
  const w = flatWorld();
  // Start clear of the block, so this exercises the escape rather than the
  // "origin inside a solid" case.
  assert.equal(raycastVoxels(w, { x: 12.5, y: 5.5, z: 12.5 }, dir(0, 1, 0)), null);
  assert.equal(
    raycastVoxels(w, { x: 12.5, y: WORLD.MAX_Y - 1, z: 12.5 }, dir(0, 1, 0), { maxDist: 1e6 }),
    null,
    'an unbounded ray must still stop at the ceiling',
  );
  assert.equal(raycastVoxels(w, { x: 12.5, y: 1.5, z: 12.5 }, dir(0, -1, 0), { maxDist: 1e6 }), null);
});

test('an axis-aligned ray with a zero component still advances', () => {
  const w = new World();
  w.column(0, 0);
  for (let x = 0; x < 6; x++) w.setAuthoritative(x, 2, 0, STONE, x + 1);
  // dir.y and dir.z are exactly zero, which is where naive DDA divides by zero.
  const hit = raycastVoxels(w, { x: -5.5, y: 2.5, z: 0.5 }, dir(1, 0, 0));
  assert.ok(hit);
  assert.deepEqual([hit.x, hit.y, hit.z], [0, 2, 0]);
  assert.deepEqual([hit.nx, hit.ny, hit.nz], [-1, 0, 0]);
});

test('a non-finite direction is rejected rather than looping forever', () => {
  const w = flatWorld();
  for (const bad of [{ x: NaN, y: 0, z: 0 }, { x: 0, y: Infinity, z: 0 }, { x: 0, y: 0, z: NaN }]) {
    assert.equal(raycastVoxels(w, { x: 3.5, y: 12, z: 3.5 }, bad), null);
  }
});

test('a diagonal ray finds the first block along its path', () => {
  const w = new World();
  w.column(0, 0);
  w.setAuthoritative(1, 8, 1, STONE, 1);
  w.setAuthoritative(6, 4, 6, STONE, 2);
  const hit = raycastVoxels(w, { x: 0.5, y: 9.5, z: 0.5 }, dir(1, -1, 1));
  assert.ok(hit);
  assert.deepEqual([hit.x, hit.y, hit.z], [1, 8, 1], 'the nearer block wins');
});

test('the accept filter can skip blocks', () => {
  const w = new World();
  w.column(0, 0);
  w.setAuthoritative(3, 8, 3, STONE, 1);
  w.setAuthoritative(3, 5, 3, STONE, 2);

  const hit = raycastVoxels(w, { x: 3.5, y: 14, z: 3.5 }, dir(0, -1, 0), {
    accept: (x, y) => y !== 8,
  });
  assert.deepEqual([hit.x, hit.y, hit.z], [3, 5, 3], 'the filtered block is ignored');
});

test('glass is skipped by default and pickable on request', () => {
  const w = new World();
  w.column(0, 0);
  w.setAuthoritative(3, 8, 3, GLASS, 1);
  w.setAuthoritative(3, 5, 3, STONE, 2);

  const through = raycastVoxels(w, { x: 3.5, y: 14, z: 3.5 }, dir(0, -1, 0));
  assert.deepEqual([through.y], [5], 'the ray passes through glass to the stone');

  const at = raycastVoxels(w, { x: 3.5, y: 14, z: 3.5 }, dir(0, -1, 0), { includeTranslucent: true });
  assert.deepEqual([at.y], [8], 'and stops on it when asked');
});

test('predictions are pickable, so you can build against your own ghost', () => {
  const w = flatWorld();
  w.setPredicted(3, 9, 3, STONE);
  const hit = raycastVoxels(w, { x: 3.5, y: 14, z: 3.5 }, dir(0, -1, 0));
  assert.deepEqual([hit.y], [9], 'the predicted block is hit');
});

test('a large flat surface is hit at the right distance', () => {
  const w = new World();
  // The surface spans x -8..7 and z -8..7, which needs columns cx -1/0 and
  // cz -1/0. Creating only one row of columns leaves the rest reading as air.
  for (const cx of [-1, 0]) for (const cz of [-1, 0]) w.column(cx, cz);
  for (let x = -8; x < 8; x++) for (let z = -8; z < 8; z++) w.setAuthoritative(x, 0, z, STONE, 1);

  const hit = raycastVoxels(w, { x: 0.5, y: 10.5, z: 0.5 }, dir(0, -1, 0));
  assert.ok(hit);
  assert.equal(hit.y, 0);
  assert.equal(hit.distance, 9.5, 'from y=10.5 down to the top face at y=1');
  assert.deepEqual([hit.nx, hit.ny, hit.nz], [0, 1, 0]);
});

// ---------------------------------------------------------------------------
// Slab test
// ---------------------------------------------------------------------------

test('the slab test reports the entry distance', () => {
  const origin = { x: -5, y: 0.5, z: 0.5 };
  assert.equal(raySlab(origin, dir(1, 0, 0), { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }), 5);
});

test('the slab test misses a ray parallel to and outside the box', () => {
  const origin = { x: -5, y: 9.5, z: 0.5 };
  assert.equal(raySlab(origin, dir(1, 0, 0), { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }), null);
  assert.equal(raySlab(origin, dir(1, 0, 0), { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }) ?? null, null);
});

test('the slab test returns zero when the origin is inside', () => {
  assert.equal(raySlab({ x: 0.5, y: 0.5, z: 0.5 }, dir(1, 0, 0), { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }), 0);
});

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

test('a prop is picked from above', () => {
  const w = new World();
  w.column(0, 0);
  w.setAuthoritative(3, 4, 3, STONE, 1); // ground to stand on
  w.setProp({ x: 3, y: 5, z: 3, prop: 'lantern', rot: 0, by: 'b1', rev: 1 });

  const hit = raycastProps(w, { x: 3.5, y: 12, z: 3.5 }, dir(0, -1, 0));
  assert.ok(hit, 'the lantern must be pickable');
  assert.deepEqual([hit.x, hit.y, hit.z], [3, 5, 3]);
  assert.equal(hit.prop, 'lantern');
  // The lantern is 0.75 tall, so its top is at y = 5.75.
  assert.ok(Math.abs(hit.distance - (12 - 5.75)) < 1e-6, `got ${hit.distance}`);
});

test('a ray beside a prop misses it', () => {
  const w = new World();
  w.column(0, 0);
  w.setProp({ x: 3, y: 5, z: 3, prop: 'chair', rot: 0, by: 'b1', rev: 1 });
  assert.equal(raycastProps(w, { x: 9.5, y: 12, z: 3.5 }, dir(0, -1, 0)), null);
});

test('the nearest prop wins when several line up', () => {
  const w = new World();
  w.column(0, 0);
  w.setProp({ x: 3, y: 5, z: 3, prop: 'torch', rot: 0, by: 'b1', rev: 1 });
  w.setProp({ x: 3, y: 9, z: 3, prop: 'lantern', rot: 0, by: 'b1', rev: 2 });
  const hit = raycastProps(w, { x: 3.5, y: 14, z: 3.5 }, dir(0, -1, 0));
  assert.equal(hit.y, 9, 'the higher prop is nearer the ray');
});

// ---------------------------------------------------------------------------
// Combined pick
// ---------------------------------------------------------------------------

test('a block beats a prop that is further along the ray', () => {
  const w = new World();
  w.column(0, 0);
  // The block must sit *above* the prop for it to be nearer a ray coming down
  // from y=14: block top at y=10 (4 away), plant top at y=5.65 (8.35 away).
  w.setAuthoritative(3, 9, 3, STONE, 1);
  w.setProp({ x: 3, y: 5, z: 3, prop: 'plant', rot: 0, by: 'b1', rev: 1 });

  const hit = pick(w, { x: 3.5, y: 14, z: 3.5 }, dir(0, -1, 0));
  assert.equal(hit.kind, 'block');
  assert.equal(hit.y, 9);
});

test('a prop in front of a block wins', () => {
  const w = new World();
  w.column(0, 0);
  w.setAuthoritative(3, 5, 3, STONE, 1);
  w.setProp({ x: 3, y: 9, z: 3, prop: 'plant', rot: 0, by: 'b1', rev: 1 });

  const hit = pick(w, { x: 3.5, y: 12, z: 3.5 }, dir(0, -1, 0));
  assert.equal(hit.kind, 'prop', 'the plant is above the block and so is hit first');
});

test('an empty world still yields a ground cursor', () => {
  const w = new World();
  w.column(0, 0);
  const hit = pick(w, { x: 4.5, y: 12, z: 4.5 }, dir(0, -1, 0));
  assert.ok(hit, 'a cursor is needed even over empty space');
  assert.equal(hit.kind, 'ground');
  assert.equal(hit.y, -1);
  assert.deepEqual([hit.nx, hit.ny, hit.nz], [0, 1, 0]);
});

test('looking away from the ground yields no pick at all', () => {
  const w = new World();
  w.column(0, 0);
  assert.equal(pick(w, { x: 4.5, y: 12, z: 4.5 }, dir(0, 1, 0)), null);
});

test('placementCell offsets by the entry face normal', () => {
  const w = new World();
  w.column(0, 0);
  w.setAuthoritative(3, 5, 3, STONE, 1);

  const hit = pick(w, { x: 3.5, y: 12, z: 3.5 }, dir(0, -1, 0));
  const cell = placementCell(hit);
  assert.deepEqual(cell, { x: 3, y: 6, z: 3 }, 'a block lands on top of the hit face');

  const side = pick(w, { x: 10, y: 5.5, z: 3.5 }, dir(-1, 0, 0));
  assert.deepEqual(placementCell(side), { x: 4, y: 5, z: 3 }, 'and beside it from the side');

  assert.equal(placementCell(null), null);
});

test('a prop hit places on its entry face, not on undefined', () => {
  // Prop hits carry no block face, so `placementCell` used to add undefined:
  // `hit.x + undefined` is NaN, the cell then reported no coordinates at all, and
  // the ghost vanished the moment the cursor crossed a bench. Since every line of
  // the overlay shares one buffer, one NaN there took the whole overlay with it.
  const w = new World();
  w.column(0, 0);
  w.setProp({ x: 3, y: 5, z: 3, prop: 'lantern', rot: 0, by: 'b1', rev: 1 });

  const fromAbove = pick(w, { x: 3.5, y: 12, z: 3.5 }, dir(0, -1, 0));
  assert.equal(fromAbove.kind, 'prop', 'the lantern is what the ray meets first');
  const cell = placementCell(fromAbove);
  assert.deepEqual(cell, { x: 3, y: 6, z: 3 }, 'it lands on top of the lantern');
  assert.ok(Object.values(cell).every(Number.isFinite), 'and every coordinate is a real number');

  const fromSide = pick(w, { x: 9, y: 5.5, z: 3.5 }, dir(-1, 0, 0));
  assert.deepEqual(placementCell(fromSide), { x: 4, y: 5, z: 3 }, 'beside it, on the face the ray entered');
});

test('a placement cell is never occupied', () => {
  // Placing always targets the air cell on the hit side, so a build can never
  // land inside an existing block.
  const w = new World();
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) w.setAuthoritative(x, 0, z, STONE, 1);
  w.setAuthoritative(2, 1, 2, STONE, 2);

  for (const [ox, oz] of [[2.5, 2.5], [0.5, 0.5], [7.5, 7.5], [3.5, 2.5]]) {
    const hit = pick(w, { x: ox, y: 10, z: oz }, dir(0, -1, 0));
    const cell = placementCell(hit);
    assert.ok(cell, 'expected a hit');
    assert.equal(w.getVoxel(cell.x, cell.y, cell.z), 0, `cell ${JSON.stringify(cell)} must be air`);
  }
});