/**
 * GLSL for the deferred pipeline.
 *
 * Written against GLSL ES 3.00 (WebGL2). Every pass shares `COMMON` so that
 * linear colour handling, tonemapping constants and the packing helpers agree in
 * one place -- the classic deferred bug is a pass that forgets it is working in
 * linear space while everything around it does not.
 *
 * The world renders in linear light and is encoded to sRGB exactly once, in the
 * composite. Materials are uploaded through `buildMaterialTables` in config.js,
 * which does the sRGB->linear conversion on the CPU, so no shader has to guess
 * whether a colour is encoded.
 */

import * as THREE from 'three';

import { buildMaterialTables, MAX_MATERIAL_ID } from '../config.js';

// ---------------------------------------------------------------------------
// Shared chunks
// ---------------------------------------------------------------------------

/**
 * Helpers that every pass may call.
 *
 * Deliberately self-contained: it declares no uniforms of its own. The material
 * decoders used to live here, which meant any pass that included COMMON without
 * also including MATERIAL_TABLE failed to compile with "undeclared identifier" --
 * and because a broken program only raises GL_INVALID_OPERATION at draw time, the
 * whole post chain went black with nothing but a numeric error code to go on.
 * Keep this chunk free of uniform dependencies.
 */
export const COMMON = /* glsl */`
const float PI = 3.14159265359;

// NOTE: luminance() is deliberately NOT declared here. three.js's own
// ShaderChunk.common already defines it for every ShaderMaterial, and redeclaring
// it makes the chunk materials fail to link with "function already has a body" --
// which surfaces only as GL_INVALID_OPERATION and a black frame. Post passes use
// RawShaderMaterial, which gets no injection, so they supply their own luma().
// Anything added to this chunk must be checked against three's prefix first.

// Value noise used by the dissolve, the fog and the SSGI jitter. Cheap, tileable
// enough for a build animation, and identical everywhere so effects agree.
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float noise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0,0,0));
  float n100 = hash13(i + vec3(1,0,0));
  float n010 = hash13(i + vec3(0,1,0));
  float n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1));
  float n101 = hash13(i + vec3(1,0,1));
  float n011 = hash13(i + vec3(0,1,1));
  float n111 = hash13(i + vec3(1,1,1));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}
float fbm3(vec3 p) {
  return noise3(p) * 0.55 + noise3(p * 2.03) * 0.28 + noise3(p * 4.01) * 0.17;
}
`;

/**
 * Packed material tables, plus the decoders that read them.
 *
 * Must be included by every shader that decodes a material id -- and only those.
 * See {@link COMMON} for why it lives apart from it.
 *
 * The array size is derived from `MAX_MATERIAL_ID`, never written by hand. It was
 * `uMatAlbedo[10]`, correct while the palette had nine materials, and the atoll palette
 * took it to seventeen. Nothing complained: GLSL leaves an out-of-bounds index into a
 * uniform array *undefined*, and this driver returns the last in-bounds element -- so
 * every one of materials 10 to 17 rendered as material 9, Cyan Glass. The whole island
 * came out as a sheet of pale cyan glass at full brightness, because glass is the
 * brightest and smoothest thing in the palette and the tone curve had nothing left to
 * model it with.
 *
 * The symptom was unusually well disguised, which is the point of writing it down:
 *
 *   - the CPU-side table in `config.js` was correct, so reading it from JS showed the
 *     right values;
 *   - the geometry carried the right material ids, so inspecting the meshes showed
 *     reef, sand, coral and palms and nothing looked wrong;
 *   - only the *shader* disagreed -- which is why tinting material 9 turned the entire
 *     terrain red, and why nothing short of reading the G-buffer back found it.
 *
 * A number written inside a shader string is not a constant anybody is watching.
 * Deriving it from the palette means the next material added cannot repeat this, and
 * `test/shaders.test.js` asserts the two agree.
 */
export const MATERIAL_TABLE = /* glsl */`
uniform vec4 uMatAlbedo[${MAX_MATERIAL_ID + 1}];
uniform vec4 uMatEmissive[${MAX_MATERIAL_ID + 1}];

vec3 decodeMaterialAlbedo(uint id) { return uMatAlbedo[id].rgb; }
float decodeMaterialRoughness(uint id) { return uMatAlbedo[id].a; }
vec3 decodeMaterialEmissive(uint id) { return uMatEmissive[id].rgb; }
float decodeMaterialMetalness(uint id) { return uMatEmissive[id].a; }
`;

