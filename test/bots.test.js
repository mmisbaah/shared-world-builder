/**
 * Bot goal derivation and commitment.
 *
 * The interesting property is that bots serve the *shared* objective. If a bot can
 * be talked into building something unrelated to the active goal, the world stops
 * reading as cooperative -- which was the entire reason for replacing the old
 * random behaviour. So the tests below mostly assert "did it build what the
 * objective asked for", not "did it build anything".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BotSwarm, BOT_PROFILES } from '../server/bots.js';
import { Authority } from '../server/authority.js';
import { ObjectiveTracker } from '../server/objectives.js';
import { intentFor, chooseIntent, SPECIALISMS, ladderWithIntents } from '../shared/botGoals.js';
import { OBJECTIVES } from '../shared/objectives.js';
import { PROPS, MATERIALS, isWaterMaterial } from '../shared/materials.js';
import { generateIsland, SEA_LEVEL, botDistricts } from '../shared/atoll.js';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Bots on an island: the terrain the swarm actually has to work with
// ---------------------------------------------------------------------------

test('a bot never treats the water surface as buildable ground', () => {
  // The swarm's core heuristic is "scan down from the sky and build on whatever is the
  // first solid thing". That was written when the world had no liquid, so `getBlock()
  // !== 0` meant "ground". On an atoll it means "the sea surface" about a third of the
  // time, and every bot would stack its district on top of the lagoon -- districts
  // visible as jetties rather than neighbourhoods.
  //
  // This checks the predicate directly against a real generated island.
  const { Authority: A } = { Authority };
  const authority = new A();
  const island = generateIsland(38);
  for (const [x, y, z, m] of island.blocks) authority.setBlock(x, y, z, m);
  for (const [x, y, z, m] of island.water) authority.setBlock(x, y, z, m);

  const swarm = new BotSwarm(authority, () => {}, {
    objectives: new ObjectiveTracker(authority),
    onWorldChanged: () => {},
  });
  try {
    // Sampled every 3 units: enough cells to cover the whole disc, few enough to stay
    // fast. Over r<30 that lattice hits 441 columns -- 51 of them cay, 390 lagoon.
    const waterAsGround = [];
    const dryRejected = [];
    let dryTotal = 0;
    for (let x = -30; x <= 30; x += 3) {
      for (let z = -30; z <= 30; z += 3) {
        const top = swarm._topMaterial(x, z);
        if (top === 0) continue;
        const surfaceY = swarm._surfaceY(x, z);
        if (isWaterMaterial(top)) {
          if (surfaceY >= 0) waterAsGround.push(`${x},${z}`);
        } else {
          dryTotal++;
          if (surfaceY < 0) dryRejected.push(`${x},${z}`);
        }
      }
    }
    assert.deepEqual(waterAsGround, [],
      `lagoon columns offered to bots as build sites: ${waterAsGround.slice(0, 5).join(' ')}`);
    assert.deepEqual(dryRejected, [],
      `beach columns rejected as unbuildable: ${dryRejected.slice(0, 5).join(' ')}`);
    // Guard against the test passing vacuously if the sampling ever misses the island.
    assert.ok(dryTotal > 20, `only sampled ${dryTotal} dry columns`);
  } finally {
    swarm.dispose();
  }
});

test('every bot district anchor is on dry land', () => {
  // The anchors were hardcoded at +/-10 per quadrant, chosen for the old plaza -- a disc
  // of radius 22 that was entirely dry. On an atoll two of the four land in the water,
  // their nearest dry ground 2 and 4 units away, so a bot would claim a rectangle of
  // sea, refuse everybody's edits to it, and build nothing.
  //
  // The anchors are now derived from the terrain. This asserts they stay that way for
  // any island the generator produces, not just today's.
  for (const seed of [1337, 1, 7, 99, 4242]) {
    // Index the island by column once. The first version called
    // `generateIsland(38, seed).blocks` inside the loop and then `.find`-ed through all
    // 18,000 blocks per anchor -- five seeds times four anchors times eighteen thousand,
    // which is what pushed the whole file past the 25s timeout.
    const ground = new Set();
    for (const [x, , z, m] of generateIsland(38, seed).blocks) {
      if (m !== 14 && m !== 15) ground.add(`${x},${z}`);
    }
    const districts = botDistricts();
    assert.equal(districts.length, 4, 'four quadrants');
    for (const d of districts) {
      assert.ok(ground.has(`${d.anchor.x},${d.anchor.z}`),
        `seed ${seed}: anchor ${d.anchor.x},${d.anchor.z} has no ground at all`);
      assert.ok(d.anchor.height > SEA_LEVEL,
        `seed ${seed}: anchor ${d.anchor.x},${d.anchor.z} is underwater`);
    }
  }
});

test('the anchors are deterministic, so bot districts survive a restart', () => {
  assert.deepEqual(botDistricts(), botDistricts());
  // And distinct: four bots sharing one district is the failure districts exist to stop.
  const keys = botDistricts().map((d) => `${d.anchor.x},${d.anchor.z}`);
  assert.equal(new Set(keys).size, 4, `anchors collapsed to ${keys.join(' / ')}`);
});

// ---------------------------------------------------------------------------
// intentFor: every objective maps to something buildable
// ---------------------------------------------------------------------------

test('every objective maps to an intent', () => {
  // An objective a bot cannot act on is an objective the bots will visibly idle
  // through, which reads as broken. Each is allowed to be idle, but only if it is
  // deliberate.
  for (const o of OBJECTIVES) {
    const intent = intentFor(o.id);
    assert.ok(intent, `${o.id} has no intent`);
    assert.ok(['material', 'prop', 'tower', 'idle'].includes(intent.kind));
    assert.ok(intent.label && intent.label.length > 0, `${o.id} intent needs a label`);
  }
});

test('a prop objective tells the bot which prop to place', () => {
  const lantern = OBJECTIVES.find((o) => o.metric === 'propCount' && o.prop === 'lantern');
  const intent = intentFor(lantern.id);
  assert.equal(intent.kind, 'prop');
  assert.equal(intent.prop, 'lantern');
  assert.ok(isValidPropName(intent.prop));
});

test('a material objective names a real material', () => {
  for (const o of OBJECTIVES.filter((x) => x.metric === 'materialCount' || x.metric === 'materialPresent')) {
    const intent = intentFor(o.id);
    assert.equal(intent.kind, 'material');
    const mat = intent.material;
    const ok = Array.isArray(mat)
      ? mat.every((m) => MATERIALS[m])
      : !!MATERIALS[mat];
    assert.ok(ok, `${o.id} names material ${mat} which is not in the catalogue`);
  }
});

test('a height objective names the target height', () => {
  const o = OBJECTIVES.find((x) => x.metric === 'columnHeight');
  const intent = intentFor(o.id);
  assert.equal(intent.kind, 'tower');
  assert.equal(intent.height, o.goal);
});

test('the multi-builder objective makes bots stand down, on purpose', () => {
  // A bot cannot make a human appear. Building something unrelated here would be
  // the bots looking busy while the one thing that would actually advance the
  // goal -- another person joining -- does not happen.
  const o = OBJECTIVES.find((x) => x.metric === 'distinctBuilders');
  const intent = intentFor(o.id);
  assert.equal(intent.kind, 'idle');
  assert.match(intent.label, /waiting/i);
});

test('an unknown objective id is handled rather than thrown on', () => {
  const intent = intentFor('no_such_objective');
  assert.equal(intent.kind, 'idle');
});

// ---------------------------------------------------------------------------
// chooseIntent: specialism varies the method, never the objective
// ---------------------------------------------------------------------------

test('every bot specialism works the same objective', () => {
  // This is the whole cooperative premise. Divergence here is the bug the old
  // random behaviour had.
  for (const o of OBJECTIVES) {
    for (const specialism of Object.keys(SPECIALISMS)) {
      const intent = chooseIntent(o.id, specialism);
      const base = intentFor(o.id);
      assert.equal(intent.kind, base.kind, `${specialism} changed the kind for ${o.id}`);
      assert.equal(intent.prop, base.prop, `${specialism} changed the prop for ${o.id}`);
      assert.equal(intent.material, base.material, `${specialism} changed the material for ${o.id}`);
      assert.equal(intent.height, base.height, `${specialism} changed the height for ${o.id}`);
    }
  }
});

test('every bot specialism appears in the table', () => {
  for (const p of BOT_PROFILES) {
    assert.ok(SPECIALISMS[p.specialism], `${p.name} has specialism "${p.specialism}" with no description`);
    assert.ok(p.district, `${p.name} has no district`);
  }
});

test('bot districts do not all overlap the same cell', () => {
  // District ownership is what makes the plaza read as a town. Two bots in the
  // same quadrant undo the whole effect.
  const seen = new Set();
  for (const p of BOT_PROFILES) {
    const k = `${Math.sign(p.district.x)},${Math.sign(p.district.z)}`;
    seen.add(k);
  }
  assert.equal(seen.size, BOT_PROFILES.length, 'each bot owns a distinct quadrant');
});

test('an idle objective stays idle for every specialism', () => {
  const idle = OBJECTIVES.find((o) => o.metric === 'distinctBuilders');
  for (const s of Object.keys(SPECIALISMS)) {
    assert.equal(chooseIntent(idle.id, s).kind, 'idle');
  }
});

test('ladderWithIntents annotates the ladder for the client', () => {
  const ladder = ladderWithIntents(2);
  assert.equal(ladder.length, OBJECTIVES.length);
  assert.equal(ladder.filter((x) => x.active).length, 1, 'exactly one entry is active');
  assert.equal(ladder[2].active, true);
  for (const row of ladder) assert.ok(row.intent && row.intent.kind);
});

// ---------------------------------------------------------------------------
// The swarm itself
// ---------------------------------------------------------------------------

/**
 * A swarm wired to a fresh authority.
 *
 * `spawn()` starts a `setTimeout` chain, which keeps Node's event loop alive and
 * hangs the whole test run -- so every caller must pass the test context and the
 * swarm is disposed when the test ends.
 */
