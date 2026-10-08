/**
 * Chunk column meshes with a dual buffer and content-addressed animation.
 *
 * The rebuild problem
 * -------------------
 * A column is re-meshed asynchronously, so the geometry on screen lags the world
 * by a few frames. Simply swapping in the new buffers means a quad that vanished
 * is gone before the user can see it, and a new quad pops in fully formed.
 * Neither reads as a world being edited.
 *
 * The fix is to diff two mesh generations by quad *content* (see quadDiff.js) and
 * route each quad down one of three paths:
 *
 *   in both  -> settled immediately, present only in the new geometry
 *   new only -> spawn: dissolves in, driven by its fx attribute
 *   old only -> destroy: re-packed into a retiring mesh that melts away
 *
 * Retiring geometry is extracted into its own buffer rather than kept as a second
 * live copy, because a quad present in both generations must not be drawn twice:
 * two coincident surfaces z-fight and shimmer.
 *
 * Animation is entirely data-driven -- one material serves settled, spawning and
 * melting geometry with the mode carried per vertex -- so there are no material
 * clones and no per-mesh uniforms.
 */

import * as THREE from 'three';

import { CHUNK_SIZE, WORLD, chunkKey, FX } from '../../../shared/protocol.js';
import {
  diffQuads, extractQuads, fxBytes, fxBytesUniform, quadKeys, quadIndices,
  FX_MODE, FX_CHANNELS,
} from './quadDiff.js';

const STRIDE_U16 = 8; // 16 bytes per vertex, viewed as eight uint16 slots

/** Column bounds, used instead of computeBoundingSphere: exact and free. */
const COLUMN_RADIUS = Math.hypot(CHUNK_SIZE / 2, WORLD.MAX_Y / 2, CHUNK_SIZE / 2);
const BYTES_PER_QUAD_FX = 4 * FX_CHANNELS; // four vertices, four channels each

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInQuad = (t) => t * t;

/**
 * Build a BufferGeometry from one partition of a mesher result.
 *
 * The 16-byte vertex layout is viewed as eight uint16 slots. That is sound
 * because every emitted coordinate is non-negative (x and z span 0..CHUNK_SIZE,
 * y spans 0..WORLD.MAX_Y), so signedness carries no information and a single
 * interleaved buffer covers the lot. The packed face+AO bytes at byte 10..13
 * split into two 2-channel attributes instead of needing bit unpacking in the
 * shader.
 *
 * @returns {THREE.BufferGeometry|null} null when the partition has no surface
 */
function buildGeometry(part) {
  const { vertex, index, vertexCount, indexCount } = part;
  if (!vertexCount || !indexCount) return null;

  const interleaved = new THREE.InterleavedBuffer(new Uint16Array(vertex), STRIDE_U16);
  interleaved.setUsage(THREE.StaticDrawUsage);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('aPos', new THREE.InterleavedBufferAttribute(interleaved, 3, 0));
  geom.setAttribute('aUV', new THREE.InterleavedBufferAttribute(interleaved, 2, 3));
  // (nx + 1, ny + 1) and (nz + 1, ao), stored component+1 so a garbage read
  // yields an obviously wrong normal rather than a plausible one.
  geom.setAttribute('aNrm', new THREE.InterleavedBufferAttribute(interleaved, 2, 5));
  geom.setAttribute('aNzAo', new THREE.InterleavedBufferAttribute(interleaved, 2, 6));
  geom.setAttribute('aMat', new THREE.InterleavedBufferAttribute(interleaved, 1, 7));

  const fx = new THREE.BufferAttribute(new Uint8Array(vertexCount * FX_CHANNELS), FX_CHANNELS);
  fx.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('aFx', fx);

  // Alias the interleaved position as `position`. three.js reads
  // `geometry.attributes.position` internally -- computeBoundingBox, raycasting
  // and several shadow-camera paths all assume it exists -- and without it a
  // geometry yields a null bounding box. Aliasing the existing attribute costs
  // nothing: no second buffer, both names read the same interleaved data.
  geom.setAttribute('position', geom.getAttribute('aPos'));

  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1));
  geom.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(CHUNK_SIZE / 2, WORLD.MAX_Y / 2, CHUNK_SIZE / 2),
    COLUMN_RADIUS,
  );
  return geom;
}

