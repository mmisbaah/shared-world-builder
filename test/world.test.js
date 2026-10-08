import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../public/src/world/world.js';
import { greedyMesh, decodeQuads } from '../public/src/world/greedyMesher.js';
import { CHUNK_SIZE, WORLD, chunkKey } from '../shared/protocol.js';

const STONE = 1;
const BRICK = 2;
const S = CHUNK_SIZE;

function seedColumn(w, cx, cz) {
  w.column(cx, cz);
  return w;
}

/** Read the gathered apron exactly the way greedyMesh's `at()` does. */
function apronAt(padded, lx, lz, y) {
  const PAD = S + 2;
  return padded[lx + lz * PAD + (y + 1) * PAD * PAD];
}

// ---------------------------------------------------------------------------
// Authoritative state
// ---------------------------------------------------------------------------

test('authoritative writes round-trip and count occupancy', () => {
  const w = new World();
  w.column(0, 0);

  assert.equal(w.getVoxel(3, 5, 7), 0, 'untouched voxels read as air');
  assert.ok(w.setAuthoritative(3, 5, 7, STONE, 11));
  assert.equal(w.getVoxel(3, 5, 7), STONE);
  assert.equal(w.getRevision(3, 5, 7), 11);
  assert.equal(w.getColumn(0, 0).occupied, 1);

  assert.ok(w.setAuthoritative(3, 5, 7, 0, 12));
  assert.equal(w.getVoxel(3, 5, 7), 0);
  assert.equal(w.getColumn(0, 0).occupied, 0);
});

test('re-applying the same value is a no-op', () => {
  const w = new World();
  w.column(0, 0);
  w.setAuthoritative(1, 1, 1, STONE, 5);
  assert.equal(w.setAuthoritative(1, 1, 1, STONE, 5), false, 'identical write must not re-dirty');
});

test('negative world coordinates map into the right column', () => {
  const w = new World();
  w.column(-1, -1);
  w.setAuthoritative(-1, 2, -1, BRICK, 3);
  assert.equal(w.getVoxel(-1, 2, -1), BRICK);
  assert.equal(w.getColumn(-1, -1).occupied, 1);
  w.setAuthoritative(-16, 2, -16, STONE, 4);
  assert.equal(w.getVoxel(-16, 2, -16), STONE);
  assert.equal(w.getColumn(-1, -1).occupied, 2);
});

test('heights outside the column read as air and refuse writes', () => {
  const w = new World();
  w.column(0, 0);
  assert.equal(w.getVoxel(0, WORLD.MAX_Y, 0), 0);
  assert.equal(w.getVoxel(0, -1, 0), 0);
  assert.equal(w.setAuthoritative(0, WORLD.MAX_Y, 0, STONE, 1), false);
});

// ---------------------------------------------------------------------------
// Prediction overlay
// ---------------------------------------------------------------------------

test('a prediction shadows authoritative state without erasing it', () => {
  const w = new World();
  w.column(0, 0);
  w.setAuthoritative(2, 4, 2, STONE, 1);

  w.setPredicted(2, 4, 2, BRICK);
  assert.equal(w.getVoxel(2, 4, 2), BRICK, 'reads must prefer the prediction');
  assert.equal(w.getAuthoritative(2, 4, 2), STONE, 'settled state must be untouched');
  assert.equal(w.getRevision(2, 4, 2), 1);

  w.clearPredicted(2, 4, 2);
  assert.equal(w.getVoxel(2, 4, 2), STONE);
  assert.equal(w.getColumn(0, 0).predictionCount, 0);
});

test('a predicted removal is a real prediction, not an empty one', () => {
  const w = new World();
  w.column(0, 0);
  w.setAuthoritative(2, 4, 2, STONE, 1);

  // Material 0 is a legal prediction; only the mask byte distinguishes it from
  // "no prediction at all", so clearing must still know the overlay was live.
  w.setPredicted(2, 4, 2, 0);
  assert.equal(w.hasPrediction(2, 4, 2), true);
  assert.equal(w.getVoxel(2, 4, 2), 0, 'the voxel should look removed immediately');
  assert.equal(w.getAuthoritative(2, 4, 2), STONE);
  assert.equal(w.getColumn(0, 0).predictionCount, 1);

  w.clearPredicted(2, 4, 2, STONE);
  assert.equal(w.getVoxel(2, 4, 2), STONE, 'the rollback restores the block');
});

test('clearing with a fallback writes settled state in one step', () => {
  const w = new World();
  w.column(0, 0);
  w.setPredicted(9, 9, 9, BRICK);
  w.clearPredicted(9, 9, 9, STONE);
  assert.equal(w.getVoxel(9, 9, 9), STONE);
  assert.equal(w.getAuthoritative(9, 9, 9), STONE);
  assert.equal(w.hasPrediction(9, 9, 9), false);
});

