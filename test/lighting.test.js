/**
 * Lighting and palette regression tests.
 *
 * These exist because the previous revision of the lighting rig failed in a way that
 * nothing reported, twice, for different reasons.
 *
 * First: the rig was authored in sRGB hex with a `x90` ambient hack, and the visible
 * result was a flat blue disc.
 *
 * Second, and much more instructive: the rig was *fixed* -- authored in linear space,
 * with the sun and fill balanced -- and the fix was validated against a probe that
 * hardcoded `exposure = 1.0` when `CONFIG.exposure` is a different number. Every number
 * the palette was tuned against was therefore too optimistic, and the result was a
 * lagoon rendered at 255,255,255.
 *
 * So this file asserts on measured numbers, and it takes its measurements from
 * `tools/tone-probe.js` rather than from a local copy of the maths. A second
 * implementation of the tone chain is a second thing to be wrong: an earlier version of
 * this file had one, modelled only the deferred path, and so measured water -- which
 * renders entirely through the forward pass -- with the wrong formula.
 *
 * The metric that matters is the **lit/shadow ratio**. Voxel faces are flat-shaded: one
 * normal, one brightness. The only thing that shows form on a terraced surface is how
 * far a face pointing at the sun sits from one pointing away. A ratio near 1 is a flat
 * slab with the shape painted out.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MATERIALS } from '../shared/materials.js';
import { CONFIG } from '../public/src/config.js';
import {
  ENV, display, emissiveLinear, hexToLinear, lightOpaque, lightTranslucent,
} from '../tools/tone-probe.js';

const PIPELINE = readFileSync(
  new URL('../public/src/render/pipeline.js', import.meta.url), 'utf8');

/**
 * Light one material twice, through whichever chain actually renders it: a face square
 * to the sun, and the same block's shadowed side.
 */
function shadeMaterial(mat, env = ENV) {
  const translucent = mat.vis === 2;
  const emis = emissiveLinear(mat);
  const litLin = translucent
    ? lightTranslucent(env, mat.color, emis, 1)
    : lightOpaque(env, mat.color, { ndl: 1, ny: 1 });
  const shadeLin = translucent
    ? lightTranslucent(env, mat.color, emis, 0)
    : lightOpaque(env, mat.color, { ndl: 0, ny: 1 });
  const lit = display(litLin);
  const shade = display(shadeLin);
  return {
    lit: lit.mean,
    shadowed: shade.mean,
    litMax: lit.max,
    litLinear: Math.max(...litLin),
    shadowedLinear: Math.max(...shadeLin),
  };
}

const OPAQUE_PLAIN = Object.values(MATERIALS).filter(
  (m) => m.vis === 1 && !(m.emissiveIntensity > 0),
);

// ---------------------------------------------------------------------------
// The probe and the renderer must agree
// ---------------------------------------------------------------------------

test('the probe reads the real environment and the real exposure', () => {
  // If this fails, every number below is fiction. It is the check that would have caught
  // the exposure mismatch before a whole palette was tuned against it.
  assert.ok(Number.isFinite(CONFIG.exposure) && CONFIG.exposure > 0,
    `CONFIG.exposure is ${CONFIG.exposure}`);
  assert.equal(ENV.sunColor.length, 3);
  assert.ok(ENV.sunColor.every(Number.isFinite), 'sunColor has a non-numeric component');
  assert.ok(ENV.sunElevationDeg > 0 && ENV.sunElevationDeg < 90,
    `sun elevation ${ENV.sunElevationDeg} is not in the upper hemisphere`);
});

test('the environment is read from pipeline.js, not transcribed', () => {
  // Guards against the probe being quietly pointed at a copy. The sun's green channel
  // is a distinctive value; if it appears in the file, the read is real.
  const green = ENV.sunColor[1].toString();
  assert.ok(PIPELINE.includes(green),
    `pipeline.js does not contain sunColor green ${green} -- the probe is reading a copy`);
});

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

test('every opaque material keeps measurable form between lit and shadow', () => {
  // The dominant quality lever for this renderer. Voxel faces are flat-shaded: one
  // normal, one brightness. The contrast between a face pointing at the sun and one
  // pointing away is the *only* thing that communicates shape.
  //
  // 2.2 is the floor. Below that a face and its own shadow are within a quarter stop of
  // each other and the geometry flattens into a silhouette. Sand failed this at 1.24
  // when it was authored at a beach-photo 0xf2e4c9.
  const failures = [];
  for (const mat of OPAQUE_PLAIN) {
    const s = shadeMaterial(mat);
    const ratio = s.lit / s.shadowed;
    if (ratio < 2.2) {
      failures.push(`${mat.key} ${s.lit.toFixed(3)}/${s.shadowed.toFixed(3)} = ${ratio.toFixed(2)}`);
    }
  }
  assert.deepEqual(failures, [], `materials with no form: ${failures.join(', ')}`);
});

