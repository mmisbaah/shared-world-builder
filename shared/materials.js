/**
 * Material + prop catalogue. The server validates against this table (it must
 * never trust a client-supplied material id) and the client renders from it.
 *
 * `vis` drives the mesher's face-culling rule:
 *   0 = air      -> never emits geometry
 *   1 = opaque   -> participates in the deferred G-buffer pass
 *   2 = translucent -> emitted into a separate forward pass, sorted
 *
 * Face culling rule in the greedy mesher: emit a face only when the two cells
 * on either side have *different* vis classes and at least one is non-air.
 * That culls opaque/opaque interiors while keeping opaque<->glass seams lit.
 */

export const VIS = { AIR: 0, OPAQUE: 1, TRANSLUCENT: 2 };

/**
 * Whether a material is water.
 *
 * Needed by the bot swarm, whose whole search is "scan down from the sky and build on
 * whatever is the first solid thing". That heuristic was written when the world had no
 * liquid in it, so `getBlock(...) !== 0` meant "ground". It now means "the sea surface"
 * about a third of the time, and the bots build on it.
 *
 * Keyed off the id list rather than off `vis`, deliberately: `vis === TRANSLUCENT` is
 * also true of glass, and building on glass is fine. Water is water because it is one
 * of these three materials, not because it is see-through.
 *
 * @param {number} id
 * @returns {boolean}
 */
export const WATER_MATERIALS = new Set([14, 15]);

/** @param {number} id */
export function isWaterMaterial(id) {
  return WATER_MATERIALS.has(id);
}