function makeSwarm(t) {
  const authority = new Authority();
  const objectives = new ObjectiveTracker(authority);
  const events = [];
  const swarm = new BotSwarm(authority, (p) => events.push(p), {
    objectives,
    onWorldChanged: () => {},
  });
  // One bot, so the assertions are about a single agent's behaviour.
  const profile = BOT_PROFILES[0];
  swarm.spawn(profile);
  const worker = swarm.workers.get(profile.id);
  t?.after?.(() => swarm.dispose());
  return { authority, objectives, swarm, worker, profile, events };
}

test('commitPropAs refuses a prop with no ground beneath it', (t) => {
  // Bots bypass the op pipeline, so their own validation is all that stands
  // between them and props floating in mid-air.
  const { authority, profile } = makeSwarm(t);
  assert.equal(authority.commitPropAs(profile, 0, 5, 0, 'lantern'), null);
});

test('commitPropAs refuses to overwrite a solid cell or an existing prop', (t) => {
  const { authority, profile } = makeSwarm(t);
  authority.setBlock(0, 0, 0, 1);
  assert.ok(authority.commitPropAs(profile, 0, 1, 0, 'lantern'), 'first placement works');

  assert.equal(authority.commitPropAs(profile, 0, 1, 0, 'torch'), null, 'no double placement');
  authority.setBlock(2, 0, 0, 1);
  authority.setBlock(2, 1, 0, 1);
  assert.equal(authority.commitPropAs(profile, 2, 1, 0, 'plant'), null, 'not into a solid cell');
});

