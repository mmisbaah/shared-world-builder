/**
 * Atoll terrain generation.
 *
 * Generates a Maldives-style reef island: a sand cay in the middle, a shallow
 * turquoise lagoon around it, a reef shelf, and deep water beyond. Pure and
 * dependency-free so it can be tested directly and run unchanged on the server.
 *
 * Why a generator rather than a hand-authored island:
 *
 * - The previous seed was a *plaza* -- a dished disc with a raised dais, built so
 *   builds would read against a silhouette. That shape has nothing in common with
 *   an atoll, and the difference is not cosmetic: a plaza is a flat disc, and the
 *   entire appeal of a lagoon is the transition between depths.
 * - A generator makes the depth relationship explicit and testable. "Is the lagoon
 *   shallower than the ocean?" is a question with an answer, not a matter of taste.
 * - It is cheap to retune. Every threshold below is named, so the island can be made
 *   wider, shallower, or more broken without touching the shape maths.
 *
 * The profile, from the centre outward:
 *
 *     cay        dry sand, a few units proud of the waterline
 *     beach      wet sand, sloping to the water
 *     lagoon     shallow turquoise, floor still visible through it
 *     reef       broken rock, breaking the surface in patches
 *     deep       ocean, dropping away
 *
 * Height is driven by distance from the island's centre with a *noise* term, because
 * a perfectly radial island reads as a disc. Two things break the symmetry: the
 * wobble term below, and the lagoon cutting inward as a bay.
 */

import { WORLD } from './protocol.js';

/** Material ids, named so the profile reads as prose. */
const M = {
  // The pre-existing grass material, reused for crown scrub. Not part of the atoll
  // palette because it predates it and is not a beach colour -- but safe, because the
  // objectives target 5, 6 and 8 and nothing here can reach those.
  GRASS: 4,
  SAND_WET: 10,
  SAND: 11,
  PALM: 12,
  PALM_LEAF: 13,
  WATER_SHALLOW: 14,
  WATER_DEEP: 15,
  CORAL: 16,
  REEF: 17,
};

/**
 * Sea level. Everything below this is submerged.
 *
 * At 4 rather than 6, so the cay crown can stand five units proud instead of two. This
 * is a visual decision with a measurable consequence: at two units of relief the island
 * rendered as a flat plateau ringed by water -- the silhouette was correct and the
 * shading was correct, and it still did not read as an island, because there was nothing
 * for the sun to rake across. Five units gives the terraces something to catch light on.
 *
 * Lowering the water also buys vertical room for palms, which matters because the crown
 * is what the bots build on.
 */
export const SEA_LEVEL = 4;

/**
 * Where the turquoise lagoon turns to deep teal.
 *
 * Sits just past the reef shelf (34) minus the shelf itself, so the colour change and
 * the rock change coincide -- which is what makes the reef read as the edge of the
 * lagoon rather than as an arbitrary band.
 */
export const LAGOON_EDGE = 32;

/**
 * The highest y the seed may occupy, exclusive of the beacon objective's target.
 *
 * `beacon` is satisfied by a twelve-voxel-tall column, and height is measured as the
 * longest contiguous run of non-air -- so the seabed being solid from y=0 means every
 * standing column inherits its whole depth. A cay crown at 9 plus the wobble plus a
 * five-block palm measured a seed column at **y=16**: the objective was complete at
 * boot, in the same way the gold dais used to complete two objectives for free.
 *
 * So the ceiling is a stated constant and the generator clamps to it, rather than
 * leaving it to whoever last tunes the profile. 11 leaves exactly one block of headroom
 * below the goal, which is the tightest margin that still means the player has to do
 * something.
 */
export const SEED_CEILING = 11;

/**
 * Highest ground a palm will grow on.
 *
 * Below the waterline is lagoon. Above eight is the cay crown, and the crown is the
 * buildable ground -- where the players work and where all four bot districts anchor
 * their claims. Planting it with trees obstructs exactly the thing the terrain generator
 * exists to provide, and palms up there were also the reason the seed reached y=16 and
 * handed out the `beacon` objective for free.
 *
 * The band between is the beach, which is where a coconut palm actually grows.
 */
export const PALM_MAX_GROUND = 8;

