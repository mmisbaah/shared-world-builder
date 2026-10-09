import {
  CHUNK_SIZE, COLUMN_VOLUME, voxelIndex, chunkKey, worldToChunk, voxelKey,
  OP, DENY, WORLD, encodeCells, UNDO_DEPTH,
} from '../shared/protocol.js';
import { isValidMaterial, isValidProp, PROP_KEYS } from '../shared/materials.js';

/**
 * The authoritative world.
 *
 * Everything the client is allowed to believe lives here and nowhere else. The
 * client keeps a *predicted* overlay for responsiveness; this class owns the
 * settled state and is the only thing allowed to mutate it.
 *
 * Conflict model
 * --------------
 * Every voxel carries a monotonically increasing revision. Two independent
 * mechanisms produce a rejection the client can roll back against:
 *
 *   - Structural: placing into an occupied voxel, or removing an empty one.
 *   - Optimistic: a mutation carries the revision it was based on. If the
 *     revision moved on, the write is stale and is refused even when the voxel
 *     is still technically placeable. This is what makes "I looked at an empty
 *     cell, but you filled it before my packet landed" a first-class case
 *     rather than a lucky accident of arrival order.
 */
export class Authority {
  constructor() {
    /** @type {Map<string, {cells:Uint16Array, revs:Uint32Array, props:Map<string,object>, rev:number}>} */
    this.chunks = new Map();
    /** @type {Map<string, {builderId:string, expiresAt:number}>} */
    this.locks = new Map();
    /** @type {Map<string, object>} */
    this.zones = new Map();
    this.revCounter = 1;
    /** Per-builder op accounting for the rate limiter. */
    this.budget = new Map();
    /** Buffered deltas, flushed once per tick. */
    this.pending = new Map();
    /**
     * Per-builder revert history, newest last: builderId -> entry[].
     *
     * Keyed by builder rather than shared, because undo may only ever touch the
     * caller's own work -- see `undoEntry`. Entries are written only from the
     * op paths a socket can reach, which deliberately excludes the bot
     * commits (`commitAs` and friends): those stacks would be written and never
     * read, in the hottest loop in the server.
     *
     * @type {Map<string, object[]>}
     */
    this.undoStacks = new Map();
  }

  // -------------------------------------------------------------------------
  // Chunk storage
  // -------------------------------------------------------------------------

  chunk(cx, cz) {
    const key = chunkKey(cx, cz);
    let c = this.chunks.get(key);
    if (!c) {
      c = {
        cx, cz,
        cells: new Uint16Array(COLUMN_VOLUME),
        revs: new Uint32Array(COLUMN_VOLUME),
        props: new Map(),
        rev: 0,
      };
      this.chunks.set(key, c);
    }
    return c;
  }

