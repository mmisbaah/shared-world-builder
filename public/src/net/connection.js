/**
 * Network layer: prediction, reconciliation and conflict reporting.
 *
 * The latency model
 * -----------------
 * Every op the local player issues is applied to the predicted overlay *before*
 * it is sent, so the world reacts on the same frame as the input. The packet
 * then crosses the network twice (plus the configured artificial latency) before
 * the server's answer arrives. Reconciliation is what keeps that from desyncing.
 *
 * Outcomes
 * --------
 *   accepted   The server's `result` is the truth. We write it into settled state
 *              and clear the prediction. Writing the authoritative value here
 *              rather than waiting for the broadcast delta is deliberate: the delta
 *              may arrive before or after the ack, and either order must land on
 *              the same picture. Writing here makes the later delta a no-op.
 *
 *   denied     We drop the prediction, which rolls the voxel back to whatever the
 *              settled state says. If the denial carries a `winner`, the voxel
 *              legitimately now holds somebody else's block, so we adopt it and
 *              raise a conflict for the FX layer to shatter.
 *
 *   timed out  We give up waiting, drop the prediction, and mark the voxel for
 *              resync. Guessing here would be worse than showing the settled
 *              value, because a wrong guess survives until the next delta.
 *
 * Out-of-order safety
 * -------------------
 * Ops carry an id and answers are matched by id, never by arrival order, so a
 * denial that overtakes its own ack cannot corrupt state. Ops are sent with the
 * revision they were based on, which is what lets the server refuse a removal
 * whose voxel changed underneath it.
 */

import {
  OP, DENY, EV, WORLD, CHUNK_SIZE, localFromIndex, decodeCells, UNDO_DEPTH,
} from '../../../shared/protocol.js';

/**
 * How many of the most recent voxel edits keep an author for the hover readout.
 *
 * A client memory bound, which is why it lives here rather than in the protocol:
 * the server neither knows nor cares how much history a viewer chooses to keep.
 * It is bounded because an hour of building is tens of thousands of edits and
 * this map exists only to name one block under a cursor.
 */
const AUTHOR_CAP = 4096;

/** Socket.io's own ESM bundle, served by the server at this path. */
const SOCKET_IO_URL = '/socket.io/socket.io.esm.min.js';

export const PHASE = {
  IDLE: 'idle',
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DENIED: 'denied',
  TIMEOUT: 'timeout',
};

/** Give up on an ack after this long and fall back to settled state. */
const OP_TIMEOUT_MS = 4000;

/**
 * Latency probes are numbered from a disjoint block above the op id space.
 *
 * Both used to start at 1, so a probe and a placement shared ids. Because the RTT
 * read sat after an early return for unknown ids, a probe response was almost
 * never measured (107 of 112 went unanswered), and when a probe id happened to
 * collide with an op still in flight the answer deleted that pending op. Keeping
 * the spaces disjoint removes the whole class of bug rather than papering over it.
 */
const PING_ID_BASE = 1_000_000;

