/**
 * Material / environment tone probe.
 *
 * Answers one question numerically: after the *real* lighting chain, what does each
 * material actually look like on screen?
 *
 * Three things this has to get right, each of which it previously got wrong:
 *
 * **1. There are two chains, not one.**
 *
 *   opaque (deferred G-buffer + lighting pass)
 *       albedo * (uSunColor * ndl * shadow + hemi(n))  + specular + emissive
 *
 *   translucent (forward pass, `render/shaders.js`)
 *       albedo * (uAmbient * 0.6 + uSunColor * ndl * 0.5) + emissive
 *
 * The second is not the first with different constants. It is a simpler rig: no
 * shadows, no hemispheric ground/sky mix, different weights. And *water is rendered
 * entirely through it* -- so a palette that looks right against the deferred formula
 * can still blow out on screen, which is exactly what happened to the lagoon.
 *
 * **2. Exposure comes from the config, not from a guess.**
 *
 * This tool hardcoded `exposure = 1.0` while `CONFIG.exposure` is **1.7**. Every
 * number it produced was 1.7x too optimistic and the atoll palette was tuned against
 * them; the render came out a lagoon of pure 255,255,255. Exposure is now imported
 * from the real config, and `test/lighting.test.js` asserts the two agree.
 *
 * **3. The numbers come from `pipeline.js` as source text.**
 *
 * Imported, a probe cannot catch the constant it is checking being wrong. Parsed, it
 * can. That is also the only option here: `pipeline.js` imports three.js.
 *
 * The metric that matters is the **lit/shadow ratio**. Voxel faces are flat-shaded: one
 * normal, one brightness. The only thing that shows form on a terraced surface is how
 * far a face pointing at the sun sits from one pointing away. A ratio near 1 is a flat
 * slab with the shape painted out.
 *
 * Run: `node tools/probe-run.mjs`
 */

import { readFileSync } from 'node:fs';

import { MATERIALS } from '../shared/materials.js';
import { CONFIG } from '../public/src/config.js';

// ---------------------------------------------------------------------------
// The tone curve, verbatim from render/passes.js
// ---------------------------------------------------------------------------

/** Narkowicz ACES approximation. */
export function aces(x) {
  const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return (x * (a * x + b)) / (x * (c * x + d) + e);
}

export const linearToSrgb = (v) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

export const srgbToLinear = (v) =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

export function hexToLinear(hex) {
  return [
    srgbToLinear(((hex >> 16) & 255) / 255),
    srgbToLinear(((hex >> 8) & 255) / 255),
    srgbToLinear((hex & 255) / 255),
  ];
}

/** Mean display value of a linear colour after exposure and ACES. */
export function display(linearRgb, exposure = CONFIG.exposure) {
  const vals = linearRgb.map((v) => linearToSrgb(aces(Math.max(0, v * exposure))));
  return {
    disp: vals,
    mean: vals.reduce((a, b) => a + b, 0) / vals.length,
    max: Math.max(...vals),
  };
}

// ---------------------------------------------------------------------------
// The environment, read out of the renderer's source
// ---------------------------------------------------------------------------

const PIPELINE_URL = new URL('../public/src/render/pipeline.js', import.meta.url);

/** Read `createEnvironment()` out of pipeline.js as source text. */
export function readEnvironment() {
  const src = readFileSync(PIPELINE_URL, 'utf8');
  const start = src.indexOf('export function createEnvironment()');
  if (start < 0) throw new Error('createEnvironment() not found in pipeline.js');
  const body = src.slice(start);
  const grab = (name) => {
    const m = body.match(new RegExp(name + ':\\s*new THREE\\.Vector3\\(([^)]*)\\)'));
    if (!m) throw new Error(`${name} not found in createEnvironment()`);
    const v = m[1].split(',').map((x) => parseFloat(x));
    if (!v.every(Number.isFinite)) throw new Error(`${name} has a non-numeric component`);
    return v;
  };
  const dirMatch = src.match(/sunDir:\s*new THREE\.Vector3\(([^)]*)\)/);
  const sunDir = dirMatch[1].split(',').map((x) => parseFloat(x));
  const len = Math.hypot(...sunDir);
  return {
    sunColor: grab('sunColor'),
    skyColor: grab('skyColor'),
    groundColor: grab('groundColor'),
    skyZenith: grab('skyZenith'),
    skyHorizon: grab('skyHorizon'),
    fogColor: grab('fogColor'),
    ambient: grab('ambient'),
    sunDir: sunDir.map((v) => v / len),
    /** Sun elevation in degrees, which decides whether raking light survives. */
    sunElevationDeg: Math.asin(sunDir[1] / len) * 180 / Math.PI,
  };
}

export const ENV = readEnvironment();

// ---------------------------------------------------------------------------
// The two lighting chains
// ---------------------------------------------------------------------------

