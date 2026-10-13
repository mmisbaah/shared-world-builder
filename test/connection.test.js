import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../public/src/world/world.js';
import { Connection } from '../public/src/net/connection.js';
import { OP, DENY, EV, CHUNK_SIZE, voxelIndex, encodeCells, decodeCells, UNDO_DEPTH, WORLD } from '../shared/protocol.js';
import { AUTHOR_CAP } from '../public/src/net/connection.js';

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

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------
//
// The client keeps a count, not a history. Everything about *which* edit gets
// reverted is the server's decision, so the only thing worth testing here is
// that the count agrees with the server often enough for the button to be
// honest -- and that undo, having predicted nothing, never reaches the code
// that rolls predictions back.

test('an accepted edit joins the history, a denied one does not', () => {
  const { conn, sent } = harness();
  assert.equal(conn.undoDepth, 0, 'nothing to undo at boot');

  conn.placeBlock(0, 1, 0, STONE);
  answer(sent, conn, 0, { ok: true, result: { x: 0, y: 1, z: 0, mat: STONE, rev: 7 } });
  assert.equal(conn.undoDepth, 1);

  conn.placeBlock(1, 1, 0, STONE);
  answer(sent, conn, 1, { ok: false, deny: DENY.OCCUPIED, reason: 'occupied' });
  assert.equal(conn.undoDepth, 1, 'a refusal is not history the player can unwind');
});

test('undo sends nothing when there is no history', () => {
  const { conn, sent } = harness();
  assert.equal(conn.undo(), false);
  assert.equal(sent.length, 0, 'and does not spend a round trip proving it');
});

test('a successful undo decrements the history', () => {
  const { conn, sent } = harness();
  conn.placeBlock(0, 1, 0, STONE);
  answer(sent, conn, 0, { ok: true, result: { x: 0, y: 1, z: 0, mat: STONE, rev: 7 } });
  assert.equal(conn.undoDepth, 1);

  assert.equal(conn.undo(), true);
  answer(sent, conn, 1, { ok: true, result: { x: 0, y: 1, z: 0, mat: 0, rev: 8 } });
  assert.equal(conn.undoDepth, 0);
});

test('an empty-stack denial resets the count instead of decrementing it', () => {
  // The local count can run ahead of the server after a lost ack. Zeroing is
  // what makes it converge; decrementing would leave it permanently wrong.
  const { conn, sent } = harness();
  conn.placeBlock(0, 1, 0, STONE);
  answer(sent, conn, 0, { ok: true, result: { x: 0, y: 1, z: 0, mat: STONE, rev: 7 } });
  assert.equal(conn.undoDepth, 1);

  conn.undo();
  answer(sent, conn, 1, { ok: false, deny: DENY.EMPTY, reason: 'nothing to undo' });
  assert.equal(conn.undoDepth, 0, 'the server knows better than the local count');
});

test('a refusal because the world moved on keeps the rest of the history', () => {
  const { conn, sent } = harness();
  for (let i = 0; i < 3; i++) {
    conn.placeBlock(i, 1, 0, STONE);
    answer(sent, conn, i, { ok: true, result: { x: i, y: 1, z: 0, mat: STONE, rev: 7 + i } });
  }
  assert.equal(conn.undoDepth, 3);

  conn.undo();
  answer(sent, conn, 3, { ok: false, deny: DENY.OCCUPIED, reason: 'that block has changed' });
  assert.equal(conn.undoDepth, 2, 'the other two undos still work');
});

test('the history count is capped at the depth the server keeps', () => {
  const { conn, sent } = harness();
  for (let i = 0; i < UNDO_DEPTH + 4; i++) {
    conn.placeBlock(i % CHUNK_SIZE, 1, (i / CHUNK_SIZE) | 0, STONE);
    answer(sent, conn, i, { ok: true, result: { x: 0, y: 1, z: 0, mat: STONE, rev: 7 + i } });
  }
  assert.equal(conn.undoDepth, UNDO_DEPTH,
    'the button must not promise an undo the stack has already trimmed');
});

