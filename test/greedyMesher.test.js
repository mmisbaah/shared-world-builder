import test from 'node:test';
import assert from 'node:assert/strict';

import {
  greedyMesh,
  createPaddedBuffer,
  setPadded,
  decodeVertices,
  decodeQuads,
  VERTEX_STRIDE,
  FLOATS_PER_QUAD,
} from '../public/src/world/greedyMesher.js';

const STONE = 1;
const BRICK = 2;
const GLASS = 9;
const SIZE = 16;

function build(fn, size = SIZE) {
  const padded = createPaddedBuffer(size);
  fn(padded, setPaddedCurry(padded, size));
  return padded;
}

function setPaddedCurry(padded, size) {
  return (x, y, z, m) => setPadded(padded, size, x, y, z, m);
}

function fillBox(fn, x0, y0, z0, x1, y1, z1, mat) {
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) fn(x, y, z, mat);
}

// ---------------------------------------------------------------------------

test('empty chunk emits no geometry', () => {
  const r = greedyMesh(createPaddedBuffer(SIZE), SIZE);
  assert.equal(r.quadCount, 0);
  assert.equal(r.vertexCount, 0);
  assert.equal(r.indexCount, 0);
});

test('a fully solid chunk collapses to exactly 6 merged quads', () => {
  const padded = build((p, set) => fillBox(set, 0, 0, 0, SIZE - 1, SIZE - 1, SIZE - 1, STONE));
  const r = greedyMesh(padded, SIZE);

  // Greedy meshing is the whole point: 6 * 16 * 16 = 1536 faces -> 6 quads.
  assert.equal(r.quadCount, 6, 'interior faces must be culled and boundaries merged');
  assert.equal(r.vertexCount, 6 * 4);
  assert.equal(r.indexCount, 6 * 6);

  const quads = decodeQuads(r.quads);
  for (const q of quads) {
    assert.equal(q.w, SIZE);
    assert.equal(q.h, SIZE);
  }
  // All six outward normals present exactly once.
  assert.deepEqual(quads.map((q) => q.nrm).sort(), [0, 1, 2, 3, 4, 5]);
});

