import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diffQuads, extractQuads, spawnProgressBytes, quadKeys, quadIndices,
  partitionByVis, fxBytes, fxBytesUniform, FX_MODE, FX_CHANNELS, QUAD_STRIDE,
} from '../public/src/world/quadDiff.js';
import { greedyMesh, createPaddedBuffer, setPadded, decodeQuads } from '../public/src/world/greedyMesher.js';

const S = 16;
const T = 48;
const STONE = 1;
const BRICK = 2;

/** Mesh a column containing whatever `fill` draws. */
function mesh(fill) {
  const padded = createPaddedBuffer(S, T);
  if (fill) fill((x, y, z, m) => setPadded(padded, S, x, y, z, m, T));
  return greedyMesh(padded, S, undefined, T);
}

/** Side table from a Float32Array of records. */
function table(records) {
  return new Float32Array(records.flat()).buffer;
}

const A = [0, 0, 0, 1, 1, 0, 1]; // corner, 1x1, +x, stone
const B = [4, 2, 4, 2, 3, 4, 2]; // corner, 2x3, -z, brick

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

test('a quad is identified by corner, extent, normal and material', () => {
  assert.equal(quadKeys(table([A])).size, 1);
  // Every field participates in identity.
  const variants = [
    [1, 0, 0, 1, 1, 0, 1],
    [0, 1, 0, 1, 1, 0, 1],
    [0, 0, 1, 1, 1, 0, 1],
    [0, 0, 0, 2, 1, 0, 1],
    [0, 0, 0, 1, 2, 0, 1],
    [0, 0, 0, 1, 1, 1, 1],
    [0, 0, 0, 1, 1, 0, 2],
  ];
  for (const v of variants) {
    assert.equal(
      quadKeys(table([A, v])).size, 2,
      `variant ${v} must be distinct from A`,
    );
  }
});

test('an unchanged rebuild diffs to nothing', () => {
  const gen = table([A, B]);
  const d = diffQuads(gen, gen);
  assert.equal(d.added.size, 0);
  assert.equal(d.removed.size, 0);
  assert.equal(d.common, 2);
});

test('a new surface is reported as added, not as a full rebuild', () => {
  const d = diffQuads(table([A]), table([A, B]));
  assert.deepEqual([...d.added], ['4,2,4,2,3,4,2']);
  assert.equal(d.removed.size, 0);
  assert.equal(d.common, 1);
});

test('a vanished surface is reported as removed', () => {
  const d = diffQuads(table([A, B]), table([A]));
  assert.equal(d.added.size, 0);
  assert.deepEqual([...d.removed], ['4,2,4,2,3,4,2']);
  assert.equal(d.common, 1);
});

test('a material swap is both a removal and an addition', () => {
  const swapped = [4, 2, 4, 2, 3, 4, 5]; // same cell/extent/normal, new material
  const d = diffQuads(table([B]), table([swapped]));
  assert.equal(d.added.size, 1);
  assert.equal(d.removed.size, 1);
  assert.equal(d.common, 0);
});

test('diffing against an empty generation marks everything', () => {
  const empty = new Float32Array(0).buffer;
  const d = diffQuads(table([A, B]), empty);
  assert.equal(d.removed.size, 2);
  assert.equal(d.added.size, 0);
});

// ---------------------------------------------------------------------------
// Subset extraction
// ---------------------------------------------------------------------------

test('the mesher holds the vertex-per-quad invariant the extractor relies on', () => {
  const r = mesh((put) => {
    for (let x = 4; x < 9; x++)
      for (let y = 6; y < 11; y++)
        for (let z = 4; z < 9; z++) put(x, y, z, STONE);
  });
  assert.ok(r.quadCount > 0);
  assert.equal(r.vertexCount, r.quadCount * 4);
  assert.equal(r.indexCount, r.quadCount * 6);
});

