import { CHUNK_SIZE, WORLD, FX } from '../../shared/protocol.js';
import { MATERIALS, MAX_MATERIAL_ID, PROPS, VIS } from '../../shared/materials.js';

export { CHUNK_SIZE, WORLD, FX, MATERIALS, PROPS, VIS };

// Re-exported because the renderer needs it to size its GLSL uniform arrays, and
// importing across into `shared/` from a shader module is worse than one more name in
// the barrel. The point is that there is exactly one definition of "how many materials
// exist", and the shaders derive their array size from it rather than carrying a
// literal that silently goes stale.
export { MAX_MATERIAL_ID } from '../../shared/materials.js';

export const CONFIG = {
  chunkSize: CHUNK_SIZE,
  worldHeight: WORLD.MAX_Y,

  // Exposure and tone mapping are part of CONFIG so the composite and the HUD
  // read one source of truth. Kept separate from `colors` because those are
  // material/light tints, not display transforms.
  // Exposure.
  //
  // Lowered from 1.7 because the atoll is mostly *bright* material -- sand, wet sand,
  // coral -- and at 1.7 the sunlit sand measured 0.939 in display value with red and
  // green both clipped. A tone curve needs headroom at the top, or it cannot model
  // anything up there; sand at 0.85 keeps its highlight and still has somewhere to go.
  //
  // Lowering exposure darkens the sky too, which is why the sky stops in
  // `createEnvironment()` are ~1.36x brighter. That is not a fudge: the sky is a
  // *background*, and its level is a display choice rather than a lighting one.
  // Keeping those two decisions in separate uniforms is what lets the terrain be
  // correctly exposed while the sky still reads as noon.
  exposure: 1.25,
  // Bloom strength, applied before the exposure multiply.
  //
  // Kept in CONFIG rather than hardcoded in the pipeline so it can be turned off at
  // runtime. That is not a convenience: the composite sums bloom into the scene colour
  // *before* exposing, so one non-finite texel anywhere in the blur chain turns the
  // whole frame Inf, and Inf is immune to exposure. Diagnosing "the screen is white and
  // changing exposure does nothing" is impossible while the strength is a literal in
  // another file.
  //
  // Raised to 0.85 when the bright-pass threshold was corrected: with the threshold
  // at 3.0 only the ~4.4% emissive population reaches bloom at all, so a stronger
  // strength buys those blocks a real glow instead of lifting the whole frame.
  // Measured on the ground band, saturation is unchanged against the old settings
  // (19.4 vs 19.5) and clipping is untouched either way.
  bloomStrength: 0.85,
  // Height fog, per world unit. At 0.0042 this was effectively invisible: the
  // exponential only reached 0.19 at 50 units, so the world's edge cut hard
  // against the sky and the terrain read as an island floating in a void. This
  // reaches ~0.45 at 50 units and ~0.70 at 100, which is enough to put the far
  // terrain behind atmosphere.
  fogDensity: 0.022,

  // Distance-based level of detail, measured from the orbit target.
  //   LOD0 full geometry + props + dynamic lights
  //   LOD1 merged geometry, simplified shading, props as impostors
  //   LOD2 baked column impostor, heavy haze blend
  lod: { l0: 56, l1: 190, l2: 380 },

  // Only chunks intersecting this radius are meshed at all.
  meshRadius: 200,

  mesher: {
    // Bounded pool: a burst of edits queues up, but an unbounded queue would
    // let stale rebuilds starve fresh ones.
    maxConcurrent: 3,
    // Coalesce dirty chunks arriving in the same frame into one request.
    batchPerFrame: 4,
  },

  render: {
    gbufferScale: 1.0,
    halfResEffects: true,
    maxPixelRatio: 2,
    shadowMapSize: 1024,
    cascades: 3,
    clusterTilePx: 16,
    maxLightsPerCluster: 24,
    ssgiRays: 4,
    ssgiSteps: 12,
    volumetricSteps: 28,
    volumetricScale: 0.5,
    fxaa: true,
  },

  particles: {
    count: 24576,
    // Materials/dust/spark/debris/conflict all draw from one pool.
    lifetimes: { materialize: 700, debris: 1400, conflict: 620, spark: 520, dust: 900 },
  },

  camera: {
    fov: 52,
    near: 0.1,
    far: 620,
    minDistance: 4,
    maxDistance: 240,
    start: [34, 30, 42],
  },

  colors: {
    // Lighting/sky radiance is authored in LINEAR space in `createEnvironment`,
    // not here. These four tints below are retained only for the HUD and the
    // glass/overlay passes, which want sRGB colours rather than radiance.
    //
    // The `sky`/`fog`/`sun`/`ambient` entries that used to drive the lighting rig
    // are gone on purpose. They were consumed as `convertSRGBToLinear() * 90`,
    // which made "make the ambient visible" and "make the ambient correct" look
    // like the same problem. See createEnvironment's comment.
    fog: 0x0a1122,
    valid: 0x38bdf8,
    blocked: 0xfb7185,
    pending: 0xfbbf24,
    you: '#38bdf8',
  },

  // Simulated one-way latency added to every client -> server op, so
  // prediction and rollback are exercised even on a LAN.
  artificialLatencyMs: 45,
};

