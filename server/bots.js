/**
 * Server-side co-op builders.
 *
 * These are not client-side theatre: every block and prop a bot commits goes
 * through the authoritative store and reaches clients as a real chunk delta. The
 * only thing they do *before* committing is announce an intent (`botAction`),
 * which is what lets each client draw that builder's targeting ray while the
 * change is still in flight.
 *
 * What changed and why:
 *
 * **They used to build noise.** Every plan was a random material, a random shape,
 * and a random anchor within 24 voxels of the origin. Three bots did that for ten
 * minutes and produced a pile of unrelated stubs that served no goal. In a
 * *cooperative* world the other builders are supposed to be pulling on the same
 * objective as you, and they were not pulling on anything.
 *
 * **They now work the shared objective.** Each bot reads the active objective and
 * derives a concrete intent from it (see `shared/botGoals.js`). The objective is
 * never diverted from -- that is what makes it cooperative -- but each bot's
 * *specialism* changes how it contributes, so three bots on "place six lanterns"
 * hang them in three different districts rather than stacking on one spot.
 *
 * **Each bot owns a district.** Anchors are drawn from a per-bot quadrant rather
 * than from a shared random pool. This is the difference between a world that
 * looks like a town with neighbourhoods and one that looks like a tip of debris,
 * and it costs about ten lines.
 *
 * Bots still commit step by step through a queue, never teleporting a finished
 * structure into existence, so the delta stream stays observable.
 */

import { WORLD, OP } from '../shared/protocol.js';
import { PROPS, isValidProp, isWaterMaterial } from '../shared/materials.js';
import { chooseIntent, SPECIALISMS } from '../shared/botGoals.js';

/** Materials bots may use for filler work, per material name. */
const FILLER = {
  stone: 1, brick: 2, wood: 3, slate: 7,
};

export const BOT_PROFILES = [
  {
    id: 'bot_alex', name: 'Alex_Voxel', color: '#38bdf8',
    plan: 'tower', specialism: 'architect', interval: 900,
    // Quadrant the bot builds in. Signs are the world-space sign of the offset.
    district: { x: 1, z: 1 },
  },
  {
    id: 'bot_maya', name: 'Maya_Craft', color: '#a855f7',
    plan: 'wall', specialism: 'mason', interval: 1200,
    district: { x: -1, z: 1 },
  },
  {
    id: 'bot_zen', name: 'Zen_Architect', color: '#f59e0b',
    plan: 'terrace', specialism: 'electrician', interval: 1000,
    district: { x: -1, z: -1 },
  },
  {
    id: 'bot_ivy', name: 'Ivy_Green', color: '#34d399',
    plan: 'garden', specialism: 'gardener', interval: 1600,
    district: { x: 1, z: -1 },
  },
];

const DISTRICT_MIN = 6;
const DISTRICT_MAX = 17;

/**
 * Bot territory size and placement.
 *
 * Deliberately smaller than a player's default claim (12x12). Four bots at player
 * size would cover most of a 40-unit radius and leave a world with nowhere left to
 * expand, which is the opposite of what the districts are for. At 8x8 each bot holds
 * a distinct quarter and the middle stays open for people.
 */
const BOT_CLAIM_HALF = 4;
const BOT_CLAIM_RADIUS = 10;

