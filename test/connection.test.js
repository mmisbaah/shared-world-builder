import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../public/src/world/world.js';
import { Connection } from '../public/src/net/connection.js';
import { OP, DENY, EV, CHUNK_SIZE, voxelIndex, encodeCells, decodeCells } from '../shared/protocol.js';

const STONE = 1;
const BRICK = 2;

/** A Connection wired to a stub transport so ops can be captured and answered. */
function harness() {
  const world = new World();
  world.column(0, 0);
  const conn = new Connection(world, { artificialLatencyMs: 0 });
  conn.selfId = 'b_me';
  conn.self = { id: 'b_me', name: 'Me', color: '#0ff' };

  const sent = [];
  const handlers = new Map();
  conn.socket = {
    connected: true,
    emit: (event, payload) => sent.push({ event, payload }),
    on: (event, fn) => handlers.set(event, fn),
  };
  conn._wireSocket(conn.socket);

  /** Deliver a server->client event the way the real socket would. */
  const fromServer = (event, payload) => {
    const fn = handlers.get(event);
    assert.ok(fn, `no handler registered for "${event}"`);
    fn(payload);
  };

  return { world, conn, sent, fromServer };
}

/** Answer the nth sent op as the server would. */
function answer(sent, conn, index, msg) {
  const op = sent[index].payload;
  conn._onOpResult({ opId: op.id, t: op.t, actorId: 'b_me', ...msg });
}

const delta = (cx, cz, entries, by) => ({
  cx, cz, rev: 1, blocks: entries, props: [], propsRemoved: [], by,
});

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

test('placing predicts immediately, before anything is sent', () => {
  const { world, conn, sent } = harness();
  conn.placeBlock(2, 4, 2, STONE);

  assert.equal(world.getVoxel(2, 4, 2), STONE, 'the block must be visible at once');
  assert.equal(world.getAuthoritative(2, 4, 2), 0, 'settled state is untouched');
  assert.equal(world.hasPrediction(2, 4, 2), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.t, OP.PLACE_BLOCK);
  assert.equal(conn.stats.inflight, 1);
});

test('removing predicts the removal and carries the revision it saw', () => {
  const { world, conn, sent } = harness();
  world.setAuthoritative(2, 4, 2, STONE, 42);
  conn.removeBlock(2, 4, 2);

  assert.equal(world.getVoxel(2, 4, 2), 0, 'the block looks gone immediately');
  assert.equal(world.getAuthoritative(2, 4, 2), STONE);
  assert.equal(sent[0].payload.rev, 42, 'the revision lets the server refuse a stale remove');
});

test('a prediction on a neighbour column re-meshes it', () => {
  const { world, conn } = harness();
  world.column(1, 0);
  world.takeDirtyColumns(Infinity);
  for (const c of world.chunks.values()) c.needsMesh = false;

  conn.placeBlock(15, 3, 4, STONE); // lx = 15, the +x seam
  assert.equal(world.getColumn(0, 0).needsMesh, true);
  assert.equal(world.getColumn(1, 0).needsMesh, true, 'the seam neighbour must rebuild too');
});

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

test('accepting commits the server value and clears the prediction', () => {
  const { world, conn, sent } = harness();
  conn.placeBlock(2, 4, 2, STONE);
  answer(sent, conn, 0, { ok: true, deny: DENY.NONE, result: { x: 2, y: 4, z: 2, mat: STONE, rev: 7 } });

  assert.equal(world.getAuthoritative(2, 4, 2), STONE);
  assert.equal(world.hasPrediction(2, 4, 2), false);
  assert.equal(world.getRevision(2, 4, 2), 7);
  assert.equal(conn.stats.inflight, 0);
  assert.equal(conn.stats.accepted, 1);

  const events = conn.drainEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'accepted');
});

test('accepting an echo before the ack is not a conflict', () => {
  // The server's broadcast delta races its private ack. If the delta lands first
  // and we treated it as a lost race, the player would see a conflict shatter
  // over their own successful build.
  const { world, conn, sent } = harness();
  conn.placeBlock(2, 4, 2, STONE);

  conn._onDelta(delta(0, 0, [[voxelIndex(2, 4, 2), STONE, 7]], 'b_me'));

  assert.equal(conn.stats.conflicts, 0, 'our own placement is not a conflict');
  assert.equal(conn.drainEvents().filter((e) => e.type === 'conflict').length, 0);

  // And the arriving ack is still handled, leaving a settled voxel.
  answer(sent, conn, 0, { ok: true, deny: DENY.NONE, result: { x: 2, y: 4, z: 2, mat: STONE, rev: 7 } });
  assert.equal(world.getAuthoritative(2, 4, 2), STONE);
  assert.equal(world.hasPrediction(2, 4, 2), false);
});