/**
 * Chunk geometry vertex stage.
 *
 * Decodes the 16-byte interleaved vertex the mesher emits:
 *   uint16 x0..2 = position, uint16 x3..4 = quad uv, uint16 x5 = (nx+1, ny+1),
 *   uint16 x6 = (nz+1, ao), uint16 x7 = material id
 *
 * The material id arrives as a float rather than a `uint`. three.js drives
 * integer-typed attributes through vertexAttribIPointer, and a `uint` varying
 * declared over a Uint16Array makes it read four bytes per component out of a
 * two-byte-per-element buffer -- reading past the end, which the driver reports
 * only as GL_INVALID_OPERATION. Converting to uint in the shader instead is free
 * and keeps every attribute on the same well-defined float path.
 *
 * The fx attribute drives the spawn dissolve and the destroy melt.
 */
export const CHUNK_VERTEX = /* glsl */`
in vec3 aPos;
in vec2 aUV;
in vec2 aNrm;
in vec2 aNzAo;
in float aMat;
in vec4 aFx;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUV;
out float vAo;
flat out uint vMat;
out vec4 vFx;
out vec3 vLocalPos;

void main() {
  vec3 p = vec3(aPos);
  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorldPos = world.xyz;
  vLocalPos = p;
  vNormal = vec3(aNrm.x - 1.0, aNrm.y - 1.0, aNzAo.x - 1.0);
  vUV = aUV;
  vAo = aNzAo.y / 3.0;
  vMat = uint(aMat + 0.5);
  vFx = aFx;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * Chunk geometry fragment stage.
 *
 * The dissolve is a noise threshold against fx progress: below the threshold the
 * fragment is discarded, so a spawning block grows out of a noisy edge instead of
 * fading in. Melting additionally sinks and shrinks, which reads as destruction
 * rather than as a reverse dissolve.
 */
export const CHUNK_FRAGMENT = /* glsl */`
in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in float vAo;
flat in uint vMat;
in vec4 vFx;
in vec3 vLocalPos;

layout(location = 0) out vec4 gAlbedoRough;
layout(location = 1) out vec4 gNormalDepth;
layout(location = 2) out vec4 gMaterial;

${COMMON}
${MATERIAL_TABLE}

uniform float uTime;

void main() {
  float progress = vFx.x;
  uint mode = uint(vFx.y);
  float seed = vFx.z / 255.0;

  if (mode == 1u) {
    // Spawn: dissolve in against a stable per-quad noise field.
    float n = fbm3(vWorldPos * 1.7 + seed * 37.0);
    if (progress < n * 0.75 + 0.12) discard;
    // A thin hot rim right at the dissolve front sells it as materialising.
    float edge = smoothstep(n * 0.75 + 0.12, n * 0.75 + 0.24, progress);
    gAlbedoRough.rgb = mix(vec3(0.35, 0.85, 1.0), decodeMaterialAlbedo(vMat), edge);
  } else if (mode == 2u) {
    // Destroy: melt by collapsing downwards while the top edge burns away.
    float n = fbm3(vWorldPos * 1.7 + seed * 37.0);
    float local = fract(vWorldPos.y);
    if (progress > local + n * 0.35) discard;
    // No trailing comma: GLSL forbids them in call argument lists, unlike
    // JavaScript, and the error is reported at the closing paren several lines
    // below the actual mistake.
    gAlbedoRough.rgb = mix(
      decodeMaterialAlbedo(vMat),
      vec3(1.0, 0.42, 0.12),
      smoothstep(0.35, 0.0, progress) * 0.8
    );
  } else {
    gAlbedoRough.rgb = decodeMaterialAlbedo(vMat);
  }

  // Per-face tint so a wall of one material does not read as a flat sheet.
  // The material id is converted to float first: GLSL ES 3.00 has no implicit
  // uint/float conversion, so mixing them in one expression is a syntax error.
  float shade = 1.0 - (1.0 - vAo) * 0.55;
  float faceTint = 0.94 + 0.06 * hash11(float(vMat) * 13.0 + floor(vWorldPos.x + vWorldPos.z));
  gAlbedoRough.rgb *= shade * faceTint;
  gAlbedoRough.a = decodeMaterialRoughness(vMat);

  vec3 n = normalize(vNormal);
  gNormalDepth = vec4(n * 0.5 + 0.5, 1.0);

  // rgb carries emissive; a carries the fx mode so the lighting pass can darken
  // and tint melting fragments instead of lighting them as solid matter.
  gMaterial = vec4(decodeMaterialEmissive(vMat), float(mode));
}
`;

/**
 * Translucent variant.
 *
 * Glass cannot go in the G-buffer: a deferred pass has nowhere to put the blend,
 * and glass-behind-glass needs real ordering. It is drawn forward after lighting,
 * depth-tested against the G-buffer's depth texture, with premultiplied alpha.
 */
export const CHUNK_GLASS_FRAGMENT = /* glsl */`
in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in float vAo;
flat in uint vMat;
in vec4 vFx;
in vec3 vLocalPos;

