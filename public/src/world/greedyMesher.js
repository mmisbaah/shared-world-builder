/**
 * Greedy voxel mesher with baked per-corner ambient occlusion.
 *
 * Pure and dependency-free: no three.js, no DOM. It runs identically inside the
 * mesher Web Worker and inside `node --test`, which is what lets us prove the
 * output is correct (see test/greedyMesher.test.js).
 *
 * ---------------------------------------------------------------------------
 * Vertex layout: 16 bytes, interleaved.
 *
 *   byte  size  type      name     meaning
 *   ----  ----  --------  -------  -----------------------------------------
 *     0    6   Int16x3    aPos     chunk-local integer voxel coordinate
 *     6    4   Uint16x2   aUV      greedy quad extents along (u, v)
 *    10    4   Uint8x4    aFaceAO  nx,ny,nz encoded as component+1 (0..2); AO level 0..3
 *    14    2   Uint16     aMat     material id
 *
 * Because the stride is 16 bytes (8 int16 slots) every attribute sits on its
 * natural alignment: Int16 needs 2, Uint16 needs 2, Uint8 needs 1.
 *
 * Damage/spawn dissolve progress deliberately lives *outside* this buffer in a
 * dynamic attribute, so the static 16-byte layout stays cache-friendly and only
 * the handful of animating quads are ever touched.
 *
 * ---------------------------------------------------------------------------
 * Face visibility rule
 *
 * The mask holds exactly one face per plane cell, so at a boundary between two
 * different materials only one side can own the face. Emit a face when the two
 * cells straddling it have different visibility classes and at least one is
 * non-air:
 *
 *   opaque | opaque   -> cull (interior)
 *   opaque | glass    -> emit, owned by the OPAQUE cell
 *   opaque | air      -> emit
 *   glass  | glass    -> cull
 *   air    | air      -> cull
 *
 * Ownership is resolved towards opaque rather than towards whichever cell the
 * sweep happened to visit first. Without that, the same stone/glass seam would
 * resolve to a different owner depending on which side you swept from, and
 * glass could end up with a face coplanar with the opaque surface behind it.
 *
 * Because glass never owns a seam face and glass-on-glass is culled, translucent
 * geometry can never be sandwiched against a coincident opaque quad — so no
 * depth fighting at material boundaries.
 *
 * Merging is greedy in (u, v) space over a mask keyed on
 * (material, face normal, packed 4-corner AO), so a run is only merged when the
 * shading is provably identical — no AO seams get averaged away.
 *
 * The quad side table records each quad's *corner cell* (the merge origin), not
 * a single owning voxel: a merged quad can span many voxels. It exists so the
 * client can diff two mesh generations and animate only the quads that actually
 * changed.
 */

import { VIS_LUT, VIS } from '../../../shared/materials.js';

export const VERTEX_STRIDE = 16;
const SLOTS_PER_VERTEX = 8; // 16 bytes / 2

/** Normal index -> unit vector component triple. */
export const FACE_NORMALS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

export const FLOATS_PER_QUAD = 7; // ox, oy, oz, w, h, normalIndex, materialId

const ao00 = (p) => p & 3;
const ao10 = (p) => (p >> 2) & 3;
const ao11 = (p) => (p >> 4) & 3;
const ao01 = (p) => (p >> 6) & 3;

/** Growable ArrayBuffer with aligned typed-array views over the same memory. */
class PackedVertices {
  constructor(initialVertices) {
    this._alloc(Math.max(64, initialVertices));
  }

  _alloc(vertexCapacity) {
    const buf = new ArrayBuffer(vertexCapacity * VERTEX_STRIDE);
    this.buffer = buf;
    this.i16 = new Int16Array(buf);
    this.u16 = new Uint16Array(buf);
    this.u8 = new Uint8Array(buf);
    this.count = 0;
  }

  reserve(extraVertices) {
    if ((this.count + extraVertices) * VERTEX_STRIDE <= this.buffer.byteLength) return;
    let cap = this.buffer.byteLength / VERTEX_STRIDE;
    while (cap < this.count + extraVertices) cap *= 2;
    const keep = this.count;
    const old = new Uint8Array(this.buffer, 0, keep * VERTEX_STRIDE);
    this._alloc(cap);
    new Uint8Array(this.buffer).set(old);
    this.count = keep; // _alloc resets count; restore it
  }

  push(x, y, z, u, v, nIdx, ao, mat) {
    const s = this.count * SLOTS_PER_VERTEX;
    const b = this.count * VERTEX_STRIDE;
    const n = FACE_NORMALS[nIdx];
    this.i16[s + 0] = x;
    this.i16[s + 1] = y;
    this.i16[s + 2] = z;
    this.u16[s + 3] = u;
    this.u16[s + 4] = v;
    this.u8[b + 10] = n[0] + 1;
    this.u8[b + 11] = n[1] + 1;
    this.u8[b + 12] = n[2] + 1;
    this.u8[b + 13] = ao;
    this.u16[s + 7] = mat;
    this.count++;
  }