test('rollback paths ignore an op that never predicted anything', () => {
  // Reached from timeout and disconnect, not only from a denial: undo has no
  // overlay and its record carries no coordinates, so settling would write to an
  // undefined voxel and rejecting would report a race that never happened.
  const { world, conn } = harness();
  const rec = { type: OP.UNDO, opId: 99 };
  const before = conn.drainEvents().length;

  conn._settle(rec, { x: 0, y: 1, z: 0, mat: 0, rev: 3 });
  conn._reject(rec, { ok: false, deny: DENY.EMPTY, reason: 'nothing to undo' });

  assert.equal(conn.drainEvents().length, before, 'nothing was rolled back or reported');
  assert.equal(world.hasPrediction(0, 1, 0), false, 'no phantom overlay appeared');
});

// ---------------------------------------------------------------------------
// Attribution (hover readout)
// ---------------------------------------------------------------------------

test('a witnessed edit is attributed to whoever made it', () => {
  const { conn } = harness();
  assert.equal(conn.authorOf(2, 4, 2), null,
    'unwitnessed work is unattributed, never guessed');

  conn._onDelta(delta(0, 0, [[voxelIndex(2, 4, 2), STONE, 7]], 'b_me'));
  assert.equal(conn.authorOf(2, 4, 2), 'b_me');
});

test('the newest author wins when a voxel is rebuilt', () => {
  const { conn } = harness();
  conn._onDelta(delta(0, 0, [[voxelIndex(2, 4, 2), STONE, 7]], 'b_me'));
  conn._onDelta(delta(0, 0, [[voxelIndex(2, 4, 2), BRICK, 9]], 'bot_maya'));
  assert.equal(conn.authorOf(2, 4, 2), 'bot_maya');
});

test('our own edits are recorded too', () => {
  // Knowing you built the wall you are aiming at is the whole point of the
  // readout, not a special case to be filtered out.
  const { conn } = harness();
  conn._onDelta(delta(0, 0, [[voxelIndex(1, 1, 1), STONE, 3]], 'b_me'));
  assert.equal(conn.authorOf(1, 1, 1), 'b_me');
});

test('a removal spends no attribution budget', () => {
  // Once the voxel is air there is nothing left to aim at, so recording it
  // would evict a block that still exists in favour of one that does not.
  const { conn } = harness();
  conn._onDelta(delta(0, 0, [[voxelIndex(2, 4, 2), 0, 7]], 'b_me'));
  assert.equal(conn.authorOf(2, 4, 2), null);
  assert.equal(conn.authors.size, 0);
});

test('authorship is bounded and evicts the least recently changed voxel', () => {
  const { conn } = harness();
  const oldestY = WORLD.MAX_Y - 1;
  const oldest = [voxelIndex(15, oldestY, 15), STONE, 1];
  const filler = [];
  for (let i = 0; i < AUTHOR_CAP + 8; i++) filler.push([i, STONE, 1]);

  conn._onDelta(delta(0, 0, [oldest, ...filler], 'b_me'));

  assert.equal(conn.authors.size, AUTHOR_CAP, 'the map never grows past its budget');
  assert.equal(conn.authorOf(15, oldestY, 15), null, 'the oldest attribution fell off');
});

test('a builder id resolves for bots as well as for people', () => {
  // The busiest hands in this world belong to four bots, so an attribution that
  // answered for people and shrugged for them would name less than half the work.
  const { conn } = harness();
  conn.bots = [{ id: 'bot_maya', name: 'Maya_Craft', color: '#a855f7' }];
  conn.builders.set('b_x', { id: 'b_x', name: 'Someone', color: '#0ff' });

  assert.equal(conn.builder('bot_maya').name, 'Maya_Craft');
  assert.equal(conn.builder('b_x').name, 'Someone');
  assert.equal(conn.builder('nobody'), null);
  assert.equal(conn.builder(null), null, 'and an absent id is not a lookup');
});