test('a solid chunk with a 1-voxel notch does not merge across the notch', () => {
  const padded = build((p, set) => {
    fillBox(set, 0, 0, 0, SIZE - 1, SIZE - 1, SIZE - 1, STONE);
    set(4, SIZE - 1, 4, 0); // punch a hole in the top face
  });
  const r = greedyMesh(padded, SIZE);

  const quads = decodeQuads(r.quads);
  const topFaces = quads.filter((q) => q.nrm === 2); // +y

  // Upward-facing area = the 16x16 top of the chunk, minus the 1-voxel hole,
  // plus the 1-voxel floor of the hole itself.
  const area = topFaces.reduce((a, q) => a + q.w * q.h, 0);
  assert.equal(area, SIZE * SIZE, 'no upward face may be missing or doubled');

  // The hole must force a split rather than being merged over.
  assert.ok(topFaces.length >= 4, `notch should split the top face, got ${topFaces.length} quads`);

  // Corner cells must be unique per (normal, corner, material): the mask sweep
  // used to leak one shared scratch cell into every quad.
  const keys = quads.map((q) => `${q.nrm},${q.ox},${q.oy},${q.oz},${q.w},${q.h},${q.mat}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate quads emitted');
});

test('the quad side table records each quad\'s own corner cell', () => {
  // A 1xN line along x: every face should be attributed to the voxel that
  // actually owns it, which is only knowable if owner is stored per mask cell.
  const padded = build((p, set) => {
    for (let x = 0; x < SIZE; x++) set(x, 0, 0, STONE);
  });
  const quads = decodeQuads(greedyMesh(padded, SIZE).quads);

  const minusX = quads.filter((q) => q.nrm === 1);
  const plusX = quads.filter((q) => q.nrm === 0);
  assert.equal(minusX.length, 1);
  assert.equal(plusX.length, 1);
  assert.deepEqual(
    [minusX[0].ox, minusX[0].oy, minusX[0].oz], [0, 0, 0],
    '-x face must belong to the first voxel',
  );
  assert.deepEqual(
    [plusX[0].ox, plusX[0].oy, plusX[0].oz], [SIZE - 1, 0, 0],
    '+x face must belong to the last voxel',
  );

  // Top and bottom faces merge along x, so they carry the split material runs.
  const top = quads.filter((q) => q.nrm === 2);
  assert.equal(top.length, 1);
  assert.deepEqual([top[0].ox, top[0].oy, top[0].oz], [0, 0, 0]);
  // Sweep axis for +y is (u = z, v = x), so the 16-long run shows up as h.
  assert.equal(top[0].w, 1);
  assert.equal(top[0].h, SIZE);
});

test('per-corner AO blocks an otherwise mergeable run', () => {
  // Floor of two voxels at y=0, plus a blocker at (0,1,0) that darkens the
  // shared top-face corners. Without the AO term in the merge key these two
  // coplanar top faces would wrongly merge into one 2x1 quad.
  const padded = build((p, set) => {
    // A 2x2 floor, plus a raised block sitting *beside* the top faces rather
    // than on them. That block lands in the AO sampling plane one step above
    // the floor, darkening only the corners adjacent to it, so the two
    // coplanar top faces end up with different AO and must not merge.
    set(0, 0, 0, STONE); set(1, 0, 0, STONE);
    set(0, 0, 1, STONE); set(1, 0, 1, STONE);
    set(0, 1, 1, STONE);
  });
  const r = greedyMesh(padded, SIZE);
  const quads = decodeQuads(r.quads);

  const topOfFloor = quads.filter((q) => q.nrm === 2 && q.oy === 0);
  assert.ok(topOfFloor.length >= 2, 'AO mismatch must prevent merging');
  assert.ok(topOfFloor.every((q) => q.w === 1 && q.h === 1));

  const verts = decodeVertices(r.vertex, r.vertexCount);
  const levels = new Set(verts.map((v) => v.ao));
  assert.ok(levels.has(2), 'the occluded corner should be darkened');
  assert.ok(levels.has(3), 'unoccluded corners stay fully lit');
  for (const v of verts) assert.ok(v.ao >= 0 && v.ao <= 3);

  // Control: the same floor with no raised block merges into a single top quad.
  const control = build((p, set) => {
    set(0, 0, 0, STONE); set(1, 0, 0, STONE);
    set(0, 0, 1, STONE); set(1, 0, 1, STONE);
  });
  const controlTop = decodeQuads(greedyMesh(control, SIZE).quads)
    .filter((q) => q.nrm === 2 && q.oy === 0);
  assert.equal(controlTop.length, 1, 'a flat unobstructed floor should merge');
  assert.deepEqual([controlTop[0].w, controlTop[0].h], [2, 2]);
});

test('AO reaches its darkest level in a diagonal pocket', () => {
  const padded = build((p, set) => {
    // Voxel (1,0,1) has open sky above it, but the two diagonal neighbours in
    // the AO plane ((1,1,2) and (2,1,1)) are both solid -> the shared corner is
    // fully occluded (AO 0) rather than merely shaded (AO 2).
    set(1, 0, 1, STONE);
    set(1, 1, 2, STONE);
    set(2, 1, 1, STONE);
  });
  const r = greedyMesh(padded, SIZE);
  const verts = decodeVertices(r.vertex, r.vertexCount);
  assert.ok(verts.some((v) => v.ao === 0), 'expected a fully occluded corner');
});

test('opaque owns the seam face; glass only shows where it meets air', () => {
  const seam = build((p, set) => {
    set(0, 0, 0, STONE);
    set(1, 0, 0, GLASS);
  });
  const quads = decodeQuads(greedyMesh(seam, SIZE).quads);

  // The mask holds one face per plane cell, so at the stone/glass boundary the
  // opaque side wins: stone shows a +x face, glass gets no face pressed into it.
  const stone = quads.filter((q) => q.mat === STONE && q.nrm === 0);
  const glassAtSeam = quads.filter((q) => q.mat === GLASS && q.nrm === 1);
  assert.equal(stone.length, 1, 'stone must own the seam face');
  assert.equal(glassAtSeam.length, 0, 'glass must not get a coplanar seam face');
  assert.deepEqual([stone[0].ox, stone[0].oy, stone[0].oz], [0, 0, 0]);

  // ...and the seam resolves the same way regardless of sweep direction.
  const mirrored = build((p, set) => {
    set(0, 0, 0, GLASS);
    set(1, 0, 0, STONE);
  });
  const mirroredQuads = decodeQuads(greedyMesh(mirrored, SIZE).quads);
  const mirroredStone = mirroredQuads.filter((q) => q.mat === STONE && q.nrm === 1);
  assert.equal(mirroredStone.length, 1, 'opaque must win the seam from either side');
  assert.deepEqual([mirroredStone[0].ox, mirroredStone[0].oy, mirroredStone[0].oz], [1, 0, 0]);

  // Glass against air on its outer side still gets a full set of faces.
  const glassOuter = quads.filter((q) => q.mat === GLASS);
  assert.equal(glassOuter.length, 5, 'glass should show 5 faces where it meets air');

  // Glass must not cast ambient occlusion onto the stone beside it.
  const verts = decodeVertices(greedyMesh(seam, SIZE).vertex, greedyMesh(seam, SIZE).vertexCount);
  assert.ok(verts.filter((v) => v.mat === STONE).every((v) => v.ao === 3));

  const twoGlass = build((p, set) => {
    set(0, 0, 0, GLASS);
    set(1, 0, 0, GLASS);
  });
  const gg = decodeQuads(greedyMesh(twoGlass, SIZE).quads);
  // Only the two outer ends survive; the shared plane is culled.
  assert.equal(gg.filter((q) => q.nrm === 1).length, 1, 'only the outer -x face');
  assert.equal(gg.filter((q) => q.nrm === 0).length, 1, 'only the outer +x face');
  assert.equal(gg.length, 6, 'coplanar glass faces merge into one quad each');
});

test('different materials never merge into one quad', () => {
  const padded = build((p, set) => {
    for (let x = 0; x < SIZE; x++) set(x, 0, 0, x < 8 ? STONE : BRICK);
  });
  const quads = decodeQuads(greedyMesh(padded, SIZE).quads);
  const top = quads.filter((q) => q.nrm === 2);
  assert.equal(top.length, 2, 'the material boundary must split the top face');
  assert.deepEqual(top.map((q) => q.mat), [STONE, BRICK]);
  // Sweep axis for +y is (u = z, v = x): 1 voxel deep, 8 voxels of run each.
  assert.deepEqual(top.map((q) => q.w), [1, 1]);
  assert.deepEqual(top.map((q) => q.h), [8, 8]);
  assert.deepEqual(top.map((q) => q.ox), [0, 8]);
});

test('every emitted triangle winds counter-clockwise as seen from outside', () => {
  // Randomised world; recompute the geometric normal from decoded positions and
  // compare against the packed normal. Catches winding and basis errors.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (let trial = 0; trial < 12; trial++) {
    const padded = createPaddedBuffer(SIZE);
    const put = (x, y, z, m) => setPadded(padded, SIZE, x, y, z, m);
    for (let i = 0; i < 60; i++) {
      const x = Math.floor(rnd() * SIZE);
      const y = Math.floor(rnd() * SIZE);
      const z = Math.floor(rnd() * SIZE);
      put(x, y, z, rnd() < 0.15 ? GLASS : rnd() < 0.5 ? STONE : BRICK);
    }

    const r = greedyMesh(padded, SIZE);
    const verts = decodeVertices(r.vertex, r.vertexCount);
    const idx = new Uint32Array(r.index);
    assert.equal(idx.length, r.quadCount * 6);
    assert.equal(verts.length, r.quadCount * 4);

    for (let t = 0; t < idx.length; t += 3) {
      const a = verts[idx[t]];
      const b = verts[idx[t + 1]];
      const c = verts[idx[t + 2]];

      const e1 = [b.x - a.x, b.y - a.y, b.z - a.z];
      const e2 = [c.x - a.x, c.y - a.y, c.z - a.z];
      const gx = e1[1] * e2[2] - e1[2] * e2[1];
      const gy = e1[2] * e2[0] - e1[0] * e2[2];
      const gz = e1[0] * e2[1] - e1[1] * e2[0];

      // A quad is axis-aligned, so the geometric normal must be parallel to the
      // packed one. Comparing the unit vectors catches both inverted winding and
      // non-planar corners in one assertion.
      const len = Math.hypot(gx, gy, gz);
      assert.ok(len > 0, 'degenerate triangle (zero area)');
      const dot = (gx * a.n[0] + gy * a.n[1] + gz * a.n[2]) / len;
      assert.ok(dot > 0.999, `triangle wound inward (dot=${dot.toFixed(3)}) on trial ${trial}`);

      // Exactly one nonzero cross-product component, i.e. a screen-aligned face.
      const nonzero = [gx, gy, gz].filter((n) => n !== 0).length;
      assert.equal(nonzero, 1, `quad is not axis-aligned on trial ${trial}`);
    }
  }
});

test('quad side table is consistent with the vertex buffer', () => {
  const padded = build((p, set) => {
    set(3, 3, 3, STONE);
    set(4, 3, 3, BRICK);
  });
  const r = greedyMesh(padded, SIZE);
  const quads = decodeQuads(r.quads);
  const verts = decodeVertices(r.vertex, r.vertexCount);

  assert.equal(quads.length * FLOATS_PER_QUAD, new Float32Array(r.quads).length);
  for (let q = 0; q < quads.length; q++) {
    const quad = quads[q];
    for (let c = 0; c < 4; c++) {
      const v = verts[q * 4 + c];
      assert.equal(v.mat, quad.mat, 'material must agree between quad table and vertices');
      assert.deepEqual(v.n, [quad.nrm === 0 ? 1 : quad.nrm === 1 ? -1 : 0,
        quad.nrm === 2 ? 1 : quad.nrm === 3 ? -1 : 0,
        quad.nrm === 4 ? 1 : quad.nrm === 5 ? -1 : 0]);
    }
  }
});

test('growable vertex buffer survives many small quads', () => {
  // A checkerboard maximises quad count for the volume, forcing repeated
  // buffer growth (and therefore exercising the reserve() copy path).
  const padded = build((p, set) => {
    for (let x = 0; x < SIZE; x++)
      for (let y = 0; y < SIZE; y++)
        for (let z = 0; z < SIZE; z++)
          if ((x + y + z) % 2 === 0) set(x, y, z, STONE);
  });
  const r = greedyMesh(padded, SIZE);

  assert.ok(r.quadCount > 1000, `checkerboard should be very un-mergeable, got ${r.quadCount}`);
  assert.equal(r.vertexCount, r.quadCount * 4);
  assert.equal(r.indexCount, r.quadCount * 6);
  assert.equal(r.vertex.byteLength, r.vertexCount * VERTEX_STRIDE);

  const verts = decodeVertices(r.vertex, r.vertexCount);
  assert.equal(verts.length, r.vertexCount, 'no vertices lost during growth');
  // Every quad must carry real data in the high slots (catches stale copies).
  assert.ok(verts.every((v) => v.mat === STONE && v.ao >= 0));
});

test('cross-chunk apron neighbours are honoured', () => {
  // Voxels in the apron must cull faces at the chunk boundary, otherwise every
  // chunk boundary gets a visible seam of interior faces.
  const padded = createPaddedBuffer(SIZE);
  const put = (x, y, z, m) => setPadded(padded, SIZE, x, y, z, m);
  // Fill the chunk and continue into the +x apron.
  fillBox(put, 0, 0, 0, SIZE - 1, SIZE - 1, SIZE - 1, STONE);
  fillBox(put, SIZE, 0, 0, SIZE, SIZE - 1, SIZE - 1, STONE);

  const quads = decodeQuads(greedyMesh(padded, SIZE).quads);
  // Only the -x, +y, -y, +z, -z faces survive; the +x face is now interior.
  assert.equal(quads.length, 5);
  assert.ok(!quads.some((q) => q.nrm === 0), '+x boundary face should be culled by the apron');
});

// ---------------------------------------------------------------------------
// Tall chunk columns
//
// A chunk spans the full world height, so the mesher takes a separate y extent.
// The payoff is that greedy merging runs across the whole column: a 1x48x1
// pillar becomes ONE quad per side face instead of three stacked cubes worth.
// ---------------------------------------------------------------------------

const TALL = 48; // WORLD.MAX_Y

function buildColumn(fn) {
  const padded = createPaddedBuffer(SIZE, TALL);
  fn((x, y, z, m) => setPadded(padded, SIZE, x, y, z, m, TALL));
  return padded;
}

test('a full-height pillar merges vertically into one quad per side', () => {
  const padded = buildColumn((put) => {
    for (let y = 0; y < TALL; y++) put(4, y, 4, STONE);
  });

  const quads = decodeQuads(greedyMesh(padded, SIZE, undefined, TALL).quads);
  // Six faces: four sides plus the exposed top and bottom caps. If the y extent
  // were ignored the pillar would be split into per-16 slices and no side face
  // could ever span more than 16 voxels.
  assert.equal(quads.length, 6, `got ${quads.length} quads`);

  const sides = quads.filter((q) => q.nrm === 0 || q.nrm === 1 || q.nrm === 4 || q.nrm === 5);
  assert.equal(sides.length, 4);
  for (const q of sides) {
    // A side face spans the column along whichever of (u, v) is the y axis.
    const span = Math.max(q.w, q.h);
    assert.equal(span, TALL, `side face nrm=${q.nrm} must span the entire column`);
  }

  const caps = quads.filter((q) => q.nrm === 2 || q.nrm === 3);
  assert.equal(caps.length, 2, 'the top and bottom caps are exposed');
  for (const q of caps) {
    assert.equal(q.w, 1);
    assert.equal(q.h, 1);
  }
  assert.deepEqual(
    caps.map((q) => q.nrm).sort((a, b) => a - b),
    [2, 3],
  );
});

test('a voxel at the very top of the column still emits a full cube', () => {
  const padded = buildColumn((put) => put(4, TALL - 1, 4, STONE));
  const r = greedyMesh(padded, SIZE, undefined, TALL);
  assert.equal(r.quadCount, 6);
  assert.equal(r.vertexCount, 24);
  assert.equal(r.indexCount, 36);
});

test('the top apron row of a column is gathered, not treated as out of bounds', () => {
  // Fill the top voxel AND its +y apron. The +y face must then be culled as
  // interior, which only happens if y = TALL is actually read from the buffer.
  const padded = buildColumn((put) => {
    put(4, TALL - 1, 4, STONE);
    put(4, TALL, 4, STONE);
  });
  const quads = decodeQuads(greedyMesh(padded, SIZE, undefined, TALL).quads);
  assert.equal(quads.length, 5, 'the +y face should be culled by the apron');
  assert.ok(!quads.some((q) => q.nrm === 2));
});

test('a cubic call and an explicit square call agree', () => {
  const buildCube = (fn) => {
    const p = createPaddedBuffer(SIZE);
    fn((x, y, z, m) => setPadded(p, SIZE, x, y, z, m));
    return p;
  };
  const shape = (put) => fillBox(put, 1, 2, 3, 9, 11, 12, BRICK);
  const a = greedyMesh(buildCube(shape), SIZE);
  const b = greedyMesh(buildCube(shape), SIZE, undefined, SIZE);
  assert.equal(a.quadCount, b.quadCount);
  assert.deepEqual(
    decodeVertices(a.vertex, a.vertexCount),
    decodeVertices(b.vertex, b.vertexCount),
  );
});

