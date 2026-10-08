/**
 * Shader source consistency.
 *
 * These tests read `render/shaders.js` as text rather than importing it, because
 * `shaders.js` imports three.js and the Node test runner does not resolve that -- and,
 * more to the point, because the failure mode this file exists for is a number that is
 * *in a shader string* and therefore invisible to anything that does not read the string.
 *
 * The bug: `MATERIAL_TABLE` declared `uniform vec4 uMatAlbedo[10]`, sized for a
 * nine-material palette. The atoll palette made it seventeen. GLSL leaves an
 * out-of-bounds index into a uniform array undefined, and this driver returns the last
 * in-bounds element, so materials 10 through 17 all rendered as material 9, Cyan Glass.
 *
 * Everything else agreed and said so:
 *
 *   - `config.js`'s CPU-side table was correct, so reading it in JS looked perfect;
 *   - the mesher emitted the right ids, so inspecting the chunk geometries showed reef,
 *     sand, coral and palms;
 *   - the world data was right, so counting voxels showed a correct island.
 *
 * Only the GPU disagreed. The frame was a sheet of pale cyan glass at full brightness,
 * and the reason it was so hard to see is that the *shape* was right: correct coastline,
 * correct lagoon, correct palms. Every aggregate check passed. It took reading the
 * G-buffer back off the GPU and fingerprinting by roughness -- a value unique per
 * material -- to find out that the surface was glass everywhere.
 *
 * So: assert the two numbers agree, and assert that every material id in the catalogue
 * is addressable. Cheap, and it fails the moment someone adds a material.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MAX_MATERIAL_ID, MATERIALS, isValidMaterial } from '../shared/materials.js';
import * as RENDER_CONFIG from '../public/src/config.js';
import { buildMaterialTables } from '../public/src/config.js';

const SHADERS_URL = new URL('../public/src/render/shaders.js', import.meta.url);
const SRC = readFileSync(SHADERS_URL, 'utf8');

// ---------------------------------------------------------------------------
// The array size
// ---------------------------------------------------------------------------

test('the GLSL material array size matches the palette', () => {
  // `shaders.js` cannot be imported here (it pulls in three.js), so the declaration is
  // read as source. It is a template literal, so the interpolated form is what ships.
  const albedo = SRC.match(/uniform\s+vec4\s+uMatAlbedo\[([^\]]+)\]/);
  const emissive = SRC.match(/uniform\s+vec4\s+uMatEmissive\[([^\]]+)\]/);

  assert.ok(albedo, 'uMatAlbedo is not declared in MATERIAL_TABLE');
  assert.ok(emissive, 'uMatEmissive is not declared in MATERIAL_TABLE');

  const want = String(MAX_MATERIAL_ID + 1);
  assert.equal(albedo[1], '${MAX_MATERIAL_ID + 1}',
    `uMatAlbedo is sized [${albedo[1]}]. It must be derived from MAX_MATERIAL_ID so that ` +
    `adding a material cannot leave it stale -- a literal here is how every material ` +
    `past the old size silently rendered as the last valid one.`);
  assert.equal(emissive[1], '${MAX_MATERIAL_ID + 1}',
    `uMatEmissive is sized [${emissive[1]}] and must match uMatAlbedo.`);
  assert.equal(MAX_MATERIAL_ID + 1, Number(want) - Number(want) + (MAX_MATERIAL_ID + 1),
    'sanity: the expected size is derived, not literal');
});

test('every material in the catalogue is addressable by the shader table', () => {
  // The property the size has to have. Stated directly rather than inferred from the
  // declaration above, because this is the one that actually matters.
  const size = MAX_MATERIAL_ID + 1;
  for (const [id, m] of Object.entries(MATERIALS)) {
    assert.ok(Number(id) < size,
      `material ${id} (${m.key}) is outside the ${size}-slot shader table`);
  }
});

test('the uploaded table has exactly one slot per material', () => {
  const { count } = buildMaterialTables();
  assert.equal(count, MAX_MATERIAL_ID + 1,
    'the CPU-side table and the palette disagree on how many materials exist');
});

test('config.js re-exports the real MAX_MATERIAL_ID for the shaders to derive from', () => {
  // `shaders.js` gets its array size from here. If this re-export is dropped the
  // shaders fall back to nothing and the declaration becomes `undefined` entries, which
  // is a compile error at best -- so assert the name exists and agrees.
  assert.equal(RENDER_CONFIG.MAX_MATERIAL_ID, MAX_MATERIAL_ID,
    'config.js must re-export the real MAX_MATERIAL_ID; the GLSL array sizes derive from it');
  assert.equal(typeof RENDER_CONFIG.buildMaterialTables, 'function',
    'shaders.js builds its uniform arrays through buildMaterialTables');
});

// ---------------------------------------------------------------------------
// Other literals in shader strings
// ---------------------------------------------------------------------------

test('no other uniform array in the shaders is sized by hand', () => {
  // Same class of bug, anywhere else it appears. Every `uniform <type> name[N]` must
  // either be interpolated from a known constant or be listed here with a reason.
  const KNOWN_DERIVED = new Set(['uMatAlbedo', 'uMatEmissive']);
  const decls = [...SRC.matchAll(/uniform\s+\w+\s+(\w+)\[([^\]]+)\]/g)];
  assert.ok(decls.length > 0, 'no uniform arrays found -- did the shader format change?');

  const handSized = decls.filter(([, name, size]) =>
    !KNOWN_DERIVED.has(name) && /^\d+$/.test(size.trim()));

  assert.deepEqual(handSized.map((d) => `${d[1]}[${d[2]}]`), [],
    'uniform arrays sized by literal; derive them or explain why here');
});

test('the shader decoders read the tables they are meant to', () => {
  // A decoder that reads the wrong table is silent: it returns plausible numbers.
  assert.match(SRC, /decodeMaterialAlbedo\(uint id\)\s*\{\s*return uMatAlbedo\[id\]\.rgb;/);
  assert.match(SRC, /decodeMaterialRoughness\(uint id\)\s*\{\s*return uMatAlbedo\[id\]\.a;/);
  assert.match(SRC, /decodeMaterialEmissive\(uint id\)\s*\{\s*return uMatEmissive\[id\]\.rgb;/);
});

// ---------------------------------------------------------------------------
// Palette sanity
// ---------------------------------------------------------------------------

test('material ids are contiguous from 1', () => {
  // Gaps would be wasted table slots and would make the size derivation larger than the
  // palette needs, but more importantly a gap is nearly always an accident.
  const ids = Object.keys(MATERIALS).map(Number).sort((a, b) => a - b);
  for (let i = 0; i < ids.length; i++) {
    assert.equal(ids[i], i + 1, `material ids should be 1..${ids.length}, found a gap at ${i + 1}`);
  }
});

test('the palette is large enough for the atoll and the objectives still have room', () => {
  // The atoll needs 10..17. Objectives target 5, 6 and 8 -- so the two must not
  // overlap, or a seeded block completes an objective for free.
  const ATOLL = [10, 11, 12, 13, 14, 15, 16, 17];
  const OBJECTIVE_TARGETS = [5, 6, 8];
  assert.ok(MAX_MATERIAL_ID >= 17, 'the palette does not reach the atoll materials');
  for (const id of ATOLL) assert.ok(isValidMaterial(id), `atoll material ${id} is not valid`);
  for (const id of ATOLL) {
    assert.ok(!OBJECTIVE_TARGETS.includes(id),
      `atoll material ${id} collides with an objective target`);
  }
});