// ---------------------------------------------------------------------------
// Holding deltas for a time-lapse
// ---------------------------------------------------------------------------

test('a held delta is not applied to the world', () => {
  // The bots keep building while a player is watching the past. Letting one
  // through would stamp a present-tense edit onto a past-tense scene, and it
  // would be wrong twice over: the scrubber's log would not know about it yet,
  // so its next step could not know it had to be undone.
  const { world, conn, fromServer } = harness();
  const li = voxelIndex(1, 10, 1);

  conn.pauseDeltas();
  fromServer(EV.CHUNK_DELTA, delta(0, 0, [[li, STONE, 7]], 'b_other'));

  assert.equal(world.getAuthoritative(1, 10, 1), 0, 'the past stays the past');
  assert.equal(conn.bufferedDeltas.length, 1, 'and the edit is kept, not dropped');
});

test('resuming applies everything held and clears the flag with the queue', () => {
  const { world, conn, fromServer } = harness();
  const a = voxelIndex(1, 10, 1);
  const b = voxelIndex(2, 10, 1);

  conn.pauseDeltas();
  fromServer(EV.CHUNK_DELTA, delta(0, 0, [[a, STONE, 7]], 'b_other'));
  fromServer(EV.CHUNK_DELTA, delta(0, 0, [[b, BRICK, 8]], 'b_other'));

  assert.equal(conn.resumeDeltas(), 2, 'the count is what the caller reports to the player');
  assert.equal(world.getAuthoritative(1, 10, 1), STONE, 'in the order they arrived');
  assert.equal(world.getAuthoritative(2, 10, 1), BRICK);
  assert.equal(conn.bufferedDeltas.length, 0);
  assert.equal(conn.historyMode, false, 'the flag goes with the queue');
});

test('resuming does not re-buffer the queue it just flushed', () => {
  // The natural implementation clears the flag *after* applying, and `resume`
  // calls back into `_onDelta` -- so every delta is re-held, the world stays
  // one tick behind forever, and the failure is invisible until somebody
  // compares two clients. The flag has to come off first.
  const { world, conn, fromServer } = harness();
  const li = voxelIndex(1, 10, 1);

  conn.pauseDeltas();
  fromServer(EV.CHUNK_DELTA, delta(0, 0, [[li, STONE, 7]], 'b_other'));
  conn.resumeDeltas();

  assert.equal(conn.bufferedDeltas.length, 0, 'not still holding what was just applied');
  assert.equal(conn.resumeDeltas(), 0, 'and a second resume finds nothing to do');
  assert.equal(world.getAuthoritative(1, 10, 1), STONE, 'the value stayed put');
});

test('deltas apply immediately again once resumed', () => {
  const { world, conn, fromServer } = harness();
  const li = voxelIndex(1, 10, 1);

  conn.pauseDeltas();
  conn.resumeDeltas();
  fromServer(EV.CHUNK_DELTA, delta(0, 0, [[li, BRICK, 9]], 'b_other'));

  assert.equal(world.getAuthoritative(1, 10, 1), BRICK);
  assert.equal(conn.bufferedDeltas.length, 0, 'nothing is held outside playback');
});

test('a delta arriving while the world is rewound does not disturb the frame', () => {
  // End to end: hold, scrub, and confirm the held edit never leaks into the
  // frame -- and that it does land once playback ends.
  const { world, conn, fromServer } = harness();
  const li = voxelIndex(3, 10, 3);

  conn.pauseDeltas();
  fromServer(EV.CHUNK_DELTA, delta(0, 0, [[li, STONE, 4]], 'bot_zen'));
  assert.equal(world.getAuthoritative(3, 10, 3), 0);

  // A scrubber walking the world under it must not pick the held edit up.
  world.setAuthoritative(3, 10, 3, 0);
  assert.equal(world.getAuthoritative(3, 10, 3), 0);

  conn.resumeDeltas();
  assert.equal(world.getAuthoritative(3, 10, 3), STONE);
});