test('no opaque material is buried in the ACES shoulder', () => {
  // Past roughly 2.5 the tone curve is flat enough that doubling the light barely moves
  // the output, so shadows cast *onto* the surface vanish. Emissive materials are
  // excluded on purpose: being in the shoulder is what an emissive is for.
  const failures = [];
  for (const mat of OPAQUE_PLAIN) {
    const s = shadeMaterial(mat);
    if (s.litLinear > 2.8) failures.push(`${mat.key} at ${s.litLinear.toFixed(2)}`);
  }
  assert.deepEqual(failures, [], `buried in the shoulder: ${failures.join(', ')}`);
});

test('no opaque material is blown out to white', () => {
  // A tone curve needs headroom at the top or it cannot model anything up there. At
  // exposure 1.7 the sunlit sand measured 0.939 mean with red and green both clipped,
  // which is why exposure now sits at 1.25.
  for (const mat of OPAQUE_PLAIN) {
    const s = shadeMaterial(mat);
    assert.ok(s.litMax < 0.97,
      `${mat.key} peaks at ${s.litMax.toFixed(3)} -- no highlight headroom left`);
  }
});

test('sand is light enough to read as sand and dark enough to have form', () => {
  // Both halves, because both have been wrong. Too dark and the beach reads as mud; too
  // light and it reads as a blank slab. The window is narrow and it was found by
  // measurement, not by taste.
  const sand = MATERIALS[11];
  assert.equal(sand.key, 'sand', 'material 11 is no longer sand');
  const s = shadeMaterial(sand);
  assert.ok(s.litLinear < 2.0,
    `sunlit sand reaches ${s.litLinear.toFixed(2)} -- back in the shoulder`);
  assert.ok(s.lit > 0.68, `sand is too dark to read as sand (${s.lit.toFixed(3)})`);
  assert.ok(s.lit / s.shadowed > 2.2, 'sand has no form');
});

test('wet sand is clearly darker than dry sand', () => {
  // The tide edge has to be legible. At 0x9c8d70 the wet band measured only 8% below
  // the dry sand, which the tone curve compressed into invisibility.
  const dry = shadeMaterial(MATERIALS[11]);
  const wet = shadeMaterial(MATERIALS[10]);
  assert.ok(wet.lit < dry.lit * 0.88,
    `wet sand (${wet.lit.toFixed(3)}) is not clearly darker than dry (${dry.lit.toFixed(3)})`);
});

// ---------------------------------------------------------------------------
// The rig itself
// ---------------------------------------------------------------------------

test('the key light is far stronger than the fill', () => {
  // The comment in pipeline.js calls this "the whole ballgame" and it is right. With
  // the fill near the sun, every face lands within a stop of every other face and the
  // terrain reads as one flat disc no matter how the maths is arranged.
  const ratio = ENV.sunColor[1] / ENV.skyColor[1];
  assert.ok(ratio > 6, `key:fill is only ${ratio.toFixed(1)}:1 -- faces will not separate`);
  assert.ok(ratio < 24, `key:fill is ${ratio.toFixed(1)}:1 -- shadows will be crushed`);
});

test('a sun-facing wall is brighter than flat ground', () => {
  // The property that makes voxel terrain read as three-dimensional.
  //
  // A voxel world is horizontal terraces joined by vertical risers. A face's brightness
  // is its normal dotted with the sun, so the ratio between a wall facing the sun and a
  // flat tread is fixed by the sun's elevation alone -- and at 45 degrees it is exactly
  // 1.0, meaning every surface in the world is the same brightness and the geometry
  // disappears. That is worse than either extreme.
  //
  // Measured against the 51-degree sun this rig used to have:
  //
  //     60 deg   0.58x   walls nearly black beside the ground
  //     51 deg   0.81x   the ground wins -- the island read as a pale flat table
  //     45 deg   1.00x   no separation at all
  //     30 deg   1.70x   terraces separate
  //
  // Asserted rather than documented, because this one number silently undoes the entire
  // terrain generator and nothing else in the suite would notice.
  const wallNdl = Math.hypot(ENV.sunDir[0], ENV.sunDir[2]);
  const topNdl = ENV.sunDir[1];
  const ratio = wallNdl / topNdl;
  assert.ok(ratio > 1.15,
    `a sun-facing wall is only ${ratio.toFixed(2)}x a flat tread -- the terraces will not read`);
  assert.ok(ratio < 4.0,
    `a sun-facing wall is ${ratio.toFixed(2)}x a flat tread, so the ground will go black`);
});

