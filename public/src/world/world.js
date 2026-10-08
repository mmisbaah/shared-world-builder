/**
 * Client-side voxel world.
 *
 * Holds two layers per chunk column:
 *
 *   cells / revs              authoritative state, as the server last confirmed it
 *   predicted / predictedSet  the local player's unconfirmed optimistic overlay
 *
 * Reads go through {@link World#getVoxel}, which prefers the prediction. That is
 * what makes a click feel instant: the ghost appears on the same frame as the
 * input, and only later gets confirmed or rolled back by the socket layer.
 *
 * A column spans the full world height (CHUNK_SIZE x WORLD.MAX_Y x CHUNK_SIZE),
 * so columns tile horizontally only. Every x/y/z passed to the methods here is a
 * world-space voxel coordinate.
 */

import {
  CHUNK_SIZE, CHUNK_AREA, COLUMN_VOLUME, WORLD,
  voxelIndex, chunkKey, worldToChunk, voxelKey,
} from '../../../shared/protocol.js';

const AIR = 0;

/** Padded apron extents handed to the mesher: 1 voxel of border per side. */
const PAD = CHUNK_SIZE + 2; // 18
const PAD_Y = WORLD.MAX_Y - WORLD.MIN_Y + 2; // 50
const PAD_STRIDE_Y = PAD * PAD; // y stride is one whole x-z plane

/**
 * Read a voxel from a column, honouring the prediction overlay.
 * `lx`/`lz` are column-local; `y` is world-space.
 */
function readLocal(c, lx, y, lz) {
  const li = voxelIndex(lx, y, lz);
  return c.predictedSet[li] ? c.predicted[li] : c.cells[li];
}

/**
 * One 16 x WORLD.MAX_Y x 16 column of voxels.
 *
 * Memory: four typed arrays of COLUMN_VOLUME (12288) entries is ~110 KB, so a
 * 24x24 column grid is roughly 63 MB. Meshing is the real bottleneck, not this,
 * but it is why `meshRadius` stays well short of the full 80x80 voxel radius.
 */
export class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKey(cx, cz);

    /** @type {Uint16Array} authoritative material id per voxel */
    this.cells = new Uint16Array(COLUMN_VOLUME);
    /** @type {Uint32Array} authoritative revision per voxel, for optimistic removes */
    this.revs = new Uint32Array(COLUMN_VOLUME);

    /** @type {Uint16Array} optimistic overlay material id */
    this.predicted = new Uint16Array(COLUMN_VOLUME);
    /** @type {Uint8Array} 1 where `predicted` holds a live prediction */
    this.predictedSet = new Uint8Array(COLUMN_VOLUME);

    /** @type {Uint8Array} voxels mutated since this column was last meshed */
    this.dirty = new Uint8Array(COLUMN_VOLUME);

    /** @type {Map<string, object>} prop records keyed by voxelKey */
    this.props = new Map();

    /** Geometry differs from what is currently on the GPU. */
    this.needsMesh = true;
    /**
     * Bumped on every edit. A mesh job records the generation it was built from,
     * so a result that arrives after a newer edit can be recognised as stale and
     * dropped instead of briefly showing geometry that is already out of date.
     */
    this.meshGeneration = 0;
    /** Prop instances differ from what is currently instanced. */
    this.needsProps = true;
    /** Count of non-air authoritative voxels; drives LOD decisions. */
    this.occupied = 0;
    /** Timestamp of the last successful mesh build, for the HUD. */
    this.meshedAt = 0;
  }

  /** Live predictions still awaiting a server answer. */
  get predictionCount() {
    let n = 0;
    const s = this.predictedSet;
    for (let i = 0; i < s.length; i++) if (s[i]) n++;
    return n;
  }

  clearDirty() {
    this.dirty.fill(0);
  }
}

export class World {
  constructor() {
    /** @type {Map<string, Chunk>} */
    this.chunks = new Map();
    /**
     * Columns whose geometry is out of date. The mesh manager drains this once
     * per frame, which is what coalesces a burst of edits into one rebuild.
     * @type {Set<string>}
     */
    this.dirtyColumns = new Set();
  }

  // -------------------------------------------------------------------------
  // Column lookup
  // -------------------------------------------------------------------------

  getColumn(cx, cz) {
    return this.chunks.get(chunkKey(cx, cz));
  }

  /**
   * Fetch or create. Safe to call speculatively for read-then-write flows.
   *
   * A newly created column is queued for meshing here, not left for the caller
   * to remember: `needsMesh` starts true because there is no GPU geometry yet,
   * so a column that never enters `dirtyColumns` would never be built and the
   * snapshot would render nothing.
   */
  column(cx, cz) {
    const key = chunkKey(cx, cz);
    let c = this.chunks.get(key);
    if (!c) {
      c = new Chunk(cx, cz);
      this.chunks.set(key, c);
      this.dirtyColumns.add(key);
    }
    return c;
  }

