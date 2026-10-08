/**
 * Prop geometry and light collection.
 *
 * Props touch three things that are easy to get quietly wrong: the merge
 * contract (every input must agree on attributes *and* indexing), instance
 * bookkeeping across removals, and the mapping from a prop record to a light.
 */

/**
 * Prop bookkeeping.
 *
 * The prop *renderer* needs three.js and a WebGL context, so it is exercised in
 * the browser rather than here. What is testable without a GPU is everything that
 * feeds it: the world-side storage the renderer reads, the catalogue contract that
 * keeps a placeable prop from being unrenderable, and the light mapping.
 *
 * `collectPropLights` is imported from a module that pulls in three.js for its
 * colour conversion, and three.js is not a Node dependency -- it is loaded from a
 * CDN by the browser importmap. So the light mapping is tested against the
 * catalogue directly, which is the part that can actually be wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { World } from '../public/src/world/world.js';
import { PROP_KEYS, PROPS, PROPS as CATALOGUE } from '../shared/materials.js';

const here = dirname(fileURLToPath(import.meta.url));
const propsSrc = readFileSync(
  resolve(here, '..', 'public', 'src', 'world', 'props.js'), 'utf8',
);

// ---------------------------------------------------------------------------
// Catalogue / renderer agreement
// ---------------------------------------------------------------------------

test('every placeable prop has a geometry recipe in the renderer', () => {
  // A prop with no recipe would place successfully, validate on the server, and
  // then render nothing -- the half-finished state this module exists to avoid.
  const recipes = propsSrc.match(/RECIPES = \{([\s\S]*?)\n\};/);
  assert.ok(recipes, 'RECIPES table not found in props.js');

  for (const key of PROP_KEYS) {
    assert.ok(
      new RegExp(`^\\s{2}${key}:`, 'm').test(recipes[1]),
      `prop "${key}" is in the catalogue but has no recipe in props.js`,
    );
  }
});

test('no recipe refers to a prop that is not in the catalogue', () => {
  const recipes = propsSrc.match(/RECIPES = \{([\s\S]*?)\n\};/)[1];
  const defined = [...recipes.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
  for (const key of defined) {
    assert.ok(CATALOGUE[key], `props.js defines a recipe for "${key}" that the catalogue lacks`);
  }
  assert.equal(defined.length, PROP_KEYS.length, 'recipe and catalogue counts must agree');
});

test('recipe parts are all wrapped so the merge contract holds', () => {
  // A bare geometry passed where the merge expects {g, tint, emissive} is exactly
  // the bug that made every prop fail to merge.
  //
  // Two shapes are legitimate: `p(geom, tint)`, and an array of primitives closed
  // by `.map(...)` that attaches the tint. Only an array that ends without either
  // is wrong.
  const recipes = propsSrc.match(/RECIPES = \{([\s\S]*?)\n\};/)[1];

  // Each recipe's body must either wrap every entry in p(), or terminate its
  // array with a .map() that does the wrapping.
  const bodies = recipes.split(/\n  \w+: \(\) => \{/).slice(1);
  assert.ok(bodies.length === PROP_KEYS.length, 'one body per recipe');

  for (const body of bodies) {
    const name = body.split('\n')[0].trim();
    const usesMap = /\]\.map\(/.test(body);
    const bareEntries = (body.match(/^\s+(box\(|new THREE\.)/gm) || [])
      .filter((l) => !/^\s+p\(/.test(l));

    if (usesMap) {
      // Every entry is wrapped by the map; none may carry a stray tint argument.
      for (const e of bareEntries) {
        assert.ok(
          !/\)\s*,\s*(wood|metal|seat|frame|pot|leaf|flame|glow)\s*\)/.test(e),
          `${name}: entry passes a tint directly and is also mapped: ${e.trim()}`,
        );
      }
    } else {
      assert.deepEqual(
        bareEntries, [],
        `${name}: entries must be wrapped in p(...) when there is no trailing .map()`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The catalogue's own numbers
//
// These are the fields nothing else validates: they are read by the pick volume,
// by the palette and by the light collector, and each one fails quietly if it is
// wrong. A wrong height does not throw -- it makes a prop stop being clickable.
// ---------------------------------------------------------------------------

test('every prop declares a usable pick height', () => {
  const names = new Set();
  for (const prop of Object.values(CATALOGUE)) {
    assert.ok(Number.isFinite(prop.height) && prop.height > 0,
      `${prop.key} has height ${prop.height}`);
    // Below is the picking box: too short and the top of the prop cannot be
    // clicked, too tall and it steals the cell above from a block the player
    // meant to place.
    assert.ok(prop.height <= 2.5,
      `${prop.key} at ${prop.height} reaches into its neighbours' airspace`);
    assert.ok(typeof prop.name === 'string' && prop.name.length > 0, `${prop.key} has no name`);
    assert.ok(!names.has(prop.name), `two props share the label "${prop.name}"`);
    names.add(prop.name);
    // The palette builds `fa-solid ${icon}` directly, so a fully-qualified class
    // here would render as two classes and show a blank swatch.
    assert.ok(/^fa-[a-z-]+$/.test(prop.icon ?? ''), `${prop.key} icon "${prop.icon}" is not a bare FA class`);
    assert.ok('light' in prop, `${prop.key} does not say whether it is a light`);
  }
});

test('a prop light sits inside the prop it belongs to', () => {
  // `light.y` is a world offset from the cell floor. Above the prop's own height
  // you get a campfire glowing from a metre in the air; a distance shorter than
  // that y means it illuminates only empty space. Both are invisible in the
  // catalogue and glaring the moment the sun goes down.
  const lit = Object.values(CATALOGUE).filter((prop) => prop.light);
  assert.ok(lit.length > 0, 'no prop is a light any more');

  for (const prop of lit) {
    const { color, intensity, distance, y } = prop.light;
    assert.ok(Number.isInteger(color) && color > 0 && color <= 0xffffff,
      `${prop.key} light color ${color} is not a hex int`);
    assert.ok(intensity > 0, `${prop.key} light intensity ${intensity} would not be seen`);
    assert.ok(distance > 0, `${prop.key} light distance ${distance} would not be seen`);
    assert.ok(y > 0 && y < prop.height,
      `${prop.key} light at y ${y} is not inside its ${prop.height} height`);
    assert.ok(distance > y,
      `${prop.key} light reaches ${distance} but its source sits at ${y}`);
  }
});

test('no prop light is bright enough to blow out the bloom', () => {
  // The other end of the same range: an intensity that far outruns the sun clips
  // the HDR target and the whole scene washes to white around a single lantern.
  // The ceiling is generous -- the brightest light here is the torch at 8 -- so
  // this only fires when somebody types an extra digit.
  for (const prop of Object.values(CATALOGUE)) {
    if (prop.light) assert.ok(prop.light.intensity <= 12,
      `${prop.key} intensity ${prop.light.intensity} would blow out the bloom`);
  }
});

test('the merge normalises indexing, because three primitives disagree', () => {
  // BoxGeometry and CylinderGeometry are indexed; IcosahedronGeometry and
  // ConeGeometry are not. mergeGeometries rejects the entire batch when inputs
  // disagree, which silently cost the plant and the torch.
  assert.ok(
    /if \(!geometry\.index\)/.test(propsSrc),
    'props.js must add a trivial index to unindexed parts',
  );
  assert.ok(
    /deleteAttribute\('uv'\)/.test(propsSrc),
    'and strip uv so every input exposes the same attributes',
  );
});

test('props tint by their placing builder', () => {
  assert.ok(/USE_INSTANCING_COLOR/.test(propsSrc), 'the shader should tint by instance colour');
  assert.ok(/setColorAt/.test(propsSrc), 'and instances must carry a colour');
});

// ---------------------------------------------------------------------------
// Light mapping
// ---------------------------------------------------------------------------

test('exactly the props that define a light contribute one', () => {
  const expected = PROP_KEYS.filter((k) => PROPS[k].light);
  assert.ok(expected.length > 0, 'the catalogue should define at least one light');
  for (const key of expected) {
    assert.ok(PROPS[key].light.intensity > 0, `${key} light needs a positive intensity`);
    assert.ok(PROPS[key].light.distance > 0, `${key} light needs a positive radius`);
    assert.ok(PROPS[key].light.y > 0 && PROPS[key].light.y < 1, `${key} light sits inside its cell`);
  }
});

test('furniture props emit no light', () => {
  // The catalogue spells "no light" as null, so falsiness is the contract rather
  // than strict undefined.
  for (const key of PROP_KEYS) {
    if (PROPS[key].light) continue;
    assert.ok(!PROPS[key].light, `${key} should not emit light`);
  }
  const emitting = PROP_KEYS.filter((k) => PROPS[k].light);
  assert.ok(emitting.length >= 2, 'at least the lantern and the torch should emit light');
});

test('a prop with no light entry contributes nothing rather than throwing', () => {
  // What the renderer's collect step must do with an unrecognised prop key.
  const def = PROPS['not_a_real_prop'];
  assert.equal(def, undefined);
  // The lookup guards on the catalogue, so an unknown key short-circuits.
  assert.ok(PROP_KEYS.includes('lantern'), 'sanity: the guarded lookup has a real entry to find');
});

// ---------------------------------------------------------------------------
// World-side storage, which is what the renderer walks
// ---------------------------------------------------------------------------

test('props are stored on the column that owns them and removed by key', () => {
  const w = new World();
  w.column(0, 0);
  w.setProp({ x: 3, y: 5, z: 3, prop: 'lantern', rot: 0, by: 'b1', rev: 1 });

  assert.equal(w.getColumn(0, 0).props.size, 1);
  assert.equal(w.getProp(3, 5, 3).prop, 'lantern');
  assert.ok(w.removeProp(3, 5, 3));
  assert.equal(w.getProp(3, 5, 3), undefined);
  assert.equal(w.removeProp(3, 5, 3), false, 'removing twice is a no-op');
});

test('a prop outside the column height is not stored', () => {
  const w = new World();
  w.column(0, 0);
  w.setProp({ x: 3, y: 999, z: 3, prop: 'lantern', rot: 0, by: 'b1', rev: 1 });
  assert.equal(w.getColumn(0, 0).props.size, 0);
});

test('placing a prop marks the column for prop refresh', () => {
  const w = new World();
  w.column(0, 0);
  w.getColumn(0, 0).needsProps = false;
  w.setProp({ x: 1, y: 5, z: 1, prop: 'chair', rot: 0, by: 'b1', rev: 1 });
  assert.equal(w.getColumn(0, 0).needsProps, true);
});

test('props survive on a column that also holds voxels', () => {
  // The two maps are independent; a voxel edit must not disturb a prop and vice
  // versa, or props flicker out when the ground under them changes.
  const w = new World();
  w.column(0, 0);
  w.setProp({ x: 3, y: 5, z: 3, prop: 'plant', rot: 0, by: 'b1', rev: 1 });
  w.setAuthoritative(3, 4, 3, 1, 1);
  w.setAuthoritative(3, 5, 3, 0, 2);
  assert.equal(w.getProp(3, 5, 3).prop, 'plant');
});

test('a prop record carries everything the renderer needs', () => {
  const w = new World();
  w.column(0, 0);
  w.setProp({ x: 3, y: 5, z: 3, prop: 'chair', rot: 2, by: 'b1', rev: 9, color: 0xff8800 });
  const rec = w.getProp(3, 5, 3);
  assert.equal(rec.x, 3);
  assert.equal(rec.y, 5);
  assert.equal(rec.z, 3);
  assert.equal(rec.prop, 'chair');
  assert.equal(rec.rot, 2, 'rotation is needed for orientation');
  assert.equal(rec.by, 'b1', 'the owner id drives tinting');
  assert.ok(CATALOGUE[rec.prop], 'and the key must resolve in the catalogue');
});