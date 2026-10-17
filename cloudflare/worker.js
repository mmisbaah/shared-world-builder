import { DurableObject } from 'cloudflare:workers';
import { Authority } from '../server/authority.js';
import { BotSwarm } from '../server/bots.js';
import { ObjectiveTracker } from '../server/objectives.js';
import { generateIsland } from '../shared/atoll.js';
import { soloTeam } from '../shared/soloBots.js';
import { CHUNK_SIZE, OP, DENY, EV, WORLD, encodeCells, decodeCells } from '../shared/protocol.js';

const json = (body, status = 200) => Response.json(body, { status });
const validGameId = (value) =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname === '/api/status' && !url.searchParams.has('game')) {
      return json({ host: 'cloudflare', mode: 'solo' });
    }
    const gameId = url.pathname === '/api/solo/start'
      ? (await request.clone().json().catch(() => null))?.gameId
      : url.searchParams.get('game') ?? request.headers.get('x-game-id');
    if (!validGameId(gameId)) return json({ error: 'Invalid game ID' }, 400);
    const id = env.WORLD.idFromName('solo:' + gameId.toLowerCase());
    return env.WORLD.get(id).fetch(request);
  },
};

export class SharedWorld extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.authority = new Authority();
    this.objectives = new ObjectiveTracker(this.authority);
    this.bots = null;
    this.builders = new Map();
    this.teamIds = null;
    this.playerSocket = state.getWebSockets()[0] ?? null;
    this.dirty = false;
    this.dirtyChunks = new Set();
    this.lastEditsSig = '';
    this.loop = null;
    this.lastSecond = 0;
    this.lastZone = 0;
    this.lastSave = 0;
    for (const ws of state.getWebSockets()) {
      const actor = ws.deserializeAttachment();
      if (actor?.id) this.builders.set(actor.id, actor);
    }
    this.ready = state.blockConcurrencyWhile(() => this.initialize());
  }

  async initialize() {
    const meta = await this.state.storage.get('meta');
    if (meta?.initialized) {
      const chunks = await this.state.storage.list({ prefix: 'chunk:' });
      for (const saved of chunks.values()) {
        const c = this.authority.chunk(saved.cx, saved.cz);
        c.cells.set(decodeCells(saved.cells));
        c.rev = saved.rev;
        c.props = new Map(saved.props ?? []);
      }
      this.authority.revCounter = meta.revCounter ?? 1;
      this.teamIds = soloTeam(meta.teamIds) ? meta.teamIds : null;
      this.authority.restoreZones((meta.zones ?? []).filter((z) => !z.ownerId?.startsWith('bot_')));
      this.objectives.index = meta.objectives?.index ?? 0;
      this.objectives.completed = meta.objectives?.completed ?? [];
      this.objectives.contributors = new Set(meta.objectives?.contributors ?? []);
      this.objectives.humanTouched = new Set(meta.objectives?.humanTouched ?? []);
    } else {
      const island = generateIsland(WORLD.RADIUS - 2);
      for (const [x, y, z, mat] of island.blocks) this.authority.setBlock(x, y, z, mat);
      for (const [x, y, z, mat] of island.water) this.authority.setBlock(x, y, z, mat);
      await this.save(true);
    }
    this.authority.pending.clear();
    this.authority.history.start();
    this.objectives.evaluate();
    if (this.builders.size > 0) this.startBots();
  }

  sockets() {
    return this.state.getWebSockets();
  }

  actorFor(ws) {
    return ws.deserializeAttachment();
  }

  send(ws, event, payload) {
    try { ws.send(JSON.stringify({ event, payload })); } catch { /* Socket closed. */ }
  }

  broadcast(event, payload, except = null) {
    for (const ws of this.sockets()) if (ws !== except) this.send(ws, event, payload);
  }

  presence() {
    return {
      builders: [...this.builders.values()].map((b) => ({
        ...b, bot: false, edits: this.authority.edits.get(b.id) ?? 0,
      })),
      bots: this.bots?.roster().map((b) => ({
        ...b, edits: this.authority.edits.get(b.id) ?? 0,
      })) ?? [],
    };
  }

  startBots() {
    if (this.bots || !this.teamIds) return;
    this.bots = new BotSwarm(this.authority, (payload) => {
      this.dirty = true;
      this.broadcast(EV.BOT_ACTION, payload);
      this.flush();
    }, {
      objectives: this.objectives,
      profiles: soloTeam(this.teamIds),
      onWorldChanged: () => { this.dirty = true; },
    });
    if (!this.loop) this.loop = setInterval(() => { void this.tick(); }, 100);
  }

  stopBots() {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    if (this.bots) {
      this.bots.dispose();
      this.dirty = true;
    }
    this.bots = null;
  }

  flush() {
    for (const key of this.authority.pending.keys()) this.dirtyChunks.add(key);
    for (const delta of this.authority.flush()) {
      if (delta.blocks.length || delta.props.length || delta.propsRemoved.length) {
        this.broadcast(EV.CHUNK_DELTA, delta);
      }
    }
  }

  async tick() {
    this.flush();
    const now = Date.now();
    if (now - this.lastSecond >= 1000) {
      this.lastSecond = now;
      const before = this.objectives.index;
      this.objectives.evaluate();
      this.bots?.markEvaluated();
      this.bots?.syncIntents();
      if (this.objectives.index !== before) this.dirty = true;
      const sig = [...this.authority.edits].map(([id, n]) => id + ':' + n).join(',');
      if (sig !== this.lastEditsSig) {
        this.lastEditsSig = sig;
        this.broadcast(EV.PRESENCE, this.presence());
      }
      this.broadcast(EV.OBJECTIVES, this.objectives.payload());
      const locks = this.authority.lockList();
      if (locks.length) this.broadcast('locks', { locks });
    }
    if (now - this.lastZone >= 5000) {
      this.lastZone = now;
      for (const zone of this.authority.pruneZones(now)) {
        this.broadcast('zoneLost', {
          id: zone.id, ownerId: zone.ownerId, ownerName: zone.ownerName, x: zone.cx, z: zone.cz,
        });
        this.dirty = true;
      }
      this.broadcast(EV.ZONES, { zones: this.authority.zonePayload(now) });
    }
    if (this.dirty && now - this.lastSave >= 2000) await this.save();
  }

  async save(full = false) {
    const keys = full ? [...this.authority.chunks.keys()] : [...this.dirtyChunks];
    for (const key of keys) this.dirtyChunks.delete(key);
    this.dirty = false;
    try {
      for (const key of keys) {
        const c = this.authority.chunks.get(key);
        if (!c) continue;
        await this.state.storage.put('chunk:' + key, {
          cx: c.cx, cz: c.cz, rev: c.rev,
          cells: encodeCells(c.cells),
          props: [...c.props.entries()],
        });
      }
      await this.state.storage.put('meta', {
        initialized: true,
        teamIds: this.teamIds,
        revCounter: this.authority.revCounter,
        zones: [...this.authority.zones.values()].filter((z) => !z.ownerId.startsWith('bot_')),
        objectives: {
          index: this.objectives.index,
          completed: this.objectives.completed,
          contributors: [...this.objectives.contributors],
          humanTouched: [...this.objectives.humanTouched],
        },
        savedAt: new Date().toISOString(),
      });
      this.lastSave = Date.now();
    } catch (error) {
      for (const key of keys) this.dirtyChunks.add(key);
      this.dirty = true;
      throw error;
    }
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === '/api/solo/start' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const selected = soloTeam(body?.teamIds);
      if (!selected) return json({ error: 'Choose three different bots' }, 400);
      if (this.teamIds && this.teamIds.join(',') !== body.teamIds.join(',')) {
        return json({ error: 'This game already has a team' }, 409);
      }
      if (!this.teamIds) {
        this.teamIds = [...body.teamIds];
        this.dirty = true;
        await this.save();
      }
      return json({ ok: true, teamIds: this.teamIds });
    }
    if (url.pathname === '/api/socket') {
      if (!this.teamIds) return json({ error: 'Start a game first' }, 409);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return json({ error: 'WebSocket required' }, 426);
      }
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      if (this.playerSocket) {
        try { this.playerSocket.close(4001, 'Game opened in another tab'); } catch { /* Stale socket. */ }
      }
      const actor = {
        id: 'b_player', name: 'Builder', color: '#38bdf8', joinedAt: Date.now(),
      };
      server.serializeAttachment(actor);
      this.state.acceptWebSocket(server);
      this.playerSocket = server;
      this.builders.set(actor.id, actor);
      if (!this.bots) this.startBots();
      this.send(server, EV.WELCOME, {
        you: { id: actor.id, name: actor.name, color: actor.color },
        chunkSize: CHUNK_SIZE,
        tickMs: WORLD.TICK_MS,
        lockTtlMs: WORLD.LOCK_TTL_MS,
        demoRaceEnabled: false,
        zoneTtlMs: WORLD.ZONE_TTL_MS,
        zoneHoldMs: WORLD.ZONE_HOLD_MS,
        snapshot: this.authority.snapshot(),
        presence: this.presence(),
        zones: [...this.authority.zones.values()],
        objectives: this.objectives.payload(),
      });
      this.broadcast(EV.PRESENCE, this.presence());
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/api/history') {
      const h = this.authority.history;
      return json({ span: h.span(), length: h.length, entries: h.slice(0, h.length) });
    }
    if (url.pathname === '/api/status') {
      return json({
        mode: 'solo',
        builders: this.builders.size,
        teamIds: this.teamIds,
        chunks: this.authority.chunks.size,
        zones: this.authority.zones.size,
        bots: { enabled: !!this.bots?.enabled, roster: this.bots?.roster() ?? [] },
        objective: { index: this.objectives.index, completed: this.objectives.completed.length },
        host: 'cloudflare',
      });
    }
    return json({ error: 'Not found' }, 404);
  }

  async webSocketMessage(ws, raw) {
    await this.ready;
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    const actor = this.actorFor(ws);
    if (!actor || typeof message?.event !== 'string') return;
    if (message.event === 'op') {
      const op = message.payload;
      if (!op || typeof op.t !== 'number') return;
      const result = this.authority.apply({ ...op, forceRace: false }, actor);
      if (result.ok && ![OP.PING, OP.REQUEST_LOCK, OP.RELEASE_LOCK].includes(op.t)) {
        this.objectives.noteHumanContribution(actor.id);
        this.dirty = true;
      }
      if (result.ok && (op.t === OP.CLAIM_ZONE || op.t === OP.RELEASE_ZONE)) {
        this.broadcast(EV.ZONES, { zones: this.authority.zonePayload() });
      } else if (result.ok && this.authority.zones.has('zone_' + actor.id) &&
        (op.t === OP.PLACE_BLOCK || op.t === OP.PLACE_PROP)) {
        this.send(ws, EV.ZONES, { zones: this.authority.zonePayload() });
      }
      this.send(ws, EV.OP_RESULT, {
        opId: op.id, t: op.t, ok: result.ok, deny: result.deny,
        reason: result.reason ?? null, result: result.result ?? null,
        winner: result.winner ?? null, actorId: actor.id,
      });
      if (!result.ok && result.deny === DENY.NOT_CLAIMED) {
        this.send(ws, EV.ZONES, { zones: this.authority.zonePayload() });
      }
      this.flush();
      if (this.dirty) await this.save();
    } else if (message.event === 'cursor') {
      const m = message.payload;
      const x = Math.round(Number(m?.x)), y = Math.round(Number(m?.y)), z = Math.round(Number(m?.z));
      if ([x, y, z].every(Number.isFinite)) {
        this.broadcast(EV.CURSOR, { id: actor.id, color: actor.color, name: actor.name, x, y, z }, ws);
      }
    } else if (message.event === 'zones') {
      this.send(ws, EV.ZONES, { zones: this.authority.zonePayload() });
    } else if (message.event === 'objectives') {
      this.send(ws, EV.OBJECTIVES, this.objectives.payload());
    } else if (message.event === 'bots') {
      this.bots?.setEnabled(!!message.payload);
      this.broadcast(EV.PRESENCE, this.presence());
    }
  }

  async webSocketClose(ws) {
    if (ws !== this.playerSocket) return;
    this.playerSocket = null;
    const actor = this.actorFor(ws);
    if (actor) this.builders.delete(actor.id);
    this.broadcast(EV.PRESENCE, this.presence());
    if (this.builders.size === 0) {
      this.stopBots();
      if (this.dirty) await this.save();
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