  /** Resolve a world voxel to its column and linear index. Null if out of range. */
  locate(x, y, z) {
    if (y < WORLD.MIN_Y || y >= WORLD.MAX_Y) return null;
    const { cx, cz } = worldToChunk(x, y, z);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return null;
    return { chunk: c, li: voxelIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE) };
  }

  // -------------------------------------------------------------------------
  // Voxel reads
  // -------------------------------------------------------------------------

  /** Prediction-preferred read. Used by picking and by meshing alike. */
  getVoxel(x, y, z) {
    if (y < WORLD.MIN_Y || y >= WORLD.MAX_Y) return AIR;
    const { cx, cz } = worldToChunk(x, y, z);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return AIR;
    const li = voxelIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE);
    if (c.predictedSet[li]) return c.predicted[li];
    return c.cells[li];
  }

  /** Settled read, ignoring local predictions. */
  getAuthoritative(x, y, z) {
    if (y < WORLD.MIN_Y || y >= WORLD.MAX_Y) return AIR;
    const { cx, cz } = worldToChunk(x, y, z);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return AIR;
    return c.cells[voxelIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)];
  }

  /**
   * Revision the server last assigned, or 0 if unknown. Snapshots carry no
   * per-voxel revisions, so a freshly joined client sends rev = 0 and the server
   * skips the optimistic check for it until the first delta lands.
   */
  getRevision(x, y, z) {
    const hit = this.locate(x, y, z);
    return hit ? hit.chunk.revs[hit.li] : 0;
  }

  isSolid(x, y, z) {
    return this.getVoxel(x, y, z) !== AIR;
  }

  hasPrediction(x, y, z) {
    const hit = this.locate(x, y, z);
    return hit ? hit.chunk.predictedSet[hit.li] === 1 : false;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Write settled state from the server. Returns true when it actually changed
   * something, which callers use to decide whether to emit FX or re-mesh.
   */
  setAuthoritative(x, y, z, mat, rev) {
    const hit = this.locate(x, y, z);
    if (!hit) return false;
    const { chunk: c, li } = hit;

    const was = c.cells[li];
    if (was === mat && (rev === undefined || c.revs[li] === rev)) return false;

    if (was === AIR && mat !== AIR) c.occupied++;
    else if (was !== AIR && mat === AIR) c.occupied--;

    c.cells[li] = mat;
    if (rev !== undefined) c.revs[li] = rev;
    this._touch(x, y, z, li);
    return true;
  }

  /**
   * Install an optimistic value. `mat` of 0 is a legal prediction (a predicted
   * removal), so the mask byte -- not the material id -- signals "live".
   */
  setPredicted(x, y, z, mat) {
    const hit = this.locate(x, y, z);
    if (!hit) return;
    const { chunk: c, li } = hit;
    c.predicted[li] = mat;
    c.predictedSet[li] = 1;
    this._touch(x, y, z, li);
  }

  /**
   * Drop a prediction, optionally writing an authoritative value in its place.
   *
   * Both matter on an ack: the delta carrying the new state may not have arrived
   * yet, so passing `fallback` makes the mesh correct immediately and turns the
   * later delta into a no-op instead of a one-frame flicker. `rev` must be passed
   * too, or the client never learns the authoritative revision and a follow-up
   * removal goes out with rev = 0 -- which makes the server skip its stale-write
   * check precisely when it matters.
   */
  clearPredicted(x, y, z, fallback, rev) {
    const hit = this.locate(x, y, z);
    if (!hit) return;
    const { chunk: c, li } = hit;
    if (!c.predictedSet[li]) return;
    c.predictedSet[li] = 0;
    if (fallback !== undefined) this.setAuthoritative(x, y, z, fallback, rev);
    else this._touch(x, y, z, li);
  }

  /**
   * Flag every column whose geometry a change at (x, y, z) can affect: its own,
   * plus any neighbour sharing the mutated voxel's face, plus the diagonal
   * neighbour at a corner. Miss the diagonals and you get single-voxel cracks at
   * column intersections that never heal, because neither column is ever marked.
   */
  _touch(x, y, z, li) {
    const { cx, cz } = worldToChunk(x, y, z);
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;

    this._touchColumn(cx, cz, li);

    const xEdge = lx === 0 ? -1 : lx === CHUNK_SIZE - 1 ? 1 : 0;
    const zEdge = lz === 0 ? -1 : lz === CHUNK_SIZE - 1 ? 1 : 0;

    if (xEdge) {
      this._touchColumn(cx + xEdge, cz, voxelIndex(xEdge < 0 ? CHUNK_SIZE - 1 : 0, y, lz));
    }
    if (zEdge) {
      this._touchColumn(cx, cz + zEdge, voxelIndex(lx, y, zEdge < 0 ? CHUNK_SIZE - 1 : 0));
    }
    if (xEdge && zEdge) {
      this._touchColumn(
        cx + xEdge, cz + zEdge,
        voxelIndex(xEdge < 0 ? CHUNK_SIZE - 1 : 0, y, zEdge < 0 ? CHUNK_SIZE - 1 : 0),
      );
    }
  }

  _touchColumn(cx, cz, li) {
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return;
    c.dirty[li] = 1;
    c.needsMesh = true;
    c.meshGeneration++;
    this.dirtyColumns.add(c.key);
  }

  // -------------------------------------------------------------------------
  // Props
  // -------------------------------------------------------------------------

  setProp(record) {
    const hit = this.locate(record.x, record.y, record.z);
    if (!hit) return;
    hit.chunk.props.set(voxelKey(record.x, record.y, record.z), record);
    hit.chunk.needsProps = true;
  }

  removeProp(x, y, z) {
    const hit = this.locate(x, y, z);
    if (!hit) return false;
    const removed = hit.chunk.props.delete(voxelKey(x, y, z));
    hit.chunk.needsProps = true;
    return removed;
  }

  getProp(x, y, z) {
    const hit = this.locate(x, y, z);
    return hit ? hit.chunk.props.get(voxelKey(x, y, z)) : undefined;
  }

  // -------------------------------------------------------------------------
  // Mesher input
  // -------------------------------------------------------------------------

  /**
   * Build the mesher's apron buffer for one column: an 18 x 50 x 18
   * neighbourhood gathered from the 3x3 block of columns around it.
   *
   * The apron is what removes interior faces at column seams; without it every
   * boundary voxel emits faces against its neighbour's interior and the world
   * shows a lattice of cracks.
   *
   * The column lookup is hoisted per row: x spans three columns (cx-1, cx, cx+1)
   * and z spans three, but both are constant along the inner loops, so this is
   * ~900 map lookups rather than 16200.
   */
  gatherPadded(cx, cz) {
    const padded = new Uint16Array(PAD * PAD * PAD_Y);
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;

    for (let y = WORLD.MIN_Y - 1; y <= WORLD.MAX_Y; y++) {
      const yRow = (y - WORLD.MIN_Y + 1) * PAD_STRIDE_Y;
      const inColumn = y >= WORLD.MIN_Y && y < WORLD.MAX_Y;

      for (let lz = 0; lz < PAD; lz++) {
        const row = yRow + lz * PAD;
        if (!inColumn) { padded.fill(AIR, row, row + PAD); continue; }

        const wz = baseZ + lz - 1;
        const ncz = Math.floor(wz / CHUNK_SIZE);
        const lzl = wz - ncz * CHUNK_SIZE;

        const left = this.getColumn(cx - 1, ncz);
        const mid = this.getColumn(cx, ncz);
        const right = this.getColumn(cx + 1, ncz);

        // lx = 0 is the -x apron voxel, lx = 1..CHUNK_SIZE the column itself,
        // lx = PAD-1 the +x apron voxel.
        padded[row] = left ? readLocal(left, CHUNK_SIZE - 1, y, lzl) : AIR;
        for (let i = 0; i < CHUNK_SIZE; i++) {
          padded[row + 1 + i] = mid ? readLocal(mid, i, y, lzl) : AIR;
        }
        padded[row + PAD - 1] = right ? readLocal(right, 0, y, lzl) : AIR;
      }
    }
    return padded;
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  /**
   * Drain up to `limit` columns that need a rebuild. Ordered by distance from the
   * camera so the columns the player is actually looking at go first.
   */
  takeDirtyColumns(limit, cameraX = 0, cameraZ = 0) {
    if (this.dirtyColumns.size === 0) return [];
    const out = [];
    for (const key of this.dirtyColumns) {
      const c = this.chunks.get(key);
      if (!c) { this.dirtyColumns.delete(key); continue; }
      out.push(c);
      if (out.length >= limit) break;
    }
    // Only the columns we actually handed out are cleared, so the rest stay
    // queued for the next frame instead of being silently dropped.
    for (const c of out) this.dirtyColumns.delete(c.key);
    if (out.length > 1) {
      out.sort((a, b) => {
        const da = (a.cx * CHUNK_SIZE - cameraX) ** 2 + (a.cz * CHUNK_SIZE - cameraZ) ** 2;
        const db = (b.cx * CHUNK_SIZE - cameraX) ** 2 + (b.cz * CHUNK_SIZE - cameraZ) ** 2;
        return da - db;
      });
    }
    return out;
  }

  get predictionCount() {
    let n = 0;
    for (const c of this.chunks.values()) n += c.predictionCount;
    return n;
  }

  stats() {
    let columns = 0;
    let props = 0;
    let occupied = 0;
    for (const c of this.chunks.values()) {
      columns++;
      props += c.props.size;
      occupied += c.occupied;
    }
    return { columns, props, occupied, predictions: this.predictionCount };
  }
}

export { AIR, CHUNK_SIZE, CHUNK_AREA, COLUMN_VOLUME };
