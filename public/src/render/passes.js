/**
 * Fullscreen post shaders.
 *
 * Each factory returns a {@link FullscreenPass}; the pipeline owns them and
 * updates the handful of uniforms that change per frame.
 *
 * Everything here works in linear light and outputs linear colour. The single
 * sRGB encode happens in the composite, so no pass has to remember which space it
 * is in -- which is the single most common source of washed-out or crushed output
 * in a deferred chain.
 */

import * as THREE from 'three';

import { FullscreenPass, COMMON } from './shaders.js';
import { CONFIG } from '../config.js';
import { WORLD_BIAS, WORLD_SCALE, MAX_RADIUS, INTENSITY_RANGE } from './lights.js';

/**
 * Cascade count, injected into the lighting GLSL rather than hardcoded.
 *
 * The uniform array length and the split search both have to agree with what the
 * CSM actually allocated, and CONFIG is what decides that. Deriving the shader
 * from the same constant means the two cannot drift apart -- which is exactly how
 * a 3-cascade config ends up indexing a 4-element array and throwing on the first
 * frame.
 */
const CS = CONFIG.render.cascades;

/**
 * Four light indices per index-texture texel, so the cluster grid's texture is a
 * quarter the width it would otherwise be. Derived from the cap in CONFIG, since
 * the loop bound in the shader and the texture layout must agree exactly.
 */
const SLOTS = Math.ceil(CONFIG.render.maxLightsPerCluster / 4);

/**
 * Deferred lighting.
 *
 * Reads the G-buffer and resolves sun (with cascaded shadows), hemispheric
 * ambient and material emissive into an HDR target. Depth is reconstructed by
 * inverting the projection rather than by carrying a fourth attachment: it is
 * cheaper, and the reconstruction is exact for a standard perspective camera.
 */