/** @type {Record<number, object>} */
export const MATERIALS = {
  1: {
    id: 1, key: 'stone', name: 'Stone', color: 0x64748b,
    roughness: 0.85, metalness: 0.08, emissive: 0x000000, emissiveIntensity: 0, vis: VIS.OPAQUE,
  },
  2: {
    id: 2, key: 'brick', name: 'Red Brick', color: 0xb91c1c,
    roughness: 0.92, metalness: 0.0, emissive: 0x000000, emissiveIntensity: 0, vis: VIS.OPAQUE,
  },
  3: {
    id: 3, key: 'wood', name: 'Oak Wood', color: 0x92400e,
    roughness: 0.7, metalness: 0.0, emissive: 0x000000, emissiveIntensity: 0, vis: VIS.OPAQUE,
  },
  4: {
    id: 4, key: 'grass', name: 'Grass Top', color: 0x15803d,
    roughness: 0.65, metalness: 0.0, emissive: 0x000000, emissiveIntensity: 0, vis: VIS.OPAQUE,
  },
  5: {
    id: 5, key: 'neon_cyan', name: 'Cyan Neon', color: 0x06b6d4,
    roughness: 0.25, metalness: 0.0, emissive: 0x06b6d4, emissiveIntensity: 2.4, vis: VIS.OPAQUE,
  },
  6: {
    // Gold is treated as a *diffuse* albedo, not a metallic F0. It was
    // 0xeab308, which converts to linear (0.82, 0.45, 0.002) -- roughly 3x the
    // value of stone (0.13, 0.17, 0.26). That value spread is unrenderable in a
    // deferred pass with a single exposure: at any level where stone reads
    // correctly, gold's red channel pins at 255 and all its shading is lost, so
    // the dais reads as a flat saturated blob. Darkening it into the same value
    // band as the other materials is what lets the sun model actually show on it.
    id: 6, key: 'gold', name: 'Gold Metal', color: 0xb8912f,
    roughness: 0.32, metalness: 0.85, emissive: 0x000000, emissiveIntensity: 0, vis: VIS.OPAQUE,
  },
  7: {
    // Lifted from 0x1e293b to 0x3a4a5e.
    //
    // Slate was authored as the darkest thing in the palette, back when sand and stone
    // were also dark and the contrast read as depth. Against a tropical cay it read as a
    // hole: linear 0.013/0.022/0.044 against the sand's 0.39 -- a twenty-fold value gap,
    // measuring 0.298 in display value where the sand was 0.875. Anything built from it
    // came out as a black silhouette with no surface detail, and the bots build a lot.
    //
    // It is still the darkest opaque material in the set, which is what it is for, but at
    // 0.574 it is clearly darker than the sand and still reads as a surface.
    id: 7, key: 'slate', name: 'Dark Slate', color: 0x3a4a5e,
    roughness: 0.8, metalness: 0.15, emissive: 0x000000, emissiveIntensity: 0, vis: VIS.OPAQUE,
  },
  8: {
    id: 8, key: 'neon_amber', name: 'Amber Neon', color: 0xf59e0b,
    roughness: 0.25, metalness: 0.0, emissive: 0xf59e0b, emissiveIntensity: 2.0, vis: VIS.OPAQUE,
  },
  9: {
    id: 9, key: 'glass', name: 'Cyan Glass', color: 0x7dd3fc,
    roughness: 0.08, metalness: 0.0, emissive: 0x0e7490, emissiveIntensity: 0.35, vis: VIS.TRANSLUCENT,
  },

  // -------------------------------------------------------------------------
  // Atoll palette (10-15)
  //
  // Colours lifted from the Atollingo design tokens rather than invented:
  //   --teal   #003b42   rgb(0,59,66)     deep water
  //   primary  #086d75   rgb(8,109,117)   lagoon / shallow water
  //   rgb(8,123,131)                      bright turquoise shallows
  //   --wash   #fff0df   rgb(255,240,223)  sand
  //   --accent #9b4b28   rgb(155,75,40)   driftwood
  //   rgb(104,67,19)                      palm trunk
  //   rgb(72,99,110)                      wet stone / reef
  //
  // The teal family is the whole point of the theme, and it is a *narrow* band --
  // 0,59,66 up to 8,123,131. Keeping the value spread small across the three water
  // depths is what makes depth read as depth. Widening it turns the lagoon into
  // three unrelated colours.
  // -------------------------------------------------------------------------

  10: {
    // Wet sand. Darker than dry sand because it is at the waterline, and the darker
    // band is what makes the tide edge legible rather than a hard line.
    //
    // Authored at 0x9c8d70 rather than the beach-photo 0xd9c39a. Sand that looks
    // correct as a hex has a linear albedo around 0.89 -- roughly 3.5x stone's -- so
    // under a sun strong enough to model anything it lands deep in the ACES shoulder:
    // measured lit 0.949 against 0.550 in shadow, a ratio of 1.72, which is no form at
    // all on a flat-shaded voxel. At 0x9c8d70 it measures 3.08. Same lesson as the
    // gold note above, arrived at by measurement instead of by eye.
    //
    // 0x877a5e rather than 0x9c8d70: the tone curve compresses the top end hard enough
    // that a large-looking difference in hex reads as almost nothing on screen. At
    // 0x9c8d70 the tide band measured only 8% below the dry sand -- invisible. At
    // 0x877a5e it measures 16% below, which is a visible edge, and the material gains
    // form as a side effect (3.08 -> 3.69).
    // 0x7d7157, not 0x877a5e. The tone curve compresses the top end hard enough that a
    // large-looking difference in hex reads as almost nothing on screen: at 0x877a5e the
    // tide band measured 0.91x the dry sand, which is invisible. At 0x7d7157 it is 0.87x
    // -- a visible edge -- and the material gains form as a side effect (3.26 -> 3.57).
    id: 10, key: 'sand_wet', name: 'Wet Sand', color: 0x7d7157,
    roughness: 0.55, metalness: 0.0, emissive: 0x000000, emissiveIntensity: 0, vis: VIS.OPAQUE,
  },
  11: {
    // Dry sand.
    //
    // Three attempts, each corrected by measurement rather than by eye, and the history
    // is the reason this comment is longer than the material:
    //
    //   0xf2e4c9  the correct colour for a beach. Linear albedo 0.89, about 3.5x
    //             stone's, so it landed deep in the ACES shoulder: lit 0.949 against
    //             0.550 in shadow. A ratio of 1.72, and on a flat-shaded voxel face that
    //             is *no form at all*.
    //   0xc2b18c  still bright. 0.913 against 0.438 -- ratio 2.08, just under the 2.2
    //             floor, with almost no highlight headroom left.
    //   0xa89a78  lit 0.875, ratio 2.47, shoulder 0.97. Enough highlight left for the
    //             sun to actually model the terraces with.
    //
    // The hue is unchanged across all three; only the value moved -- the same lesson the
    // gold material carries, for the same reason.
    id: 11, key: 'sand', name: 'Palm Sand', color: 0xa89a78,
    roughness: 0.92, metalness: 0.0, emissive: 0x000000, emissiveIntensity: 0, vis: VIS.OPAQUE,
  },
  12: {
    id: 12, key: 'palm', name: 'Palm Wood', color: 0x7d5730,
    roughness: 0.78, metalness: 0.0, emissive: 0x000000, emissiveIntensity: 0, vis: VIS.OPAQUE,
  },
  13: {
    // Foliage. Deep green rather than the grass material's 0x15803d, because tropical
    // canopy is darker and bluer than lawn -- and the existing grass is used for
    // nothing else, so it could have been retinted, but leaving it alone keeps the
    // pre-atoll palette intact if the world is ever rolled back.
    id: 13, key: 'palm_leaf', name: 'Palm Frond', color: 0x2a7d57,
    roughness: 0.68, metalness: 0.0, emissive: 0x000000, emissiveIntensity: 0, vis: VIS.OPAQUE,
  },
  14: {
    // Shallow lagoon. Translucent so the sand under it shows through, which is the
    // single thing that makes shallow water read as water rather than as blue glass.
    id: 14, key: 'water_shallow', name: 'Lagoon Water', color: 0x0e8f9c,
    roughness: 0.10, metalness: 0.0, emissive: 0x05343c, emissiveIntensity: 0.5, vis: VIS.TRANSLUCENT,
  },
  15: {
    // Deep ocean. Also translucent -- a fully opaque deep blue would hide the reef
    // shelf entirely and flatten the drop-off that makes an atoll read as an atoll.
    //
    // Lifted from 0x0b4552 to 0x14606e, then back down to 0x115564. The first sat close
    // enough to black that the lagoon read as the only water in the world; the second
    // overcorrected so far that the two depths measured only 1.33x apart, which is not
    // enough for depth to read as depth. At 0x115564 the ratio is 1.50.
    id: 15, key: 'water_deep', name: 'Deep Water', color: 0x115564,
    roughness: 0.06, metalness: 0.0, emissive: 0x021c22, emissiveIntensity: 0.4, vis: VIS.TRANSLUCENT,
  },
  16: {
    id: 16, key: 'coral', name: 'Coral Rock', color: 0x9c7a63,
    roughness: 0.86, metalness: 0.0, emissive: 0x000000, emissiveIntensity: 0, vis: VIS.OPAQUE,
  },
  17: {
    // Reef / wet stone. The token rgb(72,99,110) -- the one cool grey in the palette,
    // which is what keeps a sand island from looking like a pile of yellow.
    id: 17, key: 'reef', name: 'Reef Rock', color: 0x48636e,
    roughness: 0.80, metalness: 0.05, emissive: 0x000000, emissiveIntensity: 0, vis: VIS.OPAQUE,
  },
};