/** Hemispheric ambient for a face with the given vertical normal. */
function hemi(env, ny) {
  const t = ny * 0.5 + 0.5;
  return env.skyColor.map((s, i) => env.groundColor[i] + (s - env.groundColor[i]) * t);
}

/**
 * Opaque path: the deferred lighting pass in render/passes.js.
 *
 * `ndl` is the face normal dotted with the sun, `shadow` is the cascaded shadow term,
 * `ny` is the face's vertical component (which selects the hemispheric mix).
 */
export function lightOpaque(env, albedoHex, { ndl = 1, shadow = 1, ny = 1 } = {}) {
  const albedo = hexToLinear(albedoHex);
  const h = hemi(env, ny);
  return albedo.map((a, i) =>
    a * (env.sunColor[i] * ndl * shadow + h[i]));
}

/**
 * Translucent path: the forward pass in render/shaders.js.
 *
 * Verbatim in structure -- `uAmbient * 0.6 + uSunColor * ndl * 0.5` -- because the
 * weights are the thing that matters and they are not the deferred weights.
 */
export function lightTranslucent(env, albedoHex, emissiveLinear = [0, 0, 0], ndl = 1) {
  const albedo = hexToLinear(albedoHex);
  return albedo.map((a, i) => {
    const rig = env.ambient[i] * 0.6 + env.sunColor[i] * ndl * 0.5;
    return a * rig + emissiveLinear[i];
  });
}

/** Linear emissive for a material, matching config.js's table build. */
export function emissiveLinear(mat) {
  return hexToLinear(mat.emissive ?? 0).map((v) => v * (mat.emissiveIntensity ?? 0));
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/**
 * Probe every material through the chain that actually renders it.
 *
 * @param {object} env from {@link readEnvironment}
 * @param {string[]} [keys] material keys; defaults to the whole catalogue
 * @param {number} [ndl] dot of the lit face with the sun
 */
export function probe(env = ENV, keys = Object.values(MATERIALS).map((m) => m.key), ndl = 1) {
  const rows = [];
  for (const key of keys) {
    const mat = MATERIALS[key] ?? Object.values(MATERIALS).find((x) => x.key === key);
    if (!mat) { rows.push({ key, missing: true }); continue; }

    const translucent = mat.vis === 2;
    const emis = emissiveLinear(mat);
    const litLin = translucent
      ? lightTranslucent(env, mat.color, emis, ndl)
      : lightOpaque(env, mat.color, { ndl, ny: 1 });
    const shadeLin = translucent
      ? lightTranslucent(env, mat.color, emis, 0)
      : lightOpaque(env, mat.color, { ndl: 0, ny: 1 });

    const lit = display(litLin);
    const shade = display(shadeLin);

    rows.push({
      key,
      name: mat.name,
      translucent,
      emissive: (mat.emissiveIntensity ?? 0) > 0,
      albedoPeak: Math.max(...hexToLinear(mat.color)),
      lit: lit.mean,
      litMax: lit.max,
      shadowed: shade.mean,
      ratio: shade.mean > 0 ? lit.mean / shade.mean : Infinity,
      /** Peak linear radiance before exposure. Past ~2.5 the curve has no gradient. */
      shoulder: Math.max(...litLin),
      clipped: lit.max >= 0.995,
    });
  }
  return rows;
}

/** Render a probe as a table. */
export function printProbe(title, rows) {
  console.log('\n' + title);
  console.log('-'.repeat(94));
  console.log(
    'material'.padEnd(15) + 'albedo'.padStart(7) + 'lit'.padStart(7) + 'shade'.padStart(7) +
    'ratio'.padStart(7) + 'shoulder'.padStart(9) + '  flags',
  );
  console.log('-'.repeat(94));
  const f = (n, w = 7, d = 3) => n.toFixed(d).padStart(w);
  for (const r of rows) {
    if (r.missing) { console.log(r.key.padEnd(15) + '  MISSING'); continue; }
    const flags = [];
    if (r.clipped) flags.push('CLIPPED');
    // "No form" applies only to opaque, non-emissive surfaces. Emissives are *supposed*
    // to sit high and flat -- that is what an emissive is for -- and translucents are
    // judged on depth separation rather than on lit/shadow contrast.
    if (r.ratio < 2.2 && !r.emissive && !r.translucent) flags.push('no form');
    if (r.shoulder > 2.5 && !r.emissive) flags.push('shoulder');
    console.log(
      r.key.padEnd(15) + f(r.albedoPeak) + f(r.lit) + f(r.shadowed) +
      f(r.ratio, 7, 2) + f(r.shoulder, 9, 2) + '  ' + flags.join(', ') +
      (r.translucent ? ' [fwd]' : ''),
    );
  }
  return rows;
}