test('the sun does not sit at the horizon or straight overhead', () => {
  // Both extremes are known failure modes. At the horizon, shadow cascades fitted to
  // the near range stretch every caster across most of a cascade's depth. At 90 degrees,
  // the raking light is gone and voxel terraces flatten into a silhouette.
  assert.ok(ENV.sunElevationDeg > 25,
    `sun at ${ENV.sunElevationDeg.toFixed(0)} deg -- too low for the cascades`);
  assert.ok(ENV.sunElevationDeg < 65,
    `sun at ${ENV.sunElevationDeg.toFixed(0)} deg -- too high, no raking form`);
});

test('the sky is brighter at the horizon than at the zenith', () => {
  // Tropical haze scatters along the ground far more than overhead. A dusk rig with a
  // muddy brown horizon inverts this and makes an ocean look like a desert.
  const horizon = ENV.skyHorizon.reduce((a, b) => a + b, 0);
  const zenith = ENV.skyZenith.reduce((a, b) => a + b, 0);
  assert.ok(horizon > zenith * 1.3,
    `horizon ${horizon.toFixed(2)} is not clearly brighter than zenith ${zenith.toFixed(2)}`);
});

test('the fog matches the horizon so the world does not end in a hard line', () => {
  // The world is a small island ringed by ocean, and the ocean is exactly the geometry
  // that has to fade rather than stop. A hard horizon edge gives the whole illusion away.
  for (let i = 0; i < 3; i++) {
    const delta = Math.abs(ENV.fogColor[i] - ENV.skyHorizon[i]);
    assert.ok(delta < 0.16, `fog and horizon differ by ${delta.toFixed(3)} in channel ${i}`);
  }
});

test('the sky is not empty', () => {
  // A near-black sky is the single most expensive thing the renderer can do: it is the
  // largest area on screen. This rig previously reached for a x90 multiplier instead of
  // fixing the space it was authored in.
  const zenith = ENV.skyZenith.reduce((a, b) => a + b, 0);
  assert.ok(zenith > 0.6, `sky zenith sums to ${zenith.toFixed(2)} -- nearly black`);
});

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

test('no material has a non-finite or out-of-gamut colour', () => {
  for (const [id, m] of Object.entries(MATERIALS)) {
    assert.ok(Number.isInteger(m.color) && m.color >= 0 && m.color <= 0xffffff,
      `material ${id} (${m.key}) has colour ${m.color}`);
  }
});

test('every opaque non-emissive material is in the renderable value band', () => {
  // Peak linear albedo below ~0.62. Above that a material needs a very dim sun to avoid
  // the shoulder, and then nothing else in the scene lights properly. Sand at 0.89, and
  // gold before its own fix, are the two that have been over.
  for (const mat of OPAQUE_PLAIN) {
    const peak = Math.max(...hexToLinear(mat.color));
    assert.ok(peak < 0.62,
      `${mat.key} has a linear albedo of ${peak.toFixed(2)} -- above the renderable band`);
  }
});

test('water is translucent and everything structural is opaque', () => {
  // Shallow water must be translucent or the sand under it -- the entire reason a
  // lagoon reads as a lagoon -- is never visible.
  assert.equal(MATERIALS[14].vis, 2, 'shallow water must be translucent');
  assert.equal(MATERIALS[15].vis, 2, 'deep water must be translucent');
  for (const id of [10, 11, 12, 13, 16, 17]) {
    assert.equal(MATERIALS[id].vis, 1, `material ${id} should be opaque`);
  }
});

test('shallow and deep water differ enough to read as depth', () => {
  // A narrow value band is what makes depth read as depth. Widening it turns a lagoon
  // into two unrelated colours.
  const shallow = shadeMaterial(MATERIALS[14]);
  const deep = shadeMaterial(MATERIALS[15]);
  const ratio = shallow.lit / deep.lit;
  assert.ok(ratio > 1.4,
    `shallow (${shallow.lit.toFixed(3)}) and deep (${deep.lit.toFixed(3)}) are too close`);
});

test('water is lit through the forward chain, not the deferred one', () => {
  // The forward pass is `uAmbient * 0.6 + uSunColor * ndl * 0.5` -- a different rig from
  // the deferred `uSunColor * ndl * shadow + hemi`. Measuring water with the deferred
  // formula is how this file previously concluded the two depths were too similar when
  // they were fine. Assert the two chains actually disagree, so the distinction stays
  // load-bearing rather than decorative.
  const deferred = lightOpaque(ENV, MATERIALS[14].color, { ndl: 1, ny: 1 });
  const forward = lightTranslucent(ENV, MATERIALS[14].color, emissiveLinear(MATERIALS[14]), 1);
  const delta = Math.abs(deferred[2] - forward[2]);
  assert.ok(delta > 0.02,
    `the two chains agree on water (delta ${delta.toFixed(4)}), so the distinction is moot`);
});