test('commitPropAs rejects an unknown prop key', (t) => {
  const { authority, profile } = makeSwarm(t);
  authority.setBlock(0, 0, 0, 1);
  assert.equal(authority.commitPropAs(profile, 0, 1, 0, 'hovercraft'), null);
});

test('a committed prop is attributed to the bot', (t) => {
  const { authority, profile } = makeSwarm(t);
  authority.setBlock(0, 0, 0, 1);
  const rec = authority.commitPropAs(profile, 0, 1, 0, 'plant', 3);
  assert.equal(rec.by, profile.id);
  assert.equal(rec.rot, 3);
  assert.equal(rec.prop, 'plant');
});

test('bots count as distinct builders, so a solo player is not stuck at Room For Everyone', (t) => {
  // Regression, and the reason this file needed a swarm rather than a bare tracker.
  // The contributor set was only reachable from the human op handler, so
  // `distinctBuilders` could only ever count people. A lone player therefore could
  // never reach three, and the ladder stopped at 6/8 with nothing they could build
  // to move it -- which reads as the game being broken rather than as a request to
  // invite somebody.
  const { swarm, authority, objectives } = makeSwarm(t);
  const roomForEveryone = OBJECTIVES.findIndex((o) => o.id === 'room_for_everyone');
  assert.ok(roomForEveryone > 0, 'the objective exists');
  objectives.index = roomForEveryone;

  // Three bots place a block each, the way they do over the first six objectives.
  for (let i = 0; i < 3; i++) {
    const profile = BOT_PROFILES[i];
    if (!swarm.workers.has(profile.id)) swarm.spawn(profile);
    const worker = swarm.workers.get(profile.id);
    assert.ok(swarm._commitBlock(worker, [i * 2, 1, 0, 1]), `bot ${i} placed a block`);
    assert.ok(objectives.contributors.has(profile.id), `bot ${i} is counted as a builder`);
  }
  assert.equal(objectives.contributors.size, 3, 'three distinct builders, none of them human');

  // Meeting the number is still not enough on its own -- the human gate is a
  // separate input and must stay shut, or the swarm would carry the ladder alone.
  objectives.evaluate();
  assert.equal(objectives.index, roomForEveryone, 'the ladder waits for a person');
  assert.equal(objectives.awaitingHuman, true, 'and says so, instead of looking stuck');

  // One block from the player is what actually clears it.
  objectives.noteHumanContribution('solo_player');
  objectives.evaluate();
  assert.equal(objectives.index, roomForEveryone + 1, 'the dead-end is gone');
});

test('a bot working a prop objective actually places that prop', (t) => {
  const { swarm, worker, authority, profile } = makeSwarm(t);
  // Seed ground so there is somewhere legal to build.
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) authority.setBlock(x, 0, z, 1);

  worker.intent = intentFor('first_light');
  worker.queue = swarm.plan(worker);
  assert.ok(worker.queue.length > 0, 'a prop objective produces work');

  let placed = null;
  for (const step of worker.queue) {
    placed = swarm._commitProp(worker, step) ?? placed;
  }
  assert.ok(placed, 'something was placed');
  assert.equal(placed.prop, 'lantern', 'and it is the objective\'s prop');
  assert.equal(placed.by, profile.id);
});

test('a bot working a material objective only places that material', (t) => {
  const { swarm, worker, authority } = makeSwarm(t);
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) authority.setBlock(x, 0, z, 1);

  worker.intent = intentFor('gold_ten');
  worker.queue = swarm.plan(worker);
  assert.ok(worker.queue.length > 0);

  const mats = worker.queue.map((s) => s[3]);
  assert.ok(mats.every((m) => m === worker.intent.material),
    `every step should be material ${worker.intent.material}, saw ${[...new Set(mats)]}`);
});

test('a bot working a tower objective builds upward toward the goal height', (t) => {
  const { swarm, worker, authority } = makeSwarm(t);
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) authority.setBlock(x, 0, z, 1);

  worker.intent = intentFor('beacon');
  worker.queue = swarm.plan(worker);
  assert.ok(worker.queue.length > 0);

  const ys = worker.queue.map((s) => s[1]);
  assert.ok(ys.every((y, i) => i === 0 || y === ys[i - 1] + 1), 'steps are a contiguous vertical run');
  assert.ok(Math.max(...ys) >= 1);
  // The top of a beacon is a glow material, so the finish is visible.
  const top = worker.queue[worker.queue.length - 1][3];
  assert.notEqual(top, worker.queue[0][3], 'the summit is capped differently from the shaft');
});

test('a bot does not keep building once the objective is already satisfied', (t) => {
  // Four bots each placing a lantern about once a second turned a goal of six
  // into a lantern pile: measured 1600 prop commits against a goal of one. The
  // planner has to read the tracker's verdict, not just trust that the intent
  // was derived from an unmet goal.
  const { swarm, worker, authority, objectives } = makeSwarm(t);
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) authority.setBlock(x, 0, z, 1);

  worker.intent = intentFor('first_light');
  // Stand in for a tracker that has already measured the goal as met.
  objectives.index = 0;
  objectives.wire = {
    index: 0,
    active: [{ ...OBJECTIVES[0], current: 1, goal: 1, done: true }],
  };

  assert.deepEqual(swarm.plan(worker), [], 'no work planned when the goal is met');
  assert.equal(swarm._stillNeeded(worker.intent), false);
});

