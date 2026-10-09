/**
 * Shared build objectives.
 *
 * A sandbox with no goal is not a game, and the goals have to be *true* rather
 * than self-reported -- "I finished the objective" is not a win condition, it is
 * a claim. So every objective here is a pure function of authoritative world
 * state, evaluated on the server, and the client is only ever told the answer.
 * A client that lies about its progress gets nothing, because progress is not
 * something the client can send.
 *
 * Cooperative by construction: progress is a property of the shared world, not of
 * a player. Every builder contributes to the same bar, and the reward for
 * finishing belongs to whoever is present.
 *
 * Dependency-free so Node and the browser can both import it directly, like
 * `protocol.js` and `materials.js`.
 */

import { CHUNK_SIZE, CHUNK_AREA, WORLD } from './protocol.js';

/**
 * How an objective measures progress.
 *
 * All three are evaluated against world state rather than accumulated from ops,
 * which matters in two ways: a client cannot forge progress, and progress cannot
 * drift out of sync with the world when someone removes a block.
 */
export const METRIC = {
  /** Any voxel of a given material id exists. "The world contains a gold block." */
  MATERIAL_PRESENT: 'materialPresent',
  /** At least N voxels of a material exist anywhere. */
  MATERIAL_COUNT: 'materialCount',
  /** At least N props of a given key exist. */
  PROP_COUNT: 'propCount',
  /** A vertical column exists at least N voxels tall. */
  COLUMN_HEIGHT: 'columnHeight',
  /** At least N distinct builders have each contributed at least one op. */
  DISTINCT_BUILDERS: 'distinctBuilders',
};

/**
 * The objective ladder.
 *
 * Ordered: exactly one is active at a time, and finishing it opens the next. A
 * ladder rather than a board because a board makes the optimal strategy "ignore
 * the hard ones", while a ladder forces a shared order and gives a reason to come
 * back -- which is the whole point of wanting people to return.
 *
 * `check` receives a scan of the world and returns `{ current, goal, done }`.
 */
export const OBJECTIVES = [
  {
    id: 'first_light',
    title: 'First Light',
    brief: 'Place a lantern. Somewhere dark is better than somewhere convenient.',
    metric: METRIC.PROP_COUNT,
    prop: 'lantern',
    goal: 1,
    reward: 'You can see in the dark now.',
  },
  {
    id: 'warm_the_plaza',
    title: 'Warm the Plaza',
    brief: 'Six lanterns, so nobody has to build in the dark.',
    metric: METRIC.PROP_COUNT,
    prop: 'lantern',
    goal: 6,
    reward: 'The plaza is lit.',
  },
  {
    id: 'something_gold',
    title: 'Something Gold',
    brief: 'Put a single block of gold in the world. One is enough to start with.',
    metric: METRIC.MATERIAL_PRESENT,
    material: 6,
    goal: 1,
    reward: 'Worth building around.',
  },
  {
    id: 'gold_ten',
    title: 'Ten Gold',
    brief: 'Ten gold blocks. Gold is scarce here for a reason.',
    metric: METRIC.MATERIAL_COUNT,
    material: 6,
    goal: 10,
    reward: 'A gold standard, literally.',
  },
  {
    id: 'beacon',
    title: 'The Beacon',
    brief: 'Build something twelve voxels tall. Height is measured, not declared.',
    metric: METRIC.COLUMN_HEIGHT,
    goal: 12,
    reward: 'Visible from across the world.',
  },
  {
    id: 'neon_night',
    title: 'Neon Night',
    brief: 'Eight emissive blocks. Cyan or amber, your pick.',
    metric: METRIC.MATERIAL_COUNT,
    // Emissive materials only: 5 = cyan neon, 8 = amber neon.
    material: [5, 8],
    goal: 8,
    reward: 'The plaza does not need lanterns now.',
  },
  {
    id: 'room_for_everyone',
    title: 'Room For Everyone',
    brief: 'Three different builders have to touch the world. Invite someone.',
    metric: METRIC.DISTINCT_BUILDERS,
    goal: 3,
    reward: 'It is a shared world, after all.',
  },
  {
    id: 'garden',
    title: 'Garden',
    brief: 'Four plants. The plaza could use something alive.',
    metric: METRIC.PROP_COUNT,
    prop: 'plant',
    goal: 4,
    reward: 'Green in a world of stone.',
  },
];