test('an ack arriving before its delta leaves the delta as a no-op', () => {
  const { world, conn, sent } = harness();
  conn.placeBlock(2, 4, 2, STONE);
  answer(sent, conn, 0, { ok: true, deny: DENY.NONE, result: { x: 2, y: 4, z: 2, mat: STONE, rev: 7 } });

  const occupied = world.getColumn(0, 0).occupied;
  conn._onDelta(delta(0, 0, [[voxelIndex(2, 4, 2), STONE, 7]], 'b_me'));
  assert.equal(world.getColumn(0, 0).occupied, occupied, 're-applying must not double count');
  assert.equal(world.getAuthoritative(2, 4, 2), STONE);
});

test('an accepted removal commits air', () => {
  const { world, conn, sent } = harness();
  world.setAuthoritative(2, 4, 2, STONE, 9);
  conn.removeBlock(2, 4, 2);
  answer(sent, conn, 0, { ok: true, deny: DENY.NONE, result: { x: 2, y: 4, z: 2, mat: 0, rev: 10 } });

  assert.equal(world.getAuthoritative(2, 4, 2), 0);
  assert.equal(world.hasPrediction(2, 4, 2), false);
  assert.equal(world.getColumn(0, 0).occupied, 0);
});

// ---------------------------------------------------------------------------
// Denial and rollback
// ---------------------------------------------------------------------------

test('a plain denial rolls back to the settled value', () => {
  const { world, conn, sent } = harness();
  conn.placeBlock(2, 4, 2, STONE);
  answer(sent, conn, 0, { ok: false, deny: DENY.OUT_OF_BOUNDS, reason: 'outside build bounds' });

  assert.equal(world.getVoxel(2, 4, 2), 0, 'the ghost is gone');
  assert.equal(world.hasPrediction(2, 4, 2), false);
  assert.equal(conn.stats.denied, 1);

  const events = conn.drainEvents();
  const denial = events.find((e) => e.type === 'denied');
  assert.ok(denial);
  assert.equal(denial.deny, DENY.OUT_OF_BOUNDS);
  assert.equal(denial.conflict, undefined, 'a plain denial is not a conflict');
});

test('a lost race adopts the winner material and reports a conflict', () => {
  const { world, conn, sent } = harness();
  conn.placeBlock(2, 4, 2, STONE, { forceRace: true });

  answer(sent, conn, 0, {
    ok: false,
    deny: DENY.OCCUPIED,
    reason: 'Alex_Voxel committed this voxel first',
    winner: { id: 'bot_alex', name: 'Alex_Voxel', color: '#38bdf8', x: 2, y: 4, z: 2, mat: BRICK },
  });

  // Adopting matters: without it the world would show our stone until the
  // winner's own delta arrived.
  assert.equal(world.getVoxel(2, 4, 2), BRICK, 'the winner owns the voxel immediately');
  assert.equal(world.hasPrediction(2, 4, 2), false);
  assert.equal(conn.stats.conflicts, 1);

  const denial = conn.drainEvents().find((e) => e.type === 'denied');
  assert.equal(denial.conflict, true);
  assert.equal(denial.winner.name, 'Alex_Voxel');
  assert.equal(denial.deny, DENY.OCCUPIED);
});

test('a denial for a removal restores the block', () => {
  const { world, conn, sent } = harness();
  world.setAuthoritative(2, 4, 2, STONE, 5);
  conn.removeBlock(2, 4, 2);
  answer(sent, conn, 0, { ok: false, deny: DENY.OCCUPIED, reason: 'voxel changed since you looked at it' });

  assert.equal(world.getVoxel(2, 4, 2), STONE, 'the block comes back');
  assert.equal(world.getAuthoritative(2, 4, 2), STONE);
  assert.equal(world.hasPrediction(2, 4, 2), false);
});

// ---------------------------------------------------------------------------
// Losing a race to somebody else's delta
// ---------------------------------------------------------------------------