test('extracting a subset yields a self-contained, correctly based geometry', () => {
  const r = mesh((put) => {
    // Two separated blocks, so quads from each are distinct.
    for (let y = 2; y < 5; y++) { put(1, y, 1, STONE); put(12, y, 12, BRICK); }
  });
  const keys = quadKeys(r.quads);
  const victim = [...keys][0];
  const out = extractQuads(r.vertex, r.index, r.quads, new Set([victim]));

  assert.equal(out.quadCount, 1);
  assert.equal(out.vertexCount, 4);
  assert.equal(out.indexCount, 6);

  const idx = new Uint32Array(out.index);
  for (const i of idx) {
    assert.ok(i >= 0 && i < out.vertexCount, `index ${i} must be rebased into the new buffer`);
  }
  // The winding must survive re-basing: two triangles, no degenerate fan.
  assert.deepEqual([...idx], [0, 1, 2, 0, 2, 3]);
});

test('extracting everything reproduces the original geometry', () => {
  const r = mesh((put) => {
    for (let x = 2; x < 7; x++)
      for (let y = 3; y < 9; y++)
        for (let z = 2; z < 7; z++) put(x, y, z, BRICK);
  });
  const all = extractQuads(r.vertex, r.index, r.quads, quadKeys(r.quads));
  assert.equal(all.quadCount, r.quadCount);
  assert.equal(all.vertexCount, r.vertexCount);
  assert.deepEqual([...new Uint32Array(all.index)], [...new Uint32Array(r.index)]);
});

test('extracting nothing yields empty buffers, not null', () => {
  const r = mesh((put) => put(4, 4, 4, STONE));
  const out = extractQuads(r.vertex, r.index, r.quads, new Set());
  assert.equal(out.quadCount, 0);
  assert.equal(out.vertexCount, 0);
  assert.equal(out.indexCount, 0);
  assert.ok(out.vertex.byteLength === 0);
});

test('extraction rejects a buffer that breaks the vertex/quad invariant', () => {
  const r = mesh((put) => put(4, 4, 4, STONE));
  // Truncate the vertex buffer so the invariant no longer holds.
  const short = r.vertex.slice(0, 8);
  assert.throws(
    () => extractQuads(short, r.index, r.quads, quadKeys(r.quads)),
    /vertex\/quad invariant/,
  );
});

// ---------------------------------------------------------------------------
// Spawn progress
// ---------------------------------------------------------------------------

test('only added quads start unspawned', () => {
  const prev = table([A]);
  const next = table([A, B]);
  const { added } = diffQuads(prev, next);
  const bytes = spawnProgressBytes(next, added);

  assert.equal(bytes.length, 2 * 4, 'one byte per vertex of both quads');
  assert.deepEqual([...bytes.slice(0, 4)], [255, 255, 255, 255], 'common quad is settled');
  assert.deepEqual([...bytes.slice(4, 8)], [0, 0, 0, 0], 'added quad animates in');
});

test('spawn progress covers every quad in the side table', () => {
  const r = mesh((put) => {
    for (let y = 2; y < 5; y++) { put(1, y, 1, STONE); put(12, y, 12, BRICK); }
  });
  const bytes = spawnProgressBytes(r.quads, new Set());
  assert.equal(bytes.length, r.quadCount * 4);
  assert.ok(bytes.every((b) => b === 255), 'no added quads means everything is settled');
});

// ---------------------------------------------------------------------------
// Diffing real mesher output
// ---------------------------------------------------------------------------

