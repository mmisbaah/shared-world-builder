import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Server as SocketServer } from 'socket.io';

import { CHUNK_SIZE, OP, DENY, EV, WORLD, chunkKey } from '../shared/protocol.js';
import { generateIsland, SEA_LEVEL } from '../shared/atoll.js';
import { Authority } from './authority.js';
import { BotSwarm } from './bots.js';
import { ObjectiveTracker } from './objectives.js';
import { Persistence } from './persistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5173;

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: '*' } });

// Assets are served un-cached. This is a development server: browser caching of
// ES modules means an edited shader or module can keep running the previous
// version after a reload, which is genuinely confusing to debug -- the symptom is
// a fix that appears to have no effect. `etag` stays on so conditional requests
// still work, but the browser must revalidate every time.
const staticOpts = { extensions: ['html'], etag: true, lastModified: true, maxAge: 0 };

app.use(express.static(path.join(__dirname, '..', 'public'), staticOpts));

// `shared/` is imported verbatim by both sides, so the browser needs to be able to
// fetch it too. Serving it at the root makes the relative paths in the client
// modules resolve without duplicating or rewriting anything.
app.use('/shared', express.static(path.join(__dirname, '..', 'shared'), staticOpts));

// ---------------------------------------------------------------------------
// Frame capture (development only)
// ---------------------------------------------------------------------------
//
// Why this exists: the whole point of a graphics change is that it *looks* right, and
// this environment cannot look at anything. Headless Chromium on a software GL stack
// refuses `browser.screenshot`, so the usual way to check a render is unavailable -- and
// `requestAnimationFrame` never fires there either, so there is not even a frame on
// screen to capture.
//
// The workaround is to read the default framebuffer out with `gl.readPixels` in the
// page and POST it here. Two things make that safe rather than a hole:
//
//   - It is off unless `SWB_CAPTURE=1` is set, so a normal deployment has no route at
//     all. Not "rate limited" or "token protected" -- absent.
//   - It only ever *writes* into the capture directory, with a filename the server
//     generates itself. A request cannot choose a path, and a 4 MB cap stops it being
//     used as free storage.
//
// Without it, "does the island look like a lagoon" is unanswerable here, and the
// previous lighting revisions of this project failed precisely because nobody could
// answer it.
const CAPTURE_ENABLED = process.env.SWB_CAPTURE === '1';
const CAPTURE_DIR = path.join(process.env.SWB_DATA || path.join(__dirname, '..', 'data'), 'captures');
const CAPTURE_MAX = '4mb';
/** Monotonic counter so two captures in the same millisecond do not collide. */
let captureSeq = 0;

if (CAPTURE_ENABLED) {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  app.post('/__capture', express.raw({ type: 'image/png', limit: CAPTURE_MAX }), (req, res) => {
    if (!req.body || !req.body.length) {
      res.status(400).json({ error: 'empty body; POST image/png bytes' });
      return;
    }
    // PNG magic, checked because the route accepts any bytes under the cap and a
    // truncated or wrong-type upload would otherwise be written out as a .png and
    // fail later, somewhere less obvious.
    const isPng = req.body[0] === 0x89 && req.body[1] === 0x50
      && req.body[2] === 0x4e && req.body[3] === 0x47;
    if (!isPng) {
      res.status(415).json({ error: 'not a PNG' });
      return;
    }
    const name = `frame-${Date.now()}-${captureSeq++}.png`;
    fs.writeFileSync(path.join(CAPTURE_DIR, name), req.body);
    console.log(`[capture] wrote ${name} (${(req.body.length / 1024).toFixed(1)} KiB)`);
    res.json({ ok: true, name, bytes: req.body.length });
  });
  console.log(`[capture] POST /__capture enabled -> ${CAPTURE_DIR}`);
}

const authority = new Authority();

// Objectives are evaluated against authoritative world state and pushed out, so
// a client cannot claim progress it did not make. Built before the swarm because
// the bots need it in order to know what they are working on.
const objectives = new ObjectiveTracker(authority);

const bots = new BotSwarm(authority, (payload) => io.emit('botAction', payload), {
  objectives,
  onWorldChanged: () => persistence?.markDirty(),
});

// Worlds survive a restart. Declared here, initialised after seedWorld() below --
// ordering matters: constructing it captures a baseline snapshot, and loading it
// has to happen *after* the seed exists, or the first save records an empty world.
const persistence = new Persistence({
  authority,
  objectives,
  dir: process.env.SWB_DATA || path.join(__dirname, '..', 'data'),
});