/**
 * Quality tiers. The deferred chain is expensive, so the pipeline is built once
 * and individual passes are switched on or off; the frame graph respects those
 * flags rather than being torn down and rebuilt.
 */
export const QUALITY = {
  high: {
    label: 'High',
    shadows: true, ssgi: true, volumetric: true, fxaa: true,
    clusters: true, lodBias: 1.0, halfRes: true,
  },
  medium: {
    label: 'Medium',
    shadows: true, ssgi: false, volumetric: true, fxaa: true,
    clusters: true, lodBias: 0.75, halfRes: true,
  },
  low: {
    label: 'Low',
    shadows: false, ssgi: false, volumetric: false, fxaa: false,
    clusters: false, lodBias: 0.5, halfRes: false,
  },
};

export const QUALITY_ORDER = ['high', 'medium', 'low'];

// ---------------------------------------------------------------------------
// Material lookup table, packed for the GPU.
//
// The G-buffer shader indexes this by material id to recover albedo,
// roughness, metallic and emissive, so material data lives on the GPU exactly
// once instead of branching per pixel.
// ---------------------------------------------------------------------------

export const MATERIAL_STRIDE = 4; // vec4 per material: rgb + roughness
export const MATERIAL_EMISSIVE_STRIDE = 4; // rgb + metallic

/** @returns {{albedo:Float32Array, emissive:Float32Array, count:number}} */
export function buildMaterialTables() {
  const n = MAX_MATERIAL_ID + 1;
  const albedo = new Float32Array(n * MATERIAL_STRIDE);
  const emissive = new Float32Array(n * MATERIAL_EMISSIVE_STRIDE);

  const toLinear = (hex) => {
    const r = ((hex >> 16) & 255) / 255;
    const g = ((hex >> 8) & 255) / 255;
    const b = (hex & 255) / 255;
    // sRGB -> linear; the renderer works in linear and encodes at the end.
    const f = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return [f(r), f(g), f(b)];
  };

  for (let id = 0; id < n; id++) {
    const m = MATERIALS[id];
    const o = id * MATERIAL_STRIDE;
    if (!m) {
      albedo[o + 3] = 1; // never matches; slot 0 is air and never shaded
      continue;
    }
    const [r, g, b] = toLinear(m.color);
    albedo[o + 0] = r;
    albedo[o + 1] = g;
    albedo[o + 2] = b;
    albedo[o + 3] = m.roughness;

    const e = id * MATERIAL_EMISSIVE_STRIDE;
    const [er, eg, eb] = toLinear(m.emissive);
    emissive[e + 0] = er * m.emissiveIntensity;
    emissive[e + 1] = eg * m.emissiveIntensity;
    emissive[e + 2] = eb * m.emissiveIntensity;
    emissive[e + 3] = m.metalness;
  }
  return { albedo, emissive, count: n };
}

/** Palette entries for the DOM tool bar. */
export const PALETTES = {
  build: Object.values(MATERIALS)
    .filter((m) => m.vis === VIS.OPAQUE)
    .map((m) => ({ id: m.id, kind: 'block', name: m.name, color: m.color, glow: m.emissiveIntensity > 0 })),
  decor: Object.values(PROPS).map((p) => ({
    id: p.key, kind: 'prop', name: p.name, icon: p.icon, light: !!p.light,
  })),
};
