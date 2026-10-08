/**
 * Immediate-mode world overlay: ghost cursor, remote cursors, hard locks, and
 * claimed-zone volumes.
 *
 * All of it is drawn as line segments in one buffer pair, rebuilt each frame from
 * live state. That is the right trade at this scale -- the counts are tens of
 * boxes, not thousands -- and it means there is no state to fall out of sync with
 * the network, which is the usual failure mode when overlays are event-driven.
 *
 * The lines are drawn with depth testing on but a small polygon offset, so a
 * cursor sits on the surface it refers to instead of flickering in and out of it.
 */

import * as THREE from 'three';

import { CONFIG, MATERIALS, PROPS } from '../config.js';

/** Line colours keyed to what the overlay is communicating. */
const COLOR = {
  valid: new THREE.Color(CONFIG.colors.valid),
  blocked: new THREE.Color(CONFIG.colors.blocked),
  pending: new THREE.Color(CONFIG.colors.pending),
  lock: new THREE.Color(0xf472b6),
  /** A claim that is fading toward expiry, and the floor of a lost one. */
  decay: new THREE.Color(0xfbbf24),
};

/**
 * Unit cube edges, as 12 segments of 2 points.
 *
 * Each segment is pushed as *one* element, so `_voxel`'s
 * `for (const [p, q] of CUBE_EDGES)` destructures it into the two endpoints.
 * Pushing the endpoints flat instead -- `e.push(corners[a], corners[b])` --
 * leaves the loop destructuring a point into `p` and `q`, so `p[0]` indexes a
 * number, yields `undefined`, and every coordinate computes to NaN. The box is
 * then silently written as 12 NaN segments: no error, no throw, and with the
 * G-buffer line bug hiding it too, nothing to give the corruption away.
 */
