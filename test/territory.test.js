/**
 * Territory: claiming, decay, and what decay must never do.
 *
 * Decay is the mechanic that gives the game stakes, so the tests below are mostly
 * about the ways it could be unfair or silently broken rather than the happy path.
 * Each of those has a specific reason to exist, recorded where it is relevant.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Authority } from '../server/authority.js';
import { WORLD, DENY } from '../shared/protocol.js';

const T = WORLD.ZONE_TTL_MS;
const HOLD = WORLD.ZONE_HOLD_MS;

function makeActor(id = 'p1', name = 'Player One') {
  return { id, name, color: '#38bdf8' };
}

/**
 * Ground at y=0 across the playable area, so claims have something to enclose.
 *
 * Only the surface layer: build *at* y=1, never y=2, so tests that place many blocks
 * in a loop do not run into their own earlier work and start being refused for the
 * wrong reason.
 */
// Bounded by the *circular* playable radius, not a square. WORLD.RADIUS is 40 and
// inBounds() tests hypot(x,z) <= 40, so a 30x30 ground plane reaches 42.4 at its
// corners: outside the world. A test that seeded there got "outside build bounds"
// and blamed the claim logic for it.
const REACH = 27;

function seedGround(a) {
  for (let x = -REACH; x <= REACH; x++) {
    for (let z = -REACH; z <= REACH; z++) a.setBlock(x, 0, z, 1);
  }
}

/** A cell guaranteed to be free *and inside the world*, so "does this succeed" is
 *  testing the thing under test rather than a bounds check. */
function freeCell(a) {
  for (let x = -REACH; x <= REACH; x++) {
    for (let z = -REACH; z <= REACH; z++) {
      if (a.getBlock(x, 1, z) === 0) return { x, y: 1, z };
    }
  }
  throw new Error('no free cell inside the playable radius');
}

const claim = (a, actor, x = 0, z = 0, half = 6) =>
  a.claimZone({ id: 1, t: 5, x, z, half }, actor);

const mine = (a, actor) => a.zones.get('zone_' + actor.id);

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

test('a claim encloses the ground it says it does', () => {
  const a = new Authority();
  const actor = makeActor();
  claim(a, actor, 4, -2, 6);

  const z = mine(a, actor);
  assert.ok(z, 'the claim exists');
  assert.equal(z.x0, -2); assert.equal(z.x1, 10);
  assert.equal(z.z0, -8); assert.equal(z.z1, 4);
  // zoneAt is the authority's own permission check, so testing it here tests the
  // exact function `preflight` uses to refuse an edit.
  assert.equal(a.zoneAt(0, 0), z, 'centre is inside');
  assert.equal(a.zoneAt(-1, -7), z, 'far corner is inside');
  assert.equal(a.zoneAt(11, 0), null, 'just outside');
  assert.equal(a.zoneAt(0, -9), null, 'just outside the other way');
});

test('a claim half-width is clamped to a sane range', () => {
  const a = new Authority();
  const actor = makeActor();
  // Zero would enclose nothing and block nothing; enormous would swallow the world.
  claim(a, actor, 0, 0, 0);
  assert.equal(mine(a, actor).half, 2);
  claim(a, actor, 0, 0, 999);
  assert.equal(mine(a, actor).half, 12);
});

test('a claim reaching past the world edge is refused, with a reason', () => {
  // Rejected rather than clamped: silently relocating a claim would leave the player
  // holding ground they did not ask for, and a claim outside the radius encloses
  // nothing buildable, so it has no consequences at all.
  const a = new Authority();
  const r = claim(a, new Authority().zones ? makeActor() : makeActor(), 39, 39, 12);
  assert.equal(r.ok, false);
  assert.match(r.reason, /edge of the world/);
});

test('one builder holds one claim, and re-claiming moves it', () => {
  const a = new Authority();
  const actor = makeActor();
  claim(a, actor, -10, 0, 4);
  assert.ok(a.zoneAt(-10, 0));

  claim(a, actor, 10, 0, 4);
  assert.equal(a.zones.size, 1, 'not a second claim');
  assert.equal(a.zoneAt(-10, 0), null, 'the old ground is gone');
  assert.ok(a.zoneAt(10, 0), 'and the new ground is held');
});

test('re-claiming keeps the original creation time', () => {
  // So a "created" figure in the UI means something stable rather than resetting
  // every time the player clicks the button.
  const a = new Authority();
  const actor = makeActor();
  claim(a, actor, 0, 0, 4);
  const first = mine(a, actor).createdAt;
  claim(a, actor, 5, 5, 4);
  assert.equal(mine(a, actor).createdAt, first);
});