// ---------------------------------------------------------------------------
// Test/demo ground: a plaza plus a stone foundation, written straight into the
// authoritative store so a joining client sees a world rather than an empty grid.
// ---------------------------------------------------------------------------

/**
 * Generate the atoll into the authority.
 *
 * The terrain used to be a hand-written plaza: a dished disc of stone and slate with a
 * raised dais and a short starter wall. That shape was chosen so builds would read
 * against a silhouette, which is a real constraint and the wrong one here -- a plaza is
 * a flat disc, and the entire appeal of a lagoon is the transition between depths. So
 * the shape now comes from a generator (`shared/atoll.js`) that makes the depth
 * relationship explicit and testable: is the lagoon actually shallower than the ocean?
 * That is a question with an answer, not a matter of taste.
 *
 * The dais and the starter wall are gone, and so are the two free objectives they were
 * quietly handing out. Both notes are preserved as tests in `test/atoll.test.js`
 * rather than as comments here, because a comment cannot fail.
 */
function seedWorld() {
  const island = generateIsland(WORLD.RADIUS - 2);
  for (const [x, y, z, mat] of island.blocks) authority.setBlock(x, y, z, mat);
  for (const [x, y, z, mat] of island.water) authority.setBlock(x, y, z, mat);

  const s = island.stats;
  console.log(
    `[seed] atoll: ${s.dryLand} dry / ${s.lagoon} lagoon / ${s.ocean} ocean columns, ` +
    `${s.palm} palm blocks, ${s.coral} coral, sea level ${SEA_LEVEL}`,
  );
}
seedWorld();

// A real save replaces the seed wholesale; seeding on top of a restored world
// would bury everyone's work in a fresh plaza. On a genuine first boot there is
// no save, so the seed is written out as the baseline the first edit diffs from.
const restored = persistence.load();
if (!restored) persistence.saveNow();

