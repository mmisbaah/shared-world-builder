/**
 * Voxel picking.
 *
 * Amanatides & Woo grid traversal: step from voxel to voxel along the dominant
 * axis boundary each iteration, so the number of cells visited is proportional to
 * the distance travelled rather than to the volume swept. A brute-force march
 * would test hundreds of cells per pixel of screen movement; this tests about one
 * per voxel crossed.
 *
 * The entry face normal matters as much as the hit cell: placement uses it to
 * decide which side of a block to build against, and the ghost block outline is
 * drawn on it. Both come out of the traversal for free.
 *
 * Props are picked in the same walk. They are AABBs sitting in a cell rather than
 * full blocks, so the hit test is a slab intersection and the nearest of a block
 * hit and a prop hit wins.
 */

import { WORLD } from '../../../shared/protocol.js';
import { PROPS, VIS_LUT, VIS } from '../../../shared/materials.js';

const AIR = 0;

/** Bounds one voxel of slack outside the buildable volume. */
const SLACK = 1;

/**
 * Walk the grid and return the first cell satisfying `accept`.
 *
 * @param {object} world needs getVoxel(x, y, z)
 * @param {{x:number,y:number,z:number}} origin
 * @param {{x:number,y:number,z:number}} dir assumed normalised
 * @param {object} [opts]
 * @param {number} [opts.maxDist=96]
 * @param {(x,y,z,mat)=>boolean} [opts.accept] extra filter per cell
 * @param {boolean} [opts.includeTranslucent=false] pick glass too
 * @returns {{x,y,z,nx,ny,nz,distance,mat}|null}
 */
export function raycastVoxels(world, origin, dir, opts = {}) {
  const maxDist = opts.maxDist ?? 96;
  const accept = opts.accept;
  const includeTranslucent = !!opts.includeTranslucent;

  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);

  // Guard against a zero-length or non-normalised direction producing NaN steps.
  if (!Number.isFinite(dir.x) || !Number.isFinite(dir.y) || !Number.isFinite(dir.z)) {
    return null;
  }

  const stepX = dir.x > 0 ? 1 : -1;
  const stepY = dir.y > 0 ? 1 : -1;
  const stepZ = dir.z > 0 ? 1 : -1;

  const adx = Math.abs(dir.x);
  const ady = Math.abs(dir.y);
  const adz = Math.abs(dir.z);

  // Distance along the ray between successive boundary crossings on each axis.
  const dX = adx === 0 ? Infinity : 1 / adx;
  const dY = ady === 0 ? Infinity : 1 / ady;
  const dZ = adz === 0 ? Infinity : 1 / adz;

  let tX = adx === 0 ? Infinity : ((dir.x > 0 ? x + 1 - origin.x : origin.x - x) / adx);
  let tY = ady === 0 ? Infinity : ((dir.y > 0 ? y + 1 - origin.y : origin.y - y) / ady);
  let tZ = adz === 0 ? Infinity : ((dir.z > 0 ? z + 1 - origin.z : origin.z - z) / adz);

  // Normal of the face we entered through; (0,0,0) for the starting cell.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;

  const yLo = WORLD.MIN_Y - SLACK;
  const yHi = WORLD.MAX_Y + SLACK;
  const limit = WORLD.RADIUS + SLACK;

  for (;;) {
    if (t > maxDist) return null;

    // Vertical bounds are hard limits; horizontal ones only stop runaway walks.
    if (y >= yLo && y < yHi && x >= -limit && x < limit && z >= -limit && z < limit) {
      const mat = world.getVoxel(x, y, z);
      if (mat !== AIR) {
        // Glass is pickable only on request: it is usually decor, and letting a
        // ray stop on it would make it impossible to reach the block behind it.
        const pickable = includeTranslucent || VIS_LUT[mat] === VIS.OPAQUE;
        if (pickable && (!accept || accept(x, y, mat))) {
          return { x, y, z, nx, ny, nz, distance: t, mat };
        }
      }
    }

    // Advance across whichever axis boundary is nearest. Ties resolve to x, then
    // y, then z so the traversal is deterministic for axis-aligned rays.
    if (tX <= tY && tX <= tZ) {
      if (tX > maxDist) return null;
      x += stepX; t = tX; tX += dX;
      nx = -stepX; ny = 0; nz = 0;
    } else if (tY <= tZ) {
      if (tY > maxDist) return null;
      y += stepY; t = tY; tY += dY;
      nx = 0; ny = -stepY; nz = 0;
    } else {
      if (tZ > maxDist) return null;
      z += stepZ; t = tZ; tZ += dZ;
      nx = 0; ny = 0; nz = -stepZ;
    }

    // Once the ray is below the floor or above the ceiling it can never return.
    if (y < yLo - 1 || y > yHi + 1) return null;
  }
}

/**
 * Ray/AABB slab test. Returns the entry distance along `dir`, or null.
 */
/**
 * Ray/axis-aligned box: the distance to the entry point, or null for a miss.
 *
 * `face` is an optional out-object filled with the outward normal of the face
 * the ray came through. Prop hits need it for the same reason block hits do --
 * `placementCell` offsets by that normal, and a hit without one subtracts
 * nothing usable: `hit.x + undefined` is NaN, which silently becomes a cell with
 * no coordinates at all. Deliberately left untouched when the ray starts inside
 * the box, where no entry face was crossed and naming one would send placement
 * out through a wall the ray never met.
 *
 * @param {{nx?:number, ny?:number, nz?:number}} [face]
 */