out vec4 fragColor;

${COMMON}
${MATERIAL_TABLE}

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uTime;
/** G-buffer scene depth, sampled so glass occludes correctly without a shared
 *  depth attachment. */
uniform sampler2D uSceneDepth;
uniform vec2 uResolution;

void main() {
  float progress = vFx.x;
  uint mode = uint(vFx.y);
  float seed = vFx.z / 255.0;

  float n = fbm3(vWorldPos * 1.7 + seed * 37.0);
  if (mode == 1u && progress < n * 0.75 + 0.12) discard;
  if (mode == 2u && progress > fract(vWorldPos.y) + n * 0.35) discard;

  // Manual depth test against the opaque scene. Slight bias so a glass pane
  // flush against a wall is not eaten by the wall's own depth.
  float sceneDepth = texture(uSceneDepth, gl_FragCoord.xy / uResolution).r;
  if (gl_FragCoord.z > sceneDepth + 0.00008) discard;

  vec3 base = decodeMaterialAlbedo(vMat);
  float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(cameraPosition - vWorldPos))), 3.0);

  // Alpha is mostly fresnel: looking straight through a pane is nearly clear and
  // glancing across it is nearly opaque, which is what sells it as glass.
  //
  // The floor was 0.13, which is right for a window and badly wrong for the lagoon.
  // Fresnel is near zero when you look *straight down* at water -- which is exactly how
  // this game is played, the camera looks down at the island -- so the lagoon came out
  // at 13% tint over bright seabed and read as pale sand with a faint blue cast. Only
  // the water seen at a glancing angle near the horizon looked turquoise at all.
  //
  // At 0.40 the lagoon reads as turquoise from directly above, which is the entire point
  // of a Maldives atoll, and a glass pane is still plainly see-through head-on. The cost
  // is real and worth stating: glass is now less transparent than it was.
  float alpha = mix(0.40, 0.78, fresnel);
  alpha *= mix(1.0, 0.25 + 0.75 * progress, float(mode == 2u));

  vec3 lit = base * (uAmbient * 0.6 + uSunColor * max(dot(normalize(vNormal), uSunDir), 0.0) * 0.5);
  lit += decodeMaterialEmissive(vMat);

  // Surface motion, gated to the two water materials. Without this the lagoon is a
  // perfectly flat mirror of its own albedo -- a colour, not a surface -- because a
  // greedy mesh collapses the water into a few huge quads with flat normals, so there
  // is no geometry left to vary the shading. The motion is done in the fragment shader
  // with a slow drifting band, the only place left for it.
  //
  // Kept subtle on purpose: it is texture for the surface you look at from one
  // distance most of the session, not an effect.
  if (vMat == 14u || vMat == 15u) {
    float drift = sin(vWorldPos.x * 0.85 + uTime * 1.05)
                * sin(vWorldPos.z * 0.70 - uTime * 0.78);
    float ripple = 0.5 + 0.5 * drift;
    lit *= 0.92 + 0.08 * ripple;
    alpha *= 0.86 + 0.14 * ripple;
  }

  fragColor = vec4(lit * alpha, alpha);
}
`;

/** A screen-filling triangle; cheaper and seam-free versus two triangles. */
export const FULLSCREEN_VERT = /* glsl */`
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * A shared fullscreen triangle, plus a helper that runs a fragment shader over
 * it into a render target. Every post pass in the pipeline goes through here so
 * they all share one geometry and one material lifecycle.
 */