/** One live or retiring surface belonging to a single visibility class. */
class Partition {
  /**
   * @param {'opaque'|'glass'} vis
   */
  constructor(vis, mesh, geometry, part) {
    this.vis = vis;
    this.mesh = mesh;
    this.geometry = geometry;
    this.quadCount = part.quadCount;
    // The source buffers are retained so a later generation can diff against this
    // one and so disappearing quads can be re-packed without re-meshing.
    this.quads = part.quads;
  }

  get fx() {
    return this.geometry.getAttribute('aFx');
  }

  get triangles() {
    return this.geometry.getAttribute('aPos').count / 2;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
  }
}

export class ChunkMesh {
  /**
   * @param {number} cx @param {number} cz
   * @param {{opaque: THREE.Group, glass: THREE.Group}} groups opaque geometry goes
   *        to the main scene group; translucent geometry goes to a group the
   *        deferred passes hide, because a G-buffer has nowhere to put a blend
   * @param {{opaque: THREE.Material, glass: THREE.Material}} materials
   */
  constructor(cx, cz, groups, materials) {
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKey(cx, cz);
    this.groups = groups;
    this.materials = materials;

    /** @type {{opaque: Partition|null, glass: Partition|null}} */
    this.live = { opaque: null, glass: null };
    /** @type {Partition[]} melting geometry, newest last */
    this.retiring = [];
    /** @type {object[]} */
    this.animations = [];

    this.quadCount = 0;
    this.triangles = 0;
    this.meshedAt = 0;
    this.builds = 0;
  }

  get animating() {
    return this.animations.length;
  }

  /** Live and melting geometry together, for the HUD. */
  get visibleTriangles() {
    let t = 0;
    for (const p of [...Object.values(this.live), ...this.retiring]) {
      if (p) t += p.triangles;
    }
    return t;
  }

  /**
   * Install a fresh mesher result, animating the difference against what is
   * currently on screen.
   *
   * @param {{opaque: object|null, glass: object|null}} result extractQuads output
   *        shapes, or null/empty for a class with no surface this generation
   * @param {number} now performance.now()
   */
  apply(result, now) {
    for (const vis of ['opaque', 'glass']) {
      this._swap(vis, result[vis], now);
    }
    this.meshedAt = now;
    this.builds++;
    this.quadCount = this._count();
    this.triangles = this._countTriangles();
  }

  _count() {
    let n = 0;
    for (const p of Object.values(this.live)) if (p) n += p.quadCount;
    return n;
  }

  _countTriangles() {
    let n = 0;
    for (const p of Object.values(this.live)) if (p) n += p.triangles;
    return n;
  }

  _swap(vis, next, now) {
    const prev = this.live[vis];

    // Nothing to show for this class: melt whatever is there and move on.
    if (!next || next.quadCount === 0) {
      if (prev) {
        this._beginMelt(prev, null, now, FX.DESTROY_MS);
        this.live[vis] = null;
      }
      return;
    }

    const geometry = buildGeometry(next);
    if (!geometry) return;

    const { added, removed } = prev
      ? diffQuads(prev.quads, next.quads)
      : { added: quadKeys(next.quads), removed: new Set() };

    const mesh = new THREE.Mesh(geometry, this.materials[vis]);
    mesh.position.set(this.cx * CHUNK_SIZE, 0, this.cz * CHUNK_SIZE);
    mesh.renderOrder = vis === 'glass' ? 1 : 0;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.groups[vis].add(mesh);

    const partition = new Partition(vis, mesh, geometry, next);
    const fxArray = partition.fx.array;

    if (added.size > 0) {
      fxArray.set(fxBytes(next.quads, added, FX_MODE.SPAWN, 0));
      partition.fx.needsUpdate = true;
      // Record which quads animate. Non-animated quads must be left at 255, so
      // the updater can never simply fill the whole buffer.
      this.animations.push({
        partition,
        duration: FX.MATERIALIZE_MS,
        start: now,
        ease: easeOutCubic,
        quads: quadIndices(next.quads, added),
        done: false,
      });
    } else {
      fxArray.set(fxBytesUniform(next.quadCount, FX_MODE.SETTLED, 255));
      partition.fx.needsUpdate = true;
    }

    if (prev) {
      if (removed.size > 0) this._beginMelt(prev, removed, now);
      else prev.dispose();
    }

    this.live[vis] = partition;
  }