test('adding a block to a real column exposes its faces and marks them added', () => {
  const before = mesh((put) => {
    for (let y = 2; y < 5; y++) put(4, y, 4, STONE);
  });
  const after = mesh((put) => {
    for (let y = 2; y < 5; y++) put(4, y, 4, STONE);
    put(5, 3, 4, STONE);
  });

  const { added, removed, common } = diffQuads(before.quads, after.quads);
  const newKeys = quadKeys(after.quads);
  const oldKeys = quadKeys(before.quads);

  // The new block's five exposed faces (+x, -y, +y, -z, +z) all appear.
  // Its -x face is interior against the pillar, so it must NOT.
  for (const nrm of [0, 3, 2, 5, 4]) {
    assert.ok(added.has(`5,3,4,1,1,${nrm},1`), `face nrm=${nrm} of the new block must be added`);
  }
  assert.ok(!added.has('5,3,4,1,1,1,1'), 'the -x face is interior and must not appear');

  // Counts are consistent with both generations.
  assert.equal(added.size + common, after.quadCount);
  assert.equal(removed.size + common, before.quadCount);

  // Added keys exist only in the new generation, removed only in the old.
  for (const k of added) {
    assert.ok(newKeys.has(k), `${k} must be in the new generation`);
    assert.ok(!oldKeys.has(k), `${k} must not be in the old generation`);
  }
  for (const k of removed) {
    assert.ok(oldKeys.has(k));
    assert.ok(!newKeys.has(k));
  }
  assert.ok(common > 0, 'the untouched sides must be left alone');

  // Greedy re-merging legitimately reshapes quads even for a small edit: the
  // pillar's single w=3 +x face is blocked in the middle by the new block and
  // splits into two 1x1 remnants. This is why the diff keys on quad content
  // instead of on position in the buffer.
  assert.ok(removed.has('4,2,4,3,1,0,1'), 'the merged +x face is superseded');
  assert.ok(added.has('4,2,4,1,1,0,1') && added.has('4,4,4,1,1,0,1'), 'and splits in two');
});

test('removing a block from a real column marks its faces as removed', () => {
  const before = mesh((put) => {
    for (let y = 2; y < 5; y++) { put(4, y, 4, STONE); put(5, 3, 4, BRICK); }
  });
  const after = mesh((put) => {
    for (let y = 2; y < 5; y++) put(4, y, 4, STONE);
  });

  const { added, removed, common } = diffQuads(before.quads, after.quads);

  // The removed cube's five exposed brick faces all disappear. Its -x face never
  // existed: it was interior against the pillar.
  for (const nrm of [0, 3, 2, 5, 4]) {
    assert.ok(removed.has(`5,3,4,1,1,${nrm},2`), `brick face nrm=${nrm} must be removed`);
  }
  assert.equal(removed.size + common, before.quadCount);

  // Taking the brick away lets the pillar's two split +x faces re-merge into a
  // single wide quad, so one quad is added and two are removed. Greedy meshing
  // re-derives extents from scratch every rebuild, so a purely subtractive edit
  // can still add a quad -- the diff has to tolerate that or FX will flicker.
  assert.equal(added.size, 1);
  assert.ok(added.has('4,2,4,3,1,0,1'), 'the pillar re-merges into one wide +x face');
  assert.ok(removed.has('4,2,4,1,1,0,1'));
  assert.ok(removed.has('4,4,4,1,1,0,1'));

  // Whatever survives the filter is exactly the unchanged surface.
  const surviving = extractQuads(
    before.vertex, before.index, before.quads,
    new Set([...quadKeys(before.quads)].filter((k) => !removed.has(k))),
  );
  assert.equal(surviving.quadCount, common);
  const survivingKeys = quadKeys(surviving.quads);
  for (const k of survivingKeys) assert.ok(!removed.has(k));
});

test('destroying an entire column extracts its full geometry for melting', () => {
  const before = mesh((put) => {
    for (let x = 3; x < 7; x++)
      for (let y = 4; y < 8; y++)
        for (let z = 3; z < 7; z++) put(x, y, z, STONE);
  });
  const empty = mesh(null);
  const { removed } = diffQuads(before.quads, empty.quads);

  const melt = extractQuads(before.vertex, before.index, before.quads, removed);
  assert.equal(melt.quadCount, before.quadCount, 'the whole surface must melt away');
  assert.equal(melt.vertexCount, before.vertexCount);
});

