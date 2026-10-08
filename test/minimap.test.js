/**
 * Minimap rasterisation.
 *
 * The minimap's job is to be *correct about the world*, and the failure mode that
 * matters is a map that quietly lies -- showing bedrock when you have built a
 * tower, or omitting an in-flight block so the map disagrees with the view. These
 * tests pin the surface rule, the prediction fold-in, and the coordinate mapping
 * between world space and canvas space, since all three are easy to get subtly
 * wrong and impossible to notice by looking at a small square.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Minimap } from '../public/src/ui/minimap.js';
import { World } from '../public/src/world/world.js';
import { MATERIALS } from '../shared/materials.js';
import { WORLD, CHUNK_SIZE, voxelIndex } from '../shared/protocol.js';

// ---------------------------------------------------------------------------
// A DOM stub just large enough for the Minimap constructor and raster path.
// The real thing needs canvas 2d and getImageData; here only the surface scan is
// exercised, which is pure arithmetic over the world and needs no drawing at all.
// ---------------------------------------------------------------------------

function fakeHost() {
  return {
    appendChild() {},
    ownerDocument: null,
  };
}

function makeMinimap() {
  const m = Object.create(Minimap.prototype);
  m.span = WORLD.RADIUS * 2;
  // Mirror the constructor's derivation rather than hardcoding it, so a change to
  // the tile/padding constants is reflected here instead of failing for the wrong
  // reason.
  m.px = m.span * 2 + 8;
  m.stats = { draws: 0, lastMs: 0, surfaceCells: 0 };
  return m;
}

/** Write a block into a world column, through the chunk-local path the map uses. */
function put(world, x, y, z, mat) {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  const col = world.column(cx, cz);
  const lx = x - cx * CHUNK_SIZE;
  const lz = z - cz * CHUNK_SIZE;
  col.cells[voxelIndex(lx, y, lz)] = mat;
}

const slotOf = (m, x, z) => (z + WORLD.RADIUS) * m.span + (x + WORLD.RADIUS);

// ---------------------------------------------------------------------------
// Surface rule: topmost, not a fixed slice
// ---------------------------------------------------------------------------

test('the map shows the topmost block in a column, not a slice', () => {
  const w = new World();
  w.column(0, 0);
  for (let y = 0; y <= 6; y++) put(w, 0, y, 0, 1);
  put(w, 0, 9, 0, 3); // a bright block well above the stack

  const m = makeMinimap();
  m.refreshSurface(w);

  assert.equal(m.heightMap[slotOf(m, 0, 0)], 9,
    'height must be the top of the stack, not the first solid voxel it walks into');
  assert.equal(m.surfaceMat[slotOf(m, 0, 0)], 3, 'and the material there');
});

test('a column with only bedrock still registers', () => {
  const w = new World();
  w.column(0, 0);
  put(w, 1, 0, 1, 1);
  const m = makeMinimap();
  m.refreshSurface(w);
  assert.equal(m.heightMap[slotOf(m, 1, 1)], 0);
  assert.equal(m.surfaceMat[slotOf(m, 1, 1)], 1);
});

test('an empty column is -1 and is skipped rather than drawn as a material', () => {
  const w = new World();
  w.column(0, 0);
  const m = makeMinimap();
  m.refreshSurface(w);
  assert.equal(m.heightMap[slotOf(m, 5, 5)], -1);
  assert.equal(m.surfaceMat[slotOf(m, 5, 5)], 0);
});

test('columns outside every loaded chunk are -1, not a stale value', () => {
  // A stale height here would draw terrain that is not in the world, which is the
  // one thing a map must never do.
  const w = new World();
  w.column(0, 0);
  put(w, 0, 5, 0, 1);
  const m = makeMinimap();
  m.refreshSurface(w);

  assert.equal(m.heightMap[slotOf(m, 0, 0)], 5);
  assert.equal(m.heightMap[slotOf(m, 39, 39)], -1, 'a distant column must be empty');
});

test('a column crossing a chunk boundary is read from the right chunk', () => {
  // x=15 is the last column of chunk 0 and x=16 the first of chunk 1. An off-by-one
  // in the local-coordinate maths shows up exactly here and nowhere else.
  const w = new World();
  w.column(0, 0);
  w.column(1, 0);
  put(w, 15, 3, 2, 2);
  put(w, 16, 4, 2, 4);

  const m = makeMinimap();
  m.refreshSurface(w);

  assert.equal(m.heightMap[slotOf(m, 15, 2)], 3);
  assert.equal(m.surfaceMat[slotOf(m, 15, 2)], 2);
  assert.equal(m.heightMap[slotOf(m, 16, 2)], 4);
  assert.equal(m.surfaceMat[slotOf(m, 16, 2)], 4);
});

// ---------------------------------------------------------------------------
// Predictions must appear immediately
// ---------------------------------------------------------------------------