export class BotSwarm {
  /**
   * @param {import('./authority.js').Authority} authority
   * @param {(payload:object)=>void} broadcast
   * @param {object} [opts]
   * @param {object} [opts.objectives] the ObjectiveTracker, so bots can work the ladder
   * @param {() => void} [opts.onWorldChanged] called after a successful commit
   */
  constructor(authority, broadcast, opts = {}) {
    this.authority = authority;
    this.broadcast = broadcast;
    this.objectives = opts.objectives ?? null;
    this.onWorldChanged = opts.onWorldChanged ?? (() => {});

    this.enabled = true;
    /** @type {Map<string, {profile:object, queue:any[], timer:any, intent:object, started:number, placed:number}>} */
    this.workers = new Map();

    /**
     * Whether bot claims decay.
     *
     * On by default, because a claim that cannot be lost is the decoration problem all
     * over again -- only now it would be the *bots* holding ground forever while
     * doing nothing, which reads as a bug even more clearly than a player doing it.
     * Exposed so it can be turned off to compare behaviour.
     */
    this.claimDecay = opts.claimDecay ?? true;

    // Bots stand in for lost races so a denied client op names a real rival.
    authority.rivals = BOT_PROFILES.map((p) => ({ ...p, mat: 8 }));

    this.stats = {
      commits: 0, propCommits: 0, intentChanges: 0,
      idleTicks: 0, satisfiedTicks: 0, failedSites: 0, selfEvaluations: 0,
    };
    this._lastObjective = null;

    /**
     * Swarm revision the held objective verdict describes.
     *
     * Compared against the commit counters to decide whether a re-measure is needed,
     * which is exact: a verdict is stale if and only if the world has moved since it
     * was taken. See {@link BotSwarm#_needsRefresh}.
     */
    this._evaluatedAtRevision = 0;

    // Spawn on construction. `enabled` alone did not start anything -- workers were
    // only created inside setEnabled(), which nothing calls at boot, so the world
    // sat empty until somebody happened to toggle the bots button and back. The
    // flag said "enabled" the whole time, which is the worst version of that bug.
    this.setEnabled(true);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      for (const w of this.workers.values()) {
        clearTimeout(w.timer);
        this._dropClaim(w);
      }
      this.workers.clear();
    } else if (this.workers.size === 0) {
      for (const profile of BOT_PROFILES) this.spawn(profile);
    }
  }

  /**
   * Give up a worker's claim.
   *
   * Clearing the worker map is not enough. A claim lives in the authority, keyed by
   * builder id, so dropping the worker leaves the ground held forever by a bot that no
   * longer exists -- and then blocks everyone else from taking it. Found by pausing the
   * swarm and finding the four districts still owned.
   */
  _dropClaim(worker) {
    this.authority.releaseZone(
      { id: -1, t: OP.RELEASE_ZONE },
      { id: worker.profile.id, name: worker.profile.name, color: worker.profile.color },
    );
    worker.claim = null;
  }

  spawn(profile) {
    if (this.workers.has(profile.id)) return;
    const worker = {
      profile,
      queue: [],
      timer: null,
      intent: this._intentFor(profile),
      started: Date.now(),
      placed: 0,
      /** Territory this bot is holding, or null. See {@link holdGround}. */
      claim: null,
      /** When the claim was last renewed by actual work. */
      workedAt: 0,
      /** Builds since the last announcement, so claims are not chatty. */
      sinceAnnounce: 0,
    };
    this.workers.set(profile.id, worker);
    // A bot claims its district immediately rather than on its first step. The
    // territory is what makes the district *its* -- without a claim, the bots were
    // building in a quadrant that anyone could also claim, and the zones on the map
    // showed nobody at all.
    this.holdGround(worker);
    this.schedule(worker, 300 + Math.random() * 500);
  }

  /**
   * Claim (or re-claim) the bot's own district.
   *
   * Bots already worked in quadrants; this makes that legible and gives it a cost.
   * A bot's claim is renewed by the same rule that applies to a human -- by building
   * in it -- and expires on the same clock. That symmetry matters: it means the decay
   * a player feels is the decay the bots feel, so a bot standing idle visibly loses
   * its district rather than holding ground forever by construction.
   *
   * Bots hold smaller claims than a player's default. Four bots each taking a
   * player-sized district would leave almost nothing unclaimed in a 40-unit radius,
   * and a world that is entirely claimed is a world with nowhere to expand into.
   *
   * @param {object} worker
   * @returns {boolean} whether the claim now exists
   */
  holdGround(worker) {
    const { profile } = worker;
    const { x: sx, z: sz } = profile.district;

    // Anchor near the middle of the bot's own quadrant, chosen deterministically so
    // each bot holds a distinct piece of ground. But the quadrant is only a preference:
    // if a player has claimed the obvious spot, or another bot got there first, that
    // anchor is taken and the bot has to move rather than stand there unable to hold
    // anything.
    //
    // Tried outward from the preferred centre in fixed steps, so the result is
    // deterministic and spread: bot 1 always ends up in the same place rather than
    // jittering every renewal.
    for (let attempt = 0; attempt < 5; attempt++) {
      const step = attempt * 7;
      // Alternate which axis to move on, so a bot walks outward in an L rather than
      // along one diagonal -- which would march it straight back into the same clash.
      const cx = sx * (BOT_CLAIM_RADIUS + (attempt % 2 === 0 ? step : 0));
      const cz = sz * (BOT_CLAIM_RADIUS + (attempt % 2 === 0 ? 0 : step));
      if (Math.hypot(cx, cz) + BOT_CLAIM_HALF > WORLD.RADIUS) continue;

      // The claim must not sit over water. A claim is 8x8 centred on (cx,cz), and on an
      // atoll the default anchor of 10 units out can be in the lagoon -- measured: the
      // anchors at (10,-10) and (-10,-10) both sit in water, their nearest dry ground
      // 2 and 4 units away. A bot would then hold a claim over the sea, refuse
      // everybody's edits to it, and build nothing.
      //
      // Scoped to water specifically, not to "has ground": an empty column is not a
      // new failure, it is how the tests build their worlds and the authority refuses
      // placements there anyway. Only water is a cell that *looks* like ground to the
      // bot's scan-down-from-the-sky heuristic.
      if (isWaterMaterial(this._topMaterial(cx, cz))) continue;

      const result = this.authority.claimZone(
        { id: -1, t: OP.CLAIM_ZONE, x: cx, z: cz, half: BOT_CLAIM_HALF },
        { id: profile.id, name: profile.name, color: profile.color },
      );
      if (!result.ok) continue;

      worker.claim = result.result;
      worker.workedAt = Date.now();
      return true;
    }

    // Nowhere free in reach. Not an error worth reporting: a world entirely claimed is
    // a legitimate state, and a bot with no district simply works where it can.
    worker.claim = null;
    return false;
  }

  /**
   * Renew or drop a bot's claim depending on whether it has been working.
   *
   * Called on each step. A bot that has built since its last check renews; one that has
   * not lets the claim lapse, which is the honest version -- a bot whose district has
   * decayed is one whose objective is satisfied or blocked, and holding ground it is
   * not working is exactly what decay is meant to prevent.
   */
  _tendClaim(worker) {
    if (!this.claimDecay) return;
    const now = Date.now();

    if (worker.sinceAnnounce > 0) {
      // Worked: keep it, but only renew occasionally so four bots are not re-claiming
      // on every step.
      if (now - worker.workedAt < 30_000) return;
      if (this.holdGround(worker)) { worker.sinceAnnounce = 0; return; }
    }

    // Not working: let it go rather than renewing on a timer.
    if (worker.claim && now - worker.workedAt > WORLD.ZONE_HOLD_MS) {
      this._dropClaim(worker);
      this.broadcast({
        t: 'botAction',
        kind: 'claimLost',
        builderId: worker.profile.id,
        name: worker.profile.name,
        color: worker.profile.color,
      });
    }
  }

  schedule(worker, delay) {
    // Clear any pending timer before arming the next one.
    //
    // `step` reschedules itself, so without this each worker accumulates a chain of
    // live timers: `worker.timer` only ever held the most recent one, so the earlier
    // ones could never be cancelled. `dispose` then reported an empty worker map and
    // cleared nothing that was still armed, and the process stayed alive until every
    // leaked timer had fired.
    //
    // That is invisible in normal play -- the stray timers do exactly the same work --
    // and fatal in a test runner, where it hangs the file at teardown. It was found
    // by a script that printed "workers: 0" after dispose and then still would not
    // exit.
    if (worker.timer) clearTimeout(worker.timer);
    worker.timer = setTimeout(() => {
      worker.timer = null;
      this.step(worker);
    }, delay);
  }

  /**
   * The active objective, or null when the ladder is finished.
   *
   * Read through the tracker rather than imported, so the swarm has no opinion
   * about what the objectives *are*.
   */
  _activeObjectiveId() {
    const tracker = this.objectives;
    if (!tracker) return null;
    const active = tracker.wire?.active?.[tracker.index];
    return active?.id ?? null;
  }

  /**
   * Whether the active objective still needs what this bot is about to make.
   *
   * Pulls a fresh verdict when the world has moved under the one it holds, rather
   * than trusting that some unrelated 1 Hz timer will have refreshed it.
   *
   * The earlier version read `tracker.wire.active[index].current`, which is only
   * refreshed when `evaluate()` runs -- so whether the guard worked depended entirely
   * on whether some unrelated timer happened to have fired. Reproduced without one:
   * 1,200 prop commits against a goal of one.
   *
   * It is also wrong for a subtler reason. With the human-contributor gate, an
   * objective whose metric is met but which no human has touched stays *active*
   * indefinitely. The metric is satisfied and the ladder cannot advance, so bots
   * polled a goal that could never complete -- 9,093 lanterns in a real session.
   *
   * So: bots only keep working while the objective is genuinely incomplete. A
   * satisfied objective means stand down, whether it is satisfied-but-locked or
   * satisfied-and-waiting-on-the-next-tick. Unlocking it is the human's job, and
   * `syncIntents` re-targets them when the ladder moves.
   *
   * @param {object} intent
   * @returns {boolean}
   */
  _stillNeeded(intent) {
    const tracker = this.objectives;
    if (!tracker) return true;

    // Pull a fresh verdict if the one we hold is stale, rather than trusting that
    // some 1 Hz server timer will have refreshed it.
    //
    // This is the actual bug behind 9,093 lanterns: the guard read a verdict that
    // only `evaluate()` updates, so its correctness depended on an unrelated timer
    // having fired. With that timer absent -- and it was absent in the test that
    // reproduced this -- bots measured zero progress forever and kept building
    // against a goal of one. Asking the tracker directly makes the swarm
    // self-sufficient: it cannot be correct only when something else happens to run.
    if (this._needsRefresh()) {
      tracker.evaluate();
      this.stats.selfEvaluations++;
      // The verdict now describes the world as of the last commit.
      this._evaluatedAtRevision = this.stats.commits + this.stats.propCommits;
    }

    const active = tracker.wire?.active?.[tracker.index];
    if (!active) return false; // ladder exhausted: nothing left to serve

    // A tower is the exception: it is built by repeatedly topping the same column,
    // so "enough blocks exist" is not the test -- "the summit reached the height"
    // is, and the planner handles that directly.
    if (intent.kind === 'tower') return true;

    // Unmeasured because the tracker has not scanned yet: assume work remains, so a
    // bot never stalls waiting for a first verdict.
    if (typeof active.current !== 'number') return true;
    return active.current < active.goal;
  }

  _intentFor(profile) {
    // The definition, not its id. Past the campaign the active objective is a
    // generated tail entry with nowhere to be looked up by id, and handing
    // `intentFor` that id made it fall through to the idle branch -- so every
    // bot stood down the moment the scripted eight were done, and the endless
    // tail was a world where nothing built itself.
    const active = this.objectives ? this.objectives.currentObjective() : null;
    return chooseIntent(active, profile.specialism);
  }

  /**
   * Whether the held verdict predates the world's latest change.
   *
   * Keyed on *what changed*, not on elapsed time. A wall-clock interval was tried
   * first and is wrong in both directions: longer than a bot's step, and the swarm
   * measured a stale verdict for the whole interval and ran away again; shorter, and
   * four bots meant four full world scans per step for no new information.
   *
   * Revisions are exact, so the swarm re-measures exactly when the world has moved
   * under the verdict it holds and never otherwise. In production the host's 1 Hz tick
   * calls {@link markEvaluated}, so most commits are covered by the host's own scan and
   * this costs a single comparison.
   */
  _needsRefresh() {
    const since = this.stats.commits + this.stats.propCommits;
    return since !== this._evaluatedAtRevision;
  }

  /** Called by the host after its own evaluation, so we adopt that result. */
  markEvaluated() {
    this._evaluatedAtRevision = this.stats.commits + this.stats.propCommits;
  }

  /**
   * Called every objective evaluation, so a bot announces the moment the shared
   * goal changes rather than silently carrying on with the previous one.
   */
  syncIntents() {
    const active = this._activeObjectiveId();
    if (active === this._lastObjective) return false;
    this._lastObjective = active;
    for (const worker of this.workers.values()) {
      worker.intent = this._intentFor(worker.profile);
      worker.queue.length = 0;
      this.stats.intentChanges++;
      this.broadcast({
        t: 'botAction',
        kind: 'intent',
        builderId: worker.profile.id,
        name: worker.profile.name,
        color: worker.profile.color,
        intent: worker.intent,
        objective: active,
      });
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Sites
  // -------------------------------------------------------------------------

  /**
   * A random buildable anchor inside a bot's own district.
   *
   * District ownership is what turns scattered output into a place. The search is
   * bounded to a quadrant so the plaza fills in with recognisable neighbourhoods
   * rather than one uniform heap.
   */
  findSite(profile, { near = null } = {}) {
    const a = this.authority;
    const { x: sx, z: sz } = profile.district;

    // Prefer ground the bot actually owns.
    //
    // This became essential rather than cosmetic once bots were made to respect
    // claims. The search ranged over the bot's whole quadrant (6..17 units out) while
    // its claim was an 8x8 block near the middle, so the great majority of picks fell
    // outside its own district, were refused by preflight, and the bot did nothing.
    // Measured: 400 steps produced 0 block commits and 1 prop.
    //
    // So: search the claim first, and fall back to the wider quadrant only when the
    // claim is full or gone. That keeps each bot visibly working its own quarter --
    // which is the entire point of districts -- without ever leaving it stuck.
    const claim = this.workers.get(profile.id)?.claim ?? null;

    if (claim) {
      const site = this._siteIn(claim.x0, claim.x1, claim.z0, claim.z1, near);
      if (site) return site;
    }

    for (let attempt = 0; attempt < 70; attempt++) {
      // Bias toward `near` once a bot has a structure going, so runs are
      // continuous instead of restarting somewhere random each plan.
      const spread = near ? 4 : DISTRICT_MAX - DISTRICT_MIN;
      const base = near ?? {
        x: Math.round(sx * (DISTRICT_MIN + Math.random() * (DISTRICT_MAX - DISTRICT_MIN))),
        z: Math.round(sz * (DISTRICT_MIN + Math.random() * (DISTRICT_MAX - DISTRICT_MIN))),
      };
      const x = Math.round(base.x + (Math.random() * 2 - 1) * spread);
      const z = Math.round(base.z + (Math.random() * 2 - 1) * spread);

      if (Math.hypot(x, z) > WORLD.RADIUS - 3) continue;
      // Skip anything inside somebody else's ground, including another bot's.
      const owner = a.zoneAt(x, z);
      if (owner && owner.ownerId !== profile.id) continue;

      const site = this._siteAt(x, z);
      if (site) return site;
    }

    this.stats.failedSites++;
    return null;
  }

  /** A buildable cell at a specific column, or null. */
  _siteAt(x, z) {
    if (Math.hypot(x, z) > WORLD.RADIUS - 3) return null;
    const ground = this._surfaceY(x, z);
    if (ground < 0) return null;
    if (ground + 1 >= WORLD.MAX_Y) return null;
    if (this.authority.getBlock(x, ground + 1, z) !== 0) return null;
    return { x, y: ground + 1, z };
  }

  /**
   * A buildable cell inside a rectangle, or null.
   *
   * Searches near `near` first when a structure is already going, so runs stay
   * continuous instead of jumping around inside the district.
   */
  _siteIn(x0, x1, z0, z1, near = null) {
    const span = near ? 4 : Math.max(x1 - x0, z1 - z0);
    for (let attempt = 0; attempt < 48; attempt++) {
      const bx = near ? near.x : Math.round(x0 + Math.random() * (x1 - x0));
      const bz = near ? near.z : Math.round(z0 + Math.random() * (z1 - z0));
      const x = Math.round(bx + (Math.random() * 2 - 1) * span);
      const z = Math.round(bz + (Math.random() * 2 - 1) * span);
      if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
      const site = this._siteAt(x, z);
      if (site) return site;
    }
    return null;
  }

  /** Highest solid voxel in a column, or -1 for an empty one. */
  /** Material of the topmost non-air cell in a column, or 0 if the column is empty. */
  _topMaterial(x, z) {
    for (let y = WORLD.MAX_Y - 1; y >= WORLD.MIN_Y; y--) {
      const mat = this.authority.getBlock(x, y, z);
      if (mat !== 0) return mat;
    }
    return 0;
  }

  _surfaceY(x, z) {
    // Water is a real voxel here, not an absence of one, so a naive scan down from the
    // top finds the *water surface* and hands it back as buildable ground. Every bot
    // would then stack its district on top of the lagoon, and the bot districts would
    // be visible jetties instead of neighbourhoods.
    //
    // So this answers the question the callers actually mean -- the y a bot can put a
    // block on -- and refuses any column whose topmost cell is water. All three callers
    // (findSite, findPropSite, _districtSummit) go through here, so this single
    // predicate is what keeps the whole swarm on the beach. Returns -1, which every
    // caller already treats as "no site".
    for (let y = WORLD.MAX_Y - 1; y >= WORLD.MIN_Y; y--) {
      const mat = this.authority.getBlock(x, y, z);
      if (mat === 0) continue;
      if (isWaterMaterial(mat)) return -1;
      return y;
    }
    return -1;
  }

  /**
   * Find a cell that can hold a prop: air, with solid ground beneath and nothing
   * already standing there. Mirrors the server's own prop rules so a bot never
   * commits something that will simply be refused.
   */
  findPropSite(profile, near = null) {
    const a = this.authority;
    const { x: sx, z: sz } = profile.district;

    // Same rule as findSite: a bot places its props in the ground it holds. Props are
    // the objectives' currency -- lanterns and plants -- so where they land decides
    // whether the districts look inhabited or whether one bot owns all the lanterns.
    const claim = this.workers.get(profile.id)?.claim ?? null;
    if (claim) {
      const site = this._siteIn(claim.x0, claim.x1, claim.z0, claim.z1, near);
      if (site && !a.chunk(Math.floor(site.x / 16), Math.floor(site.z / 16))?.props
        .has(`${site.x},${site.y},${site.z}`)) {
        return site;
      }
    }

    for (let attempt = 0; attempt < 90; attempt++) {
      const base = near ?? {
        x: Math.round(sx * (DISTRICT_MIN + Math.random() * (DISTRICT_MAX - DISTRICT_MIN))),
        z: Math.round(sz * (DISTRICT_MIN + Math.random() * (DISTRICT_MAX - DISTRICT_MIN))),
      };
      const spread = near ? 5 : DISTRICT_MAX - DISTRICT_MIN;
      const x = Math.round(base.x + (Math.random() * 2 - 1) * spread);
      const z = Math.round(base.z + (Math.random() * 2 - 1) * spread);
      if (Math.hypot(x, z) > WORLD.RADIUS - 3) continue;

      // Anywhere else, never inside somebody else's district.
      const owner = a.zoneAt(x, z);
      if (owner && owner.ownerId !== profile.id) continue;

      const ground = this._surfaceY(x, z);
      if (ground < 0 || ground + 1 >= WORLD.MAX_Y) continue;

      const y = ground + 1;
      if (a.getBlock(x, y, z) !== 0) continue;
      const key = `${x},${y},${z}`;
      if (a.chunk(Math.floor(x / 16), Math.floor(z / 16))?.props.has(key)) continue;
      return { x, y, z };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  /**
   * Turn the current intent into a queue of concrete steps.
   *
   * Steps are `[x, y, z, mat]` for a block or `{prop, x, y, z, rot}` for a prop,
   * so the same queue machinery handles both.
   */
  plan(worker) {
    const { profile, intent } = worker;
    if (intent.kind === 'idle') { worker.queue = []; return []; }
    if (!this._stillNeeded(intent)) { worker.queue = []; return []; }

    if (intent.kind === 'prop') {
      const site = this.findPropSite(profile);
      if (!site) { worker.queue = []; return []; }
      // Lanterns and torches want height or a wall; plants want ground. That
      // difference is the whole reason the objective ladder lists them separately.
      const prop = intent.prop;
      const elevated = prop === 'lantern' || prop === 'torch';
      const step = elevated ? this._propSite(profile, prop) : site;
      return step ? [{ prop, ...step, rot: Math.floor(Math.random() * 4) }] : [];
    }

    if (intent.kind === 'material') {
      const mat = intent.material;
      const site = this.findSite(profile);
      if (!site) { worker.queue = []; return []; }
      // A short plinth so the goal material is a deliberate feature of a build
      // rather than one stray block.
      const steps = [];
      const run = 2 + Math.floor(Math.random() * 3);
      const dir = Math.floor(Math.random() * 4);
      const dx = [1, -1, 0, 0][dir];
      const dz = [0, 0, 1, -1][dir];
      for (let i = 0; i < run; i++) steps.push([site.x + dx * i, site.y, site.z + dz * i, mat]);
      return steps;
    }

    if (intent.kind === 'tower') {
      // Build on top of the tallest thing in this district rather than from the
      // ground, so repeated visits raise one beacon instead of four short ones.
      // If the district already tops the goal the queue is empty, and the step
      // loop reschedules rather than spinning.
      const top = this._districtSummit(profile);
      if (top >= intent.height) return [];
      const steps = [];
      const mat = FILLER[profile.plan === 'terrace' ? 'slate' : 'stone'] ?? 1;
      for (let y = top + 1; y <= intent.height; y++) {
        steps.push([this._summit.x, y, this._summit.z, y === intent.height ? 8 : mat]);
      }
      return steps;
    }

    return [];
  }

  /**
   * Prop placement that respects what the prop is for: a lantern on a post of its
   * own, a torch on a wall face. Returns null when it cannot find a legal cell.
   */
  _propSite(profile, prop) {
    if (prop === 'lantern') {
      // One block of support, then the lantern on top, so lanterns read as
      // deliberate lamps rather than floating props.
      const base = this.findSite(profile);
      if (!base) return null;
      const post = this.authority.commitAs(profile, base.x, base.y, base.z, 7);
      if (!post) return null;
      this._noteBuilder(profile);
      return { x: base.x, y: base.y + 1, z: base.z };
    }
    if (prop === 'torch') {
      const base = this.findSite(profile);
      if (!base) return null;
      if (this.authority.commitAs(profile, base.x, base.y, base.z, 7)) this._noteBuilder(profile);
      return { x: base.x, y: base.y + 1, z: base.z };
    }
    return this.findPropSite(profile);
  }

  /**
   * Record that this bot has touched the world, so it counts as a distinct builder.
   *
   * The contributor set used to be reachable only from the socket op handler, which
   * meant only humans entered it. That made `Room For Everyone` (three distinct
   * builders) unreachable for anyone playing alone: the ladder stalled at 6/8 with
   * nothing the solo player could do, because no amount of their own building adds
   * a second person. A bot that has placed a block has touched the world exactly
   * the way a person has, so it belongs in the count.
   *
   * This deliberately does *not* touch `humanTouched`. The metric and the unlock are
   * separate inputs: bots can satisfy the number, but a person still has to act on
   * the objective before it completes, so the swarm cannot carry the ladder alone.
   * That distinction is asserted by `a bot commit can never unlock an objective`.
   *
   * @param {{id: string}} profile
   */
  _noteBuilder(profile) {
    this.objectives?.noteContributor(profile?.id);
  }

  /** Highest occupied y in a bot's district, plus where it was found. */
  _districtSummit(profile) {
    let best = -1;
    let at = null;
    const { x: sx, z: sz } = profile.district;

    for (let i = 0; i < 90; i++) {
      const x = Math.round(sx * (DISTRICT_MIN + Math.random() * (DISTRICT_MAX - DISTRICT_MIN)));
      const z = Math.round(sz * (DISTRICT_MIN + Math.random() * (DISTRICT_MAX - DISTRICT_MIN)));
      if (Math.hypot(x, z) > WORLD.RADIUS - 3) continue;
      const y = this._surfaceY(x, z);
      if (y > best) { best = y; at = { x, z }; }
    }

    this._summit = at ?? { x: Math.round(sx * 8), z: Math.round(sz * 8) };
    return best;
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  step(worker) {
    if (!this.enabled) return;

    // Pick up a new objective immediately rather than finishing an obsolete plan.
    const active = this._activeObjectiveId();
    if (active !== this._lastObjective) this.syncIntents();

    if (worker.queue.length === 0) {
      if (worker.intent.kind === 'idle') {
        this.stats.idleTicks++;
        this.schedule(worker, 2500);
        return;
      }
      // The goal may already be met but the tracker has not re-evaluated yet.
      // Wait rather than re-planning, so the bots stop the instant they are done
      // instead of over-building until the next tick catches up.
      if (!this._stillNeeded(worker.intent)) {
        this.stats.satisfiedTicks++;
        this.schedule(worker, 700);
        return;
      }
      worker.queue = this.plan(worker);
      if (worker.queue.length === 0) {
        this.schedule(worker, 1800);
        return;
      }
    }

    const step = worker.queue.shift();
    const committed = step.prop
      ? this._commitProp(worker, step)
      : this._commitBlock(worker, step);

    // A refused step is dropped rather than retried forever: the site may have been
    // built over by a player in the meantime, or fenced off by a claim, and retrying
    // would spin.
    if (!committed) worker.queue.length = 0;

    // Work is what holds a district. Counted only on a successful commit, so a bot
    // that is blocked everywhere does not keep its claim alive merely by trying.
    if (committed) {
      worker.sinceAnnounce++;
      worker.workedAt = Date.now();
      this._announceClaim(worker);
    }
    this._tendClaim(worker);

    this.schedule(worker, worker.profile.interval);
  }

  /**
   * Announce a bot's territory, rate-limited.
   *
   * Claims change what other builders may do, so clients need them -- but four bots
   * committing about once a second each would be a permanent flood of zone traffic.
   * Announced on the first build after taking ground, and then only when the district
   * actually moves, which is the only time the map genuinely changed.
   */
  _announceClaim(worker) {
    const claim = worker.claim;
    if (!claim) return;
    const key = `${claim.cx},${claim.cz}`;
    if (worker.announcedAt === key) return;
    worker.announcedAt = key;
    this.broadcast({
      t: 'botAction',
      kind: 'claim',
      builderId: worker.profile.id,
      name: worker.profile.name,
      color: worker.profile.color,
      cx: claim.cx,
      cz: claim.cz,
      half: claim.half,
    });
  }

  _commitBlock(worker, [x, y, z, mat]) {
    // Announce before committing so clients can draw the targeting ray while the
    // delta is still in flight.
    this.broadcast({
      t: 'botAction',
      builderId: worker.profile.id,
      name: worker.profile.name,
      color: worker.profile.color,
      x, y, z, mat,
      hand: [x + 1.6, y + 1.4, z + 1.6],
      intent: worker.intent.label,
    });

    const result = this.authority.commitAs(worker.profile, x, y, z, mat);
    if (result) {
      worker.placed++;
      this.stats.commits++;
      this._noteBuilder(worker.profile);
      this.onWorldChanged();
    }
    return result;
  }

  _commitProp(worker, step) {
    const { x, y, z, prop, rot } = step;
    this.broadcast({
      t: 'botAction',
      builderId: worker.profile.id,
      name: worker.profile.name,
      color: worker.profile.color,
      x, y, z, prop, rot,
      hand: [x + 1.4, y + 1.2, z + 1.4],
      intent: worker.intent.label,
    });

    const record = this.authority.commitPropAs(worker.profile, x, y, z, prop, rot);
    if (record) {
      worker.placed++;
      this.stats.propCommits++;
      this._noteBuilder(worker.profile);
      this.onWorldChanged();
    }
    return record;
  }

  /** Broadcast the current swarm roster, including what each bot is working on. */
  roster() {
    return BOT_PROFILES.map((p) => {
      const worker = this.workers.get(p.id);
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        bot: true,
        specialism: SPECIALISMS[p.specialism]?.label ?? p.specialism,
        intent: worker?.intent?.label ?? 'getting started',
        objective: worker?.intent?.kind === 'idle' ? null : this._activeObjectiveId(),
        placed: worker?.placed ?? 0,
      };
    });
  }

  dispose() {
    for (const w of this.workers.values()) {
      if (w.timer) clearTimeout(w.timer);
      w.timer = null;
      // Releases the ground too. Claims live in the authority, not in the worker map,
      // so disposing the swarm without releasing them leaves districts held by bots
      // that no longer exist -- permanently blocking that ground for everyone.
      this._dropClaim(w);
    }
    this.workers.clear();
  }
}
