/**
 * Pure quad-set algebra for the chunk mesh dual buffer.
 *
 * The mesher emits quads in a stable order and, crucially, in a fixed
 * relationship to the vertex and index buffers: every quad owns exactly four
 * consecutive vertices and six consecutive indices. That invariant is what lets
 * a *subset* of quads be re-packed into a standalone geometry without a second
 * meshing pass, which is how destroy FX works on geometry that no longer exists
 * in the new mesh.
 *
 * Kept free of three.js so it can be unit tested directly.
 */

import { VIS_LUT, VIS } from '../../../shared/materials.js';

/** Floats per record in the side table emitted by greedyMesh. */
export const QUAD_STRIDE = 7;

const VERTICES_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;

/**
 * Stable identity for one quad: its corner cell, extent, normal and material.
 *
 * Two generations agree on this key exactly when they describe the same surface
 * patch, which is what makes "animate only what changed" possible.
 */
export function quadKey(f, o) {
  return `${f[o] | 0},${f[o + 1] | 0},${f[o + 2] | 0},`
    + `${f[o + 3] | 0},${f[o + 4] | 0},${f[o + 5] | 0},${f[o + 6] | 0}`;
}

/** Key for every quad in a side table. */
export function quadKeys(buffer) {
  const f = new Float32Array(buffer);
  const n = f.length / QUAD_STRIDE;
  const keys = new Set();
  for (let i = 0; i < n; i++) keys.add(quadKey(f, i * QUAD_STRIDE));
  return keys;
}

/**
 * Compare two mesh generations.
 *
 * @returns {{added:Set<string>, removed:Set<string>, common:number}}
 *   `added`   quads only in `next`  -> animate in as a spawn
 *   `removed` quads only in `prev`  -> animate out as a destroy
 *   `common`  count of quads present in both -> leave alone entirely
 */
export function diffQuads(prevBuffer, nextBuffer) {
  const prev = quadKeys(prevBuffer);
  const next = quadKeys(nextBuffer);

  const added = new Set();
  const removed = new Set();
  let common = 0;

  for (const k of next) {
    if (prev.has(k)) common++;
    else added.add(k);
  }
  for (const k of prev) {
    if (!next.has(k)) removed.add(k);
  }
  return { added, removed, common };
}

/**
 * Re-pack a subset of quads into a standalone vertex/index pair.
 *
 * Indices are rebased, so the result can back its own mesh without sharing
 * buffers with the live geometry.
 *
 * @param {ArrayBuffer} vertexBuffer interleaved 16-byte vertices
 * @param {ArrayBuffer} indexBuffer  uint32 indices
 * @param {ArrayBuffer} quadBuffer   side table for the same generation
 * @param {Set<string>} keep         keys to retain
 * @returns {{vertex:ArrayBuffer, index:ArrayBuffer, quads:ArrayBuffer,
 *            vertexCount:number, indexCount:number, quadCount:number}}
 */
export function extractQuads(vertexBuffer, indexBuffer, quadBuffer, keep) {
  const f = new Float32Array(quadBuffer);
  const quadCount = f.length / QUAD_STRIDE;
  const vertexBytes = new Uint8Array(vertexBuffer);
  const index = new Uint32Array(indexBuffer);
  const vertexCount = vertexBytes.byteLength / 16;
  const indexCount = index.length;

  // Without this invariant the re-basing below would silently produce garbage.
  if (vertexCount !== quadCount * VERTICES_PER_QUAD) {
    throw new Error(`mesher violated the vertex/quad invariant: ${vertexCount} vertices for ${quadCount} quads`);
  }
  if (indexCount < quadCount * INDICES_PER_QUAD) {
    throw new Error(`mesher violated the index/quad invariant: ${indexCount} indices for ${quadCount} quads`);
  }

  const keptQuads = new Float32Array(quadCount * QUAD_STRIDE);
  const keptVertexBytes = new Uint8Array(quadCount * VERTICES_PER_QUAD * 16);
  const keptIndices = new Uint32Array(quadCount * INDICES_PER_QUAD);

  let vOut = 0;
  let iOut = 0;
  let qOut = 0;

  for (let q = 0; q < quadCount; q++) {
    if (!keep.has(quadKey(f, q * QUAD_STRIDE))) continue;

    const vBase = q * VERTICES_PER_QUAD;
    keptVertexBytes.set(
      vertexBytes.subarray(vBase * 16, (vBase + VERTICES_PER_QUAD) * 16),
      vOut * 16,
    );
    for (let j = 0; j < INDICES_PER_QUAD; j++) {
      keptIndices[iOut + j] = index[q * INDICES_PER_QUAD + j] - vBase + vOut;
    }

    keptQuads.set(f.subarray(q * QUAD_STRIDE, (q + 1) * QUAD_STRIDE), qOut * QUAD_STRIDE);
    vOut += VERTICES_PER_QUAD;
    iOut += INDICES_PER_QUAD;
    qOut++;
  }

  return {
    vertex: keptVertexBytes.slice(0, vOut * 16).buffer,
    index: keptIndices.slice(0, iOut).buffer,
    quads: keptQuads.slice(0, qOut * QUAD_STRIDE).buffer,
    vertexCount: vOut,
    indexCount: iOut,
    quadCount: qOut,
  };
}