export function createLightingPass(env) {
  return new FullscreenPass(/* glsl */`
uniform sampler2D uGAlbedo;
uniform sampler2D uGNormal;
uniform sampler2D uGMaterial;
uniform sampler2D uDepth;
uniform sampler2D uShadowAtlas;

uniform mat4 uInvViewProj;
uniform mat4 uView;
uniform mat4 uCascadeMat[${CS}];
uniform vec3 uCameraPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform vec4 uSplits;
uniform vec4 uTexels;
uniform float uFogDensity;
uniform float uEmissiveBoost;
/** 1 / atlas edge, so the shadow filter steps exactly one texel. */
uniform float uShadowTexel;
/** Clustered point lights: tile size in pixels, index grid and light data. */
uniform float uTilePx;
uniform sampler2D uLightIndex;
uniform sampler2D uLightData;
/**
 * Sky radiance, distinct from the fill light. These exist because the sky is a
 * background and the fill is a light source: the fill has to be bright enough to
 * lift a 0.2-albedo material (so ~1.5), which as a sky zenith would clip to flat
 * blue. One uniform cannot serve both.
 */
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;

vec3 viewFromDepth(vec2 uv, float depth) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = uInvViewProj * clip;
  return view.xyz / view.w;
}

// Linear search over the split distances. Unused slots hold Infinity, so the
    // fallthrough lands on the last real cascade rather than off the end.
int pickCascade(float viewDepth) {
  if (viewDepth < uSplits.x) return 0;
#if ${CS} > 1
  if (viewDepth < uSplits.y) return 1;
#endif
#if ${CS} > 2
  if (viewDepth < uSplits.z) return 2;
#endif
#if ${CS} > 3
  if (viewDepth < uSplits.w) return 3;
#endif
  return ${CS} - 1;
}

/** Far distance of the cascade a pixel falls in, for the boundary fade. */
float cascadeFar(int cascade) {
#if ${CS} > 3
  if (cascade == 3) return uSplits.w;
#endif
#if ${CS} > 2
  if (cascade == 2) return uSplits.z;
#endif
#if ${CS} > 1
  if (cascade == 1) return uSplits.y;
#endif
  return uSplits.x;
}

void main() {
  float depth = texture(uDepth, vUv).r;

  if (depth >= 1.0) {
    // Sky.
    //
    // This is the largest area on screen and the single cheapest place to spend
    // quality. The previous version was a two-stop vertical gradient plus a
    // pow(dot, 1200) sun disc, which read as a flat backdrop: a silhouette was
    // legible against it but the sky itself had nothing to look at.
    //
    // This is still an analytic approximation rather than a Preetham/Hosek
    // integral -- no scattering solve, no LUT -- but it adds the three things
    // that make a sky look like a sky:
    //   1. three stops instead of two (zenith / horizon / ground haze)
    //   2. sun-facing horizon glow, so the sky is not radially uniform
    //   3. a two-lobe sun (tight disc + wide halo) so the light source has size
    //
    // Colours are derived from uSkyColor / uFogColor rather than being new
    // constants, so retuning the environment retunes the sky with it instead of
    // leaving them out of sync.
    vec2 ndc = vUv * 2.0 - 1.0;
    vec3 ray = normalize(vec3(ndc, 1.4));
    float h = ray.y;

    // Three genuinely distinct stops. The previous version derived the horizon by
    // mixing uSkyColor toward uFogColor, while uFogColor was nearly black, so
    // horizon and zenith came out within 0.1 of each other: the gradient was
    // arithmetically present and visually a flat blue wall. Distinct stops are the
    // whole point of having three of them.
    vec3 zenith = uSkyZenith;
    vec3 horizon = uSkyHorizon;
    vec3 ground = uSkyHorizon * 0.45;

    float up = clamp(h, 0.0, 1.0);
    // pow on the up-axis tightens the horizon band, which is where the eye reads
    // atmospheric depth. A linear ramp puts too much colour in the top half.
    vec3 sky = mix(horizon, zenith, pow(up, 0.5));
    sky = mix(sky, ground, smoothstep(0.0, -0.22, h));

    // Sun-facing horizon glow. This is what gives the sky hue variation rather
    // than just brightness variation: the horizon runs warm where the sun is and
    // stays cool away from it, which is the cue that reads as "sky" rather than
    // "gradient".
    float sunDot = max(dot(ray, uSunDir), 0.0);
    float azimuthal = pow(sunDot, 3.0);
    float horizonBand = exp(-max(h, 0.0) * 4.0);
    sky = mix(sky, uSunColor * 0.11, azimuthal * horizonBand * 0.8);

    // Two sun lobes. The tight one is the disc; the wide one is the halo that
    // sells "this is very bright" before bloom touches it.
    //
    // Both are kept modest: bloom supplies the sense of glare, this only has to
    // seed it. A large disc term just burns a white hole through the tonemap.
    float disc = smoothstep(0.9985, 0.9995, sunDot);
    float halo = pow(sunDot, 260.0);
    sky += uSunColor * (disc * 1.4 + halo * 0.30);

    fragColor = vec4(sky, 1.0);
    return;
  }

  vec4 albedoRough = texture(uGAlbedo, vUv);
  vec3 albedo = albedoRough.rgb;
  float rough = albedoRough.a;
  vec3 n = normalize(texture(uGNormal, vUv).xyz * 2.0 - 1.0);
  vec4 mat = texture(uGMaterial, vUv);
  vec3 emissive = mat.rgb;
  float fxMode = mat.a;

  vec3 viewPos = viewFromDepth(vUv, depth);
  vec3 worldPos = (uView * vec4(viewPos, 1.0)).xyz;
  float viewDepth = -viewPos.z;

  // --- sun with cascaded shadows -------------------------------------------
  float ndl = max(dot(n, uSunDir), 0.0);
  float shadow = 1.0;

  if (ndl > 0.0) {
    int cascade = pickCascade(viewDepth);
    // Normal offset scaled by the cascade's world texel size, so the offset is
    // the same in shadow-map space regardless of cascade resolution.
    vec4 sp = uCascadeMat[cascade] * vec4(worldPos + n * uTexels[cascade] * 1.6, 1.0);

    if (sp.z > 0.0 && sp.z < 1.0 && sp.w > 0.0) {
      // Each cascade occupies one quadrant of the 2x2 atlas. Mapping the index to
      // a quadrant here is clearer than folding the offset into the matrix, and
      // keeps uCascadeMat a pure view-projection.
      vec2 uv = (sp.xy / sp.w) * 0.5 + vec2(float(cascade % 2), float(cascade / 2)) * 0.5;
      float bias = mix(0.0022, 0.0005, ndl);
      float sum = 0.0;
      // 3x3 filter: removes the stair-stepping a single tap shows on voxel faces
      // for the cost of eight extra reads in the one pass that can afford them.
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          float d = texture(uShadowAtlas, uv + vec2(float(x), float(y)) * uShadowTexel).r;
          sum += step(sp.z - bias, d);
        }
      }
      shadow = sum / 9.0;
      // Fade out at the cascade boundary so the seam is not a hard line across
      // the floor.
      float fadeStart = cascadeFar(cascade);
      shadow = mix(shadow, 1.0, smoothstep(fadeStart * 0.85, fadeStart, viewDepth));
    }
  }

  // Specular: a single Blinn-Phong lobe. Cheaper than GGX and, at this texel
  // density on a voxel world, indistinguishable.
  vec3 viewDir = normalize(uCameraPos - worldPos);
  vec3 halfVec = normalize(viewDir + uSunDir);
  float gloss = 1.0 - rough;
  float spec = pow(max(dot(n, halfVec), 0.0), mix(8.0, 128.0, gloss))
             * gloss * (1.0 - rough * 0.7) * shadow;

  vec3 direct = uSunColor * ndl * shadow;

  // Hemispheric ambient, occluded by the AO the mesher baked into albedo.
  vec3 hemi = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
  vec3 ambient = hemi;

  // Specular was scaled against the old over-bright sun. With the environment now
  // authored in linear, uSunColor peaks at ~2.45, so the old 0.6 turned every
  // low-roughness material into a clipped highlight. Bloom is the right place to
  // express glare; here it only needs to describe the surface.
  vec3 color = albedo * (direct + ambient)
            + uSunColor * spec * 0.22
            + emissive * uEmissiveBoost;

  // --- clustered point lights ------------------------------------------------
  // The index texture is SLOTS texels wide per tile, four light indices per texel.
  //
  // The grid was built with exactly this mapping, so the two must agree: a texel
  // at (tileX * SLOTS + slot, tileY) holds the indices for that tile. Reading with
  // a different stride silently samples neighbouring tiles' data, which looks
  // like "the lights do nothing" rather than like an indexing bug.
  ivec2 tile = ivec2(gl_FragCoord.xy / uTilePx);
  for (int s = 0; s < ${SLOTS}; s++) {
    vec4 packed = texelFetch(uLightIndex, ivec2(tile.x * ${SLOTS} + s, tile.y), 0);

    // The four indices are unpacked by hand rather than into a local int array.
    // Building a dynamically-indexed array inside a loop is legal GLSL but is
    // mis-compiled by at least one common driver, and the symptom is a silently
    // skipped loop body -- the lights simply do nothing, with no error anywhere.
    for (int k = 0; k < 4; k++) {
      // Both light textures are RGBA8, and an RGBA8 texture reads back *normalised*
      // to 0..1, not as the 0..255 byte values the CPU wrote. Every decode here
      // therefore has to undo that first.
      //
      // Skipping the *255 on either line is the bug that kept every lantern in the
      // world dark for the entire life of this feature. With it missing:
      //   - the sentinel byte 255 reads as 1.0, so int(1.0) is 1, never 255, so the
      //     empty-slot guard never fired and empty slots looked like a valid index;
      //   - a position byte of 128 read as 0.502 and became 0.502*1.99 - 64 = -63,
      //     putting every light at roughly (-63,-63,-63);
      //   - so dist >= r was true for every pixel and every light was skipped, with
      //     no GL error and a correct-looking image.
      //
      // Worth stating plainly: this was checked twice by decoding the CPU's byte
      // array in JavaScript, which came out perfect. The bug was only ever in what
      // the GPU handed back. Decode has to be verified against the fetch.
      float bx = k == 0 ? packed.x : k == 1 ? packed.y : k == 2 ? packed.z : packed.w;
      int id = int(bx * 255.0 + 0.5);
      if (id >= 255) continue;

      vec4 posRadius = texelFetch(uLightData, ivec2(id, 0), 0) * 255.0;
      vec3 lightPos = posRadius.xyz * ${(1 / WORLD_SCALE).toFixed(6)} - ${WORLD_BIAS.toFixed(1)};
      float r = posRadius.w * ${MAX_RADIUS.toFixed(1)};
      vec4 colorInt = texelFetch(uLightData, ivec2(id, 1), 0) * 255.0;
      // Colour and intensity were stored on separate channels; recombine them.
      //
      // colorInt is already in byte units here because of the *255 above, so the
      // intensity has to come back down by 255 as well before being scaled by the
      // reference range. Multiplying the byte by INTENSITY_RANGE directly -- which
      // is what this did -- made every light 255x too bright, which is why a lamp
      // rendered as a white hole rather than a pool of light.
      float intensity = (colorInt.a / 255.0) * ${INTENSITY_RANGE.toFixed(1)};
      vec3 lightColor = colorInt.rgb * (1.0 / 255.0) * intensity;

      vec3 toLight = lightPos - worldPos;
      float dist = length(toLight);
      if (dist >= r) continue;
      float ndl = max(dot(n, toLight / max(dist, 1e-4)), 0.0);
      // Half-Lambert keeps unlit sides from going pure black, which matters
      // indoors where a lantern is the only source.
      //
      // Inverse-square in the near field, windowed so it still reaches exactly
      // zero at the radius. Without the square a lamp lights a hard disc; without
      // the window the cut-off is a visible circle on the floor.
      float invD2 = 1.0 / (1.0 + dist * dist * 0.35);
      float windowed = invD2 * (1.0 - (dist / r) * (dist / r));
      color += albedo * lightColor * (ndl * 0.75 + 0.25) * windowed;
    }
  }

  // Melting geometry burns instead of lighting normally.
  if (fxMode > 1.5) {
    color = mix(color, vec3(2.2, 0.55, 0.12), 0.65);
  }

  // Distance fog toward the horizon colour; the volumetric pass adds the part
  // that scatters light rather than just blending to a constant.
  float fog = 1.0 - exp(-uFogDensity * viewDepth);
  color = mix(color, uFogColor, clamp(fog, 0.0, 0.92));

  fragColor = vec4(color, 1.0);
}
`, {
    uGAlbedo: { value: null },
    uGNormal: { value: null },
    uGMaterial: { value: null },
    uDepth: { value: null },
    uShadowAtlas: { value: null },
    uInvViewProj: { value: new THREE.Matrix4() },
    uView: { value: new THREE.Matrix4() },
    uCascadeMat: { value: Array.from({ length: CS }, () => new THREE.Matrix4()) },
    uCameraPos: { value: new THREE.Vector3() },
    uSunDir: { value: env.sunDir },
    uSunColor: { value: env.sunColor },
    uSkyColor: { value: env.skyColor },
    uGroundColor: { value: env.groundColor },
    uFogColor: { value: env.fogColor },
    uSkyZenith: { value: env.skyZenith },
    uSkyHorizon: { value: env.skyHorizon },
    uSplits: { value: new THREE.Vector4() },
    uTexels: { value: new THREE.Vector4() },
    uShadowTexel: { value: 1 / 2048 },
    uFogDensity: { value: CONFIG.fogDensity },
    uEmissiveBoost: { value: 1.0 },
    uTilePx: { value: CONFIG.render.clusterTilePx },
    uLightIndex: { value: null },
    uLightData: { value: null },
  });
}