test("another builder filling a predicted voxel is a conflict", () => {
  const { world, conn } = harness();
  conn.placeBlock(2, 4, 2, STONE);

  conn._onDelta(delta(0, 0, [[voxelIndex(2, 4, 2), BRICK, 3]], 'bot_alex'));

  assert.equal(world.getVoxel(2, 4, 2), BRICK);
  assert.equal(world.hasPrediction(2, 4, 2), false, 'the prediction is resolved, not left hanging');
  assert.equal(conn.stats.conflicts, 1);

  const conflict = conn.drainEvents().find((e) => e.type === 'conflict');
  assert.ok(conflict);
  assert.equal(conflict.by, 'bot_alex');
  assert.equal(conflict.mat, BRICK);
});

test('a delta on an unpredicted voxel is just a delta', () => {
  const { world, conn } = harness();
  conn._onDelta(delta(0, 0, [[voxelIndex(5, 1, 5), BRICK, 3]], 'bot_alex'));
  assert.equal(world.getAuthoritative(5, 1, 5), BRICK);
  assert.equal(conn.stats.conflicts, 0);
});

test('a removal delta clears nothing it should not', () => {
  const { world, conn } = harness();
  world.setAuthoritative(5, 1, 5, BRICK, 3);
  conn._onDelta(delta(0, 0, [[voxelIndex(5, 1, 5), 0, 4]], 'bot_alex'));
  assert.equal(world.getAuthoritative(5, 1, 5), 0);
  assert.equal(conn.stats.conflicts, 0);
});

test('a delta for an unknown column is ignored rather than creating one', () => {
  const { world, conn } = harness();
  conn._onDelta(delta(9, 9, [[voxelIndex(0, 0, 0), STONE, 1]], 'bot_alex'));
  assert.equal(world.getColumn(9, 9), undefined, 'must not materialise a column from a delta');
});

test('deltas carry the column origin into world coordinates', () => {
  const { world, conn } = harness();
  world.column(2, -1);
  // Local index 5 at local y=0 should land at world x = 2*16 + 5, z = -1*16.
  conn._onDelta(delta(2, -1, [[voxelIndex(5, 0, 0), STONE, 1]], 'bot_alex'));
  assert.equal(world.getAuthoritative(37, 0, -16), STONE);
});

test('prop deltas are applied and removals are keyed by string', () => {
  const { world, conn } = harness();
  const record = { x: 2, y: 4, z: 2, prop: 'lantern', rot: 1, by: 'b_me', rev: 1 };
  conn._onDelta({ cx: 0, cz: 0, rev: 1, blocks: [], props: [record], propsRemoved: [], by: 'b_me' });
  assert.equal(world.getProp(2, 4, 2).prop, 'lantern');

  conn._onDelta({ cx: 0, cz: 0, rev: 2, blocks: [], props: [], propsRemoved: ['2,4,2'], by: 'b_me' });
  assert.equal(world.getProp(2, 4, 2), undefined);
});

// ---------------------------------------------------------------------------
// Timeouts and disconnects
// ---------------------------------------------------------------------------

test('an unanswered op rolls back when it times out', () => {
  const { world, conn } = harness();
  conn.placeBlock(2, 4, 2, STONE);
  assert.equal(world.getVoxel(2, 4, 2), STONE);

  conn.update(performance.now() + 5000);
  assert.equal(world.getVoxel(2, 4, 2), 0, 'the ghost must not linger forever');
  assert.equal(conn.stats.timedOut, 1);
  assert.equal(conn.stats.inflight, 0);
});

test('an op answered in time is not swept up by the timeout pass', () => {
  const { conn, sent } = harness();
  conn.placeBlock(2, 4, 2, 1);
  answer(sent, conn, 0, { ok: true, deny: DENY.NONE, result: { x: 2, y: 4, z: 2, mat: 1, rev: 1 } });
  conn.update(performance.now() + 5000);
  assert.equal(conn.stats.timedOut, 0);
});

test('a disconnect rolls back every pending op at once', () => {
  const { world, conn } = harness();
  conn.placeBlock(1, 4, 1, 1);
  conn.placeBlock(2, 4, 2, 1);
  conn.placeBlock(3, 4, 3, 1);
  assert.equal(conn.pending.size, 3);

  conn._failAll('disconnected');
  assert.equal(world.predictionCount, 0, 'no ghost may survive a disconnect');
  assert.equal(conn.pending.size, 0);
  assert.equal(conn.stats.timedOut, 3);
});