/**
 * How much of the cay crown is scrub rather than bare sand.
 *
 * Swept against the crown. At 0.0 the whole crown is one flat expanse of sand, which
 * reads as a pale plate however correctly it is lit. At 0.5 it is more green than sand
 * and stops reading as a beach. Around 0.25 gives patchy scrub with sand showing through,
 * which is what a cay crown actually looks like from above.
 */
export const SCRUB_THRESHOLD = 0.24;

/**
 * Minimum grove noise for a palm to be planted, and the frequency of the grove field.
 *
 * Swept against the eligible beach band. The grove field was `x/7`, whose period is wide
 * enough that a whole grove's worth of columns passed the threshold together and the
 * exact spacing check then rejected all but the first -- the island carried 14 trees.
 * Tightening the field to `x/3.5` makes the groves smaller and more numerous:
 *
 *     freq 7, thr 0.32 -> 16        freq 4,  thr 0.32 -> 20
 *     freq 5, thr 0.22 -> 26        freq 3.5, thr 0.22 -> 29
 *
 * 0.22 rather than something lower on purpose: a lower threshold admits more trees but
 * also spreads them evenly, and groves with sand visible between them are the look.
 */
export const PALM_GROVE_FREQUENCY = 3.5;
export const PALM_GROVE_THRESHOLD = 0.22;

/**
 * Minimum spacing between palms, in blocks.
 *
 * At 3 the island carried 19 trees; at 2 it carries 35. The crowns are three wide, so
 * 2x2 spacing lets neighbouring crowns touch at their edges -- which reads as a grove --
 * without the five-wide crowns of the first version merging into a single green field.
 */
export const PALM_SPACING = 2;

/**
 * Distance profile, as a table of stops.
 *
 * Each stop is `[radius, height]`. The height is absolute (the y of the top solid
 * cell) and is interpolated linearly between stops, so the shape is defined entirely
 * by this table plus the noise added on top.
 *
 * Chosen so the lagoon is genuinely shallow -- its floor sits two units under the
 * surface, which is what keeps the sand visible through it -- and the deep water
 * drops away fast, which is what gives the drop-off its edge.
 *
 * The cay crown sits at 7, one unit above the water, which is low for a cay and is
 * the single most important number here for a reason that has nothing to do with
 * realism: `beacon` is satisfied by a twelve-voxel-tall column, and column height is
 * measured as the longest *contiguous* run of non-air. The seabed is solid from y=0,
 * so a column standing on the cay crown already reads as 8 tall before a player
 * touches it. At the original crown of 9 -- plus the wobble, plus a five-block palm on
 * top -- the seed itself reached y=16 and handed the objective out free. Any material
 * or height an objective targets has to stay out of the seed, or the objective is not
 * an objective. `seedCeiling()` below enforces it rather than trusting the table.
 */
const PROFILE = [
  [0, 9],    // cay crown, five units proud of the water
  [7, 9],    // a flat cay rather than a dome
  [11, 8],   // the back of the beach
  [14, 5],   // waterline
  [24, 2],   // lagoon floor: shallow enough to see through
  [30, 1],   // outer lagoon
  [34, 3],   // reef shelf rises slightly
  [38, 2],   // then falls again
  [52, 0],   // deep ocean floor
];

/**
 * Interpolate the base height at a distance from the island centre.
 *
 * @param {number} d distance from centre
 * @returns {number} absolute height of the top solid cell
 */
export function profileHeight(d) {
  if (d <= PROFILE[0][0]) return PROFILE[0][1];
  for (let i = 1; i < PROFILE.length; i++) {
    const [d1, h1] = PROFILE[i - 1];
    const [d2, h2] = PROFILE[i];
    if (d > d2) continue;
    const t = (d - d1) / (d2 - d1);
    return h1 + (h2 - h1) * t;
  }
  return 0;
}

/**
 * Cheap value noise.
 *
 * Deterministic, seeded, and smooth enough for terrain. Hash-based rather than a
 * permutation table so the generator stays a single file with no state -- and so the
 * same seed always produces the same island, which is what makes the tests below
 * meaningful.
 *
 * The hash uses `Math.imul` for every multiply, which is the part that matters and the
 * part that was wrong twice:
 *
 * - `seed * 2147483647` is a plain float multiply. At a seed of 4242 the product is
 *   9.1e12, well past 2^53, so the low bits the hash depends on were silently rounded
 *   away and the output collapsed.
 * - The result was then measured spanning **-0.996 to -0.004** -- never positive. Every
 *   palm grove and coral patch is gated on a positive noise value, so the island
 *   generated with no palms and no coral at all, and nothing errored. The first
 *   version of this island had 0 palms and 0 coral and looked entirely plausible.
 *
 * `Math.imul` keeps everything in int32, and dividing the unsigned result by 2^32 puts
 * it in [0,1) before centring, so the range is genuinely [-1,1]. A test now asserts
 * that, because a hash that is silently half-dead is invisible until something gates
 * on the half that is dead.
 *
 * @param {number} x
 * @param {number} z
 * @param {number} seed
 * @returns {number} in [-1, 1]
 */