/**
 * Per-vertex spawn progress bytes.
 *
 * Returns one byte per vertex: 255 for quads that should already be settled and
 * `value` for quads that should animate in. The mesh turns these into a dissolve
 * threshold, so a non-animated quad is indistinguishable from static geometry.
 */
export function spawnProgressBytes(quadBuffer, animated, value = 0) {
  const f = new Float32Array(quadBuffer);
  const quadCount = f.length / QUAD_STRIDE;
  const out = new Uint8Array(quadCount * VERTICES_PER_QUAD);
  for (let q = 0; q < quadCount; q++) {
    const v = animated.has(quadKey(f, q * QUAD_STRIDE)) ? value : 255;
    out.fill(v, q * VERTICES_PER_QUAD, (q + 1) * VERTICES_PER_QUAD);
  }
  return out;
}

/** Animation modes carried in the second fx channel. */
export const FX_MODE = { SETTLED: 0, SPAWN: 1, DESTROY: 2 };
export const FX_CHANNELS = 4; // progress, mode, seed, unused

/**
 * Expand per-vertex progress into the 4-channel fx attribute the shader reads:
 * (progress, mode, seed, unused).
 *
 * Doing this on the CPU keeps the shader branch-free and lets one material
 * serve settled, spawning and melting geometry without per-mesh uniforms -- so
 * a retiring mesh needs no special-casing beyond its own bytes.
 */
export function fxBytes(quadBuffer, animated, mode, progress = 0) {
  const f = new Float32Array(quadBuffer);
  const quadCount = f.length / QUAD_STRIDE;
  const out = new Uint8Array(quadCount * VERTICES_PER_QUAD * FX_CHANNELS);

  for (let q = 0; q < quadCount; q++) {
    const isAnimated = animated.has(quadKey(f, q * QUAD_STRIDE));
    const base = q * VERTICES_PER_QUAD * FX_CHANNELS;
    // A stable per-quad seed so the dissolve pattern does not crawl between
    // frames as progress advances.
    const seed = (Math.imul(q + 1, 2654435761) >>> 24) & 255;
    for (let v = 0; v < VERTICES_PER_QUAD; v++) {
      const o = base + v * FX_CHANNELS;
      out[o] = isAnimated ? progress : 255;
      out[o + 1] = isAnimated ? mode : FX_MODE.SETTLED;
      out[o + 2] = seed;
      out[o + 3] = 0;
    }
  }
  return out;
}

/** Expand a progress value into a full fx attribute where every quad animates. */
export function fxBytesUniform(quadCount, mode, progress = 0) {
  const out = new Uint8Array(quadCount * VERTICES_PER_QUAD * FX_CHANNELS);
  for (let q = 0; q < quadCount; q++) {
    const base = q * VERTICES_PER_QUAD * FX_CHANNELS;
    const seed = (Math.imul(q + 1, 2654435761) >>> 24) & 255;
    for (let v = 0; v < VERTICES_PER_QUAD; v++) {
      const o = base + v * FX_CHANNELS;
      out[o] = progress;
      out[o + 1] = mode;
      out[o + 2] = seed;
      out[o + 3] = 0;
    }
  }
  return out;
}

/**
 * Quad indices (not keys) whose fx progress must be driven for a spawn.
 *
 * The animation updater writes these and nothing else, so quads that were already
 * settled keep their progress of 255 instead of being dragged down by a
 * neighbour that happens to be dissolving.
 */
export function quadIndices(quadBuffer, keys) {
  const f = new Float32Array(quadBuffer);
  const n = f.length / QUAD_STRIDE;
  const out = [];
  for (let q = 0; q < n; q++) {
    if (keys.has(quadKey(f, q * QUAD_STRIDE))) out.push(q);
  }
  return Uint32Array.from(out);
}

export { VERTICES_PER_QUAD, INDICES_PER_QUAD };

/**
 * Split a raw mesher result into per-visibility-class partitions.
 *
 * The mesher emits opaque and translucent quads into one stream; the renderer
 * needs them apart because they go through different passes. Re-packing with
 * `extractQuads` duplicates no vertices -- every quad lands in exactly one class
 * -- so the two partitions together cost exactly what the combined buffer did.
 *
 * @param {{vertex:ArrayBuffer,index:ArrayBuffer,quads:ArrayBuffer}} result
 * @returns {{opaque:object|null, glass:object|null}}
 */
export function partitionByVis(result) {
  const f = new Float32Array(result.quads);
  const quadCount = f.length / QUAD_STRIDE;

  const opaqueKeys = new Set();
  for (let q = 0; q < quadCount; q++) {
    const o = q * QUAD_STRIDE;
    if (VIS_LUT[f[o + 6]] === VIS.OPAQUE) opaqueKeys.add(quadKey(f, o));
  }

  let glassKeys = null;
  if (quadCount !== opaqueKeys.size) {
    glassKeys = quadKeys(result.quads);
    for (const k of opaqueKeys) glassKeys.delete(k);
  }

  return {
    opaque: opaqueKeys.size
      ? extractQuads(result.vertex, result.index, result.quads, opaqueKeys) : null,
    glass: glassKeys && glassKeys.size
      ? extractQuads(result.vertex, result.index, result.quads, glassKeys) : null,
  };
}