test('the apron shows predictions, so the ghost is visible in the mesh', () => {
  const w = new World();
  w.column(0, 0);
  w.setPredicted(8, 20, 8, BRICK);
  const padded = w.gatherPadded(0, 0);
  assert.equal(apronAt(padded, 8 + 1, 8 + 1, 20), BRICK);
});

// ---------------------------------------------------------------------------
// Dirty propagation
// ---------------------------------------------------------------------------

test('a freshly created column is queued for meshing', () => {
  // Otherwise the initial snapshot creates columns that are flagged dirty but
  // never enqueued, and nothing is ever built.
  const w = new World();
  w.column(0, 0);
  assert.equal(w.getColumn(0, 0).needsMesh, true);
  assert.equal(w.dirtyColumns.size, 1);
  assert.equal(w.takeDirtyColumns(Infinity).length, 1);
});

test('an interior edit dirties only its own column', () => {
  const w = new World();
  seedColumn(w, 0, 0);
  seedColumn(w, 1, 0);
  // Drain the creation queue so the assertions below see only this edit's effect.
  w.takeDirtyColumns(Infinity);
  for (const c of w.chunks.values()) c.needsMesh = false;

  w.setAuthoritative(5, 3, 5, STONE, 1);

  assert.equal(w.getColumn(0, 0).needsMesh, true);
  assert.equal(w.getColumn(1, 0).needsMesh, false, 'a non-adjacent column is unaffected');
});

test('an edge edit dirties the neighbouring column across that face', () => {
  const w = new World();
  seedColumn(w, 0, 0);
  seedColumn(w, -1, 0);

  w.setAuthoritative(0, 3, 5, STONE, 1); // lx === 0, faces column cx-1
  assert.equal(w.getColumn(0, 0).needsMesh, true);
  assert.equal(w.getColumn(-1, 0).needsMesh, true, 'the seam neighbour must re-mesh');
});

test('a corner edit dirties the diagonal column too', () => {
  const w = new World();
  seedColumn(w, 0, 0);
  seedColumn(w, -1, 0);
  seedColumn(w, 0, -1);
  seedColumn(w, -1, -1);

  w.setAuthoritative(0, 3, 0, STONE, 1); // lx === 0 and lz === 0
  assert.equal(w.getColumn(0, 0).needsMesh, true);
  assert.equal(w.getColumn(-1, 0).needsMesh, true);
  assert.equal(w.getColumn(0, -1).needsMesh, true);
  assert.equal(
    w.getColumn(-1, -1).needsMesh, true,
    'missing the diagonal leaves a one-voxel crack that never heals',
  );
});

test('predicted edits dirty the mesh too', () => {
  const w = new World();
  seedColumn(w, 0, 0);
  w.column(0, 0).needsMesh = false;
  w.setPredicted(4, 4, 4, STONE);
  assert.equal(w.getColumn(0, 0).needsMesh, true);
});

test('the dirty queue is drained, bounded, and nearest-first', () => {
  const w = new World();
  // Distinct columns need coordinates at least CHUNK_SIZE apart: (2,1,2) and
  // (1,1,1) are both inside column 0,0.
  seedColumn(w, 0, 0);
  seedColumn(w, 1, 0);
  seedColumn(w, 2, 2);
  w.takeDirtyColumns(Infinity);

  w.setAuthoritative(2, 1, 2, STONE, 1); // column 0,0
  w.setAuthoritative(18, 1, 2, STONE, 2); // column 1,0
  w.setAuthoritative(34, 1, 34, STONE, 3); // column 2,2

  assert.equal(w.dirtyColumns.size, 3);

  const batch = w.takeDirtyColumns(2, 0, 0);
  assert.equal(batch.length, 2, 'the limit must bound the batch');
  assert.deepEqual(
    batch.map((c) => chunkKey(c.cx, c.cz)), ['0,0', '1,0'],
    'columns closest to the camera are rebuilt first',
  );
  assert.equal(w.dirtyColumns.size, 1, 'the unclaimed column stays queued');

  const rest = w.takeDirtyColumns(Infinity, 0, 0);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].key, '2,2');
  assert.equal(w.dirtyColumns.size, 0);
});

// ---------------------------------------------------------------------------
// Apron gathering
// ---------------------------------------------------------------------------

