/**
 * Instanced decor.
 *
 * Props are the one part of the build vocabulary that was fully wired on the
 * network side but had no renderer: `placeProp` validated and committed, the
 * world stored the record, picking could see it -- and then nothing appeared.
 * This closes that loop.
 *
 * One InstancedMesh per prop kind, all sharing a single material. That is four
 * draw calls for the whole decor layer rather than one, which is the deliberate
 * trade: a BatchedMesh would merge them into a single call, but at the scale this
 * world actually reaches (tens of props) the call count is irrelevant, and
 * InstancedMesh's per-instance bookkeeping is far easier to keep correct.
 *
 * Geometry is generated procedurally from primitives and merged, with two
 * per-vertex channels that the G-buffer shader needs:
 *
 *   aTint      base albedo, so one material can draw a metal lantern, a wooden
 *              chair and a leafy plant without a texture atlas
 *   aEmissive  how much of this vertex to treat as light-emitting
 *
 * The tint is multiplied by the placing builder's colour, so props visibly
 * belong to whoever put them there.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { PROPS, PROP_KEYS } from '../../../shared/materials.js';

/** Instance capacity per kind before the buffers are grown. */
const INITIAL_CAPACITY = 64;
/**
 * Hard ceiling on instances per prop kind.
 *
 * This was 2048, which a runaway bot session exceeded: a live world carried 9,650
 * lanterns and the renderer silently showed 2,048 of them. Silent truncation is the
 * wrong failure -- the world looks like it is working and part of it is simply not
 * drawn, with nothing anywhere saying so.
 *
 * An InstancedMesh is one buffer, so this costs 64 bytes per instance (a mat4 plus a
 * colour). 65,536 lanterns is 4 MiB, which is nothing, so the ceiling is now set by
 * what the GPU will index rather than by caution. Beyond it, `_grow` returns false
 * and `_insert` skips, which is still truncation -- but it is now reachable only at a
 * scale that would be a bug in the game rather than a bug in the renderer, and the
 * overflow is counted in `stats.dropped` instead of vanishing.
 */
const MAX_CAPACITY = 65536;

/**
 * Box primitive helper; w/h/d are extents and x/y/z the min corner.
 *
 * Defined before RECIPES so every recipe reads as a plain shape list. Note that
 * `.translate()` mutates and returns the geometry, which is what makes the inline
 * `box(...)` calls below readable.
 */
function box(w, h, d, x, y, z) {
  return new THREE.BoxGeometry(w, h, d).translate(x + w / 2, y + h / 2, z + d / 2);
}

/** A recipe part. `emissive` marks vertices the G-buffer should treat as a light. */
const p = (g, tint, emissive = 0) => ({ g, tint, emissive });