test('a bot does keep building while the objective is unmet', (t) => {
  const { swarm, worker, authority, objectives } = makeSwarm(t);
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) authority.setBlock(x, 0, z, 1);

  worker.intent = intentFor('warm_the_plaza');
  objectives.index = 1;
  // `active` is indexed by the tracker's cursor, so index 1 means the *second*
  // entry -- which is the one that has to carry the measurement. (An earlier version
  // of this test put the measurement at index 0, where it was never read.)
  objectives.wire = {
    index: 1,
    active: [
      { ...OBJECTIVES[0], current: 1, goal: 1, done: true },
      { ...OBJECTIVES[1], current: 2, goal: 6, done: false },
    ],
  };

  assert.equal(swarm._stillNeeded(worker.intent), true, 'two of six means there is work');
  assert.ok(swarm.plan(worker).length > 0);
});

test('a satisfied-but-locked objective stops the bots', (t) => {
  // The regression that produced 9,093 lanterns in a live session. With the
  // human-contributor gate, an objective whose metric is met but which no human has
  // touched stays active indefinitely -- the ladder cannot advance and the metric is
  // already satisfied. Bots polling that state build forever against a goal that can
  // never complete. Measured: 1,200 prop commits in 300 steps with no evaluate(),
  // and 9,093 over a real session.
  const { swarm, worker, authority, objectives } = makeSwarm(t);
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) authority.setBlock(x, 0, z, 1);

  worker.intent = intentFor('warm_the_plaza');
  objectives.index = 1;
  objectives.wire = {
    index: 1,
    active: [
      { ...OBJECTIVES[0], current: 1, goal: 1, done: true },
      { ...OBJECTIVES[1], current: 6, goal: 6, done: true },
    ],
  };

  assert.equal(swarm._stillNeeded(worker.intent), false,
    'the metric is met, so bots stand down whether or not the ladder can advance');
  assert.deepEqual(swarm.plan(worker), []);
});

test('bots stand down when the ladder is exhausted', (t) => {
  // Nothing left to serve. The old guard returned true here, because "no active
  // objective" was indistinguishable from "not measured yet".
  const { swarm, worker, objectives } = makeSwarm(t);
  objectives.index = OBJECTIVES.length;
  objectives.wire = { index: OBJECTIVES.length, active: [] };
  worker.intent = intentFor('warm_the_plaza');

  assert.equal(swarm._stillNeeded(worker.intent), false);
  assert.deepEqual(swarm.plan(worker), []);
});

test('the prop instance ceiling is not reachable by accident', () => {
  // MAX_CAPACITY used to be 2048 and a runaway bot session produced 9,650 lanterns,
  // so the renderer silently drew 2,048 of them. Silent truncation is worse than an
  // error: the world looks like it is working and part of it is simply not drawn.
  const src = readFileSync(resolve(here, '../public/src/world/props.js'), 'utf8');
  const cap = /const MAX_CAPACITY = (\d+);/.exec(src);
  assert.ok(cap, 'MAX_CAPACITY must be a literal so this check can read it');
  assert.ok(Number(cap[1]) > 9_650,
    `a ceiling of ${cap[1]} is below what a real session produced (9,650)`);
  // And overflow must be counted, not swallowed.
  assert.match(src, /stats\.dropped\+\+/,
    'props that could not be instanced must be counted');
});

test('prop sync does not skip a record that has lost its instance', () => {
  // The drift bug: an index entry is not the same as a live GPU instance. `_grow`
  // rebuilds the buffer from bucket.live, and a key it fails to re-insert keeps its
  // index entry while losing its instance -- so a skip-check on the index alone locks
  // the drift in permanently.
  //
  // Measured on a real world: 9,650 props, 9,650 index entries, 1,522 drawn. The other
  // 8,128 were skipped as "unchanged" on every frame forever, with dropped: 0 and no
  // warning. 84% of the world's props were invisible and nothing said so.
  const src = readFileSync(resolve(here, '../public/src/world/props.js'), 'utf8');

  // The skip must consult the bucket's live slot, not just the index.
  assert.match(src, /const slot = bucket\?\.live\.get\(key\);/,
    'sync must look up the live slot for the key');
  assert.match(src, /hasSlot && existing\.rot === record\.rot/,
    'and require a live slot before skipping a record as unchanged');
  assert.match(src, /let hasSlot = false;/,
    'hasSlot must be tracked, not inferred from index presence');

  // And the rebuild must re-read records from the index, since live only holds slots.
  assert.match(src, /for \(const \[key\] of ids\)/,
    '_grow must iterate keys only');
  assert.match(src, /const record = this\.index\.get\(key\);\s*\n\s*if \(!record\) continue;/,
    'and skip keys whose record has been detached');
});

test('prop buckets carry their own kind', () => {
  // The bug that blanked the world: _grow recovered a bucket's prop kind by searching
  // the map for its own identity, and when that came back undefined,
  // propGeometry(undefined) threw from inside the frame loop.
  const src = readFileSync(resolve(here, '../public/src/world/props.js'), 'utf8');
  assert.match(src, /b = \{ kind, mesh, capacity, live: new Map\(\) \}/,
    'the bucket must carry its kind');
  assert.match(src, /propGeometry\(bucket\.kind\)/,
    'and _grow must read it from there');
  assert.ok(!/find\(\(\[, v\]\) => v === bucket\)/.test(src),
    'the identity search must be gone');

  // The same function must not throw on an unknown kind: it is reachable from the
  // frame loop, where a throw stops all rendering.
  assert.match(src, /const recipe = RECIPES\[kind\];\s*\n\s*if \(!recipe\) return null;/,
    'an unknown prop kind must return null rather than throw');
});