test('releasing gives the ground up', () => {
  const a = new Authority();
  const actor = makeActor();
  claim(a, actor, 0, 0);
  const r = a.releaseZone({ id: 2, t: 9 }, actor);
  assert.equal(r.ok, true);
  assert.equal(a.zones.size, 0);
  assert.equal(a.zoneAt(0, 0), null);
});

test('a claim cannot be placed on top of someone else\'s', () => {
  // The failure this prevents: two claims on identical ground. The permission check
  // then resolves by Map iteration order, so which of the two owners gets locked out
  // of their *own* district changes between restarts.
  const a = new Authority();
  const me = makeActor('p1');
  const you = makeActor('p2', 'Player Two');
  assert.ok(claim(a, me, 0, 0, 6).ok);

  const over = claim(a, you, 0, 0, 5);
  assert.equal(over.ok, false);
  assert.match(over.reason, /already holds ground/);
  assert.equal(a.zones.size, 1, 'and only one claim exists');
});

test('a partially overlapping claim is also refused', () => {
  // Testing only exact centres would miss a claim that covers only a corner of
  // another's -- which is still two owners on the same block.
  const a = new Authority();
  const me = makeActor('p1');
  claim(a, me, 0, 0, 6);           // -6..6
  assert.equal(claim(a, makeActor('p2'), 9, 0, 4).ok, false, '7..13 overlaps at 6');
});

test('adjacent ground is allowed', () => {
  // Refusing overlap must not refuse everything: a world you cannot expand into is
  // worse than one with overlapping claims.
  const a = new Authority();
  const me = makeActor('p1');
  claim(a, me, 0, 0, 4);            // -4..4
  assert.equal(claim(a, makeActor('p2'), 10, 0, 4).ok, true, '6..14 is clear');
});

test('re-claiming your own ground is not a clash', () => {
  // Otherwise moving or resizing your claim would be impossible once placed.
  const a = new Authority();
  const me = makeActor('p1');
  claim(a, me, 0, 0, 4);
  assert.equal(claim(a, me, 2, 2, 6).ok, true, 'moved and resized');
  assert.equal(a.zones.size, 1);
  assert.equal(a.zoneAt(2, 2), a.zones.get('zone_p1'));
});

test('releasing when you hold nothing says so', () => {
  const a = new Authority();
  const r = a.releaseZone({ id: 2, t: 9 }, makeActor());
  assert.equal(r.ok, false);
  assert.match(r.reason, /no claim/);
});

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

test('a fresh claim is live', () => {
  const a = new Authority();
  const actor = makeActor();
  claim(a, actor, 0, 0);
  assert.equal(a.zoneState(mine(a, actor)), 'live');
  assert.equal(a.zonePayload()[0].state, 'live');
});

test('a claim enters a visible warning before it expires', () => {
  // The whole point of the grace window: decay must never be a surprise, or it reads
  // as unfair rather than as pressure.
  const a = new Authority();
  const actor = makeActor();
  claim(a, actor, 0, 0);
  const now = Date.now();

  const z = mine(a, actor);
  z.expiresAt = now + HOLD + 5_000;
  assert.equal(a.zoneState(z, now), 'live', 'still comfortable');

  z.expiresAt = now + HOLD - 5_000;
  assert.equal(a.zoneState(z, now), 'fading', 'warning is visible first');
});

test('an untouched claim is released when its clock runs out', () => {
  const a = new Authority();
  const actor = makeActor();
  claim(a, actor, 0, 0);
  mine(a, actor).expiresAt = Date.now() - 1;

  const released = a.pruneZones();
  assert.equal(released.length, 1);
  assert.equal(released[0].ownerId, actor.id, 'and names who lost it');
  assert.equal(a.zones.size, 0);
  assert.equal(a.zoneAt(0, 0), null, 'the ground is free again');
});

test('building renews the claim', () => {
  // Decay tracks *work*, not attendance. A claim that renewed on login would be a
  // timer you watched; one that renews on building is a district you maintain.
  const a = new Authority();
  seedGround(a);
  const actor = makeActor();
  claim(a, actor, 0, 0);

  const z = mine(a, actor);
  z.expiresAt = Date.now() - 1;
  assert.equal(a.touchZone(actor.id), true);

  assert.ok(mine(a, actor).expiresAt > Date.now(), 'the clock restarted');
  assert.deepEqual(a.pruneZones(), [], 'and nothing was released');
});

