/**
 * Asynchronous chunk meshing over a bounded worker pool.
 *
 * Scheduling rules
 * ----------------
 * - At most one job in flight per worker, so a burst of edits queues instead of
 *   spawning unbounded work.
 * - Jobs are dispatched nearest-camera-first, which is what keeps the surface the
 *   user is looking at responsive while the far side of the world catches up.
 * - Results carry the column generation they were built from. If the column was
 *   edited while the job ran, the result is dropped and the column stays queued.
 *   Applying it anyway would show geometry that is already known to be wrong and
 *   then immediately replace it -- a visible double-pop for no benefit.
 *
 * Visibility classes
 * ------------------
 * The mesher emits opaque and translucent quads into one stream. They are split
 * here with `extractQuads`, which re-packs each class into its own tight buffer.
 * Because every quad belongs to exactly one class, the split duplicates no
 * vertices -- the two partitions together cost the same as the combined buffer.
 */

import * as THREE from 'three';

import { CHUNK_SIZE, WORLD } from '../../../shared/protocol.js';
import { partitionByVis } from './quadDiff.js';
import { ChunkMesh } from './chunkMesh.js';
import { greedyMesh } from './greedyMesher.js';

/**
 * Split a raw mesher result into opaque and glass partitions.
 * @returns {{opaque:object|null, glass:object|null}}
 */
function inlineWorker() {
  return {
    inline: true,
    onmessage: null,
    postMessage(msg) {
      // Defer so the caller finishes its bookkeeping before the reply lands.
      queueMicrotask(() => {
        try {
          const r = greedyMesh(new Uint16Array(msg.padded), msg.size, undefined, msg.sizeY);
          this.onmessage({ data: { jobId: msg.jobId, cx: msg.cx, cz: msg.cz, ...r } });
        } catch (err) {
          this.onmessage({
            data: { jobId: msg.jobId, cx: msg.cx, cz: msg.cz, error: String(err) },
          });
        }
      });
    },
    terminate() {},
  };
}

export class MeshManager {
  /**
   * @param {import('./world.js').World} world
   * @param {{opaque: THREE.Group, glass: THREE.Group}} groups
   * @param {{opaque: THREE.Material, glass: THREE.Material}} materials
   * @param {object} config the CONFIG chunk/mesher settings
   */
  constructor(world, groups, materials, config) {
    this.world = world;
    this.groups = groups;
    this.materials = materials;
    this.config = config;

    /** @type {Map<string, ChunkMesh>} */
    this.meshes = new Map();
    /** @type {Map<number, object>} jobId -> in-flight record */
    this.inFlight = new Map();

    this.workers = [];
    this.nextJobId = 1;
    this.degraded = false;
    this.stats = {
      dispatched: 0, completed: 0, stale: 0, failed: 0,
      triangles: 0, quads: 0, lastBuildMs: 0, busy: 0,
    };

    const poolSize = Math.max(1, config.mesher.maxConcurrent);
    for (let i = 0; i < poolSize; i++) {
      const w = this._makeWorker();
      if (!w) break;
      this.workers.push(w);
    }
    if (this.workers.length === 0) throw new Error('no mesher workers could be created');
  }

  _makeWorker() {
    let worker;
    try {
      worker = new Worker(new URL('./mesher.worker.js', import.meta.url), { type: 'module' });
    } catch {
      this.degraded = true;
      worker = inlineWorker();
    }
    worker.onmessage = (e) => this._onResult(e.data);
    worker.onerror = (e) => {
      console.error('[mesher] worker error', e.message || e);
      this.stats.failed++;
    };
    return worker;
  }

  /** Workers with nothing in flight. */
  _idleWorkers() {
    return this.workers.filter((w) => !this._busy.has(w));
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Hand queued columns to idle workers, then advance every live animation.
   *
   * @param {number} now performance.now()
   * @param {number} cameraX @param {number} cameraZ used to prioritise columns
   */
  update(now, cameraX = 0, cameraZ = 0) {
    this._busy = this._busy ?? new Set();

    const idle = this._idleWorkers();
    if (idle.length > 0) {
      const budget = Math.min(idle.length, this.config.mesher.batchPerFrame);
      const columns = this.world.takeDirtyColumns(budget, cameraX, cameraZ);
      for (let i = 0; i < columns.length; i++) {
        const worker = idle[i];
        if (!worker) break;
        this._dispatch(worker, columns[i]);
      }
    }

    for (const mesh of this.meshes.values()) mesh.update(now);

    this.stats.busy = this._busy.size;
    this.stats.triangles = 0;
    this.stats.quads = 0;
    for (const mesh of this.meshes.values()) {
      this.stats.triangles += mesh.visibleTriangles;
      this.stats.quads += mesh.quadCount;
    }
  }

  _dispatch(worker, column) {
    const jobId = this.nextJobId++;
    const padded = this.world.gatherPadded(column.cx, column.cz);

    this._busy.add(worker);
    this.inFlight.set(jobId, {
      worker,
      column,
      generation: column.meshGeneration,
      sentAt: performance.now(),
    });
    this.stats.dispatched++;

    const payload = {
      jobId,
      cx: column.cx,
      cz: column.cz,
      padded: padded.buffer,
      size: CHUNK_SIZE,
      sizeY: WORLD.MAX_Y,
    };
    worker.postMessage(payload, [padded.buffer]);
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  _onResult(msg) {
    const job = this.inFlight.get(msg.jobId);
    if (!job) return; // already abandoned
    this.inFlight.delete(msg.jobId);
    this._busy?.delete(job.worker);

    const { column } = job;
    this.stats.lastBuildMs = Math.round(performance.now() - job.sentAt);

    if (msg.error) {
      this.stats.failed++;
      console.warn(`[mesher] ${column.key} failed:`, msg.error);
      this.world.dirtyColumns.add(column.key); // retry
      return;
    }

    // The column was edited while this job ran. Drop the result: it is already
    // known to be wrong, and the column is still queued for a fresh build.
    if (column.meshGeneration !== job.generation) {
      this.stats.stale++;
      return;
    }

    const parts = partitionByVis(msg);
    let mesh = this.meshes.get(column.key);
    if (!mesh) {
      mesh = new ChunkMesh(column.cx, column.cz, this.groups, this.materials);
      this.meshes.set(column.key, mesh);
    }

    mesh.apply(parts, performance.now());
    column.needsMesh = false;
    column.clearDirty();
    column.meshedAt = mesh.meshedAt;
    this.stats.completed++;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Drop columns that fell outside the mesh radius, releasing their GPU memory. */
  cull(cameraX, cameraZ, radius) {
    const limit = radius * radius;
    for (const [key, mesh] of this.meshes) {
      const dx = mesh.cx * CHUNK_SIZE - cameraX;
      const dz = mesh.cz * CHUNK_SIZE - cameraZ;
      if (dx * dx + dz * dz <= limit) continue;
      mesh.dispose();
      this.meshes.delete(key);
    }
  }

  chunkMesh(key) {
    return this.meshes.get(key);
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    for (const m of this.meshes.values()) m.dispose();
    this.meshes.clear();
    this.inFlight.clear();
    this._busy?.clear();
  }
}

export { partitionByVis };