test('the side table stride matches the mesher', () => {
  assert.equal(QUAD_STRIDE, 7);
  const r = mesh((put) => put(4, 4, 4, STONE));
  const decoded = decodeQuads(r.quads);
  assert.equal(decoded.length, r.quadCount);
  assert.equal(quadKeys(r.quads).size, r.quadCount, 'keys are unique for distinct quads');
});

// ---------------------------------------------------------------------------
// fx attribute bytes
// ---------------------------------------------------------------------------

test('fxBytes marks only the animated quads and tags them with the mode', () => {
  const gen = table([A, B]);
  const bytes = fxBytes(gen, new Set(['4,2,4,2,3,4,2']), FX_MODE.SPAWN, 0);
  assert.equal(bytes.length, 2 * 4 * FX_CHANNELS);

  // One quad is four consecutive vertices of (progress, mode, seed, unused).
  const quad = (q) => Array.from(bytes.slice(q * 16, (q + 1) * 16));
  const spread = (a) => [...a, ...a, ...a, ...a];

  const seedA = quad(0)[2];
  assert.deepEqual(quad(0), spread([255, FX_MODE.SETTLED, seedA, 0]), 'settled quad');

  const seedB = quad(1)[2];
  assert.deepEqual(quad(1), spread([0, FX_MODE.SPAWN, seedB, 0]), 'spawning quad');
});

test('fx seeds are stable per quad and differ between quads', () => {
  const bytes = fxBytes(table([A, B]), new Set(), FX_MODE.SETTLED, 255);
  const seeds = [bytes[2], bytes[16 + 2]];
  assert.ok(seeds[0] !== seeds[1], 'a per-quad seed must vary or the dissolve pattern repeats');

  const again = fxBytes(table([A, B]), new Set(), FX_MODE.SETTLED, 255);
  assert.equal(again[2], seeds[0], 'and must be stable across rebuilds');
});

test('fxBytesUniform drives every quad, used for melting geometry', () => {
  const bytes = fxBytesUniform(3, FX_MODE.DESTROY, 0);
  assert.equal(bytes.length, 3 * 16);
  for (let q = 0; q < 3; q++) {
    assert.equal(bytes[q * 16], 0);
    assert.equal(bytes[q * 16 + 1], FX_MODE.DESTROY);
  }
});

test('quadIndices selects exactly the animated quads', () => {
  const r = mesh((put) => {
    for (let y = 2; y < 5; y++) { put(4, y, 4, STONE); put(12, y, 12, BRICK); }
  });
  const all = quadKeys(r.quads);
  const one = [...all][0];

  assert.deepEqual([...quadIndices(r.quads, new Set())], []);
  assert.deepEqual([...quadIndices(r.quads, all)], [...Array(r.quadCount).keys()]);

  const picked = quadIndices(r.quads, new Set([one]));
  assert.equal(picked.length, 1);
  assert.ok(picked[0] < r.quadCount, 'indices must address real quads');
});

test('the updater can move one quad without disturbing its settled neighbour', () => {
  // Mirrors what ChunkMesh.update does: write progress at quadIndices offsets.
  const r = mesh((put) => {
    for (let y = 2; y < 5; y++) { put(4, y, 4, STONE); put(12, y, 12, BRICK); }
  });
  const all = quadKeys(r.quads);
  const target = [...all][3];
  const { added } = diffQuads(r.quads, r.quads); // no-op, just to shape the result
  assert.equal(added.size, 0);

  const bytes = fxBytes(r.quads, new Set([target]), FX_MODE.SPAWN, 0);
  const idx = quadIndices(r.quads, new Set([target]));

  // Advance only the target to full.
  for (const q of idx) bytes[q * 16] = 255;

  for (let q = 0; q < r.quadCount; q++) {
    const animated = q === idx[0];
    assert.equal(
      bytes[q * 16], animated ? 255 : 255,
      'settled quads were already 255',
    );
  }
  // The mode channel is what distinguishes them, and it must be untouched.
  for (let q = 0; q < r.quadCount; q++) {
    const animated = q === idx[0];
    assert.equal(bytes[q * 16 + 1], animated ? FX_MODE.SPAWN : FX_MODE.SETTLED);
  }
});