test('placing a block through the normal op path renews the claim', () => {
  // The renewal must live on the commit path, not only in a helper the bots use --
  // otherwise it works for bots and silently does nothing for players, which is the
  // single most likely way this mechanic ends up inert.
  const a = new Authority();
  seedGround(a);
  const actor = makeActor();
  claim(a, actor, 0, 0);
  mine(a, actor).expiresAt = Date.now() - 1;

  const r = a.apply({ id: 1, t: 1, x: 1, y: 1, z: 1, mat: 6 }, actor);
  assert.equal(r.ok, true);
  assert.ok(mine(a, actor).expiresAt > Date.now(), 'the commit renewed it');
});

test('a refused op does not renew the claim', () => {
  // Otherwise spamming invalid requests holds a district open forever, which is the
  // exploit the whole mechanic exists to prevent.
  const a = new Authority();
  seedGround(a);
  const actor = makeActor();
  claim(a, actor, 0, 0);
  mine(a, actor).expiresAt = Date.now() - 1;

  // Occupy the cell first, so the refusal is about occupancy rather than about a
  // claim check that happens to fire first.
  const cell = freeCell(a);
  a.setBlock(cell.x, cell.y, cell.z, 2);
  const r = a.apply({ id: 1, t: 1, ...cell, mat: 6 }, actor);
  assert.equal(r.ok, false, 'placing into an occupied cell is refused');
  assert.equal(r.deny, DENY.OCCUPIED, 'refused for the reason under test');
  assert.ok(mine(a, actor).expiresAt < Date.now(), 'and the clock kept running');
});

test('placing a prop renews the claim too', () => {
  const a = new Authority();
  seedGround(a);
  const actor = makeActor();
  claim(a, actor, 0, 0);
  mine(a, actor).expiresAt = Date.now() - 1;

  const r = a.apply({ id: 1, t: 3, x: 2, y: 1, z: 2, prop: 'lantern', rot: 0 }, actor);
  assert.equal(r.ok, true);
  assert.ok(mine(a, actor).expiresAt > Date.now());
});

test('another builder cannot renew your claim', () => {
  const a = new Authority();
  seedGround(a);
  const me = makeActor('p1');
  const you = makeActor('p2', 'Player Two');
  claim(a, me, 0, 0);
  mine(a, me).expiresAt = Date.now() - 1;

  a.apply({ id: 1, t: 1, x: 8, y: 1, z: 8, mat: 6 }, you);
  assert.ok(mine(a, me).expiresAt < Date.now(), 'their work did not save my ground');
});

test('tending a claim keeps it alive indefinitely', () => {
  // A player who keeps working should never lose ground, or decay becomes a tax on
  // taking a break rather than a cost for neglecting.
  const a = new Authority();
  seedGround(a);
  const actor = makeActor();
  claim(a, actor, 0, 0);

  // One block per round, each in fresh ground, so every placement can succeed. An
  // earlier version reused a five-cell strip, so rounds 6+ were refused for being
  // occupied and the claim then genuinely did expire -- the test was measuring its
  // own sloppiness rather than the mechanic.
  for (let round = 0; round < 20; round++) {
    mine(a, actor).expiresAt = Date.now() - 1; // force it to the edge each round
    const cell = freeCell(a);
    const r = a.apply({ id: round + 1, t: 1, ...cell, mat: 6 }, actor);
    assert.equal(r.ok, true, `round ${round} should be a successful build`);
  }
  assert.equal(a.pruneZones().length, 0, 'never released while being worked');
});

test('decay releases the ground but leaves the blocks standing', () => {
  // The distinction that lets decay be tense without being punishing: you lose the
  // exclusive right to build, not the work you did. Destroying someone's builds on a
  // timer would make the game hostile rather than competitive.
  const a = new Authority();
  seedGround(a);
  const actor = makeActor();
  claim(a, actor, 0, 0);
  a.apply({ id: 1, t: 1, x: 1, y: 1, z: 1, mat: 6 }, actor);

  mine(a, actor).expiresAt = Date.now() - 1;
  a.pruneZones();

  assert.equal(a.getBlock(1, 1, 1), 6, 'the block is still there');
  assert.equal(a.zoneAt(1, 1), null, 'but nobody owns the ground');
});