/** Every prop's shape, as a list of tinted (and optionally emissive) primitives. */
const RECIPES = {
  lantern: () => {
    const metal = 0x3f4a5a;
    const glow = 0x67e8f9;
    return [
      // Four corner posts plus a cap: reads as a cage without being one.
      p(box(0.06, 0.06, 0.44, 0.22, 0, 0.16), metal),
      p(box(0.06, 0.06, 0.44, 0.22, 0, 0.84), metal),
      p(box(0.06, 0.44, 0.06, 0.22, 0, 0.16), metal),
      p(box(0.06, 0.44, 0.06, 0.78, 0, 0.16), metal),
      p(box(0.06, 0.44, 0.06, 0.22, 0, 0.84), metal),
      p(box(0.06, 0.44, 0.06, 0.78, 0, 0.84), metal),
      p(box(0.68, 0.06, 0.68, 0.16, 0, 0.14), metal),
      p(box(0.68, 0.06, 0.68, 0.16, 0, 0.86), metal),
      // The light itself.
      p(box(0.34, 0.42, 0.34, 0.33, 0, 0.28), glow, 1.0),
    ];
  },

  chair: () => {
    const frame = 0x334155;
    const seat = 0x64748b;
    return [
      p(box(0.56, 0.08, 0.56, 0.22, 0.34, 0.22), seat),
      p(box(0.52, 0.42, 0.08, 0.24, 0.40, 0.74), seat),
      p(box(0.07, 0.34, 0.07, 0.24, 0.00, 0.24), frame),
      p(box(0.07, 0.34, 0.07, 0.69, 0.00, 0.24), frame),
      p(box(0.07, 0.34, 0.07, 0.24, 0.00, 0.69), frame),
      p(box(0.07, 0.34, 0.07, 0.69, 0.00, 0.69), frame),
    ];
  },

  plant: () => {
    const pot = 0xb45309;
    const leaf = 0x22c55e;
    return [
      // A tapered pot, then two offset leaf clusters for a less rigid silhouette.
      new THREE.CylinderGeometry(0.20, 0.14, 0.30, 10).translate(0.5, 0.15, 0.5),
      new THREE.IcosahedronGeometry(0.20, 0).translate(0.5, 0.44, 0.5),
      new THREE.IcosahedronGeometry(0.13, 0).translate(0.38, 0.62, 0.60),
    ].map((g, i) => ({ g, tint: i === 0 ? pot : leaf, emissive: 0 }));
  },

  torch: () => {
    const wood = 0x78350f;
    const flame = 0xf97316;
    return [
      // No stray tint argument here: `box()` takes six, and a seventh was being
      // passed and silently ignored. Harmless, but it read as if tint were a
      // parameter of `box` rather than of the map below, which is exactly how the
      // next person would have written a recipe that tints nothing.
      box(0.12, 0.34, 0.12, 0.44, 0, 0.44),
      new THREE.ConeGeometry(0.11, 0.22, 8).translate(0.5, 0.44, 0.5),
    ].map((g, i) => ({ g, tint: i === 0 ? wood : flame, emissive: i === 1 ? 1.0 : 0 }));
  },

  bench: () => {
    const plank = 0x9a6b3f;
    const leg = 0x6f4a26;
    return [
      // A backless plank on two block legs. Distinct from the chair in silhouette
      // from a few metres out, which is the distance decor is actually judged at.
      p(box(0.94, 0.09, 0.62, 0.03, 0.36, 0.19), plank),
      p(box(0.12, 0.36, 0.56, 0.06, 0.00, 0.22), leg),
      p(box(0.12, 0.36, 0.56, 0.82, 0.00, 0.22), leg),
    ];
  },

  table: () => {
    const top = 0xa8794a;
    const leg = 0x6f4a26;
    return [
      p(box(0.92, 0.07, 0.92, 0.04, 0.60, 0.04), top),
      p(box(0.10, 0.60, 0.10, 0.10, 0.00, 0.10), leg),
      p(box(0.10, 0.60, 0.10, 0.80, 0.00, 0.10), leg),
      p(box(0.10, 0.60, 0.10, 0.10, 0.00, 0.80), leg),
      p(box(0.10, 0.60, 0.10, 0.80, 0.00, 0.80), leg),
    ];
  },

  campfire: () => {
    const stone = 0x7a7f8a;
    const log = 0x5b3a1e;
    const flame = 0xfdba74;
    return [
      // Four stones pin the ring down. Without them this is a glowing cone that
      // happened to spawn here; with them it is a fire somebody built, and the
      // stones are what the eye lands on at night.
      p(box(0.17, 0.15, 0.17, 0.05, 0.00, 0.05), stone),
      p(box(0.17, 0.15, 0.17, 0.78, 0.00, 0.05), stone),
      p(box(0.17, 0.15, 0.17, 0.05, 0.00, 0.78), stone),
      p(box(0.17, 0.15, 0.17, 0.78, 0.00, 0.78), stone),
      p(box(0.70, 0.10, 0.14, 0.15, 0.06, 0.43), log),
      p(box(0.14, 0.10, 0.70, 0.43, 0.06, 0.15), log),
      p(new THREE.ConeGeometry(0.17, 0.34, 7).translate(0.5, 0.36, 0.5), flame, 1.0),
    ];
  },

  parasol: () => {
    const pole = 0x9a7b4f;
    const canvas = 0xe11d48;
    return [
      // A wide, shallow cone rather than a hemisphere: fabric under tension has an
      // edge, and a dome reads as a lampshade on a stick. It overhangs the cell by
      // five hundredths on each side, which is what a parasol does -- one fitted
      // exactly inside its own cell looks like it was measured, not erected.
      p(box(0.08, 1.42, 0.08, 0.46, 0.00, 0.46), pole),
      p(new THREE.ConeGeometry(0.55, 0.26, 8).translate(0.5, 1.47, 0.5), canvas),
    ];
  },

  sign: () => {
    const post = 0x6f4a26;
    const board = 0xb98a4a;
    const ink = 0x3f2a16;
    return [
      // The board lies flat against z, so rotation changes what you actually see
      // rather than merely spinning a lump -- this is the prop the ghost's facing
      // tick was drawn for.
      p(box(0.10, 0.95, 0.10, 0.45, 0.00, 0.45), post),
      p(box(0.78, 0.34, 0.08, 0.11, 0.78, 0.46), board),
      p(box(0.86, 0.06, 0.14, 0.07, 1.12, 0.43), post),
      // Raised panel on the front face: a darker rectangle reads as lettering at
      // any distance without needing a texture to spell anything out.
      p(box(0.66, 0.22, 0.04, 0.17, 0.84, 0.54), ink),
    ];
  },
};

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function linearTriple(hex) {
  return [
    srgbToLinear(((hex >> 16) & 255) / 255),
    srgbToLinear(((hex >> 8) & 255) / 255),
    srgbToLinear((hex & 255) / 255),
  ];
}