// ---------------------------------------------------------------------------
// Territory
// ---------------------------------------------------------------------------

test('each bot claims its own quarter of the world', (t) => {
  // The point of the change: the districts were already there on the map, but nothing
  // owned them, so the zones view showed four bots with no ground and a player had
  // nowhere visibly "taken".
  const { swarm, authority } = makeSwarm(t);
  for (const p of BOT_PROFILES) swarm.spawn(p);

  assert.equal(authority.zones.size, BOT_PROFILES.length, 'one claim each');

  // Distinct quadrants, and not overlapping: four bots holding the same ground would
  // be one claim with three liars.
  const centres = [...authority.zones.values()].map((z) => `${Math.sign(z.cx)},${Math.sign(z.cz)}`);
  assert.equal(new Set(centres).size, BOT_PROFILES.length, 'each bot holds a distinct quarter');
});

test('bot claims are smaller than a player claim, leaving room to expand', (t) => {
  // Four bots at player size would cover most of a 40-unit radius and leave a world
  // with nowhere left to build, which is the opposite of what districts are for.
  const { swarm, authority } = makeSwarm(t);
  for (const p of BOT_PROFILES) swarm.spawn(p);

  const playerHalf = 6;
  for (const z of authority.zones.values()) {
    assert.ok(z.half < playerHalf,
      `${z.ownerName} claims ${z.half * 2}x${z.half * 2}, same as a player`);
  }
  // And the middle must stay unclaimed.
  assert.equal(authority.zoneAt(0, 0), null, 'the plaza centre stays open');
});

test('bot claims stay inside the playable radius', (t) => {
  const { swarm, authority } = makeSwarm(t);
  for (const p of BOT_PROFILES) swarm.spawn(p);
  for (const z of authority.zones.values()) {
    assert.ok(Math.hypot(z.cx, z.cz) + z.half <= 40,
      `${z.ownerName} claims past the edge of the world`);
  }
});

test('a bot claim is announced once, not on every build', (t) => {
  // Four bots committing about once a second each would otherwise flood every client
  // with zone traffic for no change in the world.
  const { swarm, worker, authority, events } = makeSwarm(t);
  for (const p of BOT_PROFILES) swarm.spawn(p);

  events.length = 0;
  const cell = { x: 0, y: 1, z: 0 };
  for (let i = 0; i < 6; i++) {
    worker.workedAt = Date.now();
    swarm._announceClaim(worker);
  }
  const claims = events.filter((e) => e.kind === 'claim');
  assert.equal(claims.length, 1, 'one announcement, not six');
});

test('a claim is re-announced only when the district moves', (t) => {
  const { swarm, worker, authority, events } = makeSwarm(t);
  swarm.holdGround(worker);
  events.length = 0;

  swarm._announceClaim(worker);
  assert.equal(events.filter((e) => e.kind === 'claim').length, 1);

  // Same place: nothing changed, so nothing to say.
  swarm._announceClaim(worker);
  assert.equal(events.filter((e) => e.kind === 'claim').length, 1, 'no repeat for the same ground');

  // Moved: the map genuinely changed, so it is worth saying.
  swarm.authority.zones.get('zone_' + worker.profile.id).cx = 3;
  swarm.worker_claim = null;
  worker.claim = { cx: 3, cz: 0, half: 4 };
  swarm._announceClaim(worker);
  assert.equal(events.filter((e) => e.kind === 'claim').length, 2, 'announced on the move');
});

test('a bot that stops working loses its district', (t) => {
  // Symmetry with the player rule: decay tracks work, so an idle bot visibly loses
  // ground rather than holding it forever by construction.
  const { swarm, worker, authority } = makeSwarm(t);
  for (const p of BOT_PROFILES) swarm.spawn(p);

  const id = 'zone_' + worker.profile.id;
  assert.ok(authority.zones.has(id), 'it holds ground to begin with');

  // Idle past the grace window.
  worker.workedAt = Date.now() - 200_000;
  swarm._tendClaim(worker);

  assert.equal(authority.zones.has(id), false, 'and gives it up when idle');
  assert.equal(worker.claim, null);
});

test('a bot that keeps working keeps its district', (t) => {
  const { swarm, worker, authority } = makeSwarm(t);
  for (const p of BOT_PROFILES) swarm.spawn(p);
  const id = 'zone_' + worker.profile.id;

  // Worked very recently: the claim must survive a long idle clock without help.
  worker.workedAt = Date.now();
  worker.sinceAnnounce = 3;
  swarm._tendClaim(worker);
  assert.ok(authority.zones.has(id), 'recent work holds it');

  // Worked, but long enough ago that renewal is due -- it should re-claim rather than
  // let go, because it *was* working.
  worker.workedAt = Date.now() - 60_000;
  swarm._tendClaim(worker);
  assert.ok(authority.zones.has(id), 'renewed rather than dropped');
});

test('claim decay can be switched off for comparison', (t) => {
  // Otherwise there is no way to observe the difference the mechanic makes.
  const { swarm, worker, authority } = makeSwarm(t);
  swarm.claimDecay = false;
  for (const p of BOT_PROFILES) swarm.spawn(p);

  worker.workedAt = Date.now() - 10_000_000;
  swarm._tendClaim(worker);
  assert.ok(authority.zones.has('zone_' + worker.profile.id), 'held indefinitely when off');
});