  /** Detached copy of the used range, ready to transfer to a worker. */
  view() {
    return new Uint8Array(this.buffer, 0, this.count * VERTEX_STRIDE);
  }
}

/**
 * @param {Uint16Array} padded  (sizeXZ+2) x (sizeY+2) x (sizeXZ+2) material ids
 *                              with a 1-voxel apron on every side, indexed from
 *                              -1..size on each axis.
 * @param {number} sizeXZ       chunk edge length in voxels on the X and Z axes.
 * @param {Uint8Array} [visLut] material id -> visibility class.
 * @param {number} [sizeY]      chunk height in voxels. Defaults to sizeXZ, which
 *                              meshes a cube. Chunks in this world span the full
 *                              vertical extent, so sizeY is normally WORLD.MAX_Y.
 * @returns {{vertex:ArrayBuffer,index:ArrayBuffer,quads:ArrayBuffer,
 *            vertexCount:number,indexCount:number,quadCount:number}}
 */
export function greedyMesh(padded, sizeXZ, visLut = VIS_LUT, sizeY = sizeXZ) {
  const SX = sizeXZ + 2; // padded stride along X
  const SZ = SX; // padded stride along Z
  const SY = SX * SZ; // padded stride along Y: one whole X-Z plane

  // Layout is x fastest, then z, then y, so a Y-sized slab needs its own plane
  // stride. Using SX * SY here instead would make the maximum index exceed the
  // buffer, and out-of-bounds typed-array reads return undefined rather than
  // throwing -- which silently turns apron samples into air.
  const at = (x, y, z) => padded[(x + 1) + (z + 1) * SX + (y + 1) * SY];
  // Only opaque cells occlude. Glass must not darken its neighbours' corners,
  // and a solid glass block should not self-shade into a muddy blob.
  const opaque = (id) => (visLut[id] === VIS.OPAQUE ? 1 : 0);

  const maskCells = sizeXZ * sizeY;
  const maskMat = new Int32Array(maskCells);
  const maskAO = new Int32Array(maskCells);
  const maskNrm = new Int8Array(maskCells);
  // The solid cell each mask entry belongs to. This has to live per mask cell
  // rather than in one scratch array: the mask sweep touches every cell long
  // before the merge pass revisits them in a different order.
  const maskOx = new Int16Array(maskCells);
  const maskOy = new Int16Array(maskCells);
  const maskOz = new Int16Array(maskCells);

  const vertBuf = new PackedVertices(sizeXZ * sizeY * 6);
  let quadCount = 0;
  let quadCursor = 0;
  const quadFloats = new Float32Array(sizeXZ * sizeY * 6 * FLOATS_PER_QUAD);

  let indexCount = 0;
  let indexArr = new Uint32Array(2048);

  const reserveIndices = (n) => {
    if (indexCount + n <= indexArr.length) return;
    let cap = indexArr.length;
    while (cap < indexCount + n) cap *= 2;
    const next = new Uint32Array(cap);
    next.set(indexArr.subarray(0, indexCount));
    indexArr = next;
  };

  // Scratch coordinates reused across iterations (no per-iteration allocation).
  const owner = [0, 0, 0];
  const ca = [0, 0, 0]; // cell "a"
  const cb = [0, 0, 0]; // cell "b", one step further along d

  /**
   * Classic voxel AO for one face corner.
   *
   * `d` is the sweep axis; `gu`/`gv` are the corner's integer grid position
   * along the sweep's u and v axes. The three samples are the cell directly
   * behind that corner plus its +u and +v neighbours, all inside the face
   * plane. Each axis independently takes gu, gv, or the plane base coordinate,
   * which is why this takes `d` and permutes by axis index instead of by
   * branching on d.
   */
  const aoAt = (d, bx, by, bz, gu, gv, u, v) => {
    const ax = u === 0 ? gu : v === 0 ? gv : bx;
    const ay = u === 1 ? gu : v === 1 ? gv : by;
    const az = u === 2 ? gu : v === 2 ? gv : bz;

    let e1x = ax, e1y = ay, e1z = az;
    if (u === 0) e1x++; else if (u === 1) e1y++; else e1z++;

    let e2x = ax, e2y = ay, e2z = az;
    if (v === 0) e2x++; else if (v === 1) e2y++; else e2z++;

    const c = opaque(at(ax, ay, az));
    const e1 = opaque(at(e1x, e1y, e1z));
    const e2 = opaque(at(e2x, e2y, e2z));
    return e1 && e2 ? 0 : 3 - (e1 + e2 + c);
  };

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;

    // Extent along each axis. A chunk column spans the whole world vertically,
    // so the three axes are not the same length and the mask must be indexed by
    // the u extent rather than by a single shared `size`.
    const nD = d === 1 ? sizeY : sizeXZ;
    const nU = u === 1 ? sizeY : sizeXZ;
    const nV = v === 1 ? sizeY : sizeXZ;

    maskMat.fill(0);
    maskAO.fill(0);
    maskNrm.fill(-1);

    for (let k = -1; k < nD; k++) {
      // --- build the mask for the plane between voxel k and k+1 along d ---
      let n = 0;
      for (let j = 0; j < nV; j++) {
        for (let i = 0; i < nU; i++) {
          // (d, u, v) is a permutation of (x, y, z), so assigning the three
          // axes by index keeps every coordinate defined on every branch.
          ca[0] = 0; ca[1] = 0; ca[2] = 0;
          ca[d] = k; ca[u] = i; ca[v] = j;
          cb[0] = ca[0]; cb[1] = ca[1]; cb[2] = ca[2];
          cb[d] = k + 1;

          const a = at(ca[0], ca[1], ca[2]);
          const b = at(cb[0], cb[1], cb[2]);
          const va = visLut[a] | 0;
          const vb = visLut[b] | 0;

          // Identical visibility class (including both-air) -> interior, cull.
          if (va === vb) { n++; continue; }

          // Resolve ownership towards opaque rather than towards whichever cell
          // the sweep reached first, so seam faces are deterministic.
          let ownerIsA;
          if (va === VIS.AIR) ownerIsA = false;
          else if (vb === VIS.AIR) ownerIsA = true;
          else ownerIsA = va === VIS.OPAQUE;

          const dir = ownerIsA ? 1 : -1;
          const mat = ownerIsA ? a : b;

          if (ownerIsA) { owner[0] = ca[0]; owner[1] = ca[1]; owner[2] = ca[2]; }
          else { owner[0] = cb[0]; owner[1] = cb[1]; owner[2] = cb[2]; }
          // AO is sampled in the empty plane one step along the face normal.
          const nbx = d === 0 ? owner[0] + dir : owner[0];
          const nby = d === 1 ? owner[1] + dir : owner[1];
          const nbz = d === 2 ? owner[2] + dir : owner[2];

          const gi = i - 1;
          const gj = j - 1;
          const a00 = aoAt(d, nbx, nby, nbz, gi, gj, u, v);
          const a10 = aoAt(d, nbx, nby, nbz, gi + 1, gj, u, v);
          const a11 = aoAt(d, nbx, nby, nbz, gi + 1, gj + 1, u, v);
          const a01 = aoAt(d, nbx, nby, nbz, gi, gj + 1, u, v);

          maskMat[n] = dir * mat;
          maskAO[n] = a00 | (a10 << 2) | (a11 << 4) | (a01 << 6);
          maskNrm[n] = d * 2 + (dir > 0 ? 0 : 1);
          maskOx[n] = owner[0];
          maskOy[n] = owner[1];
          maskOz[n] = owner[2];
          n++;
        }
      }

      // --- greedy merge over (i, j) = (u, v) ---
      const plane = k + 1; // face plane coordinate along d
      for (let j = 0; j < nV; j++) {
        for (let i = 0; i < nU; ) {
          const idx = i + j * nU;
          const m = maskMat[idx];
          if (m === 0) { i++; continue; }

          const ao = maskAO[idx];
          const nrm = maskNrm[idx];
          const mat = m < 0 ? -m : m;
          const positive = m > 0;

          let w = 1;
          while (
            i + w < nU &&
            maskMat[idx + w] === m &&
            maskAO[idx + w] === ao &&
            maskNrm[idx + w] === nrm
          ) w++;

          let h = 1;
          grow: while (j + h < nV) {
            const rowBase = idx + h * nU;
            for (let t = 0; t < w; t++) {
              if (
                maskMat[rowBase + t] !== m ||
                maskAO[rowBase + t] !== ao ||
                maskNrm[rowBase + t] !== nrm
              ) break grow;
            }
            h++;
          }

          // --- emit quad ---
          const base = [0, 0, 0];
          base[d] = plane;

          // Corner offsets in (u, v). Winding is CCW seen from outside.
          // (u, v, d) is a right-handed cyclic basis, so u x v == +d.
          const corners = positive
            ? [[0, 0], [w, 0], [w, h], [0, h]]
            : [[0, 0], [0, h], [w, h], [w, 0]];
          // AO order follows the emitted winding; the -d case is mirrored.
          const aoOrder = positive
            ? [ao00(ao), ao10(ao), ao11(ao), ao01(ao)]
            : [ao00(ao), ao01(ao), ao11(ao), ao10(ao)];

          vertBuf.reserve(4);
          const vBase = vertBuf.count;

          for (let c = 0; c < 4; c++) {
            const ou = corners[c][0];
            const ov = corners[c][1];
            base[u] = i + ou;
            base[v] = j + ov;
            vertBuf.push(base[0], base[1], base[2], ou, ov, nrm, aoOrder[c], mat);
          }

          reserveIndices(6);
          indexArr[indexCount++] = vBase;
          indexArr[indexCount++] = vBase + 1;
          indexArr[indexCount++] = vBase + 2;
          indexArr[indexCount++] = vBase;
          indexArr[indexCount++] = vBase + 2;
          indexArr[indexCount++] = vBase + 3;

          quadFloats[quadCursor + 0] = maskOx[idx];
          quadFloats[quadCursor + 1] = maskOy[idx];
          quadFloats[quadCursor + 2] = maskOz[idx];
          quadFloats[quadCursor + 3] = w;
          quadFloats[quadCursor + 4] = h;
          quadFloats[quadCursor + 5] = nrm;
          quadFloats[quadCursor + 6] = mat;
          quadCursor += FLOATS_PER_QUAD;
          quadCount++;

          // Consume the merged region.
          for (let jj = 0; jj < h; jj++) {
            const rowBase = idx + jj * nU;
            for (let ii = 0; ii < w; ii++) maskMat[rowBase + ii] = 0;
          }
          i += w;
        }
      }
    }
  }

  return {
    vertex: vertBuf.view().slice().buffer,
    index: indexArr.slice(0, indexCount).buffer,
    quads: quadFloats.slice(0, quadCursor).buffer,
    vertexCount: vertBuf.count,
    indexCount,
    quadCount,
  };
}