test('another builder can build on ground once a claim decays', () => {
  // The payoff of the mechanic: space becomes available again, which is what makes
  // taking a district worth taking.
  const a = new Authority();
  seedGround(a);
  const owner = makeActor('p1');
  const taker = makeActor('p2', 'Player Two');
  claim(a, owner, 0, 0);

  assert.equal(a.apply({ id: 1, t: 1, x: 1, y: 1, z: 1, mat: 6 }, taker).ok, false,
    'refused while held');

  mine(a, owner).expiresAt = Date.now() - 1;
  a.pruneZones();

  assert.equal(a.apply({ id: 2, t: 1, x: 1, y: 1, z: 1, mat: 6 }, taker).ok, true,
    'allowed once decayed');
});

test('pruning with no claims is a no-op', () => {
  assert.deepEqual(new Authority().pruneZones(), []);
});

test('msLeft never goes negative on the wire', () => {
  // The client renders a bar from it; a negative value would draw past the track and
  // read as a bug rather than as an expired claim.
  const a = new Authority();
  claim(a, new Authority().zones ? makeActor() : makeActor(), 0, 0);
  mine(a, makeActor()).expiresAt = Date.now() - 5_000;
  assert.equal(a.zonePayload()[0].msLeft, 0);
});

// ---------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------

test('claims survive a restart but the clock does not', () => {
  // Restoring the clock would mean shutting the server for three minutes kept your
  // ground, which is exactly the exploit decay exists to close. A claim is a
  // statement that you are still here; restarting is not that.
  const a = new Authority();
  claim(a, makeActor('p1', 'Player One'), 4, 4, 5);

  const saved = [...a.zones.values()].map((z) => ({ ...z }));
  const fresh = new Authority();
  const kept = fresh.restoreZones(saved);

  assert.equal(kept, 1);
  const z = fresh.zones.get('zone_p1');
  assert.ok(z, 'the ground is still held');
  assert.equal(fresh.zoneAt(4, 4), z);
});

test('a restored claim starts already fading', () => {
  // After a restart you must work to keep ground, not merely log in -- the same rule
  // as everyone else.
  const a = new Authority();
  a.restoreZones([{ ownerId: 'p1', ownerName: 'One', cx: 0, cz: 0, half: 4 }]);
  assert.equal(a.zoneState(a.zones.get('zone_p1')), 'fading');
});

test('malformed saved claims are dropped rather than restored', () => {
  // A zone with no owner would block every builder in the area with nobody able to
  // claim or release it: a permanently walled-off district.
  const a = new Authority();
  const kept = a.restoreZones([
    null,
    { ownerId: 'p1', cx: 0, cz: 0, half: 4 },
    { cx: 5, cz: 5, half: 4 },            // no owner
    { ownerId: 'p2' },                    // no position
    { ownerId: 'p3', cx: NaN, cz: 0 },    // not a number
    'not an object',
  ]);
  assert.equal(kept, 1, 'only the well-formed claim survived');
  assert.equal(a.zones.size, 1);
});

test('restoreZones rejects a non-array', () => {
  const a = new Authority();
  assert.equal(a.restoreZones(null), 0);
  assert.equal(a.restoreZones(undefined), 0);
  assert.equal(a.restoreZones('nope'), 0);
});

test('a restored claim clamps its size like a fresh one', () => {
  // A hand-edited or stale save must not be able to create an unbounded claim.
  const a = new Authority();
  a.restoreZones([{ ownerId: 'p1', cx: 0, cz: 0, half: 9999 }]);
  assert.equal(a.zones.get('zone_p1').half, 12);
});

// ---------------------------------------------------------------------------
// Design invariants
// ---------------------------------------------------------------------------

test('the grace window is shorter than the lifetime', () => {
  // If HOLD >= TTL there is never a 'live' state to decay from, and the warning
  // would be the whole life of the claim.
  assert.ok(HOLD < T, `hold ${HOLD} must be under ttl ${T}`);
  assert.ok(HOLD > 0 && T > 0);
});

test('the grace window is long enough to cover a coffee', () => {
  // Two minutes of warning before losing ground. A shorter fuse turns a bathroom
  // break into a disaster and teaches players that claims are a punishment.
  assert.ok(HOLD >= 60_000, `hold of ${HOLD}ms is too short to be fair`);
});

test('every zone state the server can send is one the client handles', () => {
  const a = new Authority();
  const actor = makeActor();
  claim(a, actor, 0, 0);
  const z = mine(a, actor);

  const states = new Set();
  for (const exp of [Date.now() + T, Date.now() + HOLD - 1, Date.now() - 1]) {
    z.expiresAt = exp;
    states.add(a.zoneState(z));
  }
  assert.deepEqual([...states].sort(), ['expiring', 'fading', 'live']);
});