export const MAX_MATERIAL_ID = 17;

export function isValidMaterial(id) {
  return Number.isInteger(id) && MATERIALS[id] !== undefined;
}

/** Mesher fast path: material id -> vis class, with 0 = air. */
export const VIS_LUT = (() => {
  const lut = new Uint8Array(MAX_MATERIAL_ID + 1);
  for (const m of Object.values(MATERIALS)) lut[m.id] = m.vis;
  return lut;
})();

// ---------------------------------------------------------------------------
// Props: non-grid decor drawn through the instanced sub-layer.
// ---------------------------------------------------------------------------

/** @type {Record<string, object>} */
export const PROPS = {
  lantern: { key: 'lantern', name: 'Energy Lantern', icon: 'fa-lightbulb', height: 0.75, light: { color: 0x38bdf8, intensity: 6.0, distance: 9, y: 0.55 } },
  chair: { key: 'chair', name: 'Mod Chair', icon: 'fa-chair', height: 0.7, light: null },
  plant: { key: 'plant', name: 'Potted Plant', icon: 'fa-seedling', height: 0.65, light: null },
  torch: { key: 'torch', name: 'Wall Torch', icon: 'fa-fire', height: 0.5, light: { color: 0xf97316, intensity: 8.0, distance: 7, y: 0.45 } },
  // Appended, not inserted. Props persist by *string* key, so reordering would not
  // corrupt a save -- but `PROP_IDS` below is derived from `Object.keys(PROPS)` in
  // order, and an id mapping that quietly renumbers itself is worse than having no
  // id mapping at all, because nothing downstream can tell the difference.
  //
  // The five below were chosen for silhouette rather than for novelty -- every one
  // answers something a co-op builder actually does. Seating for two (bench), a
  // surface to put things on (table), a light that is neither a pole nor a cage
  // (campfire), shade (parasol), and somewhere to leave a message for the next
  // builder (sign). That is the difference between a decorated world and a world
  // that has been *lived in*.
  bench: { key: 'bench', name: 'Beach Bench', icon: 'fa-couch', height: 0.5, light: null },
  table: { key: 'table', name: 'Camp Table', icon: 'fa-table', height: 0.72, light: null },
  campfire: { key: 'campfire', name: 'Campfire', icon: 'fa-campground', height: 0.55, light: { color: 0xfb923c, intensity: 7.0, distance: 11, y: 0.34 } },
  parasol: { key: 'parasol', name: 'Beach Parasol', icon: 'fa-umbrella-beach', height: 1.7, light: null },
  sign: { key: 'sign', name: 'Trail Sign', icon: 'fa-sign-hanging', height: 1.3, light: null },
};

export const PROP_KEYS = Object.keys(PROPS);

export function isValidProp(key) {
  return typeof key === 'string' && PROPS[key] !== undefined;
}

/** Stable numeric id so props can be keyed compactly in the network payload. */
export const PROP_IDS = Object.fromEntries(PROP_KEYS.map((k, i) => [k, i]));
export const PROP_BY_ID = PROP_KEYS.map((k) => PROPS[k]);

export function propIdFromKey(key) {
  return PROP_IDS[key];
}

export function propKeyFromId(id) {
  return PROP_KEYS[id];
}