  /**
   * Start melting a partition. With `quadKeys` the whole surface melts; with a
   * subset only the disappearing quads do, and the rest are simply dropped
   * because the new geometry now owns them.
   */
  _beginMelt(partition, subset, now, durationOverride) {
    let melting = partition;
    let quadCount = partition.quadCount;

    if (subset) {
      const part = extractQuads(
        partition.geometry.getAttribute('aPos').data.array.buffer,
        partition.geometry.getIndex().array.buffer,
        partition.quads,
        subset,
      );
      if (part.quadCount === 0) { partition.dispose(); return; }

      const geometry = buildGeometry(part);
      if (!geometry) { partition.dispose(); return; }

      const mesh = new THREE.Mesh(geometry, this.materials[partition.vis]);
      mesh.position.copy(partition.mesh.position);
      mesh.renderOrder = partition.mesh.renderOrder;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.groups[partition.vis].add(mesh);

      melting = new Partition(partition.vis, mesh, geometry, part);
      quadCount = part.quadCount;
    }

    melting.fx.array.set(fxBytesUniform(quadCount, FX_MODE.DESTROY, 0));
    melting.fx.needsUpdate = true;
    this.retiring.push(melting);

    this.animations.push({
      partition: melting,
      duration: durationOverride ?? FX.DESTROY_MS,
      start: now,
      ease: easeInQuad,
      quads: null, // every quad of a melting partition animates
      done: false,
    });

    if (melting !== partition) partition.dispose();
  }

  /**
   * Advance every animation and dispose finished melting geometry.
   *
   * Spawn animations write only their own quad indices; melt animations write a
   * uniform fill because a retiring partition contains nothing but quads that are
   * dissolving. That keeps the upload proportional to what actually moves
   * without needing partial buffer ranges.
   */
  update(now) {
    for (let i = this.animations.length - 1; i >= 0; i--) {
      const a = this.animations[i];
      const t = Math.min(1, Math.max(0, (now - a.start) / a.duration));
      const p = Math.round(a.ease(t) * 255);
      const bytes = a.partition.fx.array;

      if (a.quads) {
        for (let q = 0; q < a.quads.length; q++) {
          bytes[a.quads[q] * BYTES_PER_QUAD_FX] = p;
        }
      } else {
        for (let q = 0; q < a.partition.quadCount; q++) bytes[q * BYTES_PER_QUAD_FX] = p;
      }
      a.partition.fx.needsUpdate = true;

      if (t >= 1) {
        this.animations.splice(i, 1);
        const at = this.retiring.indexOf(a.partition);
        if (at >= 0) {
          this.retiring.splice(at, 1);
          a.partition.dispose();
        }
        // A finished spawn leaves the quad at 255 and drops out; the partition
        // itself stays live and is disposed with the column.
      }
    }
  }

  dispose() {
    for (const p of [...Object.values(this.live), ...this.retiring]) {
      if (p) p.dispose();
    }
    this.live = { opaque: null, glass: null };
    this.retiring.length = 0;
    this.animations.length = 0;
  }
}

export { buildGeometry };