/**
 * Attach the per-vertex channels and strip the attributes every merge input must
 * agree on. `mergeGeometries` rejects the batch outright if any input has an extra
 * or missing attribute, so position/normal/aTint/aEmissive is the whole contract.
 */
function withChannels(geometry, hex, emissive) {
  if (!geometry) throw new Error('prop part has no geometry');
  // Every merge input must expose the same attribute set, or mergeGeometries
  // rejects the batch outright. Primitives carry uv; we do not use it.
  geometry.deleteAttribute('uv');
  geometry.deleteAttribute('uv1');
  // They must also agree on indexing. three's primitives are inconsistent here --
  // CylinderGeometry and BoxGeometry are indexed, IcosahedronGeometry and
  // ConeGeometry are not -- so anything unindexed is given a trivial index. That
  // keeps every part in the same representation instead of silently dropping the
  // mismatched ones from the merge.
  if (!geometry.index) {
    const count = geometry.attributes.position.count;
    geometry.setIndex(Array.from({ length: count }, (_, i) => i));
  }
  const count = geometry.attributes.position.count;
  const tint = new Float32Array(count * 3);
  const [r, g, b] = linearTriple(hex);
  for (let i = 0; i < count; i++) {
    tint[i * 3] = r; tint[i * 3 + 1] = g; tint[i * 3 + 2] = b;
  }
  geometry.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
  geometry.setAttribute('aEmissive', new THREE.BufferAttribute(new Float32Array(count).fill(emissive), 1));
  return geometry;
}

const geometryCache = new Map();

/**
 * @returns {THREE.BufferGeometry|null} merged, centred so the origin is the cell
 *   corner; null when there is no recipe for this kind
 *
 * Returning null rather than throwing is deliberate and load-bearing. This is
 * reached from the frame loop, and an unknown prop key -- a record from a future
 * server, or a corrupt one -- must not take the renderer down with it. A missing
 * prop is invisible; a dead frame loop is a permanently blank world.
 */
function propGeometry(kind) {
  if (geometryCache.has(kind)) return geometryCache.get(kind);

  const recipe = RECIPES[kind];
  if (!recipe) return null;

  const parts = recipe().map((part) => withChannels(part.g, part.tint, part.emissive));

  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error(`prop "${kind}" geometry failed to merge`);
  merged.computeBoundingSphere();

  geometryCache.set(kind, merged);
  return merged;
}

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