// ---------------------------------------------------------------------------
// Bots respect claims
// ---------------------------------------------------------------------------

test('a bot cannot build inside a player claim', (t) => {
  // The prerequisite bug: commitAs/commitPropAs never called preflight, so a claim
  // excluded nobody. Territory was decorative -- a player could claim a district and
  // watch a bot build straight through it.
  const { authority, profile } = makeSwarm(t);
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) authority.setBlock(x, 0, z, 1);

  authority.claimZone({ id: 1, t: 5, x: 0, z: 0, half: 6 },
    { id: 'human', name: 'Human', color: '#38bdf8' });

  assert.equal(authority.commitAs(profile, 1, 1, 1, 6), null, 'no block inside the claim');
  assert.equal(authority.commitPropAs(profile, 2, 1, 2, 'lantern'), null, 'nor a prop');
  assert.equal(authority.getBlock(1, 1, 1), 0, 'and the cell is untouched');
});

test('a bot can still build outside a player claim', (t) => {
  // Otherwise claiming ground would simply break the bots -- a bot blocked everywhere
  // looks broken rather than constrained.
  const { authority, profile } = makeSwarm(t);
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) authority.setBlock(x, 0, z, 1);
  authority.claimZone({ id: 1, t: 5, x: 0, z: 0, half: 6 },
    { id: 'human', name: 'Human', color: '#38bdf8' });

  assert.ok(authority.commitAs(profile, 18, 1, 18, 6), 'open ground is fair game');
});

test('a bot can build inside its own claim', (t) => {
  const { authority, swarm, profile } = makeSwarm(t);
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) authority.setBlock(x, 0, z, 1);
  swarm.holdGround(swarm.workers.get(profile.id) ?? (() => { swarm.spawn(profile); return swarm.workers.get(profile.id); })());

  const zone = authority.zones.get('zone_' + profile.id);
  assert.ok(zone, 'the bot holds a district');
  assert.ok(authority.commitAs(profile, zone.cx, 1, zone.cz, 6), 'and works in it');
});

test('a claim does not lock its own owner out', (t) => {
  // The other half: fencing bots off must not fence the owner off, or a claim would
  // stop working the ground it exists to protect.
  const { authority } = makeSwarm(t);
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) authority.setBlock(x, 0, z, 1);
  const me = { id: 'p1', name: 'Me', color: '#38bdf8' };
  authority.claimZone({ id: 1, t: 5, x: 0, z: 0, half: 6 }, me);

  assert.equal(authority.apply({ id: 1, t: 1, x: 1, y: 1, z: 1, mat: 6 }, me).ok, true,
    'the owner builds freely in their own claim');
});

test('pausing the swarm releases its districts', (t) => {
  // A claim lives in the authority keyed by builder id, not in the worker map. So
  // clearing the workers left four districts held by bots that no longer existed --
  // ground nobody could ever build on again, including by the players who came back.
  const { swarm, authority } = makeSwarm(t);
  assert.ok(authority.zones.size > 0, 'the swarm holds ground to begin with');

  swarm.setEnabled(false);
  assert.equal(authority.zones.size, 0, 'and gives it all up when paused');
});

test('disposing the swarm releases its districts', (t) => {
  const { swarm, authority } = makeSwarm(t);
  assert.ok(authority.zones.size > 0);
  swarm.dispose();
  assert.equal(authority.zones.size, 0);
});

test('disposing the swarm leaves player claims alone', (t) => {
  // Only the bots' own ground is released. Wiping every zone on the way out would
  // hand the whole map back to nobody and quietly undo the player's territory.
  const { swarm, authority } = makeSwarm(t);
  // Inside the circular radius: hypot(34,34) is 48, which is outside the 40-unit
  // world, so the claim is refused for reaching past the edge instead.
  // hypot(20,20) is 28, plus a half of 4, comfortably inside the 40-unit world.
  // The radius check bites hard at the corners: hypot(26,26)+4 is 40.8.
  const mine = { id: 'p1', name: 'Me', color: '#fff' };
  assert.ok(authority.claimZone({ id: 90, t: 5, x: -20, z: -20, half: 4 }, mine).ok,
    'the player claim is placed somewhere legal');

  swarm.dispose();
  assert.equal(authority.zones.size, 1, 'only the player claim is left');
  assert.ok(authority.zones.has('zone_p1'), 'and it is the right one');
  for (const id of BOT_PROFILES.map((p) => 'zone_' + p.id)) {
    assert.equal(authority.zones.has(id), false, `${id} was not released`);
  }
});

test('a bot relocates when its preferred ground is already claimed', (t) => {
  // Otherwise a player who squats a bot's district leaves that bot permanently
  // districtless -- which reads as a broken bot rather than as contested ground.
  const { swarm, authority, profile } = makeSwarm(t);
  swarm.setEnabled(false);
  for (const z of [...authority.zones.values()]) authority.zones.delete(z.id);

  // Squat exactly where this bot wants to be.
  const { x: sx, z: sz } = profile.district;
  authority.claimZone({ id: 91, t: 5, x: sx * 10, z: sz * 10, half: 8 },
    { id: 'sq', name: 'Squatter', color: '#fff' });

  swarm.spawn(profile);
  const worker = swarm.workers.get(profile.id);
  assert.ok(worker.claim, 'the bot still finds somewhere to hold ground');
  assert.notEqual(`${worker.claim.cx},${worker.claim.cz}`, `${sx * 10},${sz * 10}`,
    'and not the spot that was taken');
});