/**
 * Composite: bloom, tone map, vignette and FXAA.
 *
 * The sRGB encode happens exactly here, at the end of the chain. Nothing after
 * this point may treat the buffer as linear.
 */
export function createCompositePass() {
  return new FullscreenPass(/* glsl */`
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uResolution;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uFxaa;
uniform float uSaturation;

// ACES filmic approximation (Narkowicz). Cheap, and it rolls highlights off
// smoothly, which matters here because emissive neon is routinely over 1.0.
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055,
             step(0.0031308, c));
}

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// One pixel of the final image, end to end: bloom, exposure, tone map,
// saturation, vignette, sRGB encode.
//
// Every FXAA tap has to go through this exact function, and that is the whole
// point of factoring it out. The taps used to sample raw HDR uScene while
// rgbM was the tone-mapped, gamma-encoded centre, so the edge test compared
// linear radiance (~0.6-2.3) against display code (~0.6-1.0) in one min/max.
// Two different color spaces guarantee lMax - lMin > 0.05 over most of the
// frame, and the a/b blends then wrote those raw HDR texels into the
// framebuffer with no encode at all. Sunlit ground has linear radiance above
// 1.0, so it came out clipped white -- 43% of a 192-point ground sample --
// while shadowed ground landed near black. Measured against a model of this
// function, the old path was off by 99.8 levels per pixel; FXAA disabled,
// 15.8. The tone curve was correct the entire time. The pass after it was
// eating it.
vec3 compose(vec2 uv) {
  vec3 c = texture(uScene, uv).rgb + texture(uBloom, uv).rgb * uBloomStrength;
  c *= uExposure;
  c = aces(c);

  // Saturation, applied after the tone map so it works in display space.
  float l = luma(c);
  c = mix(vec3(l), c, uSaturation);

  vec2 centred = uv - 0.5;
  c *= 1.0 - dot(centred, centred) * uVignette;

  return linearToSrgb(c);
}

void main() {
  vec3 color = compose(vUv);

  if (uFxaa > 0.5) {
    // FXAA on the encoded result, which is where it is meant to run: luma edges
    // computed on gamma-encoded values track what the eye actually sees. The
    // taps below are compose()d for the same reason -- they are pixels of this
    // image, not samples of the buffer behind it.
    vec2 px = 1.0 / uResolution;
    vec3 rgbNW = compose(vUv + vec2(-1.0, -1.0) * px);
    vec3 rgbNE = compose(vUv + vec2( 1.0, -1.0) * px);
    vec3 rgbSW = compose(vUv + vec2(-1.0,  1.0) * px);
    vec3 rgbSE = compose(vUv + vec2( 1.0,  1.0) * px);
    vec3 rgbM  = color;
    float lNW = luma(rgbNW), lNE = luma(rgbNE);
    float lSW = luma(rgbSW), lSE = luma(rgbSE), lM = luma(rgbM);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    if (lMax - lMin > 0.05) {
      vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
      float scale = 1.0 / (min(abs(dir.x), abs(dir.y)) + 0.25);
      dir = clamp(dir * scale, -4.0, 4.0) * px;
      // Same rule as the taps above: these are pixels of the composited image,
      // so they go through compose(). Sampling uScene here was what made the
      // final assignment write linear radiance into the display framebuffer.
      vec3 a = 0.5 * (compose(vUv + dir * (1.0 / 3.0 - 0.5))
                    + compose(vUv + dir * (2.0 / 3.0 - 0.5)));
      vec3 b = a * 0.5 + 0.25 * (compose(vUv + dir * -0.5)
                                + compose(vUv + dir *  0.5));
      float lB = luma(b);
      color = (lB < lMin || lB > lMax) ? a : b;
    }
  }

  fragColor = vec4(color, 1.0);
}
`, {
    uScene: { value: null },
    uBloom: { value: null },
    uResolution: { value: new THREE.Vector2() },
    uExposure: { value: 1.0 },
    uBloomStrength: { value: 0.6 },
    uVignette: { value: 0.35 },
    uFxaa: { value: 1 },
    uSaturation: { value: 1.05 },
  });
}

