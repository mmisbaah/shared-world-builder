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
    completed,
    active: objectives.map((o) => ({ ...o, ...evaluate(o, scan, worldStats) })),
  };
}