// ---------------------------------------------------------------------------
// Visibility partitioning
// ---------------------------------------------------------------------------

const GLASS = 9;

test('an all-opaque column yields no glass partition', () => {
  const r = mesh((put) => {
    for (let x = 4; x < 8; x++)
      for (let y = 5; y < 9; y++)
        for (let z = 4; z < 8; z++) put(x, y, z, STONE);
  });
  const parts = partitionByVis(r);
  assert.ok(parts.opaque);
  assert.equal(parts.opaque.quadCount, r.quadCount);
  assert.equal(parts.glass, null);
});

test('a glass block is separated from the opaque surface around it', () => {
  const r = mesh((put) => {
    for (let x = 4; x < 8; x++)
      for (let y = 5; y < 9; y++)
        for (let z = 4; z < 8; z++) put(x, y, z, STONE);
    put(2, 5, 4, GLASS);
  });
  const parts = partitionByVis(r);
  assert.ok(parts.opaque, 'the stone block is still opaque');
  assert.ok(parts.glass, 'the glass must not be left in the deferred pass');

  const glassQuads = decodeQuads(parts.glass.quads);
  assert.ok(glassQuads.length > 0);
  for (const q of glassQuads) assert.equal(q.mat, GLASS, 'no opaque quad may leak into glass');
  for (const q of decodeQuads(parts.opaque.quads)) assert.equal(q.mat, STONE);
});

test('partitioning duplicates no vertices and loses no quads', () => {
  const r = mesh((put) => {
    for (let x = 3; x < 7; x++)
      for (let y = 4; y < 8; y++)
        for (let z = 3; z < 7; z++) put(x, y, z, x % 2 ? STONE : GLASS);
  });
  const parts = partitionByVis(r);

  const opaqueQuads = parts.opaque ? parts.opaque.quadCount : 0;
  const glassQuads = parts.glass ? parts.glass.quadCount : 0;
  assert.equal(opaqueQuads + glassQuads, r.quadCount, 'every quad must land in exactly one class');

  const opaqueVerts = parts.opaque ? parts.opaque.vertexCount : 0;
  const glassVerts = parts.glass ? parts.glass.vertexCount : 0;
  assert.equal(
    opaqueVerts + glassVerts, r.vertexCount,
    'the split must not duplicate any vertex storage',
  );

  // Each partition must independently satisfy the invariant extractQuads relies on.
  for (const p of [parts.opaque, parts.glass]) {
    if (!p) continue;
    assert.equal(p.vertexCount, p.quadCount * 4);
    assert.equal(p.indexCount, p.quadCount * 6);
  }
});

test('glass-to-glass seams are culled while glass-to-air faces are not', () => {
  const one = partitionByVis(mesh((put) => put(3, 5, 3, GLASS)));
  const three = partitionByVis(mesh((put) => {
    for (let x = 3; x < 6; x++) put(x, 5, 3, GLASS);
  }));

  // A single glass voxel already exposes all six sides. If glass-to-glass were
  // emitted, a three-voxel bar would show two extra interior faces per seam, so
  // an unchanged count is direct proof the interior faces are culled.
  assert.equal(decodeQuads(one.glass.quads).length, 6);
  assert.equal(decodeQuads(three.glass.quads).length, 6);

  // The bar's long faces must still merge across the run.
  const q = decodeQuads(three.glass.quads);
  const longFaces = q.filter((f) => f.nrm === 4 || f.nrm === 5);
  assert.equal(longFaces.length, 2);
  for (const f of longFaces) assert.equal(f.w, 3, 'the long side merges across all three voxels');

  // And the ends stay 1x1, not merged away.
  const ends = q.filter((f) => f.nrm === 0 || f.nrm === 1);
  assert.equal(ends.length, 2);
  for (const f of ends) assert.equal(f.w, 1);
});