/** Separable Gaussian used for the bloom chain. */
export function createBlurPass() {
  return new FullscreenPass(/* glsl */`
uniform sampler2D uSource;
uniform vec2 uDirection;   // texel-sized step along one axis

void main() {
  // Nine-tap Gaussian collapsed to five bilinear fetches.
  const float o1 = 1.3846153846;
  const float o2 = 3.2307692308;
  const float w0 = 0.2270270270;
  const float w1 = 0.3162162162;
  const float w2 = 0.0702702703;
  vec3 sum = texture(uSource, vUv).rgb * w0;
  sum += texture(uSource, vUv + uDirection * o1).rgb * w1;
  sum += texture(uSource, vUv - uDirection * o1).rgb * w1;
  sum += texture(uSource, vUv + uDirection * o2).rgb * w2;
  sum += texture(uSource, vUv - uDirection * o2).rgb * w2;
  fragColor = vec4(sum, 1.0);
}
`, {
    uSource: { value: null },
    uDirection: { value: new THREE.Vector2() },
  });
}

/** Bright-pass threshold feeding the bloom chain. */
export function createBrightPass() {
  return new FullscreenPass(/* glsl */`
uniform sampler2D uSource;
uniform float uThreshold;
uniform float uSoftKnee;

void main() {
  vec3 c = texture(uSource, vUv).rgb;
  float b = max(c.r, max(c.g, c.b));
  // Soft knee: a hard threshold makes bloom pop on and off as a highlight
  // crosses it, which is very visible on a pulsing emissive block.
  float knee = uThreshold * uSoftKnee + 1e-5;
  float soft = clamp(b - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, b - uThreshold) / max(b, 1e-5);
  fragColor = vec4(c * contrib, 1.0);
}
`, {
    uSource: { value: null },
    // Threshold is set from the scene's measured HDR histogram, not by eye.
    //
    // A sampled frame pre-exposure reads p50 0.76, p90 2.26, p95 2.70 -- then jumps
    // to p99 6.02, a separate ~4.4% population of emissive blocks. At the old 0.9
    // threshold, *48.7%* of the frame cleared the bright-pass, feeding ~25% of total
    // frame brightness into the blur: that is the milky wash, and it is why the
    // picture read as over-exposed while the measured clipping stayed at 2.6%.
    // 3.0 sits in the gap, so bloom comes from neon rather than sunlit sand.
    //
    // The knee stays proportional (0.30 * 3.0 = 0.9) so pulsing emissive blocks
    // still cross smoothly rather than popping, but it now starts at 2.1 instead of
    // 0.36 and cannot re-admit the diffuse range.
    uThreshold: { value: 3.0 },
    uSoftKnee: { value: 0.30 },
  });
}