export const OBJECTIVE_IDS = OBJECTIVES.map((o) => o.id);

/**
 * Where the scripted campaign ends and the endless tail begins.
 *
 * Exported rather than inferred by the client from `total`, because `total` is
 * the length of whatever ladder the server generated and grows as it goes -- it
 * is a property of the tail, not a boundary. The client needs the boundary to
 * know it is allowed to celebrate.
 */
export const CAMPAIGN_LENGTH = OBJECTIVES.length;

/**
 * Scan authoritative world state into the counts the objectives need.
 *
 * One pass over every chunk, computing every metric at once. The ladder is
 * evaluated on a timer and there are 8 objectives; walking the world once per
 * objective would be 8x the work for the same answer.
 *
 * Tallest-column is computed as the longest *contiguous* run of non-air
 * vertically. That is what "built something twelve voxels tall" should mean: a
 * tower with a gap in it is two shorter things, not one tall thing.
 *
 * @param {Iterable<{cx:number, cz:number, cells: Uint16Array}>} chunks
 * @param {Iterable<{prop:string}>} props every live prop record
 * @param {Iterable<string>} contributingBuilderIds builders who have committed an op
 */
export function scanWorld(chunks, props, contributingBuilderIds) {
  /**
   * Material id -> live voxel count. Keys are strings so this map survives the JSON
   * hop to the wire without changing shape.
   * @type {Map<string, number>}
   */
  const materialCounts = new Map();
  /** @type {Map<string, number>} prop key -> live prop count */
  const propCounts = new Map();
  let tallest = 0;

  for (const prop of props) {
    propCounts.set(prop.prop, (propCounts.get(prop.prop) ?? 0) + 1);
  }

  // Reused across every chunk so a large world does not allocate one array per
  // column per evaluation. 16x16 = one row of a chunk.
  const run = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);

  for (const chunk of chunks) {
    const { cx, cz, cells } = chunk;
    run.fill(0);

    for (let y = WORLD.MIN_Y; y < WORLD.MAX_Y; y++) {
      const yBase = (y - WORLD.MIN_Y) * CHUNK_AREA;
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const mat = cells[lx + lz * CHUNK_SIZE + yBase];
          const slot = lx + lz * CHUNK_SIZE;

          if (mat === 0) {
            // A gap breaks the run: a tower with a hole in it is not one tower.
            run[slot] = 0;
            continue;
          }

          run[slot] += 1;
          if (run[slot] > tallest) tallest = run[slot];
          // Keyed as a string because the Map is serialised to JSON for the wire,
          // and JSON turns every object key into a string anyway. Normalising here
          // keeps the in-memory map and the wire format identical -- mixing numeric
          // and string keys is exactly how this silently reads zero everywhere.
          const key = String(mat);
          materialCounts.set(key, (materialCounts.get(key) ?? 0) + 1);
        }
      }
    }
    void cx; void cz;
  }

  return {
    materialCounts,
    propCounts,
    tallest,
    builders: new Set(contributingBuilderIds),
  };
}

/**
 * Evaluate one objective against a scan produced by {@link scanWorld}.
 *
 * Returns a plain object rather than a boolean so the HUD can render a progress
 * bar without recomputing anything.
 *
 * @param {object} objective
 * @param {{materialCounts: Map<string, number>, propCounts: Map<string, number>, tallest: number, builders: Set<string>}} scan
 * @param {{tallest: number}} worldStats
 */
export function evaluate(objective, scan, worldStats = {}) {
  const goal = objective.goal ?? 1;
  let current = 0;

  switch (objective.metric) {
    case METRIC.MATERIAL_PRESENT: {
      const ids = Array.isArray(objective.material) ? objective.material : [objective.material];
      current = ids.some((id) => (scan.materialCounts.get(String(id)) ?? 0) > 0) ? 1 : 0;
      break;
    }
    case METRIC.MATERIAL_COUNT: {
      const ids = Array.isArray(objective.material) ? objective.material : [objective.material];
      current = ids.reduce((sum, id) => sum + (scan.materialCounts.get(String(id)) ?? 0), 0);
      break;
    }
    case METRIC.PROP_COUNT:
      current = scan.propCounts.get(objective.prop) ?? 0;
      break;
    case METRIC.COLUMN_HEIGHT:
      current = worldStats.tallest ?? scan.tallest ?? 0;
      break;
    case METRIC.DISTINCT_BUILDERS:
      current = scan.builders?.size ?? 0;
      break;
    default:
      current = 0;
  }

  // Clamp so a world that over-delivers (20 lanterns against a goal of 6) reads
  // as a full bar, not an overflowing one.
  const clamped = Math.min(current, goal);
  return { current: clamped, raw: current, goal, done: clamped >= goal };
}