export class Connection {
  /**
   * @param {import('../world/world.js').World} world
   * @param {object} config the CONFIG object
   */
  constructor(world, config) {
    this.world = world;
    this.config = config;

    this.socket = null;
    this.connected = false;
    this.selfId = null;

    /** @type {Map<number, object>} opId -> pending op record */
    this.pending = new Map();
    this.nextOpId = 1;

    /**
     * How many of this builder's own edits the server still holds revertible.
     *
     * Maintained from acks rather than counted optimistically, so an edit joins
     * the history only once the server accepted it -- a denied or timed-out op
     * is not something the player can unwind. Mirrors the server's own stack and
     * is capped at the same depth for the same reason: a count that could run
     * ahead of the stack would promise an undo the server has already trimmed.
     */
    this.undoDepth = 0;

    /**
     * Round trip time in ms, from OP.PING probes. This is the best recent sample
     * rather than an average: see {@link Connection#_sampleRtt}.
     */
    this.rtt = 0;
    this._rttFloor = null;
    this._pingSeq = 0;
    /** @type {Map<number, number>} probe id -> send time */
    this._pingSentAt = new Map();

    /** Latest builders and bots, for the presence UI. */
    this.builders = new Map();
    this.bots = [];
    /**
     * Who last changed each voxel: `"x,y,z"` -> builder id.
     *
     * Populated from the broadcast deltas rather than from anything the server
     * says about history, so it names everything that happened while this client
     * was connected and nothing that happened before it. That is the honest
     * limit: generated terrain has no author, a block placed before you joined
     * has one you were not there to see, and both are better shown as nothing
     * than as a guess. Props do not need this at all -- their record already
     * carries `by`.
     *
     * Insertion order doubles as eviction order: re-keying a voxel moves it to
     * the end, so dropping the first key is a least-recently-changed eviction
     * with no second structure.
     *
     * @type {Map<string, string>}
     */
    this.authors = new Map();

    /** Latest claimed zones. */
    this.zones = [];

    /**
     * Latest server-verified objective ladder. Read-only game state: the client
     * never computes progress and never sends it, so it cannot be forged.
     */
    this.objectives = null;
    /** Id of an objective completed on the most recent update, else null. */
    this.justCompleted = null;
    /**
     * The server is holding the active objective open because no human has
     * touched it. Bots comply rather than carrying the ladder themselves.
     */
    this.awaitingHuman = false;

    /**
     * A claim of ours decayed and was released.
     *
     * Null while nothing has happened. The server names the owner in every release,
     * because a client only cares about its own -- other builders losing ground is
     * visible on the map, but *yours* is an event and needs a sound and a line.
     */
    this.claimLost = null;
    /** Our claim, or null. Derived from `zones` rather than tracked separately. */
    this.myClaim = null;

    /** Latest hard-lock list, as {key -> builderId}. */
    this.locks = new Map();

    /** @type {{type:string, [k:string]:any}[]} queued FX events for the renderer */
    this.events = [];

    this.stats = {
      sent: 0, accepted: 0, denied: 0, timedOut: 0,
      inflight: 0, deltasApplied: 0, voxelsApplied: 0, conflicts: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async connect() {
    // Loaded lazily so the module graph stays free of the network dependency for
    // anything that only needs the reconciliation logic.
    const { io } = await import(SOCKET_IO_URL);

    this.socket = io({
      // Polling first, websocket second. Websocket is the better transport but it
      // is also the one that gets silently dropped by proxies and headless
      // environments; listing it first turns that into a permanent reconnect loop
      // rather than a transparent upgrade. Polling answers immediately and the
      // engine upgrades on its own once the socket is proven to work.
      transports: ['polling', 'websocket'],
      upgrade: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      reconnectionAttempts: Infinity,
    });
    this._wireSocket(this.socket);
    return this;
  }

  /**
   * Register every inbound handler on a socket.
   *
   * Split out from {@link connect} so the whole reconciliation path can be driven
   * by a stub transport in tests, with no live server and no dynamic import of the
   * socket.io bundle.
   */
  _wireSocket(socket) {
    socket.on('connect', () => { this.connected = true; this._emit('status'); });
    socket.on('disconnect', () => {
      this.connected = false;
      // Every pending op is now unanswerable; roll them all back so the world does
      // not stay stuck showing ghosts that will never resolve.
      this._failAll('disconnected');
      this._emit('status');
    });

    socket.on(EV.WELCOME, (msg) => this._onWelcome(msg));
    socket.on(EV.OP_RESULT, (msg) => this._onOpResult(msg));
    socket.on(EV.CHUNK_DELTA, (msg) => this._onDelta(msg));
    socket.on(EV.PRESENCE, (msg) => this._onPresence(msg));
    socket.on(EV.ZONES, (msg) => {
      this.zones = msg.zones ?? [];
      this.myClaim = this.zones.find((z) => z.ownerId === this.selfId) ?? null;
      this._emit('zones');
    });

    /**
     * A claim was released for inactivity.
     *
     * Only ours is surfaced. Everyone else's loss is visible on the minimap, and
     * telling every client about every release would put the toast in the way of the
     * person it does not concern.
     */
    socket.on('zoneLost', (msg) => {
      if (!msg || msg.ownerId !== this.selfId) return;
      this.claimLost = msg;
      this.myClaim = null;
      this.zones = this.zones.filter((z) => z.ownerId !== this.selfId);
      this._emit('claimLost', msg);
    });
    socket.on(EV.OBJECTIVES, (msg) => {
      // Progress is a server verdict, never a client claim, so there is nothing to
      // validate here beyond shape. The previous payload is kept so the HUD can
      // detect a completion and celebrate it rather than silently re-rendering.
      const previousActive = this.objectives?.active?.[this.objectives?.index]?.id ?? null;
      this.objectives = msg;
      this.awaitingHuman = !!msg.awaitingHuman;
      const nowActive = msg.active?.[msg.index]?.id ?? null;
      this.justCompleted = previousActive && previousActive !== nowActive ? previousActive : null;
      this._emit('objectives');
    });
    socket.on(EV.BOT_ACTION, (msg) => this._push({ type: 'bot', ...msg }));
  socket.on(EV.CURSOR, (msg) => this._push({ type: 'cursor', ...msg }));
  // Attach the signature line for the cursor throttle once, not lazily inside the send:
  // letting a shared string be null vs undefined in every comparison would be a quieter
  // bug than a missing field.
  this._cursorKey = null;
  this._cursorT = 0;
    socket.on('locks', (msg) => {
      // Replace wholesale: the payload is a snapshot of every lock currently held,
      // so merging it would leave expired locks drawn forever.
      this.locks = new Map((msg.locks ?? []).map((l) => [l.key, l.builderId]));
      this._emit('locks');
    });
  }

  _onWelcome(msg) {
    this.selfId = msg.you.id;
    this.self = msg.you;
    this.zones = msg.snapshot?.zones ?? [];

    // Seed the world from the snapshot. Columns are created through
    // `world.column`, which queues them for meshing.
    for (const c of msg.snapshot?.chunks ?? []) {
      const col = this.world.column(c.cx, c.cz);
      const cells = decodeCells(c.cells);
      col.cells.set(cells);
      col.revs.fill(0); // snapshots carry no per-voxel revisions
      let occupied = 0;
      for (let i = 0; i < cells.length; i++) if (cells[i] !== 0) occupied++;
      col.occupied = occupied;
      for (const p of c.props ?? []) col.props.set(`${p.x},${p.y},${p.z}`, p);
      // One generation bump is enough: the snapshot *is* the current state.
      col.meshGeneration++;
      col.needsMesh = true;
      col.clearDirty();
      this.world.dirtyColumns.add(col.key);
    }

    this.builders = new Map((msg.presence?.builders ?? []).map((b) => [b.id, b]));
    this.bots = msg.presence?.bots ?? [];

    this._emit('welcome', msg);
    this._emit('presence');
  }

  _onPresence(msg) {
    this.builders = new Map((msg.builders ?? []).map((b) => [b.id, b]));
    this.bots = msg.bots ?? [];
    this._emit('presence');
  }

  // -------------------------------------------------------------------------
  // Outgoing ops
  // -------------------------------------------------------------------------

  /**
   * Predict a block placement and send it.
   *
   * The prediction is installed before the packet leaves, so the block appears
   * immediately. Nothing about the outcome is assumed.
   */
  placeBlock(x, y, z, mat, { forceRace = false } = {}) {
    this.world.setPredicted(x, y, z, mat);
    return this._send({ t: OP.PLACE_BLOCK, x, y, z, mat, forceRace }, { x, y, z, mat });
  }

  /** Predict a removal, carrying the revision it was based on. */
  removeBlock(x, y, z) {
    const rev = this.world.getRevision(x, y, z);
    this.world.setPredicted(x, y, z, 0);
    return this._send({ t: OP.REMOVE_BLOCK, x, y, z, rev }, { x, y, z, mat: 0, rev });
  }

  placeProp(x, y, z, prop, rot = 0) {
    return this._send({ t: OP.PLACE_PROP, x, y, z, prop, rot: rot | 0 }, { x, y, z, prop, rot });
  }

  removeProp(x, y, z) {
    return this._send({ t: OP.REMOVE_PROP, x, y, z }, { x, y, z, prop: null });
  }

  /**
   * Ask the server to revert this builder's own most recent edit.
   *
   * Deliberately predicts nothing. Everything else predicts because the player
   * is holding a pointer down and the delay is continuous; undo is one discrete
   * press answered in a single round trip, and the change arrives as an ordinary
   * chunk delta a tick later. Predicting it would mean teaching the settle and
   * reject paths about an op that carries no coordinates of its own, and the
   * cost of getting that wrong is a phantom block that never clears.
   *
   * @returns {boolean} false when there is nothing to send -- the caller says so
   */
  undo() {
    if (this.undoDepth <= 0) return false;
    this._send({ t: OP.UNDO }, {});
    return true;
  }

  /**
   * Broadcast the cell the pointer is over so other builders can see where you are
   * working. Throttled by cell and by a short interval: without that a fast pan across
   * the island fired an event on every pointermove, and the cursor boxes of other players
   * visibly stuttered offset behind their own movements rather than following.
   *
   * Sends the world voxel, not the screen pixel. The server re-stamps identity on it,
   * so a peer renders it as "Alice is here" regardless of the sender's view angle.
   */
  sendCursor(cell) {
    if (!this.socket?.connected || !cell) return;
    const x = Math.round(cell.x), y = Math.round(cell.y), z = Math.round(cell.z);
    if (![x, y, z].every(Number.isFinite)) return;
    const key = x + ',' + y + ',' + z;
    const now = performance.now();
    if (key !== this._cursorKey || now - (this._cursorT ?? 0) > 200) {
      this._cursorKey = key;
      this._cursorT = now;
      this.socket.emit('cursor', { x, y, z });
    }
  }

  requestLock(x, y, z) {
    return this._send({ t: OP.REQUEST_LOCK, x, y, z }, { x, y, z });
  }

  releaseLock(x, y, z) {
    return this._send({ t: OP.RELEASE_LOCK, x, y, z }, { x, y, z });
  }

  /**
   * Claim (or move) a territory around this column.
   *
   * Predicts nothing: a claim is not world geometry, so there is nothing to roll
   * back. It is confirmed by the zones broadcast instead, which every client gets.
   */
  claimZone(x, z, half = 6) {
    return this._send({ t: OP.CLAIM_ZONE, x, z, half }, { x, z, half });
  }

  /** Give up a claim early. */
  releaseZone() {
    return this._send({ t: OP.RELEASE_ZONE }, {});
  }

  /**
   * Send a latency probe.
   *
   * Probes deliberately bypass `_send` and the pending table: they are not
   * mutations, must never occupy an op slot, and must never be mistaken for an
   * acknowledgement. See {@link PING_ID_BASE} for why the id space is disjoint.
   */
  ping() {
    const id = PING_ID_BASE + (++this._pingSeq);
    const sentAt = performance.now();
    this._pingSentAt.set(id, sentAt);
    if (this.socket?.connected) this.socket.emit('op', { id, t: OP.PING });
    return id;
  }

  /** True if this id belongs to the probe range. */
  _isPingId(id) {
    return id >= PING_ID_BASE;
  }

  setBotsEnabled(on) {
    this.socket?.emit('bots', !!on);
  }

  requestZones() {
    this.socket?.emit('zones');
  }

  _send(op, record) {
    const id = this.nextOpId++;
    const payload = { ...op, id };

    this.pending.set(id, {
      ...record,
      opId: id,
      type: op.t,
      sentAt: performance.now(),
      phase: PHASE.PENDING,
    });
    this.stats.sent++;
    this.stats.inflight = this.pending.size;

    if (this.socket?.connected) {
      this.socket.emit('op', payload);
    } else {
      // Offline: fail immediately rather than leaving a ghost up forever.
      queueMicrotask(() => this._onOpResult({ opId: id, ok: false, deny: DENY.NONE, reason: 'offline' }));
    }
    this._emit('pending');
    return id;
  }

  // -------------------------------------------------------------------------
  // Answers
  // -------------------------------------------------------------------------

  _onOpResult(msg) {
    // Probes are resolved first and on their own id range, before the pending
    // table is consulted at all. Handling them after the lookup would mean a probe
    // whose id never enters `pending` is silently dropped -- which is every probe.
    if (this._isPingId(msg.opId)) {
      const sentAt = this._pingSentAt.get(msg.opId);
      this._pingSentAt.delete(msg.opId);
      if (sentAt !== undefined) this._sampleRtt(performance.now() - sentAt);
      this._emit('ping');
      return;
    }

    const rec = this.pending.get(msg.opId);
    if (!rec) return; // unknown or already timed out
    this.pending.delete(msg.opId);
    this.stats.inflight = this.pending.size;

    // Undo predicts nothing, so there is nothing for settle or reject to do --
    // and both would write a voxel named by a record that has no coordinates of
    // its own. Handled here rather than at each call site, because the timeout
    // and disconnect paths reach `_reject` as well.
    if (rec.type === OP.UNDO) {
      rec.phase = msg.ok ? PHASE.ACCEPTED : PHASE.DENIED;
      if (msg.ok) {
        this.undoDepth = Math.max(0, this.undoDepth - 1);
        this._push({
          type: 'accepted',
          opId: rec.opId,
          x: msg.result?.x ?? null,
          y: msg.result?.y ?? null,
          z: msg.result?.z ?? null,
          mat: msg.result?.mat ?? 0,
          opType: OP.UNDO,
        });
      } else {
        // A refusal *spends* the entry: the server pops it rather than leaving a
        // permanently failing one on top to freeze every edit behind it, so the
        // count follows it down. EMPTY is the one denial where the local number
        // is not merely ahead of the server but wrong outright -- there was never
        // anything there to unwind -- so that one is zeroed instead.
        this.undoDepth = msg.deny === DENY.EMPTY
          ? 0 : Math.max(0, this.undoDepth - 1);
        this._push({
          type: 'denied',
          opId: rec.opId,
          deny: msg.deny,
          reason: msg.reason ?? '',
          opType: OP.UNDO,
        });
      }
      this._emit('pending');
      return;
    }

    // Locks and zone claims do not predict anything, so there is nothing to roll
    // back -- only their outcome matters.
    if (rec.type === OP.REQUEST_LOCK || rec.type === OP.RELEASE_LOCK
      || rec.type === OP.CLAIM_ZONE || rec.type === OP.RELEASE_ZONE) {
      rec.phase = msg.ok ? PHASE.ACCEPTED : PHASE.DENIED;
      if (msg.ok) {
        if (rec.type === OP.REQUEST_LOCK) {
          this.locks.set(`${rec.x},${rec.y},${rec.z}`, this.selfId);
          this._emit('locks');
        } else if (rec.type === OP.CLAIM_ZONE && msg.result) {
          // Applied immediately so the claim wall appears on the same beat as the
          // click. The zones broadcast then confirms it for every client including
          // this one, which is idempotent -- the claim is identified by ownerId, so
          // replacing your own entry cannot duplicate it.
          this.zones = [...this.zones.filter((z) => z.ownerId !== this.selfId), msg.result];
          this._emit('zones');
        } else if (rec.type === OP.RELEASE_ZONE) {
          this.zones = this.zones.filter((z) => z.ownerId !== this.selfId);
          this._emit('zones');
        }
      } else if (rec.type === OP.CLAIM_ZONE || rec.type === OP.RELEASE_ZONE) {
        // Surfaced here because a rejected claim is otherwise silent: the wall simply
        // does not appear and the player has no idea the server said no.
        this._push({
          type: 'denied',
          opId: rec.opId,
          deny: msg.deny,
          reason: msg.reason ?? '',
        });
      }
      this._emit('pending');
      return;
    }

    if (msg.ok) {
      rec.phase = PHASE.ACCEPTED;
      this.stats.accepted++;
      // Every accepted edit joins the revert history. Denied and timed-out ops
      // never do, which is what keeps this meaning "the server is holding this
      // much of your work" rather than "you pressed these keys".
      if (rec.type === OP.PLACE_BLOCK || rec.type === OP.REMOVE_BLOCK
        || rec.type === OP.PLACE_PROP || rec.type === OP.REMOVE_PROP) {
        this.undoDepth = Math.min(UNDO_DEPTH, this.undoDepth + 1);
      }
      this._settle(rec, msg.result);
      this._push({
        type: 'accepted',
        opId: rec.opId,
        x: rec.x, y: rec.y, z: rec.z,
        mat: msg.result?.mat ?? rec.mat,
        // Which op it was. A prop placement carries no material, so without this
        // a consumer cannot tell "I placed a lantern" from "I placed a block" --
        // both arrive here with no `mat`. The renderer draws them differently and
        // so does the audio.
        opType: rec.type,
      });
    } else {
      rec.phase = PHASE.DENIED;
      this.stats.denied++;
      this._reject(rec, msg);
    }
    this._emit('pending');
  }

  /**
   * Commit an accepted op.
   *
   * Props are the awkward case: the prediction layer only covers voxels, so an
   * accepted prop is written straight through and a denied one needs no rollback.
   */
  _settle(rec, result) {
    // Undo predicts nothing, so there is no overlay to clear -- and `rec` carries
    // no coordinates, so falling through would write to an undefined voxel.
    if (rec.type === OP.UNDO) return;
    if (rec.type === OP.PLACE_PROP) {
      if (result) this.world.setProp(result);
      return;
    }
    if (rec.type === OP.REMOVE_PROP) {
      if (result) this.world.removeProp(rec.x, rec.y, rec.z);
      return;
    }
    const mat = result?.mat ?? rec.mat;
    // The revision has to come along, or the client's view of this voxel stays at
    // rev 0 and every subsequent removal skips the server's stale-write check.
    this.world.clearPredicted(rec.x, rec.y, rec.z, mat, result?.rev);
  }

  /**
   * Roll a denied op back.
   *
   * Props are not part of the voxel prediction overlay, so a denied prop has
   * nothing local to undo -- it only needs reporting. Blocks always do.
   *
   * When a denial names a winner the voxel now genuinely holds somebody else's
   * block, so we adopt it *and* report a conflict. Without adopting, the rollback
   * would flash our predicted material until the winner's own delta arrived.
   */
  _reject(rec, msg) {
    // As in `_settle`: nothing was predicted, so there is nothing to roll back.
    // Returning before the prop branch also keeps it from reporting a conflict
    // for a denial the UNDO handler already reported.
    if (rec.type === OP.UNDO) return;
    if (rec.type === OP.PLACE_PROP || rec.type === OP.REMOVE_PROP) {
      this._push({
        type: 'denied',
        opId: rec.opId,
        x: rec.x, y: rec.y, z: rec.z,
        deny: msg.deny,
        reason: msg.reason ?? '',
        prop: true,
      });
      return;
    }

    const adopt = msg.winner ? msg.winner.mat : this.world.getAuthoritative(rec.x, rec.y, rec.z);
    this.world.clearPredicted(rec.x, rec.y, rec.z, adopt);

    const event = {
      type: 'denied',
      opId: rec.opId,
      x: rec.x, y: rec.y, z: rec.z,
      deny: msg.deny,
      reason: msg.reason ?? '',
      winner: msg.winner ?? null,
    };
    if (msg.winner) {
      this.stats.conflicts++;
      event.conflict = true;
    }
    this._push(event);
  }

  /** Roll back everything still waiting, e.g. after a disconnect. */
  _failAll(reason) {
    for (const [id, rec] of [...this.pending]) {
      this.pending.delete(id);
      rec.phase = PHASE.TIMEOUT;
      this.stats.timedOut++;
      if (rec.type !== OP.PLACE_PROP && rec.type !== OP.REMOVE_PROP) {
        this.world.clearPredicted(rec.x, rec.y, rec.z);
      }
      this._push({ type: 'denied', opId: id, x: rec.x, y: rec.y, z: rec.z, deny: DENY.NONE, reason });
    }
    this._pingSentAt.clear();
    this.stats.inflight = 0;
    this._emit('pending');
  }

  // -------------------------------------------------------------------------
  // Incoming world changes
  // -------------------------------------------------------------------------

  /**
   * Apply an authoritative delta.
   *
   * Block entries are `[localIndex, material, revision]`. The index is
   * column-local, so world coordinates are recovered from the column origin via
   * the protocol's own inverse mapping -- the client never trusts an x/y/z from
   * the wire for blocks.
   */
  _onDelta(d) {
    const col = this.world.getColumn(d.cx, d.cz);
    if (!col) return; // a delta for a column we were never told about

    const baseX = d.cx * CHUNK_SIZE;
    const baseZ = d.cz * CHUNK_SIZE;
    let applied = 0;
    // Centroid of the voxels this delta touched.
    //
    // A delta is one *edit*, not one event per voxel: a builder laying a four-block
    // run should read as a single action. The chunk centre would be a much cheaper
    // answer and a wrong one -- a bot working its own district commits deltas that
    // are consistently offset from the chunk origin, so every sound would come from
    // the same wrong place.
    let sumX = 0, sumY = 0, sumZ = 0;
    // Material of the first block touched. The delta carries no per-change material
    // field, but each block tuple does, so this is read rather than invented. It is
    // only a hint -- a mixed delta is described by one block -- which is enough for
    // a remote edit's timbre.
    let firstMat = null;

    for (const [li, mat, rev] of d.blocks ?? []) {
      const local = localFromIndex(li);
      const x = baseX + local.x;
      const y = local.y;
      const z = baseZ + local.z;

      const was = this.world.getAuthoritative(x, y, z);
      this.world.setAuthoritative(x, y, z, mat, rev);
      applied++;
      sumX += x; sumY += y; sumZ += z;
      if (firstMat === null) firstMat = mat;
      // Who put it there, for the hover readout. A removal is skipped: once the
      // voxel is air there is nothing left to aim at, so remembering it would
      // spend the bounded budget on entries nothing can ever look up.
      if (mat !== 0) this._noteAuthor(x, y, z, d.by);

      // Somebody else filled a voxel we had predicted on: a lost race. The
      // author check matters because the server's own echo of *our* accepted
      // placement travels the same path, and if the delta beats the ack it would
      // otherwise be misreported as a conflict against ourselves.
      if (d.by !== this.selfId
        && was === 0 && mat !== 0
        && this.world.hasPrediction(x, y, z)) {
        this.world.clearPredicted(x, y, z, mat);
        this.stats.conflicts++;
        this._push({ type: 'conflict', x, y, z, mat, by: d.by });
      }
    }

    const props = d.props ?? [];
    const removed = d.propsRemoved ?? [];
    for (const p of props) this.world.setProp(p);
    for (const key of removed) {
      const [x, y, z] = key.split(',').map(Number);
      this.world.removeProp(x, y, z);
    }

    this.stats.deltasApplied++;
    this.stats.voxelsApplied += applied;
    if (applied > 0 || props.length > 0 || removed.length > 0) {
      // Where the edit actually happened, for anything that has to place it in the
      // world -- audio panning above all, but the FX layer wants it too. Props have
      // real coordinates of their own, so they are preferred over a voxel centroid.
      let px = applied > 0 ? sumX / applied : null;
      let py = applied > 0 ? sumY / applied : null;
      let pz = applied > 0 ? sumZ / applied : null;
      if (px === null && props.length > 0) {
        px = props[0].x; py = props[0].y; pz = props[0].z;
      }
      this._push({
        type: 'delta',
        cx: d.cx, cz: d.cz, by: d.by, count: applied,
        propCount: props.length,
        x: px, y: py, z: pz,
        mat: firstMat,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Timeouts
  // -------------------------------------------------------------------------

  /**
   * Fold a round trip into the reported figure.
   *
   * A smoothed minimum rather than a plain average: one 20 s sample caused by a
   * backgrounded tab should not dominate, but a genuine regression should show up
   * quickly. Tracking the floor and nudging the reported value toward it gives
   * both without ever reporting a spike as if it were normal.
   */
  _sampleRtt(sample) {
    if (!Number.isFinite(sample) || sample < 0) return;
    this._rttFloor = this._rttFloor === null ? sample : Math.min(this._rttFloor, sample);
    this.rtt = this._rttFloor === null ? 0 : Math.round(this._rttFloor);
  }

  /** Called once per frame: expire ops the server never answered. */
  update(now) {
    // Abandoned probes would otherwise accumulate for the lifetime of the tab.
    for (const [id, sentAt] of [...this._pingSentAt]) {
      if (now - sentAt > OP_TIMEOUT_MS) this._pingSentAt.delete(id);
    }

    for (const [id, rec] of [...this.pending]) {
      if (now - rec.sentAt < OP_TIMEOUT_MS) continue;
      this.pending.delete(id);
      rec.phase = PHASE.TIMEOUT;
      this.stats.timedOut++;
      if (rec.type !== OP.PLACE_PROP && rec.type !== OP.REMOVE_PROP) {
        this.world.clearPredicted(rec.x, rec.y, rec.z);
      }
      this._push({ type: 'denied', opId: id, x: rec.x, y: rec.y, z: rec.z, deny: DENY.NONE, reason: 'no response' });
    }
    this.stats.inflight = this.pending.size;
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  _emit(type, payload) {
    for (const fn of this._handlers?.get(type) ?? []) fn(payload);
  }

  _push(event) {
    this.events.push(event);
  }

  /** Drain queued FX events; the renderer calls this once per frame. */
  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  on(type, fn) {
    if (!this._handlers) this._handlers = new Map();
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type).push(fn);
    return () => {
      const list = this._handlers.get(type);
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Who currently holds a hard lock on this voxel, if anyone. */
  lockHolder(x, y, z) {
    return this.locks.get(`${x},${y},${z}`) ?? null;
  }

  /** The claimed zone containing this column, if any. */
  zoneAt(x, z) {
    for (const zn of this.zones) {
      if (x >= zn.x0 && x < zn.x1 && z >= zn.z0 && z < zn.z1) return zn;
    }
    return null;
  }

  /**
   * Remember who changed this voxel, within a bounded budget.
   *
   * Called once per block in a delta, including deltas of our own: knowing that
   * *we* built the wall we are aiming at is as useful as knowing a teammate did.
   */
  _noteAuthor(x, y, z, by) {
    if (!by) return;
    const key = `${x},${y},${z}`;
    this.authors.delete(key);
    this.authors.set(key, by);
    while (this.authors.size > AUTHOR_CAP) {
      this.authors.delete(this.authors.keys().next().value);
    }
  }

  /**
   * The builder who last changed this voxel, or null if we never saw it change.
   *
   * Null is the truthful answer for generated terrain and for anything built
   * before this client arrived. The hover readout shows nothing in that case
   * rather than attributing work to whoever happened to be nearest.
   */
  authorOf(x, y, z) {
    return this.authors.get(`${x},${y},${z}`) ?? null;
  }

  /**
   * Name and colour for a builder id, players and bots alike.
   *
   * Bots are searched because they are the busiest hands in this world: an
   * attribution that answered for people and shrugged for the four bots building
   * alongside them would name less than half of what is on screen.
   */
  builder(id) {
    if (!id) return null;
    return this.builders.get(id) ?? this.bots.find((b) => b.id === id) ?? null;
  }
}

export { OP, DENY, EV, WORLD, AUTHOR_CAP };