// Claims survive a restart, but their decay clock does not -- see
// Authority#restoreZones. Anyone holding ground after a restart starts inside the
// warning window and has to work to keep it, which is the same rule as everyone
// else and stops "restart the server to reset your claim" from being a strategy.
if (persistence.report().zones > 0) {
  const kept = authority.restoreZones(persistence.zoneRecords());
  if (kept > 0) console.log(`[zones] restored ${kept} claim(s), all fading`);
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/** @type {Map<string, {id:string,name:string,color:string,socketId:string,joinedAt:number}>} */
const builders = new Map();

const NAME_POOL = [
  ['Rivet', '#22d3ee'], ['Cobalt', '#818cf8'], ['Sable', '#f472b6'],
  ['Flint', '#fb923c'], ['Verdigris', '#34d399'], ['Umber', '#a3a3a3'],
];
let nameCursor = 0;
function assignIdentity(socket) {
  const [name, color] = NAME_POOL[nameCursor % NAME_POOL.length];
  nameCursor++;
  return {
    id: 'b' + socket.id,
    name: (name) + '_' + String(socket.id).slice(0, 4),
    color,
    socketId: socket.id,
    joinedAt: Date.now(),
  };
}

/**
 * Contribution counts ride along in presence.
 *
 * Both lists are mapped rather than only the players, because bots write through
 * `commitAs` and are counted by the very same tally -- a builders panel that
 * showed how much humans had done and nothing about the other four hands in the
 * world would be reading the room backwards.
 */
function botPayload() {
  return bots.roster().map((b) => ({ ...b, edits: authority.edits.get(b.id) ?? 0 }));
}

function presencePayload() {
  return [...builders.values()].map((b) => ({
    id: b.id, name: b.name, color: b.color, bot: false, joinedAt: b.joinedAt,
    edits: authority.edits.get(b.id) ?? 0,
  }));
}

function broadcastPresence() {
  io.emit(EV.PRESENCE, { builders: presencePayload(), bots: botPayload() });
}

/** What the contribution tally looked like the last time presence went out. */
let lastEditsSig = '';

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  const actor = assignIdentity(socket);
  builders.set(actor.id, actor);
  socket.data.actor = actor;

  socket.emit(EV.WELCOME, {
    you: { id: actor.id, name: actor.name, color: actor.color },
    chunkSize: CHUNK_SIZE,
    tickMs: WORLD.TICK_MS,
    lockTtlMs: WORLD.LOCK_TTL_MS,
      // Claim timing travels with the welcome so the client renders the same clock
      // the server is enforcing, rather than a local copy that can drift from it.
      zoneTtlMs: WORLD.ZONE_TTL_MS,
      zoneHoldMs: WORLD.ZONE_HOLD_MS,
    snapshot: authority.snapshot(),
    presence: { builders: presencePayload(), bots: botPayload() },
    zones: [...authority.zones.values()],
    objectives: objectives.payload(),
  });
  broadcastPresence();
  console.log(`[join] ${actor.name} (${builders.size} builders connected)`);

  socket.on('op', (op) => {
    if (!op || typeof op.t !== 'number') return;
    const result = authority.apply(op, actor);

    // Only accepted ops count toward the shared ladder. A denied op changed
    // nothing, so letting it count would let a builder "contribute" by spamming
    // invalid requests.
    //
    // This is also the only place a *human* is recorded. Bots go through
    // commitAs/commitPropAs and never reach here, which is exactly what the
    // "an objective needs a human" rule depends on.
    if (result.ok) {
      objectives.noteHumanContribution(actor.id);
      persistence.markDirty();
    }

    // A claim changes what other builders are allowed to do, so it has to reach
    // every client immediately -- not on the next zone tick. Emitting here also
    // keeps the sender in sync with everyone else.
    if (result.ok && (op.t === OP.CLAIM_ZONE || op.t === OP.RELEASE_ZONE)) {
      io.emit(EV.ZONES, { zones: authority.zonePayload() });
      if (op.t === OP.CLAIM_ZONE) {
        console.log(`[claim] ${actor.name} holds ${result.result.half * 2}x${result.result.half * 2} at ${result.result.cx},${result.result.cz}`);
      }
    } else if (result.ok && authority.zones.has('zone_' + actor.id)
      && (op.t === OP.PLACE_BLOCK || op.t === OP.PLACE_PROP)) {
      // Renewal is a change to the claim, and the owner is the one who most needs to
      // see it -- the panel reads the server's clock rather than running a local
      // countdown, precisely so it cannot disagree with what is being enforced.
      //
      // Without this the renewal was real but invisible for up to five seconds, which
      // is long enough that a player watching the bar fall while they build concludes
      // the mechanic is broken. Found by measuring: the clock resumed on the server
      // and the panel kept showing the pre-renewal number.
      //
      // Private to the owner. Everyone else only cares whether a claim still exists,
      // and this fires on every single build.
      socket.emit(EV.ZONES, { zones: authority.zonePayload() });
    }

    // Private ack: this is what rolls the prediction forward or back.
    socket.emit(EV.OP_RESULT, {
      opId: op.id,
      t: op.t,
      ok: result.ok,
      deny: result.deny,
      reason: result.reason ?? null,
      result: result.result ?? null,
      winner: result.winner ?? null,
      actorId: actor.id,
    });

    if (!result.ok && result.deny === DENY.NOT_CLAIMED) {
      socket.emit(EV.ZONES, { zones: authority.zonePayload() });
    }
  });

  // A cursor is not authoritative -- it is a coarse visualization of where someone is
  // pointing, not a position the world enforces. So the server stamps the sender's
  // identity onto whatever the client sends and broadcasts the rest, rather than
  // echoing back client-supplied name and colour which a malicious build could rotate.
  socket.on('cursor', (m) => {
    const a = socket.data.actor;
    if (!a || !m) return;
    const x = Math.round(Number(m.x));
    const y = Math.round(Number(m.y));
    const z = Math.round(Number(m.z));
    if (![x, y, z].every(Number.isFinite)) return;
    socket.broadcast.emit(EV.CURSOR, { id: a.id, color: a.color, name: a.name, x, y, z });
  });

  socket.on('zones', () => {
    socket.emit(EV.ZONES, { zones: authority.zonePayload() });
  });

  socket.on('bots', (on) => {
    bots.setEnabled(!!on);
    console.log(`[bots] ${on ? 'enabled' : 'paused'}`);
    broadcastPresence();
  });

  socket.on('disconnect', () => {
    builders.delete(actor.id);
    broadcastPresence();
    console.log(`[leave] ${actor.name}`);
  });

  socket.on('objectives', () => {
    socket.emit(EV.OBJECTIVES, objectives.payload());
  });
});

// ---------------------------------------------------------------------------
// Tick loop: batch authoritative changes into delta packets
// ---------------------------------------------------------------------------

setInterval(() => {
  const deltas = authority.flush();
  if (deltas.length === 0) return;

  for (const d of deltas) {
    if (d.blocks.length === 0 && d.props.length === 0 && d.propsRemoved.length === 0) continue;
    io.emit(EV.CHUNK_DELTA, d);
  }
}, WORLD.TICK_MS);