export function raySlab(origin, dir, min, max, face) {
  let tMin = -Infinity;
  let tMax = Infinity;
  let entry = null;

  for (const axis of ['x', 'y', 'z']) {
    const d = dir[axis];
    const o = origin[axis];
    if (d === 0) {
      if (o < min[axis] || o > max[axis]) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (min[axis] - o) * inv;
    let t2 = (max[axis] - o) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tMin) { tMin = t1; entry = axis; }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  if (tMin < 0) return tMax >= 0 ? 0 : null;
  if (face && entry) {
    // Entered through the near plane, so the outward normal points back the way
    // the ray came: travelling +x means it crossed the min-x face.
    const sign = dir[entry] > 0 ? -1 : 1;
    face.nx = entry === 'x' ? sign : 0;
    face.ny = entry === 'y' ? sign : 0;
    face.nz = entry === 'z' ? sign : 0;
  }
  return tMin;
}

/**
 * Nearest prop along the ray, found by walking the same voxels as the block cast.
 *
 * @returns {{x,y,z,prop,record,distance,nx,ny,nz}|null}
 */
export function raycastProps(world, origin, dir, opts = {}) {
  const maxDist = opts.maxDist ?? 96;
  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);

  const stepX = dir.x > 0 ? 1 : -1;
  const stepY = dir.y > 0 ? 1 : -1;
  const stepZ = dir.z > 0 ? 1 : -1;

  const adx = Math.abs(dir.x);
  const ady = Math.abs(dir.y);
  const adz = Math.abs(dir.z);

  const dX = adx === 0 ? Infinity : 1 / adx;
  const dY = ady === 0 ? Infinity : 1 / ady;
  const dZ = adz === 0 ? Infinity : 1 / adz;

  let tX = adx === 0 ? Infinity : ((dir.x > 0 ? x + 1 - origin.x : origin.x - x) / adx);
  let tY = ady === 0 ? Infinity : ((dir.y > 0 ? y + 1 - origin.y : origin.y - y) / ady);
  let tZ = adz === 0 ? Infinity : ((dir.z > 0 ? z + 1 - origin.z : origin.z - z) / adz);

  let t = 0;
  let best = null;

  for (;;) {
    if (t > maxDist) break;

    if (y >= WORLD.MIN_Y && y < WORLD.MAX_Y) {
      const record = world.getProp(x, y, z);
      if (record) {
        const def = PROPS[record.prop];
        const height = def ? def.height : 0.75;
        // Props sit on the floor of their cell and shrink slightly on each side so
        // neighbouring props do not appear to touch.
        const inset = 0.08;
        const face = {};
        const hit = raySlab(
          origin, dir,
          { x: x + inset, y: y, z: z + inset },
          { x: x + 1 - inset, y: y + height, z: z + 1 - inset },
          face,
        );
        if (hit !== null && t + hit <= maxDist && (!best || hit < best.distance)) {
          best = { x, y, z, prop: record.prop, record, distance: hit,
                   nx: face.nx ?? 0, ny: face.ny ?? 0, nz: face.nz ?? 0 };
        }
      }
    }

    if (tX <= tY && tX <= tZ) {
      if (tX > maxDist) break;
      x += stepX; t = tX; tX += dX;
    } else if (tY <= tZ) {
      if (tY > maxDist) break;
      y += stepY; t = tY; tY += dY;
    } else {
      if (tZ > maxDist) break;
      z += stepZ; t = tZ; tZ += dZ;
    }
    if (y < WORLD.MIN_Y - 2 || y > WORLD.MAX_Y + 2) break;
  }

  return best;
}

/**
 * Combined pick: the nearer of a solid block and a prop.
 *
 * @returns {{kind:'block'|'prop'|'ground', x,y,z,nx,ny,nz,distance,mat?}}
 */
export function pick(world, origin, dir, opts = {}) {
  const block = raycastVoxels(world, origin, dir, opts);
  const prop = opts.pickProps === false ? null : raycastProps(world, origin, dir, opts);

  if (prop && (!block || prop.distance < block.distance)) {
    return { kind: 'prop', ...prop };
  }
  if (block) return { kind: 'block', ...block };

  // Nothing solid: fall back to the ground plane so there is always a cursor.
  if (dir.y < 0) {
    const t = (0 - origin.y) / dir.y;
    if (t >= 0 && t <= (opts.maxDist ?? 96)) {
      const x = Math.floor(origin.x + dir.x * t);
      const z = Math.floor(origin.z + dir.z * t);
      return { kind: 'ground', x, y: -1, z, nx: 0, ny: 1, nz: 0, distance: t };
    }
  }
  return null;
}

/**
 * Where a new block would go for a given pick: the first air cell adjacent to the
 * hit face, which is the only placement that is never inside an existing block.
 */
export function placementCell(hit) {
  if (!hit) return null;
  if (hit.kind === 'ground') return { x: hit.x, y: 0, z: hit.z };
  return { x: hit.x + hit.nx, y: hit.y + hit.ny, z: hit.z + hit.nz };
}

export { AIR };