test('no two bot districts ever overlap', (t) => {
  // The overlap that started all this: a player claiming (10,10) landed on top of a
  // bot's identical claim, leaving two owners on the same ground and a permission
  // check that depended on Map iteration order.
  const { swarm, authority } = makeSwarm(t);
  for (const p of BOT_PROFILES) swarm.spawn(p);

  const zones = [...authority.zones.values()];
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const a = zones[i], b = zones[j];
      const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
      assert.equal(overlap, false, `${a.ownerName} and ${b.ownerName} share ground`);
    }
  }
});

test('bots build in the ground they hold', (t) => {
  // The regression from making bots respect claims. Their site search ranged over the
  // whole quadrant while their claim was an 8x8 block near the middle, so most picks
  // landed outside it, were refused by preflight, and the bot did nothing at all.
  // Measured: 400 steps produced 0 block commits and 1 prop.
  const { swarm, authority } = makeSwarm(t);
  for (let x = -24; x <= 24; x++) for (let z = -24; z <= 24; z++) authority.setBlock(x, 0, z, 1);
  for (const o of swarm.objectives.wire.active) swarm.objectives.humanTouched.add(o.id);

  const log = [];
  const origBlock = authority.commitAs.bind(authority);
  authority.commitAs = (b, x, y, z, m) => {
    const r = origBlock(b, x, y, z, m);
    if (r) log.push({ by: b.id, x, z });
    return r;
  };
  const origProp = authority.commitPropAs.bind(authority);
  authority.commitPropAs = (b, x, y, z, p, r) => {
    const q = origProp(b, x, y, z, p, r);
    if (q) log.push({ by: b.id, x, z });
    return q;
  };

  for (let i = 0; i < 400; i++) {
    for (const w of swarm.workers.values()) swarm.step(w);
    if (i % 10 === 0) {
      swarm.objectives.evaluate();
      swarm.markEvaluated();
      swarm.syncIntents();
    }
  }

  assert.ok(log.length > 20, `bots committed almost nothing: ${log.length}`);

  let own = 0, foreign = 0, free = 0;
  for (const e of log) {
    const z = authority.zoneAt(e.x, e.z);
    if (!z) free++;
    else if (z.ownerId === e.by) own++;
    else foreign++;
  }
  assert.equal(foreign, 0, 'a bot built inside someone else\'s claim');
  // Most work should be in its own district. Some spill onto open ground is correct --
  // it happens once a district fills -- but the bulk has to be home.
  assert.ok(own > free * 2, `only ${own} of ${log.length} commits were in-district`);
});

test('the work is spread across the swarm, not one bot doing it all', (t) => {
  // One bot holding all the output means the others are stalled, which looks like a
  // broken swarm rather than four builders.
  const { swarm, authority } = makeSwarm(t);
  for (let x = -24; x <= 24; x++) for (let z = -24; z <= 24; z++) authority.setBlock(x, 0, z, 1);
  for (const o of swarm.objectives.wire.active) swarm.objectives.humanTouched.add(o.id);

  for (let i = 0; i < 400; i++) {
    for (const w of swarm.workers.values()) swarm.step(w);
    if (i % 10 === 0) { swarm.objectives.evaluate(); swarm.markEvaluated(); swarm.syncIntents(); }
  }

  const counts = [...swarm.workers.values()].map((w) => w.placed);
  assert.ok(Math.min(...counts) > 0, `a bot placed nothing: ${counts.join(',')}`);
  assert.ok(Math.max(...counts) < Math.min(...counts) * 4,
    `one bot is doing all the work: ${counts.join(',')}`);
});

test('rescheduling does not leak timers', (t) => {
  // `step` reschedules itself. If schedule() does not clear the previous timer, each
  // worker accumulates a chain of live timers and only the most recent one is
  // cancellable -- so dispose() reports an empty map and the process still hangs.
  // Found by a script that printed "workers: 0" after dispose and would not exit.
  const { swarm } = makeSwarm(t);
  // The swarm's constructor spawns every profile, so there is more than one worker.
  const before = swarm.workers.size;
  const w = [...swarm.workers.values()][0];

  for (let i = 0; i < 20; i++) swarm.schedule(w, 60_000);
  // Re-scheduling one worker must not add workers; it re-arms one timer.
  assert.equal(swarm.workers.size, before, 're-scheduling does not spawn anything');

  // And dispose must leave nothing armed. The 60s delay means a leaked timer would
  // hang the runner for a minute, so this fails loudly rather than silently.
  //
  // `timer` is checked rather than `workers.size`, because the empty map proves
  // nothing: `dispose` always empties the map, even when it fails to cancel the
  // timers it is supposed to. That is exactly how this bug hid.
  const armed = [...swarm.workers.values()].filter((x) => x.timer !== null);
  assert.ok(armed.length > 0, 'a timer is armed before dispose, so this test can fail');

  swarm.dispose();
  assert.equal(w.timer, null, 'the pending timer was cleared, not overwritten');
});

test('the swarm re-measures when the world moves under its verdict', (t) => {
  // The guard reads a verdict that only `evaluate()` refreshes. Keying the refresh on
  // elapsed time was tried and is wrong in both directions -- longer than a bot step
  // and the verdict goes stale for the whole interval (1,200 prop commits), shorter
  // and four bots mean four world scans per step. Revisions are exact.
  const { swarm, worker, authority } = makeSwarm(t);
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) authority.setBlock(x, 0, z, 1);

  swarm.markEvaluated();
  assert.equal(swarm._needsRefresh(), false, 'a fresh verdict needs no rescan');

  const before = swarm.stats.selfEvaluations;
  worker.intent = intentFor('first_light');
  swarm._stillNeeded(worker.intent);
  assert.equal(swarm.stats.selfEvaluations, before, 'nothing changed, so no scan');

  // A commit is a change. The next guard check must notice.
  swarm._commitProp(worker, { x: 0, y: 1, z: 0, prop: 'lantern', rot: 0 });
  assert.equal(swarm._needsRefresh(), true, 'a commit invalidates the verdict');
});