test('the gathered apron matches world reads at every apron coordinate', () => {
  // This is the load-bearing check: gatherPadded and greedyMesh must agree on
  // the padded layout exactly. Asserting against the mesher's own index formula
  // catches any stride disagreement, including the anisotropic y stride.
  const w = new World();
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) w.column(cx, cz);

  // A deterministic, asymmetric scatter so a transposed axis cannot pass.
  for (let x = -20; x <= 20; x++) {
    for (let z = -20; z <= 20; z++) {
      for (let y = 0; y < WORLD.MAX_Y; y += 7) {
        if ((x * 31 + z * 17 + y * 13) % 5 === 0) {
          w.setAuthoritative(x, y, z, (x + y + z) % 2 ? STONE : BRICK, y + 1);
        }
      }
    }
  }

  const PAD = S + 2;
  for (const [cx, cz] of [[0, 0], [1, 0], [0, -1], [-1, -1]]) {
    const padded = w.gatherPadded(cx, cz);
    for (let lz = 0; lz < PAD; lz++) {
      for (let lx = 0; lx < PAD; lx++) {
        for (let y = -1; y <= WORLD.MAX_Y; y++) {
          const wx = cx * S - 1 + lx;
          const wz = cz * S - 1 + lz;
          assert.equal(
            apronAt(padded, lx, lz, y), w.getVoxel(wx, y, wz),
            `mismatch at column ${cx},${cz} apron ${lx},${lz},${y}`,
          );
        }
      }
    }
  }
});

test('the apron spans all three columns in x and z', () => {
  const w = new World();
  w.column(0, 0);
  w.column(-1, 0);
  w.column(1, 0);
  w.column(0, -1);
  w.column(0, 1);

  w.setAuthoritative(-1, 10, 4, STONE, 1); // column (-1, 0)
  w.setAuthoritative(16, 10, 4, BRICK, 2); // column ( 1, 0)
  w.setAuthoritative(4, 10, -1, STONE, 3); // column ( 0,-1)
  w.setAuthoritative(4, 10, 16, BRICK, 4); // column ( 0, 1)

  const padded = w.gatherPadded(0, 0);
  assert.equal(apronAt(padded, 0, 4 + 1, 10), STONE, '-x apron');
  assert.equal(apronAt(padded, S + 1, 4 + 1, 10), BRICK, '+x apron');
  assert.equal(apronAt(padded, 4 + 1, 0, 10), STONE, '-z apron');
  assert.equal(apronAt(padded, 4 + 1, S + 1, 10), BRICK, '+z apron');
});

test('columns outside the loaded set read as air rather than throwing', () => {
  const w = new World();
  w.column(0, 0);
  w.setAuthoritative(4, 10, 4, STONE, 1);
  const padded = w.gatherPadded(0, 0);
  assert.equal(apronAt(padded, 0, 0, 10), 0, 'the unloaded neighbour is air');
});

// ---------------------------------------------------------------------------
// World + mesher integration
// ---------------------------------------------------------------------------

test('a gathered column feeds the mesher and produces the expected geometry', () => {
  const w = new World();
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) w.column(cx, cz);

  // A 4x4x4 cube of stone sitting inside the column.
  for (let x = 4; x < 8; x++)
    for (let y = 6; y < 10; y++)
      for (let z = 4; z < 8; z++) w.setAuthoritative(x, y, z, STONE, 1);

  const quads = decodeQuads(greedyMesh(w.gatherPadded(0, 0), S, undefined, WORLD.MAX_Y).quads);
  assert.equal(quads.length, 6, 'an isolated cube greedily merges into exactly 6 quads');

  for (const q of quads) {
    if (q.nrm === 2 || q.nrm === 3) {
      assert.equal(q.w, 4, 'the caps are 4 wide');
      assert.equal(q.h, 4, 'the caps are 4 tall');
    } else {
      assert.equal(Math.max(q.w, q.h), 4, 'each side face spans the cube');
    }
  }
});

test('a column seam culls the shared face once both sides are loaded', () => {
  const w = new World();
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) w.column(cx, cz);

  // A wall straddling x = 15/16, i.e. the boundary between columns -1 and 0.
  for (let x = 13; x <= 17; x++)
    for (let y = 3; y < 8; y++)
      for (let z = 4; z < 8; z++) w.setAuthoritative(x, y, z, BRICK, 1);

  const left = decodeQuads(greedyMesh(w.gatherPadded(-1, 0), S, undefined, WORLD.MAX_Y).quads);
  const right = decodeQuads(greedyMesh(w.gatherPadded(0, 0), S, undefined, WORLD.MAX_Y).quads);

  // The seam face must be owned by exactly one of the two columns: the opaque
  // cell, and never emitted twice.
  const seamNormals = (qs) => qs.filter((q) => q.nrm === 0 || q.nrm === 1).length;
  assert.equal(seamNormals(left) + seamNormals(right), 1, 'the shared face is emitted once');
});

test('props live on the column that owns them', () => {
  const w = new World();
  w.column(0, 0);
  w.setProp({ x: 3, y: 4, z: 3, prop: 'lantern', rot: 1, by: 'b1', rev: 9 });
  assert.equal(w.getProp(3, 4, 3).prop, 'lantern');
  assert.equal(w.getColumn(0, 0).needsProps, true);
  assert.ok(w.removeProp(3, 4, 3));
  assert.equal(w.getProp(3, 4, 3), undefined);
  assert.equal(w.removeProp(3, 4, 3), false, 'removing twice is a no-op');
});