/**
 * G-buffer prop shader.
 *
 * Shares the chunk material's output layout so props need no separate lighting
 * pass. Instance transforms come from three's own instancing prefix, which is
 * injected for ShaderMaterial (not RawShaderMaterial) when the object is an
 * InstancedMesh -- so `instanceMatrix` and, if colours were set,
 * `instanceColor` are available without being declared here.
 *
 * The owner tint is guarded by #ifdef because it is optional: a prop whose
 * builder colour is unknown falls back to its authored tint.
 */
function createPropMaterial() {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uEmissiveBoost: { value: 1.6 },
    },
    vertexShader: /* glsl */`
      in vec3 aTint;
      in float aEmissive;

      out vec3 vTint;
      out vec3 vNormal;
      out vec3 vWorldPos;
      out float vEmissive;

      void main() {
        vec3 transformed = position;
        vec3 objNormal = normal;

        #ifdef USE_INSTANCING
          transformed = (instanceMatrix * vec4(transformed, 1.0)).xyz;
          objNormal = mat3(instanceMatrix) * objNormal;
        #endif

        vec4 world = modelMatrix * vec4(transformed, 1.0);
        vWorldPos = world.xyz;
        vNormal = normalize(mat3(modelMatrix) * objNormal);

        vec3 tint = aTint;
        #ifdef USE_INSTANCING_COLOR
          // Per-builder tint, applied only to the non-emissive parts so a glowing
          // lantern keeps its own colour instead of turning into a blue blob.
          tint = mix(tint, tint * instanceColor, 0.55 * (1.0 - aEmissive));
        #endif
        vTint = tint;
        vEmissive = aEmissive;

        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;

      in vec3 vTint;
      in vec3 vNormal;
      in vec3 vWorldPos;
      in float vEmissive;

      uniform float uEmissiveBoost;

      layout(location = 0) out vec4 gAlbedoRough;
      layout(location = 1) out vec4 gNormalDepth;
      layout(location = 2) out vec4 gMaterial;

      void main() {
        vec3 n = normalize(vNormal);
        // Props are closed solids, so back faces are never legitimately visible;
        // flipping keeps the normal outward-facing without a two-sided draw.
        if (!gl_FrontFacing) n = -n;

        gAlbedoRough = vec4(vTint, 0.7);
        gNormalDepth = vec4(n * 0.5 + 0.5, 1.0);
        gMaterial = vec4(vTint * vEmissive * uEmissiveBoost, 0.0);
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class PropRenderer {
  /** @param {THREE.Group} parent */
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.name = 'props';
    parent.add(this.group);

    this.material = createPropMaterial();
    /** @type {Map<string, {mesh: THREE.InstancedMesh, capacity: number, live: Map<string, number>}>} */
    this.buckets = new Map();
    /** voxelKey -> record, so removals are found without a rescan. */
    this.index = new Map();

    this._matrix = new THREE.Matrix4();
    this._pivot = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3(1, 1, 1);
    this._pos = new THREE.Vector3();
    this._color = new THREE.Color();
    this.upY = new THREE.Vector3(0, 1, 0);

    /**
     * `dropped` counts props the world contains but that could not be given an
     * instance -- only reachable at MAX_CAPACITY, which is why it is reported rather
     * than assumed impossible.
     */
    this.stats = { live: 0, capacity: 0, rebuilds: 0, dropped: 0 };
  }

  /**
   * @returns {object|null} the bucket for this prop kind, or null when the kind has
   *   no geometry recipe
   */
  _bucket(kind) {
    let b = this.buckets.get(kind);
    if (b) return b;

    const capacity = INITIAL_CAPACITY;
    const geometry = propGeometry(kind);
    // Unknown kind: skip the prop rather than throw. See propGeometry.
    if (!geometry) return null;
    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    // Instanced bounds are in local space; three cannot infer them from a merged
    // primitive reliably, and an over-tight bound pops props out early.
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.4, 0.5), 1.2);
    this.group.add(mesh);

    b = { kind, mesh, capacity, live: new Map() };
    this.buckets.set(kind, b);
    return b;
  }

  _grow(bucket) {
    const next = Math.min(bucket.capacity * 2, MAX_CAPACITY);
    if (next <= bucket.capacity) return false;

    // `bucket.kind` is stored on the bucket itself rather than recovered by
    // searching the map for its own identity. That search was the bug: it looks up
    // `v === bucket`, which is fine, but it was also the only link between a
    // bucket and its prop key, so any refactor that changed how buckets are stored
    // silently returned undefined here -- and `propGeometry(undefined)` throws.
    //
    // That is not hypothetical. It happened, and because _grow is called from
    // _insert which is called from sync() which is called from the frame loop, one
    // lantern past the initial capacity killed the entire render loop on its first
    // pass. Every stat in the HUD froze at its initial value, so the symptom was a
    // permanently blank world that still updated its own text.
    const geometry = propGeometry(bucket.kind);
    // The recipe vanished between construction and now. Leave the bucket as-is
    // rather than discarding every instance in it.
    if (!geometry) return false;
    const old = bucket.mesh;

    const mesh = new THREE.InstancedMesh(geometry, this.material, next);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.boundingSphere = old.boundingSphere;
    this.group.add(mesh);
    old.removeFromParent();
    old.dispose();

    // Existing instances have to be re-uploaded into the larger buffer.
    //
    // `bucket.live` maps key -> slot, so the second element is a *number*. An earlier
    // version destructured this as `[key, record]` and re-inserted the slot as if it
    // were a prop record, which sent a bare number into `_insert`. Since that is
    // reached from the frame loop, the throw it caused killed rendering entirely --
    // the blank world reported as "no world", with a live socket and a healthy HUD.
    const ids = [...bucket.live.entries()];
    bucket.mesh = mesh;
    bucket.capacity = next;
    bucket.live.clear();
    for (const [key] of ids) {
      // `ids` holds slots, but `this.index` is the only place the *record* still
      // lives -- `_remove` deletes index entries, so a key absent from it here was
      // already detached and must not be resurrected.
      const record = this.index.get(key);
      if (!record) continue;
      this._insert(key, record, true);
    }
    return true;
  }

  _insert(key, record, reuseSlot = false) {
    if (!record) return;
    const bucket = this._bucket(record.prop);
    // No recipe for this kind. Skipping is the whole point of returning null.
    if (!bucket) return;
    let slot = reuseSlot ? bucket.live.get(key) : undefined;

    if (slot === undefined || slot >= bucket.mesh.count) {
      // At the ceiling: record the loss instead of dropping it silently. A prop the
      // server accepted and the world contains simply not appearing is the hardest
      // kind of bug to report, because everything looks like it is working.
      if (bucket.mesh.count >= bucket.capacity && !this._grow(bucket)) {
        this.stats.dropped++;
        return;
      }
      slot = bucket.mesh.count++;
    }

    const rotY = ((record.rot | 0) * Math.PI) / 2;
    this._quat.setFromAxisAngle(this.upY, rotY);

    // Rotate about the cell *centre*, not the cell corner.
    //
    // Recipes are authored in [0,1]^3 with the origin at the cell's min corner, and
    // compose() applies the rotation about that origin. Rotating a unit cell about
    // its own corner maps it straight onto the neighbouring cell: measured on a
    // real instance, a chair placed at rot=1 had its geometry centre land exactly
    // 1.0 in -z away from where it was put. So pressing R to face a chair a
    // different way silently moved it a whole cell sideways -- into mid-air, or
    // inside whatever was next door, with the ghost still showing the cell the
    // player actually clicked.
    //
    // The transform is T(c + o) * R * T(-o) with o the half-cell: shift the pivot to
    // the centre, rotate, shift back. For rot = 0 this collapses to T(c), so the
    // overwhelmingly common unrotated case is unchanged.
    this._pos.set(record.x + 0.5, record.y, record.z + 0.5);
    this._matrix.compose(this._pos, this._quat, this._scale);
    this._pivot.makeTranslation(-0.5, 0, -0.5);
    this._matrix.multiply(this._pivot);
    bucket.mesh.setMatrixAt(slot, this._matrix);

    // Tinting by owner is best-effort: an unknown builder must not stop the prop
    // from drawing.
    const hex = record.color ?? 0xffffff;
    this._color.setHex(hex, THREE.SRGBColorSpace);
    bucket.mesh.setColorAt(slot, this._color);

    bucket.live.set(key, slot);
    bucket.mesh.count = Math.max(bucket.mesh.count, slot + 1);
    bucket.mesh.instanceMatrix.needsUpdate = true;
    if (bucket.mesh.instanceColor) bucket.mesh.instanceColor.needsUpdate = true;

    this.index.set(key, record);
  }

  _remove(key) {
    const record = this.index.get(key);
    if (!record) return;
    const bucket = this.buckets.get(record.prop);
    this.index.delete(key);
    if (!bucket) return;

    const slot = bucket.live.get(key);
    if (slot === undefined) return;
    bucket.live.delete(key);

    // Swap-remove: move the last live instance into the vacated slot so the draw
    // stays contiguous without rebuilding the whole bucket.
    const lastSlot = bucket.mesh.count - 1;
    if (slot !== lastSlot) {
      const movedKey = [...bucket.live.entries()].find(([, s]) => s === lastSlot)?.[0];
      if (movedKey) {
        const src = [...bucket.live.entries()].find(([, s]) => s === lastSlot);
        const tmp = this._matrix.clone();
        bucket.mesh.getMatrixAt(lastSlot, tmp);
        bucket.mesh.setMatrixAt(slot, tmp);
        if (bucket.mesh.instanceColor) {
          const c = new THREE.Color();
          bucket.mesh.getColorAt(lastSlot, c);
          bucket.mesh.setColorAt(slot, c);
        }
        bucket.live.set(movedKey, slot);
        if (src) bucket.live.delete(lastSlot);
      }
    }
    bucket.mesh.count = Math.max(0, bucket.mesh.count - 1);
    bucket.mesh.instanceMatrix.needsUpdate = true;
    if (bucket.mesh.instanceColor) bucket.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * Reconcile instances against the world.
   *
   * A full rescan rather than a delta: prop counts are in the tens, the scan is a
   * Map walk, and it cannot drift out of sync with a missed add or remove event.
   */
  sync(world) {
    const seen = new Set();

    for (const chunk of world.chunks.values()) {
      for (const [key, record] of chunk.props) {
        seen.add(key);
        const existing = this.index.get(key);

        // Presence in the index is NOT the same as "has an instance". The two can
        // drift apart: `_grow` rebuilds the GPU buffer from `bucket.live`, and any key
        // it fails to re-insert keeps its index entry while losing its instance.
        // Skipping on the index alone then locks that drift in forever.
        //
        // Measured: 9,650 props in the world, 9,650 in the index, 1,522 actually
        // drawn. Every one of the other 8,128 was skipped as "unchanged" on every
        // subsequent frame, forever, with `dropped: 0` and no warning. The world
        // looked alive and 84% of its props were invisible.
        //
        // So the skip requires *both* halves: the index entry and a live slot in the
        // bucket that owns it.
        let hasSlot = false;
        if (existing) {
          const bucket = this.buckets.get(existing.prop);
          const slot = bucket?.live.get(key);
          hasSlot = slot !== undefined && slot < bucket.mesh.count;
        }

        // A record's `rot` or colour can change without the voxel moving, so compare
        // rather than assuming the key alone means "unchanged".
        if (hasSlot && existing.rot === record.rot && existing.color === record.color) continue;
        if (existing) this._remove(key);
        this._insert(key, record);
      }
    }

    for (const key of [...this.index.keys()]) {
      if (!seen.has(key)) this._remove(key);
    }

    let live = 0;
    let capacity = 0;
    for (const b of this.buckets.values()) {
      live += b.mesh.count;
      capacity += b.capacity;
    }
    this.stats.live = live;
    this.stats.capacity = capacity;
    this.stats.rebuilds++;
  }

  /** @returns {Array<{x,y,z,color,name}>} every live prop, for the lighting pass */
  collect() {
    return [...this.index.values()];
  }

  dispose() {
    for (const b of this.buckets.values()) {
      b.mesh.removeFromParent();
      b.mesh.dispose();
    }
    this.buckets.clear();
    this.index.clear();
    this.group.removeFromParent();
    this.material.dispose();
  }
}

export { PROP_KEYS };