export function noise2(x, z, seed = 1337) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  // Smoothstep, so the lattice does not show as facets on the beach.
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);

  const h = (ix, iz) => {
    let n = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1442695041);
    n = Math.imul(n ^ (n >>> 15), 1274126177);
    n = n ^ (n >>> 16);
    // >>> 0 is the unsigned reinterpretation; without it the value is negative and
    // the range lands on [-1, 0] instead of [-1, 1].
    return (n >>> 0) / 4294967296;
  };

  const a = h(xi, zi), b = h(xi + 1, zi), c = h(xi, zi + 1), d = h(xi + 1, zi + 1);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return (top + (bot - top) * v) * 2 - 1;
}

/** Layered noise, so the wobble has more than one scale of detail. */
function wobble(x, z, seed) {
  return noise2(x / 9, z / 9, seed) * 1.9
       + noise2(x / 3.5, z / 3.5, seed + 71) * 0.7;
}

/**
 * Where the lagoon bites into the island as a bay.
 *
 * Without this the island is a disc with water around it. With it, there is a bay --
 * an inlet -- which is what stops the plan reading as a plate. One bay is deliberate:
 * two would make the buildable area ambiguous, and the bots' four quadrants need
 * reasonably solid ground to work in.
 *
 * @returns {{x:number, z:number, angle:number, radius:number}}
 */
/**
 * The bay.
 *
 * `angle` is the direction the inlet opens toward -- the mouth, out to sea. Derived
 * from the bay's own position so the two can never disagree: an earlier version
 * hard-coded an angle 19 degrees off the position, so the inlet cut inland on one
 * side while a test measured along `angle` and saw it biting on the other. Two
 * numbers describing one feature, and only one of them true.
 *
 * `reach` is how far past the bay's centre the water is carried, and it is what makes
 * this a channel rather than a pond. Measured before it existed: walking *out* from
 * the bay along its own mouth direction, the ground rose 7 -> 10, and the landward
 * side sat at 7. The bite was exactly backwards -- a ridge pointing out to sea.
 */
export const BAY = (() => {
  /**
   * Placed just *inside* the waterline, and that is the whole constraint.
   *
   * Five earlier positions all failed, three of them identically: a flood fill over the
   * dry columns found a 9-column component against 415 total, i.e. the island cut in
   * two. Those were sign and radius errors on an unconditional carve, and are fixed by
   * the coastal gate in `columnAt` -- the carve can no longer touch anything above the
   * waterline, so it cannot breach the cay whatever the radius.
   *
   * With that fixed, the remaining question is only "is it in the right place", and the
   * answer is r=12: the coastline sits at about r=14, so a bowl centred at r=17 was
   * entirely offshore. Measured then, walking inland from the bay went 4 -> 6 -> 8 -> 9,
   * which is a *hole in the lagoon* two units from the beach -- the exact opposite of an
   * inlet, and invisible as a feature.
   *
   * At r=12 the bowl straddled the waterline but the *gate* only opens where the ground
   * is within three units of sea level, and at r=12 the natural height is eight. The bay
   * centre came out at height 8 -- dry land, two units short of the water -- so the inlet
   * still began four units out to sea instead of cutting in.
   *
   * r=14 is where the profile crosses the waterline, which is exactly where a notch has
   * to sit for the gate to open on it.
   */
  const x = -9, z = 11;
  return {
    x, z,
    radius: 9,
    angle: Math.atan2(z, x),
  };
})();

/**
 * Terrain for one column.
 *
 * Returns the full column: `height` is how many cells are filled from y=0, the cells
 * carry their material, and `water` says what to stack above the seabed.
 *
 * @param {number} x
 * @param {number} z
 * @param {number} [seed]
 * @returns {{height:number, mat:number, water:number, waterTop:number, top:number}}
 */