const CUBE_EDGES = (() => {
  const e = [];
  const corners = [
    [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
    [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1],
  ];
  const pairs = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  for (const [a, b] of pairs) e.push([corners[a], corners[b]]);
  return e;
})();

export class WorldOverlay {
  constructor(scene) {
    this.scene = scene;

    // Positions carry no colour; colours come from vertex colours so one draw
    // call covers every overlay element regardless of kind.
    const maxSegments = 4096;
    this.capacity = maxSegments * 2;

    this.positions = new Float32Array(this.capacity * 3);
    this.colors = new Float32Array(this.capacity * 3);

    const geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', this.posAttr);
    geom.setAttribute('color', this.colAttr);
    geom.setDrawRange(0, 0);

    // A G-buffer material, not a LineBasicMaterial.
    //
    // The G-buffer is a three-attachment MRT, and a built-in material declares a
    // single fragment output. Against this framebuffer three r170 raises
    // INVALID_OPERATION on the line draw and rasterises nothing at all -- the
    // draw is issued, counted in renderer.info.render.lines, and produces zero
    // pixels. Measured directly: the same geometry into a single-attachment
    // target writes 1440 pixels, into the G-buffer writes 0.
    //
    // That made every line here invisible, which is every piece of placement
    // feedback the game has: the ghost, the lock boxes, the claim volumes, the
    // remote cursors. It was never a symptom anybody could see as "the overlay is
    // broken", because the world still looked right without it.
    //
    // Writing all three outputs -- the same contract the prop material honours --
    // is the whole fix. The overlay is a readout rather than matter, so albedo is
    // black (no lighting term survives) and roughness is 1 (no specular), while
    // the authored colour rides the emissive channel and reaches the composite
    // untouched by the sun. `opacity` becomes a multiplier on that colour: with
    // blending off there is no per-pixel alpha left to do the job for three
    // separate attachments.
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uOpacity: { value: 0.95 } },
      vertexShader: /* glsl */`
        // Declared here rather than through the vertexColors flag, so three does
        // not also declare it and the stage fails to compile on a duplicate.
        in vec3 color;

        out vec3 vColour;

        void main() {
          vColour = color;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;

        in vec3 vColour;
        uniform float uOpacity;

        layout(location = 0) out vec4 gAlbedoRough;
        layout(location = 1) out vec4 gNormalDepth;
        layout(location = 2) out vec4 gMaterial;

        void main() {
          // A normal is required rather than merely unused: the lighting pass
          // normalises this and then mixes on n.y, so leaving it at zero would
          // feed normalize(vec3(0)) -- NaN -- into the whole frame.
          gAlbedoRough = vec4(0.0, 0.0, 0.0, 1.0);
          gNormalDepth = vec4(0.5, 0.5, 1.0, 1.0);
          gMaterial = vec4(vColour * uOpacity, 0.0);
        }
      `,
      depthTest: true,
      depthWrite: true,
      // Opaque, so all three attachments are replaced outright. Blending would
      // otherwise darken whatever the line is drawn over *and* fade the emissive
      // against a background that is not there yet.
      transparent: false,
    });

    this.lines = new THREE.LineSegments(geom, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 10;
    this.lines.name = 'overlay';
    scene.add(this.lines);

    this.cursor = 0;
  }

  _reset() {
    this.cursor = 0;
  }

  _segment(x0, y0, z0, x1, y1, z1, color) {
    if (this.cursor + 2 > this.capacity) return;
    const i = this.cursor * 3;
    this.positions[i] = x0; this.positions[i + 1] = y0; this.positions[i + 2] = z0;
    this.positions[i + 3] = x1; this.positions[i + 4] = y1; this.positions[i + 5] = z1;
    this.colors[i] = color.r; this.colors[i + 1] = color.g; this.colors[i + 2] = color.b;
    this.colors[i + 3] = color.r; this.colors[i + 4] = color.g; this.colors[i + 5] = color.b;
    this.cursor += 2;
  }

  /** Axis-aligned box outline. `h` defaults to a full voxel. */
  _box(x, y, z, w, h, d, color) {
    const x1 = x + w;
    const y1 = y + h;
    const z1 = z + d;
    this._segment(x, y, z, x1, y, z, color);
    this._segment(x1, y, z, x1, y, z1, color);
    this._segment(x1, y, z1, x, y, z1, color);
    this._segment(x, y, z1, x, y, z, color);
    this._segment(x, y1, z, x1, y1, z, color);
    this._segment(x1, y1, z, x1, y1, z1, color);
    this._segment(x1, y1, z1, x, y1, z1, color);
    this._segment(x, y1, z1, x, y1, z, color);
    this._segment(x, y, z, x, y1, z, color);
    this._segment(x1, y, z, x1, y1, z, color);
    this._segment(x1, y, z1, x1, y1, z1, color);
    this._segment(x, y, z1, x, y1, z1, color);
  }

  /**
   * Arrow on the cell floor pointing the way decor will face.
   *
   * Rotation had no preview at all, which made R a leap of faith: the only way to
   * find out which way a sign would face was to place it and look. Drawn on the
   * floor rather than up in the air so it reads as a mark on the surface the prop
   * stands on, and short enough not to be mistaken for the cell boundary itself.
   */
  _facing(x, y, z, rot, color) {
    const r = (rot | 0) * (Math.PI / 2);
    // Matches the renderer's own Y rotation, so the arrow and the prop can never
    // disagree about which way round rot = 1 is.
    const fx = Math.sin(r);
    const fz = Math.cos(r);
    const y0 = y + 0.03;
    const cx = x + 0.5;
    const cz = z + 0.5;
    const tx = cx + fx * 0.62;
    const tz = cz + fz * 0.62;

    this._segment(cx, y0, cz, tx, y0, tz, color);

    // Two barbs swung off the shaft. Without them it is a stray line on the floor,
    // which reads as debris rather than as a direction.
    for (const s of [-1, 1]) {
      const a = s * 0.6;
      const bx = -fx;
      const bz = -fz;
      const dx = bx * Math.cos(a) + bz * Math.sin(a);
      const dz = -bx * Math.sin(a) + bz * Math.cos(a);
      this._segment(tx, y0, tz, tx + dx * 0.24, y0, tz + dz * 0.24, color);
    }
  }

  /** Cube outline with per-axis extents, anchored at its min corner. */
  _voxel(x, y, z, color, inset = 0.002) {
    const a = inset;
    const b = 1 - inset;
    for (const [p, q] of CUBE_EDGES) {
      this._segment(
        x + a + (b - a) * p[0],
        y + a + (b - a) * p[1],
        z + a + (b - a) * p[2],
        x + a + (b - a) * q[0],
        y + a + (b - a) * q[1],
        z + a + (b - a) * q[2],
        color,
      );
    }
  }

  /**
   * Rebuild the overlay for this frame.
   *
   * @param {object} state
   * @param {object|null} state.ghost  {x,y,z,valid,pending}
   * @param {Map} state.locks  voxelKey -> builderId
   * @param {Array} state.zones
   * @param {Array} state.cursors [{x,y,z,color,name}]
   * @param {string|null} state.selfId
   */
  update(state) {
    this._reset();

    // --- claimed zones: a low wall around the claim perimeter ---------------
    for (const zone of state.zones ?? []) {
      // A fading claim is drawn short and dashed, so "mine, and I am losing it" is
      // legible from across the plaza without reading a timer. Colour alone would not
      // carry it: the owner already tints the wall, so the only free channel is
      // height and motion.
      const fading = zone.state === 'fading' || zone.state === 'expiring';
      const c = new THREE.Color(zone.color ?? '#818cf8');
      if (fading) c.lerp(new THREE.Color(COLOR.decay), 0.55);
      const height = CONFIG.worldHeight * (fading ? 0.12 : 0.34);
      // Corner posts plus the top rail read as a volume without needing a solid
      // wall, which would obscure the builds the claim is meant to protect.
      for (const [x, z] of [
        [zone.x0, zone.z0], [zone.x1, zone.z0], [zone.x0, zone.z1], [zone.x1, zone.z1],
      ]) {
        this._segment(x, 0, z, x, height, z, c);
      }
      this._segment(zone.x0, height, zone.z0, zone.x1, height, zone.z0, c);
      this._segment(zone.x1, height, zone.z0, zone.x1, height, zone.z1, c);
      this._segment(zone.x1, height, zone.z1, zone.x0, height, zone.z1, c);
      this._segment(zone.x0, height, zone.z1, zone.x0, height, zone.z0, c);
    }

    // --- hard locks ---------------------------------------------------------
    for (const [key, builderId] of state.locks ?? []) {
      if (builderId === state.selfId) continue;
      const [x, y, z] = key.split(',').map(Number);
      if (!Number.isFinite(x)) continue;
      this._voxel(x, y, z, COLOR.lock);
    }

    // --- other builders' cursors -------------------------------------------
    for (const cur of state.cursors ?? []) {
      if (cur.id === state.selfId) continue;
      this._voxel(cur.x, cur.y, cur.z, new THREE.Color(cur.color), 0.06);
    }

    // --- local ghost, drawn last so it wins any depth tie --------------------
    //
    // Guarded on finite coordinates rather than on truthiness alone. A pick that
    // leaves the buildable area reports a cell with no coordinates, and drawing
    // it would coerce null to zero -- outlining the world origin instead of the
    // hovered cell, with the ghost's own "outside build bounds" reason saying
    // the opposite. The guard matters more than that, though: every line in this
    // frame shares one buffer, so one NaN vertex here would blank the whole
    // overlay rather than just its own box.
    const g = state.ghost;
    if (g && Number.isFinite(g.x) && Number.isFinite(g.y) && Number.isFinite(g.z)) {
      let color;
      if (g.pending) {
        color = COLOR.pending;
      } else if (!g.valid) {
        color = COLOR.blocked;
      } else if (g.pendingMat > 0) {
        // A preview, not only permission: colour the box with the block a click would
        // place. Without this, switching from 'Wet Sand' to 'Cyan Neon' in the palette
        // changed nothing visible in the world -- the ghost was a green box either way,
        // so the selector felt wired to nothing. It made deciding a block type a matter
        // of guessing.
        color = new THREE.Color(MATERIALS[g.pendingMat]?.color ?? 0x9ca3af);
      } else {
        color = COLOR.valid;
      }
      // Decor previews as the prop's own volume rather than as a whole voxel, so a
      // bench reads low and a parasol reads tall before you commit to it. The box
      // is inset to match the pick volume exactly, so what is highlighted is what
      // a click will actually select.
      const def = g.prop ? PROPS[g.prop] : null;
      const h = def ? def.height : 1;
      if (def) {
        // Two lifts, both of which exist because line primitives cannot be
        // polygon-offset in WebGL -- only filled ones can, so the old
        // polygonOffsetFactor did nothing for this geometry at all.
        //
        // The first is horizontal: props sit in the cell, and an outline drawn on
        // the cell walls would z-fight with every neighbour it touches. The
        // second is 4 mm off the floor, for the same reason against the ground
        // the prop stands on, which is exactly where the bottom edges land.
        const inset = 0.08;
        const lift = 0.004;
        this._box(g.x + inset, g.y + lift, g.z + inset, 1 - inset * 2, h - lift, 1 - inset * 2, color);
        this._facing(g.x, g.y, g.z, g.rot, color);
      } else {
        this._voxel(g.x, g.y, g.z, color, 0.004);
      }

      // A short vertical stalk makes the target readable when the ghost is
      // inside geometry and only its edges would otherwise be visible. It starts
      // at the top of whatever the ghost is drawing, so a tall prop does not have
      // a line running up through the middle of it.
      this._segment(g.x + 0.5, g.y + h, g.z + 0.5, g.x + 0.5, g.y + h + 0.55, g.z + 0.5, color);
    }

    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, this.cursor);
  }

  dispose() {
    this.lines.removeFromParent();
    this.lines.geometry.dispose();
    this.material.dispose();
  }
}