test('a late answer to a timed-out op is discarded', () => {
  const { world, conn, sent } = harness();
  conn.placeBlock(2, 4, 2, STONE);
  conn.update(performance.now() + 5000); // times out and rolls back

  answer(sent, conn, 0, { ok: true, deny: DENY.NONE, result: { x: 2, y: 4, z: 2, mat: STONE, rev: 1 } });
  assert.equal(world.getVoxel(2, 4, 2), 0, 'a stale ack must not resurrect the ghost');
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test('answers are matched by op id, not by arrival order', () => {
  const { world, conn, sent } = harness();
  conn.placeBlock(1, 4, 1, 1);
  conn.placeBlock(2, 4, 2, 2);
  conn.placeBlock(3, 4, 3, 3);

  // Answer out of order: middle first, then last, then first.
  answer(sent, conn, 1, { ok: false, deny: DENY.LOCKED, reason: 'locked' });
  assert.equal(world.getVoxel(2, 4, 2), 0, 'the denied one rolled back');
  assert.equal(world.getVoxel(1, 4, 1), 1, 'the others are still pending');
  assert.equal(world.getVoxel(3, 4, 3), 3);

  answer(sent, conn, 2, { ok: true, deny: DENY.NONE, result: { x: 3, y: 4, z: 3, mat: 3, rev: 2 } });
  answer(sent, conn, 0, { ok: true, deny: DENY.NONE, result: { x: 1, y: 4, z: 1, mat: 1, rev: 1 } });

  assert.equal(conn.pending.size, 0);
  assert.equal(world.getAuthoritative(1, 4, 1), 1);
  assert.equal(world.getAuthoritative(3, 4, 3), 3);
  assert.equal(conn.stats.accepted, 2);
  assert.equal(conn.stats.denied, 1);
});

test('two ops on the same voxel resolve in the order they were answered', () => {
  const { world, conn, sent } = harness();
  conn.placeBlock(2, 4, 2, 1);
  conn.placeBlock(2, 4, 2, 2); // second op on an already-predicted cell

  answer(sent, conn, 1, { ok: true, deny: DENY.NONE, result: { x: 2, y: 4, z: 2, mat: 2, rev: 5 } });
  assert.equal(world.getAuthoritative(2, 4, 2), 2);

  answer(sent, conn, 0, { ok: false, deny: DENY.OCCUPIED, reason: 'voxel already occupied' });
  assert.equal(world.getAuthoritative(2, 4, 2), 2, 'the older denial must not clear the newer value');
});

test('sending while offline fails the op instead of leaving a ghost', async () => {
  const { world, conn } = harness();
  conn.socket.connected = false;
  conn.placeBlock(2, 4, 2, 1);
  assert.equal(world.getVoxel(2, 4, 2), 1, 'predicted first, as always');

  await new Promise((r) => setTimeout(r, 0));
  assert.equal(world.getVoxel(2, 4, 2), 0, 'then resolved locally as offline');
  assert.equal(conn.pending.size, 0);
});

// ---------------------------------------------------------------------------
// Zones, locks, presence
// ---------------------------------------------------------------------------

test('claiming a zone replaces any previous claim by the same builder', () => {
  const { conn, sent } = harness();
  conn.zones = [
    { id: 'zone_b_me', ownerId: 'b_me', x0: 0, x1: 4, z0: 0, z1: 4 },
    { id: 'zone_b_them', ownerId: 'b_them', x0: 8, x1: 12, z0: 8, z1: 12 },
  ];
  conn.claimZone(20, 20, 5);
  answer(sent, conn, 0, {
    ok: true, deny: DENY.NONE,
    result: { id: 'zone_b_me', ownerId: 'b_me', x0: 15, x1: 25, z0: 15, z1: 25 },
  });

  const mine = conn.zones.filter((z) => z.ownerId === 'b_me');
  assert.equal(mine.length, 1, 'one claim per builder, moved not duplicated');
  assert.equal(mine[0].x0, 15);
  assert.equal(conn.zones.filter((z) => z.ownerId === 'b_them').length, 1, 'others untouched');
});

test('zoneAt finds the containing zone', () => {
  const { conn } = harness();
  conn.zones = [{ ownerId: 'b_them', x0: -4, x1: 4, z0: -4, z1: 4 }];
  assert.equal(conn.zoneAt(0, 0).ownerId, 'b_them');
  assert.equal(conn.zoneAt(10, 0), null);
  assert.equal(conn.zoneAt(4, 0), null, 'the upper bound is exclusive');
});

test('requesting a lock records the holder locally', () => {
  const { conn, sent } = harness();
  conn.requestLock(2, 4, 2);
  answer(sent, conn, 0, { ok: true, deny: DENY.NONE, result: { x: 2, y: 4, z: 2, holder: 'b_me' } });
  assert.equal(conn.lockHolder(2, 4, 2), 'b_me');
  assert.equal(conn.lockHolder(9, 9, 9), null);
});

test('a denied lock is not recorded', () => {
  const { conn, sent } = harness();
  conn.requestLock(2, 4, 2);
  answer(sent, conn, 0, { ok: false, deny: DENY.LOCKED, result: { holder: 'b_them' } });
  assert.equal(conn.lockHolder(2, 4, 2), null);
});

test('the locks broadcast replaces the local picture wholesale', () => {
  const { conn, fromServer } = harness();
  conn.locks.set('1,1,1', 'b_me');
  fromServer('locks', { locks: [{ key: '2,2,2', builderId: 'b_them' }] });
  assert.equal(conn.locks.size, 1);
  assert.equal(conn.lockHolder(2, 2, 2), 'b_them');
  assert.equal(conn.lockHolder(1, 1, 1), null, 'locks that expired must not linger');
});

test('an empty locks broadcast clears every lock', () => {
  const { conn, fromServer } = harness();
  conn.locks.set('1,1,1', 'b_me');
  fromServer('locks', { locks: [] });
  assert.equal(conn.locks.size, 0);
});

test('a presence broadcast replaces builders and bots', () => {
  const { conn, fromServer } = harness();
  fromServer('presence', {
    builders: [{ id: 'b_a', name: 'A' }, { id: 'b_b', name: 'B' }],
    bots: [{ id: 'bot_1', name: 'Bot' }],
  });
  assert.equal(conn.builders.size, 2);
  assert.equal(conn.bots.length, 1);
  assert.equal(conn.builder('b_a').name, 'A');
  assert.equal(conn.builder('nope'), null);

  fromServer('presence', { builders: [{ id: 'b_a', name: 'A' }], bots: [] });
  assert.equal(conn.builders.size, 1, 'departed builders must be dropped');
});

test('a zones broadcast replaces the claim list', () => {
  const { conn, fromServer } = harness();
  fromServer('zones', { zones: [{ ownerId: 'b_them', x0: 0, x1: 4, z0: 0, z1: 4 }] });
  assert.equal(conn.zones.length, 1);
  fromServer('zones', { zones: [] });
  assert.equal(conn.zones.length, 0);
});

test('a bot action is queued as a renderer event', () => {
  const { conn, fromServer } = harness();
  fromServer('botAction', { builderId: 'bot_1', x: 1, y: 2, z: 3, t: 1 });
  const events = conn.drainEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'bot');
  assert.deepEqual([events[0].x, events[0].y, events[0].z], [1, 2, 3]);
});

test('a disconnect event rolls back and marks the connection down', () => {
  const { world, conn, fromServer } = harness();
  conn.placeBlock(2, 4, 2, 1);
  fromServer('disconnect');
  assert.equal(conn.connected, false);
  assert.equal(world.predictionCount, 0);
});

test('the welcome snapshot seeds columns and queues them for meshing', () => {
  const { world, conn } = harness();
  const cells = new Uint16Array(12288);
  cells[voxelIndex(3, 4, 3)] = STONE;
  conn._onWelcome({
    you: { id: 'b_me', name: 'Me', color: '#0ff' },
    snapshot: {
      chunks: [{
        cx: 1, cz: 1, rev: 3,
        cells: encodeCells(cells),
        props: [{ x: 3, y: 4, z: 3, prop: 'torch', by: 'b_them', rev: 2 }],
      }],
      zones: [{ id: 'z1', ownerId: 'b_them', x0: 0, x1: 4, z0: 0, z1: 4 }],
    },
    presence: { builders: [{ id: 'b_them', name: 'Them' }], bots: [{ id: 'bot_1', name: 'Bot' }] },
  });

  const col = world.getColumn(1, 1);
  assert.ok(col);
  assert.equal(col.occupied, 1);
  assert.equal(world.getVoxel(CHUNK_SIZE + 3, 4, CHUNK_SIZE + 3), STONE, 'snapshot is offset by the column origin');
  assert.equal(col.props.size, 1);
  assert.equal(world.dirtyColumns.has('1,1'), true, 'the column must be queued for meshing');
  assert.equal(conn.builders.size, 1);
  assert.equal(conn.bots.length, 1);
  assert.equal(conn.zones.length, 1);
});

test('snapshot cells survive the base64 round trip', () => {
  // Materials are single digits, so this is a compact transport -- but a wrong
  // stride or a dropped byte would silently corrupt a column, so pin it down.
  const cells = new Uint16Array(12288);
  for (const y of [0, 1, 15, 16, 31, 47]) cells[voxelIndex(5, y, 7)] = (y % 8) + 1;
  const back = decodeCells(encodeCells(cells));
  assert.equal(back.length, cells.length);
  for (let i = 0; i < cells.length; i++) assert.equal(back[i], cells[i], `index ${i}`);
});

test('empty snapshot chunks are skipped by the server but handled if present', () => {
  const { world, conn } = harness();
  conn._onWelcome({
    you: { id: 'b_me', name: 'Me', color: '#0ff' },
    snapshot: { chunks: [], zones: [] },
    presence: { builders: [], bots: [] },
  });
  assert.equal(world.chunks.size, 1, 'only the pre-created test column remains');
  assert.equal(conn.zones.length, 0);
});

test('events queue up and drain exactly once', () => {
  const { conn, sent } = harness();
  conn.placeBlock(2, 4, 2, 1);
  answer(sent, conn, 0, { ok: true, deny: DENY.NONE, result: { x: 2, y: 4, z: 2, mat: 1, rev: 1 } });

  const first = conn.drainEvents();
  assert.equal(first.length, 1);
  assert.equal(conn.drainEvents().length, 0, 'draining twice must not replay events');
});

test('a latency probe measures round trip time', () => {
  const { conn, sent } = harness();
  const id = conn.ping();
  assert.equal(sent[0].payload.t, OP.PING);
  conn._onOpResult({ opId: id, ok: true, deny: DENY.NONE });
  assert.ok(conn.rtt >= 0 && conn.rtt < 50, `rtt ${conn.rtt} should be a small non-negative number`);
});

test('probe ids never collide with op ids', () => {
  // The bug this guards: probes and ops were both numbered from 1, so a probe
  // answer could be matched to a pending placement and delete it.
  const { conn, sent } = harness();
  conn.placeBlock(1, 4, 1, 1);
  conn.placeBlock(2, 4, 2, 1);
  const pingId = conn.ping();

  assert.notEqual(pingId, 1);
  assert.notEqual(pingId, 2);
  assert.ok(pingId > 1_000_000, `probe id ${pingId} must sit above the op range`);
  assert.equal(conn.pending.size, 2, 'a probe must not enter the pending table');

  // The probe answer must leave both ops untouched.
  conn._onOpResult({ opId: pingId, ok: true, deny: DENY.NONE });
  assert.equal(conn.pending.size, 2, 'a probe answer must not consume a pending op');
  assert.ok(conn.rtt >= 0, 'and must still measure rtt');
});

test('every probe is answerable, so none are left stranded', () => {
  // Previously 107 of 112 probe entries went unanswered because the rtt read sat
  // after an early return for unknown ids.
  const { conn, sent } = harness();
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(conn.ping());
  assert.equal(conn._pingSentAt.size, 12);

  for (const id of ids) conn._onOpResult({ opId: id, ok: true, deny: DENY.NONE });
  assert.equal(conn._pingSentAt.size, 0, 'answered probes must be cleared');
});

test('abandoned probes are pruned instead of leaking', () => {
  const { conn } = harness();
  for (let i = 0; i < 5; i++) conn.ping();
  assert.equal(conn._pingSentAt.size, 5);
  conn.update(performance.now() + 10_000);
  assert.equal(conn._pingSentAt.size, 0, 'unanswered probes must not accumulate forever');
});

test('rtt tracks the best recent sample, not a one-off spike', () => {
  const { conn } = harness();
  conn._sampleRtt(24);
  assert.equal(conn.rtt, 24);
  conn._sampleRtt(4000); // a backgrounded tab, or a real stall
  assert.equal(conn.rtt, 24, 'a single spike must not become the reported figure');
  conn._sampleRtt(20);
  assert.equal(conn.rtt, 20, 'a genuinely better sample still lowers it');
});

test('a nonsensical rtt sample is ignored', () => {
  const { conn } = harness();
  conn._sampleRtt(30);
  conn._sampleRtt(NaN);
  conn._sampleRtt(-5);
  assert.equal(conn.rtt, 30);
});