/**
 * Serialisable ladder state for the wire.
 *
 * Sends the definitions the client needs to render plus the evaluated progress,
 * so the client never contains the rules -- it displays a verdict.
 */
export function toWire(objectives, index, completed, scan, worldStats) {
  return {
    index,
    total: objectives.length,
    /**
     * Length of the scripted campaign, so the client can tell "objective 9" from
     * "objective 9 of the endless tail" and only celebrate crossing the actual
     * boundary. Taken from the constant rather than `objectives.length`, which
     * includes generated tail entries.
     */
    campaign: CAMPAIGN_LENGTH,
    completed,
    active: objectives.map((o) => ({ ...o, ...evaluate(o, scan, worldStats) })),
  };
}

// ---------------------------------------------------------------------------
// The endless tail
// ---------------------------------------------------------------------------

/**
 * Objectives past the end of the campaign.
 *
 * A ladder that stops leaves nobody a reason to return: the panel reads "Ladder
 * complete" and the shared goal that organised everyone's building is simply
 * over. A *daily* reset was considered and rejected, because it penalises a
 * persistent world for the crime of having been built on Tuesday -- and this
 * world is the thing players are meant to care about, so a mode that wipes their
 * gains on a schedule is a mode nobody invests in.
 *
 * So the tail is endless instead: the same measured goals, re-rolled with rising
 * targets. Two properties matter more than the flavour text:
 *
 * 1. **Each is a pure function of `(seed, n)`.** Persistence round-trips the
 *    cursor and the completed ids but not objective *definitions*, so a stored
 *    ladder would be lost on restart and regenerated ids would no longer match
 *    the ones already sent to clients. Deriving them keeps a restart
 *    byte-identical with nothing extra to save.
 * 2. **Difficulty is capped** (see `tier`). An endless goal that scales forever
 *    stops being a goal and becomes a chore, which is how endless modes die.
 *
 * Nothing here is self-reported. These run through the same `evaluate()` against
 * the same world scan as the campaign, and still need a human touch to unlock --
 * so bots cannot grind the tail on their own either.
 */

/** Material the tail can ask for, with a name that reads as a goal. */
const ROLLING_MATERIALS = [
  { id: 6, noun: 'gold', title: 'Gold Rush', brief: 'Gold is scarce here for a reason. Prove you can get more of it.' },
  { id: 5, noun: 'cyan neon', title: 'Cold Light', brief: 'The lagoon should glow after dark.' },
  { id: 8, noun: 'amber neon', title: 'Warm Glow', brief: 'Amber reads warmer than cyan. Use both.' },
  { id: 2, noun: 'red brick', title: 'Brickwork', brief: 'Something load-bearing for once.' },
  { id: 3, noun: 'oak wood', title: 'Timber Yard', brief: 'Wood everywhere -- this is an island.' },
  { id: 7, noun: 'dark slate', title: 'Slate Roof', brief: 'Dark stone underneath all that sand.' },
  { id: 9, noun: 'cyan glass', title: 'Clear Thinking', brief: 'Glass lets the light through and keeps the sand out.' },
];

/** Props the tail can ask for. All eight are buildable without a ladder to chase. */
const ROLLING_PROPS = [
  { key: 'bench', title: 'Somewhere to Sit', brief: 'A world nobody can sit in is a world nobody visits.' },
  { key: 'table', title: 'Set the Table', brief: 'A surface to put things on is the beginning of a room.' },
  { key: 'campfire', title: 'Keep the Fire', brief: 'Something warm to build around.' },
  { key: 'parasol', title: 'Some Shade', brief: 'It is noon here. Get out of it.' },
  { key: 'sign', title: 'Leave a Note', brief: 'The next builder should know what you were doing.' },
  { key: 'chair', title: 'Pull Up a Chair', brief: 'One chair is a prop. Two is an invitation.' },
  { key: 'torch', title: 'More Torches', brief: 'Torches need no base, so they can go anywhere.' },
  { key: 'plant', title: 'More Green', brief: 'Something alive between all the stone.' },
];

