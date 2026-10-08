/**
 * Point lights for props (lanterns, torches).
 *
 * Deferred lighting makes point lights cheap to *store* and expensive to *apply*:
 * a forward pass would evaluate every light for every fragment, while a deferred
 * pass can light each pixel once. The cost moves to finding which lights affect a
 * pixel, and that is what the cluster grid is for.
 *
 * Clustering
 * ----------
 * Screen space is divided into tiles, and each tile keeps the lights whose sphere
 * reaches it, capped at a small budget. For the light counts this world actually
 * carries (tens) even a naive per-pixel loop over the nearest N would be fine; the
 * grid exists so the cost stays flat as builders add more lanterns, which is the
 * whole point of a shared world.
 *
 * The index list is uploaded as an integer texture and the light data as a float
 * texture, rather than as uniform arrays: the count per tile is dynamic, and a
 * uniform array would need a fixed upper bound with a loop that reads past its own
 * data when a tile overflows.
 *
 * Occlusion is deliberately approximate -- a light is not shadow-tested. With a
 * small radius and a soft falloff this reads correctly, and full per-light shadow
 * maps would cost far more than they add here.
 */

import * as THREE from 'three';

import { CONFIG } from '../config.js';

/** Tiles across the screen at the configured tile size. */
function tileGrid(width, height, tilePx) {
  return {
    x: Math.max(1, Math.ceil(width / tilePx)),
    y: Math.max(1, Math.ceil(height / tilePx)),
  };
}

const MAX_LIGHTS = 96;

/**
 * Byte offset of row 1 in the light data texture.
 *
 * The texture is `MAX_LIGHTS` wide and 2 tall with row-major storage, so texel
 * (i, 0) is at `i*4` and texel (i, 1) is at `MAX_LIGHTS*4 + i*4`. Getting this
 * wrong is silent: every colour fetch reads zero and every light contributes
 * nothing, while the position fetch -- which was already at the right offset --
 * still succeeds and makes the whole cluster path look healthy.
 */
export const ROW1_BYTE_OFFSET = MAX_LIGHTS * 4;

/** The empty-slot sentinel. Must survive the texture's storage type exactly. */
const NO_LIGHT = 255;

/**
 * World-space range the light-position encoding covers, centred on the origin.
 *
 * Chosen to enclose the whole buildable volume (radius 40) with room to spare.
 * Exported to the shader as a constant so the encode and decode cannot drift.
 */
export const WORLD_BIAS = 64;
export const WORLD_SCALE = 255 / (WORLD_BIAS * 2);

/**
 * Largest radius the radius channel can represent. Exported so the shader's
 * decode scales by the same constant the CPU encodes against.
 */
export const MAX_RADIUS = 32;

/**
 * Intensity that maps to a full byte. Exported so the shader decodes against the
 * same reference the CPU encodes with.
 */
export const INTENSITY_RANGE = 8;

/** Map a world coordinate into one unsigned byte. */
function encodePos(v) {
  return Math.max(0, Math.min(255, Math.round((v + WORLD_BIAS) * WORLD_SCALE)));
}

/**
 * Allocate the tile -> light index texture.
 *
 * `UnsignedByteType` is stated explicitly for two reasons. three.js infers
 * HalfFloatType from a bare RGBA DataTexture, and half-float cannot represent
 * 255 exactly -- which makes every sentinel read as a valid light index and every
 * tile appear to hold garbage. And the index values must not be rescaled: the
 * shader compares them against NO_LIGHT directly.
 */
