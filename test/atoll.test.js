/**
 * Atoll terrain generation.
 *
 * The tests are mostly about relationships that must hold -- the lagoon shallower than
 * the ocean, dry land above the waterline -- rather than exact numbers, because the
 * profile is meant to be retunable and the shape is meant to survive that.
 *
 * Two of these exist because the first version of the island was wrong in ways nothing
 * reported: the noise hash collapsed to a single sign, so there were no palms and no
 * coral, and the surface statistics counted buried volume. Both produced a plausible
 * island and both are now asserted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateIsland, columnAt, profileHeight, noise2, SEA_LEVEL, BAY, ATOLL_MATERIALS,
  SEED_CEILING, LAGOON_EDGE, PALM_MAX_GROUND, PALM_SPACING,
} from '../shared/atoll.js';
import { MAX_MATERIAL_ID, isValidMaterial } from '../shared/materials.js';

const M = ATOLL_MATERIALS;

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

test('noise2 spans both signs', () => {
  // The bug: the hash mixed with plain float multiplies, so `seed * 2147483647`
  // overflowed past 2^53 and lost the low bits the output depended on. Measured range
  // was -0.996 to -0.004 -- never positive. Every palm and coral placement gates on a
  // positive value, so the island generated with none of either and nothing errored.
  let min = Infinity, max = -Infinity;
  for (let x = -40; x < 40; x += 0.7) {
    for (let z = -40; z < 40; z += 0.7) {
      const v = noise2(x / 7, z / 7, 4242);
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  assert.ok(min < -0.3, `noise never goes clearly negative (min ${min})`);
  assert.ok(max > 0.3, `noise never goes clearly positive (max ${max})`);
});

test('noise2 stays inside its stated range', () => {
  for (let x = -20; x < 20; x += 0.31) {
    for (let z = -20; z < 20; z += 0.31) {
      const v = noise2(x, z, 7);
      assert.ok(v >= -1 && v <= 1, `noise2 returned ${v}`);
    }
  }
});

test('noise2 is deterministic for a seed and differs between seeds', () => {
  // Determinism is what makes the generator testable at all -- and what lets a
  // rollback to a previous world reproduce its island.
  assert.equal(noise2(1.5, 2.5, 99), noise2(1.5, 2.5, 99));
  const a = noise2(1.5, 2.5, 99);
  const b = noise2(1.5, 2.5, 100);
  assert.notEqual(a, b, 'different seeds should differ');
});

test('a large seed does not break the hash', () => {
  // The overflow needed a seed above about 3 to show up, which is why a small default
  // hid it.
  for (const seed of [1, 3, 1337, 4242, 99991]) {
    const v = noise2(3.3, 4.4, seed);
    assert.ok(Number.isFinite(v), `seed ${seed} produced ${v}`);
  }
  const v = noise2(3.3, 4.4, 99991);
  assert.ok(v > -1 && v < 1);
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

test('the profile rises at the centre and falls outward', () => {
  assert.ok(profileHeight(0) > profileHeight(20), 'the cay is higher than the lagoon');
  assert.ok(profileHeight(20) > profileHeight(45), 'the lagoon floor is above the ocean floor');
});

test('the profile falls to the lagoon and the reef shelf stays submerged', () => {
  // There is one deliberate rise: the reef shelf at 34, which is what makes an atoll
  // an atoll. So the shape is not monotonic and should not be asserted as such --
  // the earlier version of this test failed on exactly that rise and was wrong to.
  //
  // What has to hold is that the fall is monotonic *up to* the reef, and that the reef
  // never surfaces into a second island.
  for (let d = 15; d <= 30; d += 1) {
    assert.ok(profileHeight(d) <= profileHeight(d - 1) + 0.001,
      `profile rose before the reef at ${d} units`);
  }
  assert.ok(profileHeight(34) > profileHeight(30), 'the reef shelf should rise');
  assert.ok(profileHeight(34) < SEA_LEVEL, 'but stay submerged -- no second island');
  assert.ok(profileHeight(45) < profileHeight(34), 'and fall away again beyond it');
});

test('the lagoon floor is shallow enough to see through', () => {
  // The whole appeal of a lagoon is the sand visible under turquoise water. A floor
  // deep enough to go black would just be dark water.
  assert.ok(profileHeight(24) >= SEA_LEVEL - 4,
    `lagoon floor at ${profileHeight(24)} is too deep to read as shallow`);
});

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

test('the centre is dry land above the waterline', () => {
  const c = columnAt(0, 0);
  assert.ok(c.top > SEA_LEVEL, 'the cay crown is above water');
  assert.equal(c.water, 0, 'and has no water on it');
  assert.equal(c.mat, M.SAND);
});

test('dry land is dry and the lagoon is not', () => {
  let sawDry = false, sawLagoon = false, sawOcean = false;
  for (let d = 0; d <= 38; d += 1) {
    for (const z of [-30, -12, 0, 9, 21, 33]) {
      const c = columnAt(d, z);
      if (c.top > SEA_LEVEL) sawDry = true;
      else if (c.waterTop === M.WATER_SHALLOW) sawLagoon = true;
      else sawOcean = true;
    }
  }
  assert.ok(sawDry, 'no dry land found');
  assert.ok(sawLagoon, 'no shallow lagoon found');
  assert.ok(sawOcean, 'no deep ocean found');
});

test('water sits above the seabed and nowhere else', () => {
  // A column with water but no seabed under it would be a floating sheet.
  for (let x = -30; x <= 30; x += 3) {
    for (let z = -30; z <= 30; z += 3) {
      const c = columnAt(x, z);
      assert.ok(c.height >= 1, `column ${x},${z} has no ground`);
      if (c.water > 0) {
        assert.ok(c.height < SEA_LEVEL, `column ${x},${z} has water above dry land`);
        assert.equal(c.height + c.water, SEA_LEVEL, 'the surface is flat at sea level');
      }
    }
  }
});

test('every emitted material is in the catalogue', () => {
  // The server validates against this table, so an unknown id would be refused at
  // commit and the island would silently generate nothing.
  const isl = generateIsland(20);
  for (const [, , , m] of isl.blocks) assert.ok(isValidMaterial(m), `unknown material ${m}`);
  for (const [, , , m] of isl.water) assert.ok(isValidMaterial(m), `unknown water material ${m}`);
  assert.ok(MAX_MATERIAL_ID >= M.REEF, 'the catalogue is large enough for the atoll palette');
});

test('no column exceeds the world height', () => {
  for (let x = -38; x <= 38; x += 3) {
    for (let z = -38; z <= 38; z += 3) {
      const c = columnAt(x, z);
      assert.ok(c.top < 48, `column ${x},${z} reaches y=${c.top}`);
    }
  }
});

test('the island is not a perfect disc', () => {
  // A radial island reads as a plate, not a place. The wobble has to actually reach the
  // waterline.
  let min = Infinity, max = -Infinity;
  for (let a = 0; a < 360; a += 2) {
    const r = Math.PI * (a / 180);
    let edge = 0;
    for (let d = 4; d <= 34; d += 1) {
      const c = columnAt(Math.round(Math.cos(r) * d), Math.round(Math.sin(r) * d));
      if (c.top <= SEA_LEVEL) { edge = d; break; }
    }
    if (edge) { min = Math.min(min, edge); max = Math.max(max, edge); }
  }
  assert.ok(max - min >= 3,
    `the coastline varies by only ${max - min} units, so the island is a disc`);
});

// ---------------------------------------------------------------------------
// The bay
// ---------------------------------------------------------------------------

test('the bay cuts water into the beach', () => {
  // What a bay has to do: the ground at the bay's centre must be *lower than the terrain
  // would otherwise be*, and at or below the waterline, while the land behind it still
  // rises to the crown.
  //
  // The earlier version compared the coastline along the bay's axis against the opposite
  // axis and demanded the bay direction reach water sooner. That measured the wrong
  // thing -- the bay sits at the waterline, so both rays hit water at roughly the same
  // radius, and the test failed while the bay was working. It had also passed by
  // accident when the bay was a lagoon hole two units offshore, because that hole was
  // water too.
  const atBay = columnAt(BAY.x, BAY.z);
  const natural = profileHeight(Math.hypot(BAY.x, BAY.z));
  assert.ok(atBay.height < natural,
    `the bay centre is at ${atBay.height}, unchanged from the bare profile's ${natural} -- it cuts nothing`);
  assert.ok(atBay.top <= SEA_LEVEL,
    `the bay centre stands ${atBay.top - SEA_LEVEL} above the waterline -- a sandbar, not a bay`);

  // And the island behind it is still an island.
  const inland = columnAt(Math.round(BAY.x * 0.3), Math.round(BAY.z * 0.3));
  assert.ok(inland.top > SEA_LEVEL + 2,
    `the cay behind the bay only reaches ${inland.top} -- the bay has eaten the island`);
  const r = Math.hypot(BAY.x, BAY.z);
  assert.ok(r > 8 && r < 20, `the bay sits at r=${r.toFixed(1)}, which is nowhere near a coast`);
});

test('water runs out of the bay rather than into it', () => {
  // The seaward direction has to stay at or below sea level all the way out, and the
  // landward direction has to rise. Measured before this was right: walking *out* from
  // the bay the ground rose 7 -> 10, which is a headland pointing out to sea.
  const r = Math.hypot(BAY.x, BAY.z) || 1;
  const ux = BAY.x / r, uz = BAY.z / r;
  const seaward = [], landward = [];
  for (let d = 0; d <= 22; d += 2) {
    seaward.push(columnAt(Math.round(BAY.x + ux * d), Math.round(BAY.z + uz * d)).top);
    landward.push(columnAt(Math.round(BAY.x - ux * d), Math.round(BAY.z - uz * d)).top);
  }
  assert.ok(Math.max(...seaward) <= SEA_LEVEL,
    `the coast rises to ${Math.max(...seaward)} on the bay's seaward axis -- a headland, not a bay`);
  assert.ok(Math.max(...landward) > SEA_LEVEL + 2,
    `the land behind the bay only reaches ${Math.max(...landward)} -- the bay is open sea`);
});

test('the bay has a floor rather than being a hole', () => {
  const c = columnAt(BAY.x, BAY.z);
  assert.ok(c.height >= 1, 'the bay has a seabed');
});

// ---------------------------------------------------------------------------
// Whole island
// ---------------------------------------------------------------------------

test('the island has dry land, a lagoon and an ocean in sensible proportion', () => {
  // An atoll that is 90% ocean is just an ocean with a bump on it. The buildable island
  // has to be a real share of the playable area.
  const { stats } = generateIsland(38);
  const total = stats.dryLand + stats.lagoon + stats.ocean;
  const dryFrac = stats.dryLand / total;
  assert.ok(dryFrac > 0.04, `only ${(dryFrac * 100).toFixed(1)}% is dry land`);
  assert.ok(dryFrac < 0.35, `${(dryFrac * 100).toFixed(1)}% dry land is not an island`);
  assert.ok(stats.lagoon > stats.dryLand, 'the lagoon should be bigger than the cay');
});

test('the lagoon occupies the middle and deep water frames it', () => {
  // Not "lagoon beats ocean" as a raw count -- that depends on where the world's edge
  // falls, and the playable disc is wider than the lagoon ring by construction. What
  // has to be true is the *shape*: the lagoon is the centre of the frame, not a fringe.
  const { stats } = generateIsland(38);
  const lagoonShare = stats.lagoon / (stats.dryLand + stats.lagoon + stats.ocean);
  assert.ok(lagoonShare > 0.28,
    `the lagoon is only ${(lagoonShare * 100).toFixed(0)}% of the water and land`);
  // And every deep-water column is further out than every lagoon column, which is the
  // property that makes it read as a ring rather than as scattered patches.
  let maxLagoonR = 0, minOceanR = Infinity;
  for (let x = -38; x <= 38; x++) {
    for (let z = -38; z <= 38; z++) {
      const c = columnAt(x, z);
      if (c.top > SEA_LEVEL) continue;
      const d = Math.hypot(x, z);
      if (c.waterTop === M.WATER_SHALLOW) maxLagoonR = Math.max(maxLagoonR, d);
      else minOceanR = Math.min(minOceanR, d);
    }
  }
  assert.ok(minOceanR >= maxLagoonR - 2,
    `deep water appears at ${minOceanR.toFixed(0)} but lagoon reaches ${maxLagoonR.toFixed(0)}`);
});

test('there are palms and coral', () => {
  // The regression this whole section exists for. With the broken hash both were zero
  // and the island still generated.
  const { stats } = generateIsland(38);
  assert.ok(stats.palm > 20, `only ${stats.palm} palm blocks`);
  assert.ok(stats.leaf > 20, `only ${stats.leaf} frond blocks`);
  assert.ok(stats.coral > 50, `only ${stats.coral} coral columns`);
});

test('palms stand on dry sand, above the waterline', () => {
  // A palm growing out of the lagoon would be the single most obvious sign the theme
  // change was bolted on rather than generated.
  const isl = generateIsland(30);
  let checked = 0;
  for (const [x, y, z, m] of isl.blocks) {
    if (m !== M.PALM) continue;
    const ground = columnAt(x, z);
    // The first palm block sits exactly one above the ground surface.
    assert.ok(y >= ground.height, `palm block at ${x},${y},${z} is below the ground (${ground.height})`);
    assert.ok(ground.top > SEA_LEVEL, `palm at ${x},${z} stands in water`);
    checked++;
  }
  assert.ok(checked > 20, `only checked ${checked} palm blocks`);
});

test('surface statistics describe the surface, not the volume', () => {
  // The first version tallied every emitted cell, so `wet` came out at 12,151 against
  // 537 for dry sand -- because buried seabed is deliberately filled with wet sand.
  // Correct numbers, useless ones: they described the interior.
  //
  // This used to assert `dryLand === sand`, on the reasoning that the cay is beach and
  // nothing else. Crown scrub broke that: a flat expanse of one material reads as a pale
  // plate however correctly it is lit, so the crown now carries patches of vegetation.
  // The property worth keeping is narrower -- the dry land is *beach*, made of dry
  // surface materials, with no submerged rock showing through above the waterline.
  const { stats } = generateIsland(38);
  assert.equal(stats.dryLand, stats.sand + stats.scrub,
    'a dry column is either dry sand or crown scrub, and nothing else');
  // Every column the generator considered lands in exactly one of the three buckets.
  // The deep-ocean cap beyond the reef edge means this is not simply the square's
  // area, so it is checked against a recount rather than a constant.
  let columns = 0;
  for (let x = -38; x <= 38; x++) for (let z = -38; z <= 38; z++) columns++;
  assert.equal(stats.dryLand + stats.lagoon + stats.ocean, columns,
    'dry/lagoon/ocean must partition every column exactly once');
  assert.ok(stats.scrub > 40, `only ${stats.scrub} columns of crown scrub`);
  assert.ok(stats.scrub < stats.dryLand * 0.5,
    `${stats.scrub} of ${stats.dryLand} dry columns are scrub -- it is no longer a beach`);
  assert.ok(stats.sand < 1500, `dry sand surface of ${stats.sand} columns is implausibly large`);
  assert.ok(stats.sand > 200, `only ${stats.sand} columns of dry land`);
});

test('water is only emitted where there is water to see', () => {
  // Storing the invisible cells beneath the surface tripled the water cost across the
  // whole ocean for no visual difference.
  //
  // Beyond the ocean edge `columnAt` still reports the profile's water depth, because
  // it answers "what would the terrain be here" -- but the generator emits a single
  // flat cell out there and nothing else. So the assertion is on *emission*, not on
  // what the column reports.
  const { water, stats } = generateIsland(38);
  assert.equal(water.length, stats.waterCells);

  // One cell per column, everywhere.
  const perColumn = new Map();
  for (const [x, , z] of water) {
    const k = `${x},${z}`;
    perColumn.set(k, (perColumn.get(k) || 0) + 1);
  }
  for (const [k, n] of perColumn) {
    assert.equal(n, 1, `column ${k} emitted ${n} water cells`);
  }
  assert.ok(perColumn.size > 1000, 'the lagoon is missing');
});

test('water always sits at the sea surface', () => {
  // A water cell at any other height would be a floating sheet.
  const { water } = generateIsland(38);
  for (const [x, y, z] of water) {
    assert.equal(y, SEA_LEVEL - 1,
      `water at ${x},${y},${z} is not at the surface (${SEA_LEVEL - 1})`);
  }
});

test('no column sits on the waterline without water on it', () => {
  // A column at exactly `SEA_LEVEL` reports `top <= SEA_LEVEL` while carrying
  // `water === 0`. Any consumer testing "is this submerged" gets `true` for a column
  // with nothing on top of it -- measured at 311 columns, all of them strays pushed
  // down to exactly the waterline rather than below it.
  for (let x = -38; x <= 38; x++) {
    for (let z = -38; z <= 38; z++) {
      const c = columnAt(x, z);
      if (c.top <= SEA_LEVEL) {
        assert.ok(c.water > 0, `column ${x},${z} is at the surface with no water cell`);
      }
    }
  }
});

test('the island is one island, with sandbars rather than confetti', () => {
  // The wobble lifts individual seabed columns clear of the waterline, which scattered
  // the lagoon with lone sand blocks. Requiring two above-water neighbours removes the
  // specks, but genuine sandbars -- including the bay's inner lip -- survive, and a
  // couple of small islands is what an atoll actually looks like.
  //
  // What must hold is that one island dominates absolutely. If the main component ever
  // drops below half the dry land, the coast has been carved in two and the bots'
  // quadrants are on separate islands.
  const dry = new Set();
  for (let x = -38; x <= 38; x++) {
    for (let z = -38; z <= 38; z++) {
      if (columnAt(x, z).top > SEA_LEVEL) dry.add(`${x},${z}`);
    }
  }
  assert.ok(dry.size > 200, `only ${dry.size} columns of dry land`);

  const seen = new Set();
  const components = [];
  for (const k of dry.keys()) {
    if (seen.has(k)) continue;
    const stack = [k];
    const comp = [];
    seen.add(k);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      const [x, z] = cur.split(',').map(Number);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = `${x + dx},${z + dz}`;
        if (dry.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    components.push(comp);
  }
  components.sort((a, b) => b.length - a.length);
  const mainShare = components[0].length / dry.size;
  assert.ok(mainShare > 0.85,
    `the largest island is only ${(mainShare * 100).toFixed(0)}% of the dry land`);
  assert.ok(components.length <= 8,
    `${components.length} separate pieces of dry land -- the lagoon is full of confetti`);
});

test('the bay opens to the sea rather than sitting behind the beach', () => {
  // Walking out from the bay centre must not rise. An earlier version measured exactly
  // that and got 7 -> 10: the bite was a headland pointing out to sea, the precise
  // inverse of a bay. That test also had the axis negated, so it was walking *inland*
  // while claiming to walk seaward.
  const r = Math.hypot(BAY.x, BAY.z) || 1;
  const ux = BAY.x / r, uz = BAY.z / r;
  const heights = [];
  for (let d = 0; d <= 20; d += 2) {
    heights.push(columnAt(Math.round(BAY.x + ux * d), Math.round(BAY.z + uz * d)).top);
  }
  assert.ok(heights[0] <= SEA_LEVEL, 'the bay itself is not water');
  assert.ok(Math.max(...heights) <= SEA_LEVEL,
    `the coast rises to ${Math.max(...heights)} along the bay mouth -- a headland, not a bay`);
});

test('the seed does not hand out any objective for free', () => {
  // The gold dais used to complete two of eight objectives before anyone joined, and
  // the first version of the island did the same to `beacon`: palms on a cay crown at
  // 9 reached y=16 against a goal of 12, so the objective was already done at boot.
  //
  // Height is measured the way `scanWorld` measures it -- the longest *contiguous*
  // run of non-air -- which is why the solid seabed matters: a standing column inherits
  // its full depth without a player touching it.
  const isl = generateIsland(38);
  const top = new Map();
  for (const [x, y, z] of isl.blocks) top.set(`${x},${z}`, Math.max(top.get(`${x},${z}`) ?? 0, y));
  for (const [x, y, z] of isl.water) top.set(`${x},${z}`, Math.max(top.get(`${x},${z}`) ?? 0, y));
  let tallest = 0;
  for (const y of top.values()) tallest = Math.max(tallest, y);
  assert.ok(tallest < 12,
    `the seed reaches y=${tallest}, so "The Beacon" (12 tall) is complete at boot`);
  assert.ok(tallest <= SEED_CEILING, `the seed exceeds its stated ceiling of ${SEED_CEILING}`);

  // And the one-block margin is exactly the margin claimed: a player standing on the
  // cay must still have to build.
  assert.equal(SEED_CEILING, 11, 'the ceiling should sit one below the beacon goal');
});

test('the seed contains no material an objective targets', () => {
  // `something_gold` and `gold_ten` target material 6; `neon_night` targets 5 and 8.
  // The atoll palette is 10-17 precisely so it cannot collide with those -- which is
  // why the atoll needed new ids rather than retinting stone and slate.
  const TARGETED = new Set([5, 6, 8]);
  const isl = generateIsland(38);
  for (const [, , , m] of isl.blocks) {
    assert.ok(!TARGETED.has(m), `the seed contains objective material ${m}`);
  }
  for (const [, , , m] of isl.water) {
    assert.ok(!TARGETED.has(m), `the seed contains objective water material ${m}`);
  }
});

test('palms are separated enough to read as separate trees', () => {
  // The crowns are three wide. Any two palms closer than that fully merge, and a grove
  // becomes a single green field with no trunks visible at all -- which is exactly what
  // the first version looked like, because placement tested the grove noise per column
  // and every qualifying column inside a grove planted a tree.
  //
  // Spacing was first implemented as `floor(x/2), floor(z/2)` patch keys, which looked
  // equivalent and was not: that puts (2,2) and (3,3) in different patches, and the
  // closest pair came out 1.0 blocks apart. Hence an exact Chebyshev test.
  const isl = generateIsland(38);
  const trunks = new Map();
  for (const [x, y, z, m] of isl.blocks) {
    if (m !== M.PALM) continue;
    const k = `${x},${z}`;
    trunks.set(k, Math.max(trunks.get(k) ?? 0, y));
  }
  const pts = [...trunks.keys()].map((k) => k.split(',').map(Number));
  assert.ok(pts.length > 10, `only ${pts.length} palms on the island`);

  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const gap = Math.max(Math.abs(pts[i][0] - pts[j][0]), Math.abs(pts[i][1] - pts[j][1]));
      assert.ok(gap >= PALM_SPACING,
        `palms at ${pts[i]} and ${pts[j]} are ${gap} apart; crowns are 3 wide`);
    }
  }
});

test('palms grow on the beach, not on the crown', () => {
  // The crown is the buildable ground -- where players work and where all four bot
  // districts anchor. Planting it with trees obstructs exactly what the terrain generator
  // exists to provide, and palms up there are also what pushed the seed to y=16 and
  // handed out the `beacon` objective for free.
  for (const [x, y, z, m] of generateIsland(30).blocks) {
    if (m !== M.PALM) continue;
    const ground = columnAt(x, z);
    assert.ok(ground.height > SEA_LEVEL, `palm at ${x},${z} stands in water`);
    assert.ok(ground.height <= PALM_MAX_GROUND,
      `palm at ${x},${z} stands at height ${ground.height}, above the palm band`);
  }
});

test('every palm has a trunk tall enough to read as a tree', () => {
  // Three is the floor. The first version used `2 + round(wobble * 1.4)`, which could
  // produce a two-block stub under a five-wide cap -- as wide as it was tall, so it read
  // as a bush rather than a palm.
  const isl = generateIsland(38);
  const tops = new Map();
  for (const [x, y, z, m] of isl.blocks) {
    if (m !== M.PALM) continue;
    const k = `${x},${z}`;
    tops.set(k, Math.max(tops.get(k) ?? 0, y));
  }
  for (const [k, topY] of tops) {
    const [x, z] = k.split(',').map(Number);
    const trunk = topY - columnAt(x, z).height;
    assert.ok(trunk >= 3, `palm at ${k} has a ${trunk}-block trunk`);
  }
});

test('generation is deterministic and reasonably fast', () => {
  // Deterministic so a rollback to an old world reproduces its island; fast enough to
  // run at boot without a loading stall.
  const a = generateIsland(20, 5);
  const b = generateIsland(20, 5);
  assert.deepEqual(a.blocks.length, b.blocks.length);

  const t0 = Date.now();
  generateIsland(38);
  assert.ok(Date.now() - t0 < 2000, 'generation took too long for boot');
});

test('a different seed gives a different island', () => {
  const a = generateIsland(20, 1);
  const b = generateIsland(20, 2);
  assert.notDeepEqual(a.blocks, b.blocks, 'the seed is being ignored');
});