test('the swarm is correct with no host evaluation running at all', (t) => {
  // The 9,093-lantern bug in one assertion: without a 1 Hz tick to refresh it, the
  // swarm used to measure zero progress forever.
  // `step` reschedules on a timer, so the timers must not outlive the test. Same
  // trap as in makeSwarm: an undisposed swarm hangs the run at teardown.
  const { swarm, authority } = makeSwarm(t);
  for (const p of BOT_PROFILES) swarm.spawn(p);
  for (let x = -22; x <= 22; x++) for (let z = -22; z <= 22; z++) authority.setBlock(x, 0, z, 1);

  for (let i = 0; i < 300; i++) for (const w of swarm.workers.values()) swarm.step(w);

  assert.ok(swarm.stats.propCommits <= 2,
    `expected about one prop for a goal of one, got ${swarm.stats.propCommits}`);
});

test('markEvaluated lets the host cover the scan', (t) => {
  // The production path: the 1 Hz objective tick evaluates and tells the swarm, so
  // the swarm should not repeat the work.
  const { swarm, authority } = makeSwarm(t);
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) authority.setBlock(x, 0, z, 1);

  const before = swarm.stats.selfEvaluations;
  swarm.markEvaluated();
  swarm._stillNeeded(intentFor('first_light'));
  assert.equal(swarm.stats.selfEvaluations, before,
    'the host already measured this, so the swarm must not scan again');
});

test('an unmeasured objective is assumed to need work', (t) => {
  // Before the tracker's first scan there is no verdict to read. Assuming "no work"
  // would deadlock every bot at boot until the first evaluation landed.
  const { swarm, worker, objectives } = makeSwarm(t);
  objectives.index = 0;
  objectives.wire = { index: 0, active: [{ ...OBJECTIVES[0], goal: 1 }] };

  assert.equal(swarm._stillNeeded(worker.intent), true);
});

test('the tower intent is exempt from the satisfaction guard', (t) => {
  // A beacon is raised by repeatedly topping one column, so "enough blocks
  // exist" is the wrong test -- the goal is a height, not a count, and the
  // guard would otherwise freeze a half-built tower forever.
  const { swarm, worker, objectives } = makeSwarm(t);
  worker.intent = intentFor('beacon');
  objectives.index = 4;
  objectives.wire = {
    index: 4,
    active: [
      ...OBJECTIVES.slice(0, 4).map((o) => ({ ...o, current: o.goal, done: true })),
      { ...OBJECTIVES[4], current: 1, goal: 12, done: false },
    ],
  };
  assert.equal(swarm._stillNeeded(worker.intent), true);
});

test('an idle objective produces no work at all', (t) => {
  const { swarm, worker } = makeSwarm(t);
  worker.intent = intentFor('room_for_everyone');
  worker.queue = swarm.plan(worker);
  assert.deepEqual(worker.queue, [], 'bots stand down rather than building filler');
});

test('the roster reports each bot\'s specialism and intent', (t) => {
  const { swarm, worker, profile } = makeSwarm(t);
  worker.intent = intentFor('first_light');
  const me = swarm.roster().find((b) => b.id === profile.id);
  assert.ok(me, 'the bot is in the roster');
  assert.equal(me.bot, true);
  assert.equal(me.specialism, SPECIALISMS[profile.specialism].label);
  assert.equal(me.intent, worker.intent.label);
  assert.equal(me.objective, 'first_light');
});

test('syncIntents is a no-op while the objective is unchanged', (t) => {
  const { swarm, worker } = makeSwarm(t);
  worker.intent = intentFor('first_light');
  swarm._lastObjective = 'first_light';
  assert.equal(swarm.syncIntents(), false, 'no churn, no broadcast');
});

test('syncIntents re-targets and clears stale work when the objective moves', (t) => {
  // Carrying on with an obsolete plan is the failure mode: a bot announces
  // "raising the beacon" and then keeps walling.
  const { swarm, worker, events } = makeSwarm(t);
  worker.intent = intentFor('beacon');
  worker.queue = [[0, 0, 0, 1]];
  swarm._lastObjective = 'beacon';

  swarm.objectives.index = 1; // move to the next objective
  swarm.objectives.wire = { active: OBJECTIVES, index: 1 };

  assert.equal(swarm.syncIntents(), true);
  assert.equal(worker.queue.length, 0, 'the obsolete queue is dropped');
  assert.notEqual(worker.intent.kind, 'tower');
  const announced = events.find((e) => e.kind === 'intent');
  assert.ok(announced, 'and the change is announced');
  assert.equal(announced.intent.kind, worker.intent.kind, 'the announcement matches the new work');
  assert.equal(announced.objective, swarm.objectives.wire.active[swarm.objectives.index].id);
});

test('bots never commit outside the buildable radius', (t) => {
  const { swarm, worker, authority } = makeSwarm(t);
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) authority.setBlock(x, 0, z, 1);
  worker.intent = intentFor('gold_ten');

  for (let i = 0; i < 40; i++) {
    worker.queue = swarm.plan(worker);
    for (const step of worker.queue) {
      const [x, y, z] = step;
      assert.ok(Math.hypot(x, z) <= 40, `(${x},${z}) is outside the radius`);
      assert.ok(y >= 0 && y < 48, `y=${y} out of range`);
    }
  }
});

function isValidPropName(key) {
  return !!PROPS[key];
}