export class FullscreenPass {
  constructor(fragmentShader, uniforms = {}, defines = {}) {
    this.geometry = new THREE.BufferGeometry();
    // Positions in clip space; the vertex shader passes them straight through.
    this.geometry.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3,
    ));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array([0, 0, 2, 0, 0, 2]), 2,
    ));
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      // `glslVersion: THREE.GLSL3` makes three.js prepend `#version 300 es` to both
      // stages of a RawShaderMaterial. The prelude must therefore NOT contain a
      // version directive of its own: a second one is a hard error ("#version
      // directive must occur before anything else").
      //
      // The prelude is also exactly what a pass may assume. COMMON is spliced in
      // here, so a pass needing the material tables includes MATERIAL_TABLE in its
      // own source rather than re-including COMMON.
      vertexShader: `precision highp float;\nin vec3 position;\nin vec2 uv;\n${FULLSCREEN_VERT}`,
      fragmentShader: `precision highp float;\nin vec2 vUv;\nout vec4 fragColor;\n${COMMON}\n${fragmentShader}`,
      uniforms,
      defines,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
  }

  get uniforms() {
    return this.material.uniforms;
  }

  /** @param {THREE.WebGLRenderer} renderer @param {THREE.WebGLRenderTarget|null} target */
  render(renderer, target = null) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(this.scene, CAMERA);
    renderer.setRenderTarget(prev);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Every fullscreen pass shares one orthographic camera; it is never transformed. */
const CAMERA = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/**
 * Upload the material tables as uniform arrays.
 *
 * The tables come from config.js already converted to linear. `THREE.Vector4`
 * arrays are used rather than a data texture because 10 entries is small enough
 * that a uniform array keeps the shader branch-free and indexable.
 */
export function materialUniforms() {
  const { albedo, emissive, count } = buildMaterialTables();
  const uAlbedo = [];
  const uEmissive = [];
  for (let i = 0; i < count; i++) {
    const a = i * 4;
    uAlbedo.push(new THREE.Vector4(albedo[a], albedo[a + 1], albedo[a + 2], albedo[a + 3]));
    uEmissive.push(new THREE.Vector4(
      emissive[a], emissive[a + 1], emissive[a + 2], emissive[a + 3],
    ));
  }
  return {
    uMatAlbedo: { value: uAlbedo },
    uMatEmissive: { value: uEmissive },
  };
}

/**
 * Materials for chunk columns: opaque writes the G-buffer, glass is drawn forward.
 *
 * `ShaderMaterial` rather than `RawShaderMaterial` because the chunk stages use
 * three's built-in `modelMatrix`/`viewMatrix`/`projectionMatrix`, which a raw
 * material would require declaring by hand. GLSL3 throughout: the vertex
 * attributes are integer-typed, which is what lets the material id be a flat
 * `uint` and index the material tables directly.
 *
 * Both materials share one uniform object so the sun and the clocks only have to
 * be updated in one place per frame.
 */
export function createChunkMaterials(env) {
  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: env.sunDir },
    uSunColor: { value: env.sunColor },
    uAmbient: { value: env.ambient },
    uSceneDepth: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    ...materialUniforms(),
  };

  const opaque = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: CHUNK_VERTEX,
    fragmentShader: CHUNK_FRAGMENT,
    uniforms,
    // Greedy quads that merge across an axis can end up with winding that no
    // longer matches their neighbours, so back-face culling punches holes in
    // merged surfaces. Double-sided costs nothing here because the shading uses a
    // geometric normal that is valid either way.
    side: THREE.DoubleSide,
  });

  const glass = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: CHUNK_VERTEX,
    fragmentShader: CHUNK_GLASS_FRAGMENT,
    uniforms,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    // The HDR target has its own depth attachment rather than sharing the
    // G-buffer's, so glass is occluded by solid geometry by comparing its own
    // clip-space depth against the scene depth sampled as a texture. That keeps
    // the two framebuffers independent, which is what the shared-attachment
    // version broke on.
    depthTest: false,
    // Premultiplied: the glass stage emits colour already scaled by alpha.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });

  return { opaque, glass, uniforms };
}