/**
 * How many tail objectives make a "round", purely for the client's kicker text.
 * A round gives the endless mode a rhythm without pretending it has an ending.
 */
export const ROUND_SIZE = 4;

/** Difficulty tier for tail objective `n`, capped so the tail never becomes a chore. */
function tierFor(n) {
  return 1 + Math.min(4, Math.floor(n / ROUND_SIZE));
}

const ROLLING_KINDS = [
  /** More of a material the world is short of. */
  (rand, tier, n) => {
    const m = rand.pick(ROLLING_MATERIALS);
    const goal = 8 + tier * 4 + Math.floor(rand.n() * 5);
    return {
      metric: METRIC.MATERIAL_COUNT, material: m.id, goal,
      title: m.title, brief: m.brief, reward: `${goal} blocks of ${m.noun}.`,
    };
  },
  /** More of a prop. These scale more gently: props are placeable in bulk. */
  (rand, tier) => {
    const p = rand.pick(ROLLING_PROPS);
    const goal = 3 + tier * 2 + Math.floor(rand.n() * 3);
    return {
      metric: METRIC.PROP_COUNT, prop: p.key, goal,
      title: p.title, brief: p.brief, reward: `${goal} of them now.`,
    };
  },
  /** Taller. Never past WORLD.MAX_Y, which would be unsatisfiable. */
  (rand, tier) => {
    const titles = ['High Ground', 'Skyline', 'Above It All', 'Long View', 'The Long Shadow'];
    const goal = Math.min(WORLD.MAX_Y - 1, 14 + tier * 4);
    return {
      metric: METRIC.COLUMN_HEIGHT, goal,
      title: titles[tier - 1] ?? 'High Ground',
      brief: `${goal} voxels, unbroken. A gap makes two shorter things.`,
      reward: 'Visible from the far side of the lagoon.',
    };
  },
  /** More humans. Capped at 5: past that it stops being a goal and becomes a wall. */
  (rand, tier) => {
    const goal = 3 + Math.min(2, tier - 1);
    const titles = ['Bring a Friend', 'Full House'];
    return {
      metric: METRIC.DISTINCT_BUILDERS, goal,
      title: titles[Math.min(titles.length - 1, tier - 1)],
      brief: `${goal} different builders, each contributing something.`,
      reward: 'Still a shared world, after all.',
    };
  },
];

/** 32-bit mix so `(seed, n)` is well spread without pulling in a hash library. */
function hash32(seed, n) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (n >>> 0), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Mulberry32: 4 lines, good distribution for shuffling a 9-element array, and
 * it produces the *same* stream on every platform because it is all 32-bit
 * integer maths. Anything using `Math.random` here would silently regenerate a
 * different ladder after every restart.
 */
function mulberry32(a) {
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.n = () => next();
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  return next;
}

/**
 * The `n`-th objective of the endless tail (n = 0 is the one after `garden`).
 *
 * @param {number} seed stable per server, so a restart regenerates the same tail
 * @param {number} n zero-based position in the tail
 * @returns {object} shaped exactly like a campaign objective
 */
export function rollingObjective(seed = 0, n = 0) {
  const rand = mulberry32(hash32(seed >>> 0, n >>> 0));
  const tier = tierFor(n);
  // Rotate through the kinds with a small jitter: `(n + 0..2) % kinds` always
  // differs from the same expression at `n + 1`, so a kind never repeats twice in
  // a row, while the jitter stops it reading as a fixed cycle.
  const kind = ROLLING_KINDS[(n + Math.floor(rand() * 3)) % ROLLING_KINDS.length];
  return { id: `rolling_${n}`, rolling: true, ...kind(rand, tier, n) };
}

/**
 * Round number a tail index belongs to, for the panel's kicker.
 *
 * Takes only the index, deliberately: `Array.prototype.map(roundOf)` would pass
 * the array position as a second argument, and a defaulted parameter would
 * silently swallow it and return a wrong round for every element.
 *
 * @param {number} index absolute ladder index
 */
export function roundOf(index) {
  if (index < CAMPAIGN_LENGTH) return 0;
  return Math.floor((index - CAMPAIGN_LENGTH) / ROUND_SIZE) + 1;
}