// ---------------------------------------------------------------------------
// Test / tooling helpers
// ---------------------------------------------------------------------------

/**
 * Allocate a zeroed apron buffer for {@link greedyMesh}, 1 voxel of padding on
 * every side. Defaults to a cube; pass sizeY for a full-height chunk column.
 */
export function createPaddedBuffer(sizeXZ, sizeY = sizeXZ) {
  return new Uint16Array((sizeXZ + 2) * (sizeY + 2) * (sizeXZ + 2));
}

export function paddedIndex(sizeXZ, x, y, z, sizeY = sizeXZ) {
  const SX = sizeXZ + 2;
  const SY = SX * SX; // must match the stride used inside greedyMesh
  return (x + 1) + (z + 1) * SX + (y + 1) * SY;
}

/** Write a single voxel into a padded buffer. Coordinates may be -1..size. */
export function setPadded(padded, sizeXZ, x, y, z, material, sizeY = sizeXZ) {
  padded[paddedIndex(sizeXZ, x, y, z, sizeY)] = material;
}

/** Read a single voxel out of a padded buffer. */
export function getPadded(padded, sizeXZ, x, y, z, sizeY = sizeXZ) {
  return padded[paddedIndex(sizeXZ, x, y, z, sizeY)];
}

/** Decode a packed vertex buffer back into readable objects (tests + debugging). */
export function decodeVertices(vertexBuffer, vertexCount) {
  const u8 = new Uint8Array(vertexBuffer);
  const i16 = new Int16Array(u8.buffer, u8.byteOffset, vertexCount * SLOTS_PER_VERTEX);
  const u16 = new Uint16Array(u8.buffer, u8.byteOffset, vertexCount * SLOTS_PER_VERTEX);
  const out = [];
  for (let v = 0; v < vertexCount; v++) {
    const s = v * SLOTS_PER_VERTEX;
    const b = v * VERTEX_STRIDE;
    out.push({
      x: i16[s + 0], y: i16[s + 1], z: i16[s + 2],
      u: u16[s + 3], v: u16[s + 4],
      n: [u8[b + 10] - 1, u8[b + 11] - 1, u8[b + 12] - 1],
      ao: u8[b + 13],
      mat: u16[s + 7],
    });
  }
  return out;
}

/** Decode the per-quad side table produced alongside the vertex buffer. */
export function decodeQuads(quadBuffer) {
  const f = new Float32Array(quadBuffer);
  const out = [];
  for (let i = 0; i < f.length; i += FLOATS_PER_QUAD) {
    out.push({
      ox: f[i], oy: f[i + 1], oz: f[i + 2],
      w: f[i + 3], h: f[i + 4], nrm: f[i + 5], mat: f[i + 6],
    });
  }
  return out;
}