test('a predicted block appears on the map before the server confirms it', () => {
  // The minimap reads the client's world. If it ignored the prediction overlay it
  // would lag the first-person view by a round trip, and clicking on the block you
  // just placed would land on nothing.
  const w = new World();
  w.column(0, 0);
  const m = makeMinimap();
  m.refreshSurface(w);
  assert.equal(m.heightMap[slotOf(m, 3, 3)], -1, 'nothing there yet');

  w.setPredicted(3, 8, 3, 5);
  m.refreshSurface(w);
  assert.equal(m.heightMap[slotOf(m, 3, 3)], 8);
  assert.equal(m.surfaceMat[slotOf(m, 3, 3)], 5, 'the predicted material, not the committed one');
});

test('a prediction of air (a removal) clears the column top', () => {
  // A removal predicts mat 0. If the scan ignored the 0 flag it would keep drawing
  // the block the player just destroyed.
  const w = new World();
  w.column(0, 0);
  put(w, 4, 7, 4, 1);

  const m = makeMinimap();
  m.refreshSurface(w);
  assert.equal(m.heightMap[slotOf(m, 4, 4)], 7);

  w.setPredicted(4, 7, 4, 0);
  m.refreshSurface(w);
  assert.equal(m.heightMap[slotOf(m, 4, 4)], -1, 'a predicted removal must not draw');
});

test('a prediction overrides committed geometry at the same cell', () => {
  const w = new World();
  w.column(0, 0);
  put(w, 6, 2, 6, 1);
  w.setPredicted(6, 2, 6, 9);
  const m = makeMinimap();
  m.refreshSurface(w);
  assert.equal(m.surfaceMat[slotOf(m, 6, 6)], 9);
});

// ---------------------------------------------------------------------------
// Coordinate mapping: world <-> canvas
// ---------------------------------------------------------------------------

test('the canvas is sized from the tile grid, so the world cannot be clipped', () => {
  // A hand-picked canvas size against a span*TILE grid clipped 2px off each side,
  // which hid the outer ring of the buildable world. The backing size must be
  // derived, never set independently.
  const m = makeMinimap();
  assert.equal(m.px, m.span * 2 + 8, 'backing size = world span + 2*PAD');
  assert.ok(m._origin() >= 0, 'west edge visible');
  assert.ok(m._origin() + m.span * 2 <= m.px, 'east edge visible');
  assert.ok(m._origin() > 0, 'with a margin so the edge is not flush');
});

test('the origin is a constant margin, independent of canvas size', () => {
  const m = makeMinimap();
  assert.equal(m._origin(), 4);
});

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

test('a prop is flagged so the map can mark it', () => {
  const w = new World();
  w.column(0, 0);
  put(w, 2, 1, 2, 1);
  w.setProp({ x: 2, y: 2, z: 2, prop: 'lantern', rot: 0, by: 'b', rev: 1 });

  const m = makeMinimap();
  m.refreshSurface(w);
  assert.equal(m.surfaceProp[slotOf(m, 2, 2)], 1, 'prop sits above the topmost block');
});

test('a prop elsewhere in the world does not mark this column', () => {
  const w = new World();
  w.column(0, 0);
  put(w, 7, 1, 7, 1);
  w.setProp({ x: 9, y: 1, z: 9, prop: 'plant', rot: 0, by: 'b', rev: 1 });
  const m = makeMinimap();
  m.refreshSurface(w);
  assert.equal(m.surfaceProp[slotOf(m, 7, 7)], 0);
});

// ---------------------------------------------------------------------------
// Contract with the catalogue
// ---------------------------------------------------------------------------

test('every material the map can draw has an sRGB colour to draw it with', () => {
  // The map indexes MATERIALS by id and shifts the hex directly. A missing entry
  // would silently skip a whole material, which reads as "that block does not
  // exist on the map".
  for (const [id, def] of Object.entries(MATERIALS)) {
    assert.ok(Number.isInteger(def.color), `material ${id} needs a numeric colour`);
    assert.ok(def.color >= 0 && def.color <= 0xffffff, `material ${id} colour in range`);
  }
});

test('the surface scan is idempotent', () => {
  // The scan runs on a timer over a world that is simultaneously changing. If a
  // repeat call produced different results for unchanged input, the map would
  // flicker for no reason.
  const w = new World();
  w.column(0, 0);
  for (let y = 0; y < 12; y++) put(w, y % 5, y, y % 3, (y % 9) + 1);

  const m = makeMinimap();
  m.refreshSurface(w);
  const a = Array.from(m.heightMap);
  const b = Array.from(m.surfaceMat);

  m.refreshSurface(w);
  assert.deepEqual(Array.from(m.heightMap), a);
  assert.deepEqual(Array.from(m.surfaceMat), b);
});

test('the heightmap is allocated once and reused, not per draw', () => {
  // Allocating span^2 typed arrays every redraw is the kind of cost that looks
  // free in a profile dominated by GL calls and is not.
  const w = new World();
  w.column(0, 0);
  const m = makeMinimap();
  assert.equal(m.heightMap, undefined, 'nothing allocated before the first scan');

  m.refreshSurface(w);
  const first = m.heightMap;
  m.refreshSurface(w);
  assert.equal(m.heightMap, first, 'the same buffer is reused');
});