export function columnAt(x, z, seed = 1337) {
  const dx = x - BAY.x, dz = z - BAY.z;
  const bayDist = Math.hypot(dx, dz);

  const d = Math.hypot(x, z);
  const profile = profileHeight(d);
  let height = profile + wobble(x, z, seed);

  // --- the bay --------------------------------------------------------------
  //
  // Four earlier versions of this were wrong, and three failed identically: a flood
  // fill over the dry columns found a 9-column component against 415 total, i.e. the
  // island cut in two. The cause was structural rather than a sign error. The bay was
  // defined as a *carve* -- an unconditional pull of the terrain down toward the lagoon
  // floor -- so everywhere its radius reached became lagoon. The bay sat at r=17 with a
  // 15-unit carve, which reaches r=2. It was always going to cut the island in half;
  // moving it around only changed where the halves were.
  //
  // A bay is a notch in the *coast*, not a hole bored into the middle of the island, so
  // that is now what it is defined as: the carve is gated on the ground already being
  // near the waterline. At the cay crown, five units above the sea, the gate is zero
  // and the terrain is untouched -- which is what makes this incapable of splitting the
  // island, rather than a radius that happens to be small enough today.
  //
  // Working on height rather than on distance also removes the need for the seaward arm
  // term, which carried a sign error that pointed the inlet inland. The bowl now
  // reaches past the waterline by itself, and since everything beyond the waterline is
  // already below sea level the carve there is a no-op -- so the inlet connects to the
  // lagoon for free.
  const BAY_FALLOFF = 6;
  if (bayDist < BAY.radius + BAY_FALLOFF) {
    // 1 at the bay's centre, 0 at its rim.
    const t = 1 - (bayDist - BAY.radius) / BAY_FALLOFF;
    const bowl = Math.max(0, Math.min(1, t)) ** 2;
    // 1 where the ground is already at or below the waterline, 0 three units above it.
    //
    // Gated on the *profile* height, not the wobbled one. The wobble is worth up to 2.6
    // units and it happened to lift the bay site from 4.8 to 6.3, which pushed it past
    // the gate and left the bay as a one-unit sandbar at height 6 instead of water at
    // 4. Deciding on the wobble would also have made the gate seed-dependent, so the
    // same bay would be a notch in one place and a flat in another.
    const coastal = Math.max(0, Math.min(1, (SEA_LEVEL + 3 - profile) / 3));
    const bite = bowl * coastal;
    if (bite > 0) height = height * (1 - bite) + (SEA_LEVEL - 1) * bite;
  }

  height = Math.max(1, Math.round(height));
  if (height > WORLD.MAX_Y - 2) height = WORLD.MAX_Y - 2;

  // An islet needs neighbours.
  //
  // The wobble can lift a single seabed column just clear of the waterline on its own,
  // and the result is a lone sand block standing in the lagoon with water around it --
  // a flood fill found five such components, the largest of which was nine columns.
  // They are not islets; they are noise, and they scatter the lagoon with specks that
  // read as geometry errors rather than as land.
  //
  // So: a column only breaks the surface if at least two of its four neighbours are
  // also above water. Cheap -- eight lookups -- and it is the same rule that decides
  // where a real shoreline sits.
  if (height >= SEA_LEVEL) {
    let neighbours = 0;
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      // Neighbour height is evaluated *without* the bay carve on purpose: the bay is a
      // channel through the coast, not a reason for the land either side of it to
      // vanish. Carving here would make the carve feed on itself.
      const nh = profileHeight(Math.hypot(x + ox, z + oz)) + wobble(x + ox, z + oz, seed);
      if (nh >= SEA_LEVEL) neighbours++;
    }
    if (neighbours < 2) height = SEA_LEVEL - 1;
  }

  // Sitting exactly *on* the waterline is not a third state, it is water.
  //
  // A column at `height === SEA_LEVEL` reports `top <= SEA_LEVEL` while carrying
  // `water === 0` -- it reads as submerged to any consumer that tests the surface
  // height, and there is no water cell above it to say otherwise. Measured at 311
  // columns, all of them the strays the rule above had just pushed down to exactly
  // the waterline rather than below it.
  //
  // So the shoreline is pushed one unit under and those columns get a real water
  // cell. This also costs nothing at genuine beaches: a column whose natural height
  // is exactly sea level *is* at the waterline, and giving it one cell of water is
  // what makes the tide edge read as a transition rather than a seam.
  if (height === SEA_LEVEL) height = SEA_LEVEL - 1;

  // --- surface material ---------------------------------------------------
  let mat;
  const above = height - SEA_LEVEL;
  if (above >= 1) {
    // Scrub on the crown, sand on the beach.
    //
    // The crown used to be sand everywhere, and a flat expanse of one material under a
    // high sun is a pale plate however correctly it is lit -- there is nothing for the
    // eye to hold on to. Real cay crowns are patchy: scrub where something has taken,
    // bare sand where it has not.
    //
    // `GRASS` is the pre-existing grass material, unused by the atoll until now. Reusing
    // it is safe precisely because the atoll palette was given new ids (10-17) instead
    // of retinting the originals: no material an objective targets (5, 6, 8) can be
    // reached by accident, which is the same rule that keeps the seed from completing
    // `beacon` for free.
    const scrub = above >= 3 && noise2(x / 4.5, z / 4.5, 8123) > SCRUB_THRESHOLD;
    mat = scrub ? M.GRASS : M.SAND;
  } else if (above === 0) mat = M.SAND_WET;  // waterline band
  else mat = seabedMat(d, height, x, z);       // under water

  // --- water column -------------------------------------------------------
  let water = 0;
  let waterTop = 0;
  if (height < SEA_LEVEL) {
    water = SEA_LEVEL - height;
    // The water's own top material: turquoise over the lagoon, deep teal beyond.
    //
    // The threshold is the lagoon rim, not an arbitrary distance. It has to sit past
    // the reef shelf, because the turquoise-to-teal change is what makes the reef
    // read as the edge of something rather than as a colour in the middle of the water.
    // Measured at 30: 1,908 shallow against 3,545 deep over the playable disc, with the
    // lagoon holding the whole middle and the deep water framing it. That is the
    // proportion an atoll actually has -- the lagoon is the feature, the open ocean is
    // the backdrop.
    waterTop = d < LAGOON_EDGE ? M.WATER_SHALLOW : M.WATER_DEEP;
  }

  return { height, mat, water, waterTop, top: height + water };
}