// Locks are advisory and expire; tell clients when the picture changes so hard
// lock borders do not linger after a builder disconnects mid-edit.
setInterval(() => {
  const locks = authority.lockList();
  if (locks.length > 0) io.emit('locks', { locks });
}, 1000);

// Territory decay.
//
// Two separate emissions, deliberately. A claim crossing into its warning window is
// an event every client needs to draw -- a claim silently fading is indistinguishable
// from a claim that is about to vanish. An actual release is an event worth telling
// the *owner* about specifically, because it is the one that cost them something.
//
// A release does not destroy anything. The blocks stay exactly where they are; what
// is lost is the exclusive right to build there. That distinction is the whole reason
// decay can be tense without being punishing.
setInterval(() => {
  const now = Date.now();
  const released = authority.pruneZones(now);
  if (released.length > 0) {
    for (const zone of released) {
      io.emit('zoneLost', {
        id: zone.id,
        ownerId: zone.ownerId,
        ownerName: zone.ownerName,
        x: zone.cx,
        z: zone.cz,
      });
    }
    persistence.markDirty();
    console.log(`[decay] released ${released.length} claim(s): ${released.map((z) => z.ownerName).join(', ')}`);
  }
  // Always re-send, so the `fading` state appears on every client's minimap as the
  // clock runs down rather than only for whoever happens to poll.
  if (io.engine.clientsCount > 0) io.emit(EV.ZONES, { zones: authority.zonePayload(now) });
}, 5000);

// Objective ladder. Evaluated on a timer rather than per-op: an op moves progress
// by one, so reacting to every op would broadcast almost every op, and the moment
// worth telling clients about is an objective completing, not a bar ticking by 1%.
setInterval(() => {
  const before = objectives.index;
  objectives.evaluate();
  // Tell the swarm the verdict is fresh so it does not scan the world itself.
  bots.markEvaluated();
  if (objectives.index !== before) persistence.markDirty();
  // Tell the bots the goal moved, so they announce it instead of carrying on with
  // an obsolete plan.
  //
  // Contribution counts are re-sent from here too. Presence originally went out
  // only when the roster changed, which is fine for names and useless for a
  // number: a counter that only moves when somebody joins is a decoration, not
  // attribution. Gated on the tally actually having moved, so an idle world
  // still sends nothing.
  const intentsChanged = bots.syncIntents();
  const editsSig = [...authority.edits].map(([id, n]) => `${id}:${n}`).join(',');
  const editsChanged = editsSig !== lastEditsSig;
  if (intentsChanged || editsChanged) {
    lastEditsSig = editsSig;
    broadcastPresence();
  }
  if (io.engine.clientsCount > 0) io.emit(EV.OBJECTIVES, objectives.payload());
}, 1000);

// Autosave. Bots commit continuously, so the dirty flag is essentially always set
// once anything is happening; the debounce inside Persistence is what keeps this
// from turning into a disk write per op.
setInterval(() => {
  persistence.maybeSave(Date.now());
}, 1000);

// ---------------------------------------------------------------------------
// Demo control endpoints
// ---------------------------------------------------------------------------

app.get('/api/status', (_req, res) => {
  let voxels = 0;
  for (const c of authority.chunks.values()) {
    for (let i = 0; i < c.cells.length; i++) if (c.cells[i] !== 0) voxels++;
  }
  res.json({
    builders: builders.size,
    bots: bots.enabled,
    chunks: authority.chunks.size,
    voxels,
    zones: authority.zones.size,
    locks: authority.lockList().length,
    objective: {
      index: objectives.index,
      completed: objectives.completed.length,
      contributors: objectives.contributors.size,
    },
    bots: { enabled: bots.enabled, ...bots.stats, roster: bots.roster() },
    persistence: persistence.report(),
  });
});

server.listen(PORT, () => {
  console.log(`Shared World Builder -> http://localhost:${PORT}`);
  console.log(
    `  column ${CHUNK_SIZE}x${WORLD.MAX_Y}x${CHUNK_SIZE} | tick ${WORLD.TICK_MS}ms`
    + ` | radius ${WORLD.RADIUS}`,
  );
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    // Save synchronously on the way out. The debounce means the last few seconds
    // of building may not have hit disk yet, and a clean shutdown is exactly when
    // that matters most.
    persistence.saveNow();
    bots.dispose();
    io.close();
    server.close(() => process.exit(0));
  });
}