  /** Read a world voxel. Returns 0 for air, including outside loaded chunks. */
  getBlock(x, y, z) {
    if (y < WORLD.MIN_Y || y >= WORLD.MAX_Y) return 0;
    const { cx, cz } = worldToChunk(x, y, z);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return 0;
    return c.cells[voxelIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)];
  }

  getRevision(x, y, z) {
    const { cx, cz } = worldToChunk(x, y, z);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return 0;
    return c.revs[voxelIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)];
  }

  setBlock(x, y, z, mat) {
    const { cx, cz } = worldToChunk(x, y, z);
    const c = this.chunk(cx, cz);
    const i = voxelIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE);
    c.cells[i] = mat;
    const rev = this.revCounter++;
    c.revs[i] = rev;
    c.rev++;
    return rev;
  }

  // -------------------------------------------------------------------------
  // Bounds, zones and locks
  // -------------------------------------------------------------------------

  inBounds(x, y, z) {
    return y >= WORLD.MIN_Y && y < WORLD.MAX_Y
      && x * x + z * z <= WORLD.RADIUS * WORLD.RADIUS;
  }

  /** The zone containing this voxel, if any. */
  zoneAt(x, z) {
    for (const zone of this.zones.values()) {
      if (x >= zone.x0 && x < zone.x1 && z >= zone.z0 && z < zone.z1) return zone;
    }
    return null;
  }

  pruneLocks(now) {
    for (const [key, lock] of this.locks) {
      if (lock.expiresAt <= now) this.locks.delete(key);
    }
  }

  lockHolder(x, y, z) {
    const lock = this.locks.get(voxelKey(x, y, z));
    if (!lock) return null;
    if (lock.expiresAt <= Date.now()) {
      this.locks.delete(voxelKey(x, y, z));
      return null;
    }
    return lock.builderId;
  }

  // -------------------------------------------------------------------------
  // Delta batching
  // -------------------------------------------------------------------------

  /**
   * Record a settled change for broadcast. Multiple mutations to the same chunk
   * inside one tick collapse into a single delta packet.
   */
  record(cx, cz, mutate) {
    const key = chunkKey(cx, cz);
    let d = this.pending.get(key);
    if (!d) {
      d = { cx, cz, rev: 0, blocks: [], props: [], propsRemoved: [], by: null };
      this.pending.set(key, d);
    }
    mutate(d);
    return d;
  }

  flush() {
    if (this.pending.size === 0) return [];
    const out = [...this.pending.values()];
    this.pending.clear();
    return out;
  }

  // -------------------------------------------------------------------------
  // Operation validation + application
  // -------------------------------------------------------------------------

  /**
   * Validate and (if valid) apply one client operation.
   * @returns {{ok:boolean, deny:number, opId:number, op:number,
   *            result?:object, reason?:string}}
   */
  apply(op, actor) {
    const reject = (deny, reason) => ({ ok: false, deny, reason, opId: op.id, op: op.t });

    if (!this.spendBudget(actor.id)) return reject(DENY.RATE_LIMITED, 'slow down');
    this.pruneLocks(Date.now());

    switch (op.t) {
      case OP.PLACE_BLOCK: return this.placeBlock(op, actor);
      case OP.REMOVE_BLOCK: return this.removeBlock(op, actor);
      case OP.PLACE_PROP: return this.placeProp(op, actor);
      case OP.REMOVE_PROP: return this.removeProp(op, actor);
      case OP.CLAIM_ZONE: return this.claimZone(op, actor);
      case OP.RELEASE_ZONE: return this.releaseZone(op, actor);
      case OP.REQUEST_LOCK: return this.requestLock(op, actor);
      case OP.RELEASE_LOCK: return this.releaseLock(op, actor);
      case OP.UNDO: return this.undoEntry(op, actor);
      default: return reject(DENY.UNKNOWN_MATERIAL, 'unknown op');
    }
  }

  spendBudget(builderId) {
    const now = Date.now();
    let b = this.budget.get(builderId);
    if (!b || now - b.since > 1000) {
      this.budget.set(builderId, { since: now, count: 1 });
      return true;
    }
    if (b.count >= WORLD.MAX_OPS_PER_TICK) return false;
    b.count++;
    return true;
  }

  /**
   * Shared pre-flight: bounds, locks and zone permissions.
   *
   * `ok: false` is set explicitly rather than left for callers to patch on. Every
   * other rejection path in this class returns an explicit boolean, and a missing
   * `ok` makes `result.ok === false` quietly false for any caller that tests for
   * strict equality instead of truthiness.
   */
  preflight(op, actor) {
    const { x, y, z } = op;
    if (!this.inBounds(x, y, z)) {
      return { ok: false, deny: DENY.OUT_OF_BOUNDS, reason: 'outside build bounds' };
    }

    const holder = this.lockHolder(x, y, z);
    if (holder && holder !== actor.id) {
      return { ok: false, deny: DENY.LOCKED, reason: 'another builder holds this voxel' };
    }

    const zone = this.zoneAt(x, z);
    if (zone && zone.ownerId !== actor.id) {
      return { ok: false, deny: DENY.NOT_CLAIMED, reason: `inside ${zone.ownerName}'s claim` };
    }
    return null;
  }

  placeBlock(op, actor) {
    const { x, y, z } = op;
    if (!isValidMaterial(op.mat)) return { ok: false, deny: DENY.UNKNOWN_MATERIAL, reason: 'bad material', opId: op.id, op: op.t };

    const bad = this.preflight(op, actor);
    if (bad) return { ...bad, opId: op.id, op: op.t };

    // Injected latency race: a bot commits this exact voxel first, then we run
    // the ordinary validation. The client is already predicting a placement
    // here, so it gets a genuine OCCUPIED rejection to roll back against.
    if (op.forceRace && this.getBlock(x, y, z) === 0) {
      const bot = this.rivalBuilder(actor.id);
      const rev = this.setBlock(x, y, z, bot.mat);
      this.record(worldToChunk(x, y, z).cx, worldToChunk(x, y, z).cz, (d) => {
        d.blocks.push([voxelIndex(x - worldToChunk(x, y, z).cx * CHUNK_SIZE, y, z - worldToChunk(x, y, z).cz * CHUNK_SIZE), bot.mat, rev]);
        d.by = bot.id;
      });
      return {
        ok: false, deny: DENY.OCCUPIED, opId: op.id, op: op.t,
        reason: `${bot.name} committed this voxel first`,
        winner: { id: bot.id, name: bot.name, color: bot.color, x, y, z, mat: bot.mat },
      };
    }

    if (this.getBlock(x, y, z) !== 0) {
      return { ok: false, deny: DENY.OCCUPIED, reason: 'voxel already occupied', opId: op.id, op: op.t };
    }

    // Captured before the write: an undo restores *this* value, so it has to be
    // read while it is still on the voxel rather than inferred afterwards.
    const prevMat = this.getBlock(x, y, z);
    const rev = this.setBlock(x, y, z, op.mat);
    this._pushUndo(actor, { kind: 'block', x, y, z, prevMat, rev });
    const { cx, cz } = worldToChunk(x, y, z);
    this.record(cx, cz, (d) => {
      d.blocks.push([
        voxelIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE), op.mat, rev,
      ]);
      d.by = actor.id;
    });
    // Building is what keeps a claim alive. Called only when the edit actually
    // landed, so a denied op cannot hold a district open by spamming.
    this.touchZone(actor.id);
    return { ok: true, deny: DENY.NONE, opId: op.id, op: op.t, result: { x, y, z, mat: op.mat, rev, by: actor.id } };
  }

  removeBlock(op, actor) {
    const { x, y, z } = op;
    const bad = this.preflight(op, actor);
    if (bad) return { ...bad, opId: op.id, op: op.t };

    // Optimistic concurrency: if the client based this removal on a revision
    // that has since moved, refuse even if the voxel is still solid.
    if (op.rev !== undefined && op.rev !== 0 && this.getRevision(x, y, z) !== op.rev) {
      return { ok: false, deny: DENY.OCCUPIED, reason: 'voxel changed since you looked at it', opId: op.id, op: op.t };
    }

    if (this.getBlock(x, y, z) === 0) {
      return { ok: false, deny: DENY.EMPTY, reason: 'voxel is already air', opId: op.id, op: op.t };
    }

    const { cx, cz } = worldToChunk(x, y, z);
    // The block being lifted is what an undo puts back, so it is read first.
    const prevMat = this.getBlock(x, y, z);
    const rev = this.setBlock(x, y, z, 0);
    this._pushUndo(actor, { kind: 'block', x, y, z, prevMat, rev });
    this.record(cx, cz, (d) => {
      d.blocks.push([voxelIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE), 0, rev]);
      d.by = actor.id;
    });
    return { ok: true, deny: DENY.NONE, opId: op.id, op: op.t, result: { x, y, z, mat: 0, rev, by: actor.id } };
  }

  placeProp(op, actor) {
    const { x, y, z } = op;
    if (!isValidProp(op.prop)) {
      return { ok: false, deny: DENY.UNKNOWN_PROP, reason: 'bad prop', opId: op.id, op: op.t };
    }
    const bad = this.preflight(op, actor);
    if (bad) return { ...bad, opId: op.id, op: op.t };

    // A prop occupies the air cell it is snapped into, so that cell must be
    // empty, and it must have something to stand on.
    if (this.getBlock(x, y, z) !== 0) {
      return { ok: false, deny: DENY.OCCUPIED, reason: 'a block already occupies that cell', opId: op.id, op: op.t };
    }
    if (y === WORLD.MIN_Y || this.getBlock(x, y - 1, z) === 0) {
      return { ok: false, deny: DENY.EMPTY, reason: 'props need solid ground beneath them', opId: op.id, op: op.t };
    }

    const { cx, cz } = worldToChunk(x, y, z);
    const c = this.chunk(cx, cz);
    const pkey = voxelKey(x, y, z);
    if (c.props.has(pkey)) {
      return { ok: false, deny: DENY.OCCUPIED, reason: 'something already stands here', opId: op.id, op: op.t };
    }

    const record = {
      x, y, z, prop: op.prop, rot: op.rot | 0, by: actor.id, rev: this.revCounter++,
    };
    c.props.set(pkey, record);
    c.rev++;
    this._pushUndo(actor, { kind: 'prop', x, y, z, prev: null, rev: record.rev });
    this.record(cx, cz, (d) => { d.props.push(record); d.by = actor.id; });
    // As with blocks: a prop is work, so it renews the claim too.
    this.touchZone(actor.id);
    return { ok: true, deny: DENY.NONE, opId: op.id, op: op.t, result: record };
  }

  removeProp(op, actor) {
    const { x, y, z } = op;
    const bad = this.preflight(op, actor);
    if (bad) return { ...bad, opId: op.id, op: op.t };

    const { cx, cz } = worldToChunk(x, y, z);
    const c = this.chunks.get(chunkKey(cx, cz));
    const pkey = voxelKey(x, y, z);
    const existing = c?.props.get(pkey);
    if (!existing) {
      return { ok: false, deny: DENY.EMPTY, reason: 'no prop here', opId: op.id, op: op.t };
    }
    // The whole record, not a reference: undoing a removal has to put the prop
    // back exactly as it was, including who placed it and how it was rotated.
    this._pushUndo(actor, { kind: 'prop', x, y, z, prev: { ...existing }, rev: existing.rev });
    c.props.delete(pkey);
    c.rev++;
    this.record(cx, cz, (d) => { d.propsRemoved.push(x + ',' + y + ',' + z); d.by = actor.id; });
    return { ok: true, deny: DENY.NONE, opId: op.id, op: op.t, result: { x, y, z, removed: true } };
  }

  // -------------------------------------------------------------------------
  // Undo
  // -------------------------------------------------------------------------

  /**
   * Record what a write overwrote, so it can be put back.
   *
   * Called only from the four mutation paths a socket reaches -- deliberately
   * *not* from `undoEntry`. Storing the *previous* value rather than the new one
   * is the whole trick: the new value is already in the world, and recovering
   * what was there before it would mean either scanning history or trusting the
   * client, and this server never does the second thing.
   */
  _pushUndo(actor, entry) {
    let stack = this.undoStacks.get(actor.id);
    if (!stack) {
      stack = [];
      this.undoStacks.set(actor.id, stack);
    }
    stack.push(entry);
    // Capped from the bottom: the newest edits stay reachable and the oldest
    // quietly falls off, rather than the stack growing with session length.
    while (stack.length > UNDO_DEPTH) stack.shift();
  }

  /**
   * Re-point every deeper entry for this voxel at the revision just written.
   *
   * Entries hold the revision their own edit produced, which the guard then
   * compares with the live one to ask "has anyone else been here?". An undo is
   * also a write, so it moves that number -- and without this, editing the same
   * voxel twice would strand the earlier entry behind a revision only I could
   * have caused. Re-pointing keeps the question honest: from then on, only
   * somebody *else's* write can fail it.
   *
   * Linear over at most UNDO_DEPTH entries, and only ever reached from undo, so
   * the placement path never pays for it.
   */
  _refreshUndo(actor, kind, x, y, z, rev) {
    const stack = this.undoStacks.get(actor.id);
    if (!stack) return;
    for (const e of stack) {
      if (e.kind === kind && e.x === x && e.y === y && e.z === z) e.rev = rev;
    }
  }

  /**
   * Revert this builder's own most recent edit.
   *
   * Two things make this safe in a world other people are editing too:
   *
   * 1. It pops from *this builder's* stack. The request carries no coordinates
   *    and no way to supply one, so no player can name an edit they did not
   *    make -- which is what "undo my own last N edits" has to mean when the
   *    world is shared.
   * 2. The entry's revision is compared with the voxel's current one. If anyone
   *    has written since, the world has moved on and reverting would discard
   *    *their* work rather than ours, so it is refused.
   *
   * A refusal pops as well as refusing. Leaving a permanently failing entry on
   * top would freeze every edit behind it, so an undo the world no longer
   * permits is simply spent.
   *
   * It deliberately does **not** record what it overwrote. Doing so would turn
   * undo into an undo-*redo* toggle: after reverting the newest edit, the next
   * press would revert the revert, and the player would stand in place flipping
   * one block over while believing they were walking back through their work.
   * Walking back needs the stack to shrink, so it does.
   */
  undoEntry(op, actor) {
    const stack = this.undoStacks.get(actor.id);
    const entry = stack?.length ? stack[stack.length - 1] : null;
    if (!entry) {
      return { ok: false, deny: DENY.EMPTY, reason: 'nothing to undo', opId: op.id, op: op.t };
    }
    stack.pop();

    const bad = this.preflight(entry, actor);
    if (bad) {
      return { ...bad, reason: `cannot undo: ${bad.reason}`, opId: op.id, op: op.t };
    }

    return entry.kind === 'prop' ? this._undoProp(entry, op, actor)
      : this._undoBlock(entry, op, actor);
  }

  /** Put a voxel back to the value it held before this builder changed it. */
  _undoBlock(entry, op, actor) {
    const { x, y, z } = entry;
    if (this.getRevision(x, y, z) !== entry.rev) {
      return {
        ok: false, deny: DENY.OCCUPIED,
        reason: 'that block has changed since you last edited it',
        opId: op.id, op: op.t,
      };
    }

    const { cx, cz } = worldToChunk(x, y, z);
    const rev = this.setBlock(x, y, z, entry.prevMat);
    // Re-point the deeper entries for this voxel. The guard asks "has anybody
    // else been here?", and comparing revisions answers that -- but my own undo
    // just moved the number too, so leaving them stale would make the second
    // press on the same block refuse for a change I made myself.
    this._refreshUndo(actor, 'block', x, y, z, rev);
    this.record(cx, cz, (d) => {
      d.blocks.push([
        voxelIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE), entry.prevMat, rev,
      ]);
      d.by = actor.id;
    });
    // Reverting a demolition is rebuilding and renews the claim; reverting a
    // build is demolition and does not. Claims follow building here, so only the
    // first counts -- otherwise a stack of undos would keep a district alive
    // without anyone building in it.
    if (entry.prevMat !== 0) this.touchZone(actor.id);
    return {
      ok: true, deny: DENY.NONE, opId: op.id, op: op.t,
      result: { x, y, z, mat: entry.prevMat, rev, by: actor.id },
    };
  }

  /** Put a prop back, or take away the one this builder set down. */
  _undoProp(entry, op, actor) {
    const { x, y, z } = entry;
    const { cx, cz } = worldToChunk(x, y, z);
    const c = this.chunk(cx, cz);
    const pkey = voxelKey(x, y, z);
    const existing = c.props.get(pkey);

    if (entry.prev) {
      // We removed it. Restorable only while nothing stands there -- a prop
      // placed since belongs to whoever placed it.
      if (existing) {
        return {
          ok: false, deny: DENY.OCCUPIED, reason: 'something else stands there now',
          opId: op.id, op: op.t,
        };
      }
      // A fresh revision rather than the old one: the cell is a new record as
      // far as the guard is concerned, and a stale rev would let the next undo
      // compare against an id nobody has ever sent.
      const record = { ...entry.prev, rev: this.revCounter++ };
      c.props.set(pkey, record);
      c.rev++;
      this._refreshUndo(actor, 'prop', x, y, z, record.rev);
      this.record(cx, cz, (d) => { d.props.push(record); d.by = actor.id; });
      this.touchZone(actor.id);
      return { ok: true, deny: DENY.NONE, opId: op.id, op: op.t, result: record };
    }

    // We placed it, so it must still be that exact prop -- otherwise this would
    // delete somebody else's replacement.
    if (!existing || existing.rev !== entry.rev) {
      return {
        ok: false, deny: DENY.OCCUPIED, reason: 'that prop has changed since you placed it',
        opId: op.id, op: op.t,
      };
    }
    c.props.delete(pkey);
    c.rev++;
    this.record(cx, cz, (d) => { d.propsRemoved.push(x + ',' + y + ',' + z); d.by = actor.id; });
    return { ok: true, deny: DENY.NONE, opId: op.id, op: op.t, result: { x, y, z, removed: true } };
  }

  requestLock(op, actor) {
    const { x, y, z } = op;
    if (!this.inBounds(x, y, z)) {
      return { ok: false, deny: DENY.OUT_OF_BOUNDS, opId: op.id, op: op.t };
    }
    const key = voxelKey(x, y, z);
    const holder = this.lockHolder(x, y, z);
    if (holder && holder !== actor.id) {
      return { ok: false, deny: DENY.LOCKED, opId: op.id, op: op.t, result: { holder } };
    }
    this.locks.set(key, { builderId: actor.id, expiresAt: Date.now() + WORLD.LOCK_TTL_MS });
    return { ok: true, deny: DENY.NONE, opId: op.id, op: op.t, result: { x, y, z, holder: actor.id } };
  }

  releaseLock(op, actor) {
    const key = voxelKey(op.x, op.y, op.z);
    const lock = this.locks.get(key);
    if (lock && lock.builderId === actor.id) this.locks.delete(key);
    return { ok: true, deny: DENY.NONE, opId: op.id, op: op.t };
  }

  /**
   * Claim (or move) a territory.
   *
   * A claim covers a square of half-width `half` and decays on inactivity; see
   * WORLD.ZONE_TTL_MS for why that matters. Re-claiming renews, and a builder who
   * already owns a zone gets to move it rather than being stuck with the first
   * square they ever picked.
   */
  claimZone(op, actor) {
    const half = Math.min(Math.max(op.half | 0, 2), 12);
    const cx = op.x | 0;
    const cz = op.z | 0;

    // A claim outside the playable radius would enclose nothing anyone can build on,
    // so it would be a claim with no consequences. Rejected rather than clamped:
    // silently moving it would leave the player claiming somewhere they did not ask
    // for, and the rejection says why.
    if (Math.hypot(cx, cz) + half > WORLD.RADIUS) {
      return {
        ok: false,
        deny: DENY.NOT_CLAIMED,
        reason: 'that claim would reach past the edge of the world',
        opId: op.id,
        op: op.t,
      };
    }

    const now = Date.now();
    const id = 'zone_' + actor.id;
    const existing = this.zones.get(id);

    // Overlap check. Without it two claims can occupy the same ground, and the
    // permission check then depends on Map iteration order -- so which of the two
    // owners is locked out of their *own* district flips between restarts.
    //
    // Also makes territory competitive rather than cosmetic: you cannot simply
    // overprint somebody's district, including a bot's. Observed directly: claiming
    // (10,10) with half 5 landed on top of Alex_Voxel's district without complaint,
    // producing two claims on identical ground.
    const clash = this._claimClash(cx, cz, half, id);
    if (clash) {
      return {
        ok: false,
        deny: DENY.NOT_CLAIMED,
        reason: `${clash.ownerName} already holds ground there`,
        opId: op.id,
        op: op.t,
      };
    }

    const zone = {
      id,
      ownerId: actor.id,
      ownerName: actor.name,
      color: actor.color,
      cx,
      cz,
      half,
      x0: cx - half, x1: cx + half,
      z0: cz - half, z1: cz + half,
      createdAt: existing?.createdAt ?? now,
      // Renewal resets the decay clock but keeps the original creation time, so a
      // player who keeps working their district can hold it indefinitely.
      touchedAt: now,
      expiresAt: now + WORLD.ZONE_TTL_MS,
    };
    this.zones.set(id, zone);
    return { ok: true, deny: DENY.NONE, opId: op.id, op: op.t, result: zone };
  }

  /**
   * Whether a proposed claim would overlap someone else's.
   *
   * Squares are axis-aligned, so overlap is a plain interval test on each axis -- no
   * geometry needed. A claim re-claiming its *own* ground is not a clash, which is what
   * lets a builder move or resize freely.
   *
   * @param {number} cx
   * @param {number} cz
   * @param {number} half
   * @param {string} selfId the claim id being placed, excluded from the test
   * @returns {object|null} the offending zone, or null
   */
  _claimClash(cx, cz, half, selfId) {
    const x0 = cx - half, x1 = cx + half, z0 = cz - half, z1 = cz + half;
    for (const zone of this.zones.values()) {
      if (zone.id === selfId) continue;
      if (x0 < zone.x1 && zone.x0 < x1 && z0 < zone.z1 && zone.z0 < z1) return zone;
    }
    return null;
  }

  /** Release a claim. A no-op if the builder holds none. */
  releaseZone(op, actor) {
    const id = 'zone_' + actor.id;
    if (!this.zones.has(id)) {
      return {
        ok: false, deny: DENY.NONE, reason: 'no claim to release', opId: op.id, op: op.t,
      };
    }
    this.zones.delete(id);
    return { ok: true, deny: DENY.NONE, opId: op.id, op: op.t };
  }

  /**
   * Rebuild zones from a save.
   *
   * Decay is deliberately *not* restored across a restart. A claim is a statement
   * that you are still here; resuming the server is not that. Restoring the clock
   * would mean shutting the game down for three minutes kept your ground, which is
   * precisely the exploit the mechanic exists to close.
   */
  restoreZones(list) {
    if (!Array.isArray(list)) return 0;
    const now = Date.now();
    let kept = 0;
    for (const z of list) {
      // Drop anything malformed rather than trusting the file; a zone with no owner
      // would block every builder in the area with no one able to claim it.
      if (!z || typeof z.ownerId !== 'string' || !Number.isFinite(z.cx) || !Number.isFinite(z.cz)) continue;
      const half = Math.min(Math.max(z.half | 0, 2), 12);
      const zone = {
        id: z.id ?? 'zone_' + z.ownerId,
        ownerId: z.ownerId,
        ownerName: z.ownerName ?? z.ownerId,
        color: z.color ?? '#38bdf8',
        cx: z.cx | 0,
        cz: z.cz | 0,
        half,
        x0: (z.cx | 0) - half, x1: (z.cx | 0) + half,
        z0: (z.cz | 0) - half, z1: (z.cz | 0) + half,
        createdAt: now,
        // Starts already inside the warning window: after a restart you must work to
        // keep the ground, not merely log in.
        touchedAt: now,
        expiresAt: now + WORLD.ZONE_HOLD_MS,
      };
      this.zones.set(zone.id, zone);
      kept++;
    }
    return kept;
  }

  /**
   * Keep an owner's claim alive because they built in it.
   *
   * Called from the commit path so decay tracks *work*, not attendance. This is the
   * difference between a claim that is a timer you watch and one that is a district
   * you maintain.
   */
  touchZone(ownerId) {
    const zone = this.zones.get('zone_' + ownerId);
    if (!zone) return false;
    const now = Date.now();
    zone.touchedAt = now;
    zone.expiresAt = now + WORLD.ZONE_TTL_MS;
    return true;
  }

  /**
   * Expire claims that have gone untended.
   *
   * @param {number} now
   * @returns {object[]} the zones that were released, for the client to announce
   */
  pruneZones(now = Date.now()) {
    const released = [];
    for (const zone of [...this.zones.values()]) {
      if (zone.expiresAt > now) continue;
      this.zones.delete(zone.id);
      released.push(zone);
    }
    return released;
  }

  /**
   * How a claim should be presented: live, fading, or gone in `holdMs`.
   *
   * Computed server-side and sent with the zone so every client agrees, and so the
   * client never has to know the TTL constants to draw a warning.
   *
   * @returns {'live'|'fading'|'expiring'}
   */
  zoneState(zone, now = Date.now()) {
    if (!zone) return 'live';
    if (zone.expiresAt <= now) return 'expiring';
    if (zone.expiresAt - now <= WORLD.ZONE_HOLD_MS) return 'fading';
    return 'live';
  }

  /** The zone list as the wire sees it, with decay state folded in. */
  zonePayload(now = Date.now()) {
    return [...this.zones.values()].map((z) => ({
      ...z,
      state: this.zoneState(z, now),
      msLeft: Math.max(0, z.expiresAt - now),
    }));
  }

  // -------------------------------------------------------------------------
  // Helpers used by the bot layer
  // -------------------------------------------------------------------------

  /** Pick a builder to act as the race winner. Deterministic per actor. */
  rivalBuilder(actorId) {
    const pool = this.rivals ?? [];
    if (pool.length === 0) {
      return { id: 'server', name: 'Server', color: '#f59e0b', mat: 8 };
    }
    let h = 0;
    for (let i = 0; i < actorId.length; i++) h = (h * 31 + actorId.charCodeAt(i)) | 0;
    return pool[Math.abs(h) % pool.length];
  }

  /** Commit a change on behalf of a bot, bypassing client validation. */
  commitAs(builder, x, y, z, mat) {
    if (!this.inBounds(x, y, z)) return null;
    // Zones and locks, same as the op path. Bots used to skip these entirely, which
    // made every claim decorative: a player could claim a district and watch a bot
    // build straight through it. A claim that does not exclude anyone is not a claim.
    const blocked = this.preflight({ x, y, z }, builder);
    if (blocked) return null;
    if (this.getBlock(x, y, z) !== 0) return null;
    const rev = this.setBlock(x, y, z, mat);
    const { cx, cz } = worldToChunk(x, y, z);
    this.record(cx, cz, (d) => {
      d.blocks.push([voxelIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE), mat, rev]);
      d.by = builder.id;
    });
    return { x, y, z, mat, rev };
  }

  /**
   * Commit a prop on a bot's behalf.
   *
   * Mirrors the validation in {@link Authority#placeProp} -- air in the cell, solid
   * ground beneath, nothing already standing there -- but goes straight to storage
   * without going through the op pipeline. Bots cannot be sent ops, and letting
   * them skip these checks would let a bot place a prop inside a wall, which the
   * client would render intersecting the geometry with no way to explain it.
   */
  commitPropAs(builder, x, y, z, prop, rot = 0) {
    if (!this.inBounds(x, y, z)) return null;
    if (!isValidProp(prop)) return null;
    // As above: a bot must not place a lantern inside somebody's claim.
    const blocked = this.preflight({ x, y, z }, builder);
    if (blocked) return null;
    if (this.getBlock(x, y, z) !== 0) return null;
    if (y === WORLD.MIN_Y || this.getBlock(x, y - 1, z) === 0) return null;

    const { cx, cz } = worldToChunk(x, y, z);
    const c = this.chunk(cx, cz);
    const pkey = voxelKey(x, y, z);
    if (c.props.has(pkey)) return null;

    const record = { x, y, z, prop, rot: rot & 3, by: builder.id, rev: this.revCounter++ };
    c.props.set(pkey, record);
    c.rev++;
    this.record(cx, cz, (d) => { d.props.push(record); d.by = builder.id; });
    return record;
  }

  removeAs(builder, x, y, z) {
    if (this.getBlock(x, y, z) === 0) return null;
    const { cx, cz } = worldToChunk(x, y, z);
    const rev = this.setBlock(x, y, z, 0);
    this.record(cx, cz, (d) => {
      d.blocks.push([voxelIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE), 0, rev]);
      d.by = builder.id;
    });
    return { x, y, z };
  }

  // -------------------------------------------------------------------------
  // Wire payloads
  // -------------------------------------------------------------------------

  /** Everything a joining client needs to render the settled world. */
  snapshot() {
    const chunks = [];
    for (const c of this.chunks.values()) {
      let nonEmpty = 0;
      for (let i = 0; i < c.cells.length; i++) if (c.cells[i] !== 0) nonEmpty++;
      if (nonEmpty === 0 && c.props.size === 0) continue;
      chunks.push({
        cx: c.cx, cz: c.cz, rev: c.rev,
        // Base64, not a raw ArrayBuffer: see encodeCells in shared/protocol.js.
        cells: encodeCells(c.cells),
        props: [...c.props.values()],
      });
    }
    return { chunks, zones: this.zonePayload() };
  }

  lockList() {
    const now = Date.now();
    return [...this.locks.entries()]
      .filter(([, l]) => l.expiresAt > now)
      .map(([key, l]) => ({ key, builderId: l.builderId }));
  }

  get propCatalogue() {
    return PROP_KEYS;
  }
}