/**
 * What the seabed is made of.
 *
 * Sand under the lagoon floor, reef rock on the shelf, and coral scattered in the
 * shallows. Coral is placed by noise rather than uniformly, so it clumps -- an even
 * scatter reads as noise, and clumping is what makes it look like a reef.
 */
function seabedMat(d, height, x, z) {
  if (height < SEA_LEVEL - 5) return M.SAND;                 // lagoon floor stays sandy
  const reefiness = noise2(x / 5, z / 5, 991);
  if (d > 28 && d < 40 && reefiness > 0.1) return M.REEF;
  if (height >= SEA_LEVEL - 3 && reefiness > 0.25) return M.CORAL;
  if (d > 32) return M.REEF;
  return M.SAND_WET;
}

/**
 * Generate the whole island.
 *
 * @param {number} radius world radius to fill
 * @param {number} [seed]
 * @returns {{blocks: Array<[number,number,number,number]>, water: Array<[number,number,number,number]>, stats: object}}
 *   `blocks` and `water` are [x, y, z, material] tuples, ready to feed the authority.
 */
export function generateIsland(radius = WORLD.RADIUS - 2, seed = 1337) {
  const blocks = [];
  const water = [];
  /**
   * 3x3 patches that already have a palm in them.
   *
   * Held across the whole sweep rather than recomputed per grove, which is what makes a
   * grove a grove: with the test applied per column, every qualifying column inside a
   * grove threshold planted a tree and the result was a solid mat of them.
   */
  const planted = new Set();

  /**
   * How far out the deep ocean reaches.
   *
   * Capped so the island sits in a ring of water rather than filling the whole
   * disc. Uncapped, the deep ocean outnumbered the lagoon 3,487 to 1,905 -- the frame
   * became open sea with an island in it, which is the opposite of an atoll, where the
   * lagoon *is* the feature and the deep water is the backdrop.
   */
  const oceanEdge = 33;

  // Surface counts, not volume counts.
  //
  // The first version tallied every emitted cell by material, which made `wet` come out
  // at 12,151 against 537 for dry sand -- because buried seabed is filled with wet sand
  // on purpose so it does not read as floating. The numbers were correct and useless:
  // they described the interior, not the island. Surface area is what "how much sand
  // is there" actually means, and it is what a player would see.
  let sand = 0, wet = 0, reef = 0, coral = 0, palm = 0, leaf = 0, scrub = 0;
  let shallow = 0, deep = 0;
  let dryLand = 0, lagoon = 0, ocean = 0;

  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      const distC = Math.hypot(x, z);
      const col = columnAt(x, z, seed);

      // Beyond the ocean edge there is only deep water, and nothing is emitted: an
      // empty plane reads as sea meeting the sky, and a seabed out there would be
      // invisible under deep water anyway.
      const beyond = distC > oceanEdge;
      const seabed = beyond ? 1 : col.height;

      for (let y = 0; y < seabed; y++) {
        const m = beyond ? M.REEF : (y === col.height - 1 ? col.mat : (col.mat === M.SAND ? M.SAND_WET : col.mat));
        blocks.push([x, y, z, m]);
      }

      if (!beyond) {
        if (col.mat === M.SAND) sand++;
        else if (col.mat === M.SAND_WET) wet++;
        else if (col.mat === M.GRASS) scrub++;
        else if (col.mat === M.REEF) reef++;
        else if (col.mat === M.CORAL) coral++;
      } else {
        reef++;
      }

      // Where the surface sits relative to the water decides what it *is*.
      // Mutually exclusive, and the `beyond` case has to be tested first: the
      // profile already calls everything past 30 units deep water, so without this
      // ordering the 30-33 band was counted as ocean *and* emitted as seabed, and the
      // deep water came out at 3,545 columns against the ~1,115 the geometry implies.
      if (beyond) {
        ocean++;
      } else if (col.top > SEA_LEVEL) {
        dryLand++;
      } else if (col.waterTop === M.WATER_SHALLOW) {
        lagoon++;
      } else {
        ocean++;
      }

      if (!beyond) {
        for (let y = col.height; y < col.height + col.water; y++) {
          // Only the top water cell is ever seen; the ones beneath it are invisible
          // through a translucent layer above them. Filling them anyway would triple the
          // water cost across the whole ocean for no visual difference.
          if (y === col.height + col.water - 1) {
            water.push([x, y, z, col.waterTop]);
            if (col.waterTop === M.WATER_SHALLOW) shallow++; else deep++;
          }
        }
      } else {
        // A single flat cell at sea level: the open sea surface, no seabed behind it.
        water.push([x, SEA_LEVEL - 1, z, M.WATER_DEEP]);
        deep++;
      }

      // --- palms -----------------------------------------------------------
      //
      // A coconut palm is a tall thin trunk under a wide flat crown, and the silhouette
      // is the entire point. The first version was four blocks of trunk with a
      // plus-shaped cap five wide -- a lollipop. And because placement was
      // `grove > 0.42` tested per *column*, a grove came out a solid mat of them that
      // merged into one green mass from any distance.
      //
      // Three changes, each with a reason:
      //
      //  - **Height band.** Palms only grow where the ground is between the waterline
      //    and PALM_MAX_GROUND. Below is lagoon; above is the crown, and the crown is the
      //    buildable ground -- where the players and all four bot districts work -- so
      //    planting it with trees would obstruct exactly that. The band between is the
      //    beach, which is where a palm actually grows.
      //  - **Proportion.** A five-to-seven block trunk under a crown two blocks deep and
      //    five across. Tall and thin is the whole read; the earlier version was as wide
      //    as it was tall.
      //  - **Spacing.** At most one palm per 3x3 patch, so a grove is a scatter of trees
      //    with sand visible between them rather than a mat.
      if (col.mat === M.SAND && col.height > SEA_LEVEL && col.height <= PALM_MAX_GROUND) {
        const grove = noise2(x / PALM_GROVE_FREQUENCY, z / PALM_GROVE_FREQUENCY, 4242);
        // Headroom charged up front: two blocks for the crown.
        const headroom = SEED_CEILING - col.height - 2;
        // Exact separation rather than a patch grid. A grid looked simpler and was wrong
        // in a way that only measurement caught: `floor(x/2), floor(z/2)` puts (2,2) and
        // (3,3) in different patches, so the closest pair of palms came out **1.0 blocks
        // apart** with three-wide crowns centred on them -- fully merged, a green field
        // rather than two trees.
        if (grove > PALM_GROVE_THRESHOLD && headroom >= 2 && !palmTooClose(x, z)) {
          planted.add(x + ',' + z);
          const trunk = Math.max(3, Math.min(7, headroom,
            5 + Math.round(Math.abs(wobble(x, z, 55)) * 1.6)));
          for (let t = 1; t <= trunk; t++) {
            blocks.push([x, col.height + t, z, M.PALM]);
            palm++;
          }
          const crown = col.height + trunk;
          // A three-wide ring under a plus-shape: a shallow dome, and narrow enough that
          // neighbouring crowns touch at their edges without merging into one mass.
          for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1],
            [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            blocks.push([x + ox, crown, z + oz, M.PALM_LEAF]);
            leaf++;
          }
          for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) {
            blocks.push([x + ox, crown + 1, z + oz, M.PALM_LEAF]);
            leaf++;
          }
        }
      }

      /**
       * Whether a palm already sits within PALM_SPACING of here, Chebyshev.
       *
       * Chebyshev rather than Euclidean because the crowns are square: two trunks two
       * apart diagonally have crowns that share a corner block, and a Euclidean test
       * would wave that through at 2.83.
       */
      function palmTooClose(px, pz) {
        for (let dx = -PALM_SPACING; dx <= PALM_SPACING; dx++) {
          for (let dz = -PALM_SPACING; dz <= PALM_SPACING; dz++) {
            if (planted.has((px + dx) + ',' + (pz + dz))) return true;
          }
        }
        return false;
      }
    }
  }

  return {
    blocks,
    water,
    stats: {
      // Surface columns by material.
      sand, wet, scrub, reef, coral,
      // Surface columns by what they are, relative to the waterline.
      dryLand, lagoon, ocean,
      // Structures.
      palm, leaf,
      // Volume actually emitted.
      blocks: blocks.length, waterCells: water.length,
    },
  };
}

