/**
 * Wire protocol + world-space math shared verbatim by the authoritative server
 * and the browser client. Kept dependency-free so Node ESM and the browser can
 * both import it directly.
 */

// ---------------------------------------------------------------------------
// Chunk / voxel geometry
// ---------------------------------------------------------------------------

export const CHUNK_SIZE = 16;
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;

/**
 * World bounds + limits.
 *
 * Declared up here because a chunk's storage shape depends on WORLD.MAX_Y.
 */
/**
 * Claim decay, overridable so it can be observed rather than waited out.
 *
 * The default values are tuned for play; `SWB_ZONE_TTL_MS` exists because a
 * three-minute clock cannot be tested or demonstrated in seconds, and a mechanic
 * nobody can watch fail is a mechanic nobody has verified. Both are read from the
 * environment in Node, where the server runs, and ignored in the browser.
 */
const envMs = (name, fallback) => {
  const raw = typeof process !== 'undefined' && process.env ? process.env[name] : undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const WORLD = {
  MIN_Y: 0,
  MAX_Y: 48,
  // Playable radius in voxels around the origin. Keeps bots and zone claims honest.
  RADIUS: 40,
  TICK_MS: 50, // delta batching window
  LOCK_TTL_MS: 4000,
  MAX_OPS_PER_TICK: 64,

  /**
   * Territory decay, in milliseconds.
   *
   * A claim is only worth anything if it can be lost. Without decay the whole
   * system is decoration: claim once and the ground is yours permanently, so there
   * is no reason to return, no reason to defend anything, and no reason for a second
   * player to matter.
   *
   * The clock is *inactivity*, not creation. Building inside your own claim renews
   * it, which is what makes the mechanic about tending a district rather than
   * watching a timer. Two grace values:
   *
   *   HOLD_MS  the claim lingers, visibly warning, so decay is never a surprise.
   *           A player who stops for a coffee should not come back to a stolen
   *           quarter.
   *   TTL_MS   total lifetime of inactivity before the claim is released.
   *
   * Generous on purpose. This runs in shared world time, and a player alt-tabbing
   * for a few minutes must not lose work they did not see abandoned.
   */
  ZONE_HOLD_MS: envMs('SWB_ZONE_HOLD_MS', 90_000),
  ZONE_TTL_MS: envMs('SWB_ZONE_TTL_MS', 180_000),
};

// ---------------------------------------------------------------------------
// Chunk storage shape
//
// A chunk spans the *full* world height: horizontally it tiles at CHUNK_SIZE,
// vertically there is exactly one chunk layer. It is therefore a column, not a
// cube, and its voxel count is CHUNK_AREA * COLUMN_HEIGHT -- not CHUNK_SIZE^3.
//
// This matters: `voxelIndex` keys on the world-space y coordinate, so a cubic
// buffer of CHUNK_SIZE^3 entries silently drops every write above y=15 (typed
// array out-of-bounds writes are no-ops) and reads back `undefined`, which then
// compares unequal to 0 and makes the whole upper world read as "occupied".
// ---------------------------------------------------------------------------

export const COLUMN_HEIGHT = WORLD.MAX_Y - WORLD.MIN_Y;
export const COLUMN_VOLUME = CHUNK_AREA * COLUMN_HEIGHT;

/** True if a world y coordinate falls inside the stored column. */
export function yInColumn(y) {
  return y >= WORLD.MIN_Y && y < WORLD.MAX_Y;
}

/**
 * Voxel index inside a chunk column. Layout is Y-major so vertical columns are
 * strided. `y` is the world y coordinate; `x`/`z` are chunk-local (0..15).
 */
export function voxelIndex(x, y, z) {
  return x + z * CHUNK_SIZE + (y - WORLD.MIN_Y) * CHUNK_AREA;
}

/**
 * Inverse of {@link voxelIndex}: recover the column-local coordinate from a
 * linear index. Block deltas travel as local indices rather than world
 * coordinates, so both directions of the mapping have to live side by side --
 * deriving one from the other by hand is how off-by-one axis bugs creep in.
 */
export function localFromIndex(li) {
  const y = Math.floor(li / CHUNK_AREA) + WORLD.MIN_Y;
  const rest = li - (y - WORLD.MIN_Y) * CHUNK_AREA;
  const z = Math.floor(rest / CHUNK_SIZE);
  const x = rest - z * CHUNK_SIZE;
  return { x, y, z };
}

/** World voxel coordinate -> chunk coordinate. Chunks are aligned to CHUNK_SIZE. */
export function worldToChunk(wx, wy, wz) {
  return {
    cx: Math.floor(wx / CHUNK_SIZE),
    cy: Math.floor(wy / CHUNK_SIZE),
    cz: Math.floor(wz / CHUNK_SIZE),
  };
}

/** World voxel coordinate -> local voxel index inside its chunk. */
export function worldToLocal(wx, wy, wz) {
  return voxelIndex(
    wx - Math.floor(wx / CHUNK_SIZE) * CHUNK_SIZE,
    wy - Math.floor(wy / CHUNK_SIZE) * CHUNK_SIZE,
    wz - Math.floor(wz / CHUNK_SIZE) * CHUNK_SIZE,
  );
}

export function chunkKey(cx, cz) {
  return cx + ',' + cz;
}

/**
 * Snapshot voxel transport.
 *
 * A snapshot is the one payload that carries thousands of voxels at once, and it
 * was originally sent as a raw ArrayBuffer. That works from Node but the browser's
 * socket.io parser cannot decode nested binary inside an object: it raises a parse
 * error, drops the connection, and the client reconnects forever. The failure is
 * silent from the server's point of view -- it has already logged a join.
 *
 * Base64 sidesteps the parser entirely, and it is not merely a workaround: a
 * material id is a single digit, so 12288 voxels compress to 12288 bytes and then
 * 16 KB of text. That is smaller than the JSON an array of numbers would produce.
 */
export function encodeCells(u16) {
  const bytes = new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  // Chunked so a 24 KB payload does not blow the argument limit of apply().
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function decodeCells(b64) {
  if (typeof Buffer !== 'undefined') {
    // Copy out of the Buffer pool: a pooled allocation is not guaranteed to be
    // 2-byte aligned, and Uint16Array requires it.
    const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
    return new Uint16Array(bytes.buffer, 0, bytes.byteLength >> 1);
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Uint16Array(bytes.buffer, 0, bytes.byteLength >> 1);
}

/** Stable string key for a world-space voxel. */
export function voxelKey(x, y, z) {
  return x + ',' + y + ',' + z;
}

// ---------------------------------------------------------------------------
// Operation types (client -> server)
// ---------------------------------------------------------------------------

export const OP = {
  PLACE_BLOCK: 1,
  REMOVE_BLOCK: 2,
  PLACE_PROP: 3,
  REMOVE_PROP: 4,
  CLAIM_ZONE: 5,
  REQUEST_LOCK: 6,
  RELEASE_LOCK: 7,
  PING: 8,
  RELEASE_ZONE: 9,
  /**
   * Revert this builder's own most recent edit.
   *
   * Carries no coordinates on purpose: the server owns the stack, so a client
   * naming a voxel would only give it a say in *which* of its own edits gets
   * reverted -- and the revision guard is there to refuse when the world has
   * moved on. Nothing here can reach an edit the sender did not make.
   */
  UNDO: 10,
};

export const OP_NAME = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));

/**
 * How many of a builder's own edits stay revertible.
 *
 * Declared here rather than beside the stack it caps, because both ends need
 * it: the server trims to this depth and the client caps its own count at it.
 * Keeping the number in one place is what stops the client insisting there is
 * history to undo when the server has already trimmed past it.
 */
export const UNDO_DEPTH = 16;

// ---------------------------------------------------------------------------
// Rejection reasons (server -> client)
// ---------------------------------------------------------------------------

export const DENY = {
  NONE: 0,
  OCCUPIED: 1, // lost the race: another builder committed this voxel first
  EMPTY: 2, // tried to remove a voxel that is already air
  OUT_OF_BOUNDS: 3,
  LOCKED: 4, // another builder holds a hard lock on this voxel
  NOT_CLAIMED: 5, // voxel sits inside another builder's claimed zone
  UNKNOWN_MATERIAL: 6,
  UNKNOWN_PROP: 7,
  RATE_LIMITED: 8,
};

// ---------------------------------------------------------------------------
// Server -> client event names
// ---------------------------------------------------------------------------

export const EV = {
  WELCOME: 'welcome',
  OP_RESULT: 'opResult', // private ack/deny for the op's originator
  CHUNK_DELTA: 'chunkDelta', // authoritative voxel+prop changes for everyone
  SNAPSHOT: 'snapshot', // full chunk payload on join
  PRESENCE: 'presence', // builders joined/left/updated
  BOT_ACTION: 'botAction', // narrative hook so the client can draw build lasers
  ZONES: 'zones', // full claimed-zone list
  OBJECTIVES: 'objectives', // server-verified ladder progress; clients never send this
  /**
   * Live pointer cell from a remote builder. Ephemeral, last-writer-wins, not part of
   * the authoritative world -- so unlike every other event it carries its own
   * semantics of being "an approximation of where someone is looking", and the server
   * attaches the sender's identity to what is broadcast rather than trusting the
   * client to send it accurately.
   */
  CURSOR: 'cursor',
};

// ---------------------------------------------------------------------------
// Interpolation timings (client-side visual state machine)
// ---------------------------------------------------------------------------

export const FX = {
  MATERIALIZE_MS: 150, // noise-dissolve wireframe -> solid
  DESTROY_MS: 260, // alpha-clip melt
  SHATTER_MS: 420, // conflict implosion
  PREDICTION_ECHO_BORDER: true,
};