function makeIndexTexture(width, height) {
  const tex = new THREE.DataTexture(
    new Uint8Array(width * height * 4).fill(NO_LIGHT),
    width,
    height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export class LightClusterer {
  /**
   * @param {number} width drawing-buffer width
   * @param {number} height drawing-buffer height
   */
  constructor(width, height) {
    this.maxPerTile = CONFIG.render.maxLightsPerCluster;
    this.setSize(width, height);

    /**
     * Index texture: one texel per (tile, slot), four light indices per texel,
     * 255 = empty. Packing four per texel keeps the width a quarter of what a
     * one-per-texel layout would need.
     *
     * The type is given explicitly. three.js infers `HalfFloatType` from an RGBA
     * DataTexture when no type is passed, and half-float cannot represent the
     * 255 sentinel exactly -- every tile then reads as empty and the lights
     * silently do nothing.
     */
    this.indexTexture = makeIndexTexture(this.grid.x * Math.ceil(this.maxPerTile / 4), this.grid.y);

    /**
     * Light data, two rows per light: (x, y, z, radius) then (r, g, b, intensity).
     *
     * Stored as an RGBA8 texture with fixed-point encoding. Both FloatType and
     * HalfFloatType DataTextures read back as all-zero on this driver -- verified
     * down to a 1x1 texture with hand-encoded values -- so the upload silently
     * no-ops and every `texelFetch` returns zero. That presents as "the lights do
     * nothing", with no GL error anywhere, which is exactly the bug this comment
     * exists to prevent someone re-introducing.
     *
     * UnsignedByteType is the only texture type here that reliably round-trips.
     * World positions are stored as unsigned with a bias, which covers the whole
     * buildable volume; radii and intensities are plain unit-range values.
     */
    this.dataTexture = new THREE.DataTexture(
      new Uint8Array(MAX_LIGHTS * 2 * 4),
      MAX_LIGHTS,
      2,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this.dataTexture.magFilter = THREE.NearestFilter;
    this.dataTexture.minFilter = THREE.NearestFilter;
    this.dataTexture.needsUpdate = true;

    this.activeCount = 0;
    this.droppedByTile = 0;
  }

  setSize(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.grid = tileGrid(this.width, this.height, CONFIG.render.clusterTilePx);

    if (this.indexTexture) this.indexTexture.dispose();
    const slots = Math.ceil(this.maxPerTile / 4);
    this.indexTexture = makeIndexTexture(this.grid.x * slots, this.grid.y);
  }

  /**
   * Rebuild the cluster grid for this frame.
   *
   * @param {Array<{x,y,z,radius,color:THREE.Color,intensity}>} lights world-space
   * @param {THREE.Camera} camera
   */
  update(lights, camera) {
    // Data texture first: only the lights that survive the cap need uploading.
    const data = this.dataTexture.image.data;
    const viewProj = new THREE.Matrix4()
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const view = new THREE.Vector3();

    const visible = [];
    for (const light of lights) {
      view.set(light.x, light.y, light.z).applyMatrix4(camera.matrixWorldInverse);
      // A light behind the near plane cannot affect anything, and its projection
      // is degenerate.
      if (-view.z > camera.far + light.radius) continue;
      if (-view.z < -light.radius) continue;
      visible.push({ light, viewZ: -view.z });
    }

    // Nearest first: when a tile overflows, the lights it keeps should be the ones
    // that matter most, and a light 3 units away contributes more than one 60 away.
    visible.sort((a, b) => a.viewZ - b.viewZ);
    const active = visible.slice(0, MAX_LIGHTS);

    for (let i = 0; i < active.length; i++) {
      const l = active[i].light;
      const o = i * 4;
      // Fixed-point, biased so the whole buildable volume maps to 0..255.
      // The shader inverts this exactly; see WORLD_BIAS / WORLD_SCALE.
      data[o + 0] = encodePos(l.x);
      data[o + 1] = encodePos(l.y);
      data[o + 2] = encodePos(l.z);
      // Radius over MAX_RADIUS, giving ~4 cm of resolution at 10 units.
      data[o + 3] = Math.min(255, Math.round((l.radius / MAX_RADIUS) * 255));

      // Colour and intensity stay on separate channels. Pre-multiplying and then
      // storing as a byte clamps: a cyan lantern at intensity 3.3 encodes to
      // (0, 2, 3), which is both the wrong hue and effectively unlit. The shader
      // multiplies them back together.
      //
      // Row 1 starts at ROW1 byte offset, NOT at o+4. The texture is MAX_LIGHTS
      // wide and 2 tall, so its data is row-major: texel (i,0) lives at i*4 and
      // texel (i,1) lives at MAX_LIGHTS*4 + i*4. Writing colour at o+4 interleaved
      // it into row 0 for the first 95 lights and let it spill into row 1 only at
      // the very end, so every `texelFetch(data, (i,1))` returned zeros -- and
      // a zero colour multiplied by everything else is exactly zero, which is
      // why every light in the world rendered and lit nothing.
      const c2 = o + ROW1_BYTE_OFFSET;
      const c = l.color;
      data[c2 + 0] = Math.min(255, Math.round(c.r * 255));
      data[c2 + 1] = Math.min(255, Math.round(c.g * 255));
      data[c2 + 2] = Math.min(255, Math.round(c.b * 255));
      // Intensity is normalised against a reference rather than stored raw, so a
      // bright light uses the full byte range instead of saturating at 255.
      data[c2 + 3] = Math.min(255, Math.round((l.intensity / INTENSITY_RANGE) * 255));
    }
    this.activeCount = active.length;
    this.dataTexture.needsUpdate = true;

    // --- per-tile fill -------------------------------------------------------
    const idx = this.indexTexture.image.data;
    idx.fill(NO_LIGHT);
    const slots = Math.ceil(this.maxPerTile / 4);
    const stride = this.grid.x * slots * 4;
    let dropped = 0;

    const clip = new THREE.Vector4();
    for (let i = 0; i < active.length; i++) {
      const l = active[i].light;

      // Project the sphere to screen space. A sphere spanning the whole screen
      // clamps to the full grid, which is correct rather than a special case.
      clip.set(l.x, l.y, l.z, 1).applyMatrix4(viewProj);
      if (clip.w <= 0) continue;

      const ndcX = clip.x / clip.w;
      const ndcY = clip.y / clip.w;
      // Screen radius of a sphere: r * (halfHeight / (w * viewZ)), the standard
      // perspective divide for a sphere rather than a point.
      const viewZ = Math.max(0.001, active[i].viewZ);
      const ndcRadius = (l.radius / viewZ) * (this.height * 0.5);

      // NDC has +Y up, but gl_FragCoord.y -- which the shader uses to derive its
      // tile row -- also has +Y up, and a texture row 0 is the *bottom* row. The
      // two agree only if the row index is flipped, so the grid is stored
      // bottom-up to match. Getting this wrong puts each light's cluster on the
      // vertically mirrored tiles, which reads as "the lights do nothing" wherever
      // the scene is not symmetric about the horizon.
      const cx = (ndcX * 0.5 + 0.5) * this.grid.x;
      const cy = (0.5 - ndcY * 0.5) * this.grid.y;
      const rx = (ndcRadius / this.width) * this.grid.x;
      const ry = (ndcRadius / this.height) * this.grid.y;

      const x0 = Math.max(0, Math.floor(cx - rx));
      const x1 = Math.min(this.grid.x - 1, Math.ceil(cx + rx));
      const y0 = Math.max(0, Math.floor(cy - ry));
      const y1 = Math.min(this.grid.y - 1, Math.ceil(cy + ry));

      for (let ty = y0; ty <= y1; ty++) {
        const rowBase = ty * stride;
        for (let tx = x0; tx <= x1; tx++) {
          const base = rowBase + tx * slots * 4;
          let slot = 0;
          while (slot < this.maxPerTile && idx[base + slot] !== NO_LIGHT) slot++;
          if (slot >= this.maxPerTile) { dropped++; continue; }
          idx[base + slot] = i;
        }
      }
    }

    this.droppedByTile = dropped;
    this.indexTexture.needsUpdate = true;
  }

  dispose() {
    this.indexTexture.dispose();
    this.dataTexture.dispose();
  }
}

/**
 * Collect point lights from placed props.
 *
 * Props own their light definition in the shared catalogue, so adding a light to
 * the world needs no change here -- it needs a new entry in shared/materials.js.
 */
export function collectPropLights(records, builders) {
  const out = [];
  for (const record of records) {
    const def = PROPS_LOOKUP(record.prop);
    if (!def || !def.light) continue;
    out.push({
      x: record.x + 0.5,
      y: record.y + def.light.y,
      z: record.z + 0.5,
      radius: def.light.distance,
      color: def.lightColor,
      // Scale against the new linear rig (sun 6.2, fill ~1.5). Tuned by sweeping
      // the rendered floor around a single lamp and reading back near-vs-far: at
      // intensity ~3.3 a lantern tinted the floor about 13% toward cyan, at ~12
      // about 30%, which reads as a pool of light rather than a tint. 1.2 lands
      // between those; the remaining taste call is best made by eye.
      intensity: def.light.intensity * 1.2,
    });
  }
  return out;
}

// Imported lazily to keep this module free of a circular dependency on materials.
import { PROPS } from '../../../shared/materials.js';
function PROPS_LOOKUP(key) {
  const def = PROPS[key];
  if (def && def.light && !def.lightColor) {
    // Cache the converted colour on the definition rather than per record.
    def.lightColor = new THREE.Color(def.light.color).convertSRGBToLinear();
  }
  return def;
}

export { MAX_LIGHTS };