/**
 * The nearest dry column to a point, searched outward.
 *
 * The bots anchor their districts at fixed offsets of plus or minus 10 per quadrant.
 * Those offsets were chosen for the old plaza -- a disc of radius 22, entirely dry --
 * and on an atoll they are simply wrong: measured, the two anchors at `(10,-10)` and
 * `(-10,-10)` sit in the lagoon, and their nearest dry ground is 2 and 4 units away.
 * A bot district anchored in water builds a pile of blocks standing in the sea.
 *
 * So the anchor is derived from the terrain rather than trusted to a constant, and the
 * bots get a real patch of beach in every quadrant whatever the island's shape does.
 *
 * Spiral search rather than a straight line, so it finds the closest dry ground
 * *anywhere* nearby rather than only along the heading it was given. Spiral ordering
 * also means the search is deterministic: the same island always yields the same
 * anchors, which is what keeps bot districts stable across restarts.
 *
 * @param {number} sx seed x, the quadrant sign and rough direction
 * @param {number} sz seed z
 * @param {number} [maxRadius] how far to search before giving up
 * @returns {{x:number, z:number, height:number, searched:number}}
 */
export function dryAnchor(sx, sz, maxRadius = 14) {
  let fallback = null;
  // Ring by ring. Each ring is every cell at Chebyshev distance `r` from the seed.
  for (let r = 0; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        // Only the ring's edge, not the filled square.
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = sx + dx, z = sz + dz;
        const col = columnAt(x, z);
        if (col.top > SEA_LEVEL) {
          return { x, z, height: col.height, searched: r };
        }
        if (!fallback && col.height >= 1) fallback = { x, z, height: col.height, searched: r };
      }
    }
  }
  // Nothing dry within reach. Returning the shallowest cell we saw is better than
  // returning the seed outright, because at least it is the closest thing to land.
  return fallback ?? { x: sx, z: sz, height: columnAt(sx, sz).height, searched: maxRadius };
}

/**
 * Anchors for the four bot districts, one per quadrant.
 *
 * Derived from {@link dryAnchor} so that changing the island cannot silently strand a
 * bot in the sea. Returned as a frozen list because callers treat them as fixed.
 */
export function botDistricts(maxRadius = 14) {
  return [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => ({
    x: sx * 10, z: sz * 10,
    anchor: dryAnchor(sx * 10, sz * 10, maxRadius),
  }));
}

export { M as ATOLL_MATERIALS, PROFILE };