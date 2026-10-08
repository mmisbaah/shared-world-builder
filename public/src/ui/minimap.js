/**
 * Top-down minimap.
 *
 * A builder's real question is never "what am I looking at" but "where am I, what
 * did I make, and where is everyone else". None of that is answered well from a
 * first-person camera in a world that is a disc in the middle of nothing, so this
 * exists to answer it directly.
 *
 * Two decisions worth stating:
 *
 * **Topmost-surface rasterisation.** For each (x, z) column the map shows the
 * highest non-air voxel, not a slice at some fixed height. A slice shows you the
 * bedrock and nothing you built; the surface shows the silhouette of the thing.
 *
 * **It reads the client's world, not the server's.** That is deliberate. The
 * minimap is a navigation aid, not game state, and it should show what this client
 * currently believes -- including a block that is still in flight as a prediction.
 * Deriving it from authoritative state would make it lag the view by one round
 * trip for no benefit.
 *
 * Rendering is a single ImageData blit rather than thousands of fillRect calls.
 * At 80x80 columns redrawn several times a second, per-cell canvas calls are the
 * difference between a free overlay and a measurable frame cost.
 */

import { MATERIALS } from '../../../shared/materials.js';
import { WORLD, CHUNK_SIZE, voxelIndex, worldToChunk } from '../../../shared/protocol.js';

const TILE = 2; // canvas pixels per world column
const PAD = 4; // canvas pixels of margin so the world edge is not flush

export class Minimap {
  /**
   * @param {HTMLElement} host container element
   * @param {object} [opts]
   */
  constructor(host, opts = {}) {
    this.span = WORLD.RADIUS * 2;

    /**
     * Canvas backing size is *derived* from the tile grid, never set
     * independently. A hand-picked 156 against a 160px world clipped 2px off each
     * side -- and because the clipped part is the buildable boundary, the map
     * silently hid the outer ring of the world rather than looking obviously
     * wrong. CSS scales it down for display; the backing store stays exact.
     */
    this.px = this.span * TILE + PAD * 2;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minimap-canvas';
    this.canvas.width = this.px;
    this.canvas.height = this.px;
    this.canvas.title = 'Click to move the camera. Drag to pan continuously.';

    this.root = document.createElement('div');
    this.root.className = 'minimap';
    this.root.appendChild(this.canvas);

    this.label = document.createElement('div');
    this.label.className = 'minimap-label mono';
    this.root.appendChild(this.label);
    host.appendChild(this.root);

    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingEnabled = false;

    // Offscreen buffer, reused every frame. Allocated once because this redraws
    // several times a second for the life of the page.
    this.img = this.ctx.createImageData(this.px, this.px);
    this.imageData = this.img;

    /** @type {{x:number,z:number}|null} */
    this.hoverCell = null;

    this._bindInteraction(opts.onPick);
    this.stats = { draws: 0, lastMs: 0, surfaceCells: 0 };
  }

  _bindInteraction(onPick) {
    const toCell = (ev) => {
      const r = this.canvas.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * this.px;
      const py = ((ev.clientY - r.top) / r.height) * this.px;
      const half = WORLD.RADIUS;
      const wx = Math.round((px - this._origin()) / TILE - half);
      const wz = Math.round((py - this._origin()) / TILE - half);
      if (Math.abs(wx) > half || Math.abs(wz) > half) return null;
      return { x: wx, z: wz };
    };

    this.canvas.addEventListener('pointermove', (ev) => {
      this.hoverCell = toCell(ev);
    });
    this.canvas.addEventListener('pointerleave', () => { this.hoverCell = null; });

    this.canvas.addEventListener('pointerdown', (ev) => {
      const cell = toCell(ev);
      if (!cell || !onPick) return;
      onPick(cell);
      this.canvas.setPointerCapture?.(ev.pointerId);
    });
    this.canvas.addEventListener('pointermove', (ev) => {
      // Drag to pan: a click that lands on the map should move the view there and
      // stay there while you keep dragging, which is how every map control works.
      if (!(ev.buttons & 1) || !onPick) return;
      const cell = toCell(ev);
      if (cell) onPick(cell);
    });
  }

  _origin() {
    return PAD;
  }

  /**
   * Rebuild the surface heightmap: for each (x, z), the topmost y holding a
   * non-air voxel, plus the material there.
   *
   * Split out from `render` and run on a slower timer because it is the expensive
   * half. Walking every column top-down costs span^2 * worldHeight in the worst
   * case -- 80*80*48, nearly 300k probes -- and almost all of that is walking down
   * through empty air above a mostly-empty world. Measured at 16.6 ms, which at
   * 7 Hz is 12% of the frame budget spent redrawing an overlay.
   *
   * Caching this and blitting from it drops a frame-cost draw to well under a
   * millisecond. A 2 Hz surface refresh is indistinguishable from instant here,
   * because it only becomes stale if someone builds faster than the eye tracks.
   */
  refreshSurface(world) {
    const span = this.span;
    if (!this.heightMap) {
      this.heightMap = new Int16Array(span * span).fill(-1);
      this.surfaceMat = new Uint8Array(span * span);
      this.surfaceProp = new Uint8Array(span * span);
      this.surfaceWorld = null;
    }

    for (let lz = 0; lz < span; lz++) {
      const wz = lz - WORLD.RADIUS;
      const { cz } = worldToChunk(0, 0, wz);
      const localZ = wz - cz * CHUNK_SIZE;
      const rowBase = lz * span;

      for (let lx = 0; lx < span; lx++) {
        const wx = lx - WORLD.RADIUS;
        const { cx } = worldToChunk(wx, 0, 0);
        const chunk = world.chunks.get(cx + ',' + cz);
        const slot = rowBase + lx;

        if (!chunk) { this.heightMap[slot] = -1; continue; }

        const cells = chunk.cells;
        const predicted = chunk.predicted;
        const predictedSet = chunk.predictedSet;

        // Top-down so this is a surface map and not a slice of bedrock.
        // Predicted voxels are folded in: a block placed but not yet acknowledged
        // should appear immediately, or the map lags the view by a round trip.
        let mat = 0;
        let topY = -1;
        const localX = wx - cx * CHUNK_SIZE;
        for (let y = WORLD.MAX_Y - 1; y >= WORLD.MIN_Y; y--) {
          const li = voxelIndex(localX, y, localZ);
          const m = predictedSet[li] ? predicted[li] : cells[li];
          if (m !== 0) { mat = m; topY = y; break; }
        }

        this.heightMap[slot] = topY;
        this.surfaceMat[slot] = mat;
        this.surfaceProp[slot] = world.getProp(wx, topY + 1, wz) ? 1 : 0;
      }
    }

    this.surfaceWorld = world;
  }

  /**
   * @param {import('../world/world.js').World} world
   * @param {object} cameraRig
   * @param {object} conn connection, for builders and zones
   */
  render(world, cameraRig, conn) {
    const t0 = performance.now();
    const d = this.imageData.data;
    const origin = this._origin();
    const span = this.span;

    // Background: outside the buildable radius. Distinct from sky so the world
    // boundary reads as a boundary rather than as more world.
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 8; d[i + 1] = 11; d[i + 2] = 18; d[i + 3] = 255;
    }

    if (!this.heightMap) this.refreshSurface(world);
    let surfaceCells = 0;

    for (let lz = 0; lz < span; lz++) {
      const py0 = origin + lz * TILE;
      const rowBase = lz * span;

      for (let lx = 0; lx < span; lx++) {
        const slot = rowBase + lx;
        const topY = this.heightMap[slot];
        if (topY < 0) continue;

        const mat = this.surfaceMat[slot];
        const def = MATERIALS[mat];
        if (!def) continue;

        // Height shading: the top of a tall column reads brighter than the base of
        // a flat one, which gives the map relief without drawing another pixel.
        const rel = (topY - WORLD.MIN_Y) / Math.max(1, WORLD.MAX_Y - WORLD.MIN_Y);
        const shade = 0.55 + rel * 0.45;

        let r = ((def.color >> 16) & 255) * shade;
        let g = ((def.color >> 8) & 255) * shade;
        let b = (def.color & 255) * shade;

        // Emissive materials ignore height, so neon reads as neon rather than as a
        // dark patch low in a tower.
        if (def.emissiveIntensity > 0) {
          r = (def.color >> 16) & 255;
          g = (def.color >> 8) & 255;
          b = def.color & 255;
        }

        // Prop marker: a brighter cap on whatever sits beneath it.
        if (this.surfaceProp[slot]) {
          r = Math.min(255, r + 70); g = Math.min(255, g + 70); b = Math.min(255, b + 70);
        }

        const px0 = origin + lx * TILE;
        for (let dy = 0; dy < TILE; dy++) {
          let o = ((py0 + dy) * this.px + px0) * 4;
          for (let dx = 0; dx < TILE; dx++) {
            d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
            o += 4;
          }
        }
        surfaceCells++;
      }
    }

    this.ctx.putImageData(this.img, 0, 0);

    this._drawOverlays(cameraRig, conn);
    this._drawHover();

    this.stats.draws++;
    this.stats.surfaceCells = surfaceCells;
    this.stats.lastMs = Math.round((performance.now() - t0) * 100) / 100;
  }

  /** Zone borders, builders, and the camera. Vector passes on top of the raster. */
  _drawOverlays(cameraRig, conn) {
    const ctx = this.ctx;
    const origin = this._origin();
    const toPx = (wx, wz) => [
      origin + (wx + WORLD.RADIUS) * TILE,
      origin + (wz + WORLD.RADIUS) * TILE,
    ];

    // Claimed zones. Drawn as outlines because a filled region would hide the
    // geometry underneath, which is the thing you are actually looking at.
    ctx.lineWidth = 1;
    for (const zone of conn?.zones ?? []) {
      const [x0, y0] = toPx(zone.x0, zone.z0);
      const [x1, y1] = toPx(zone.x1, zone.z1);
      ctx.strokeStyle = zone.color ?? '#38bdf8';
      ctx.globalAlpha = 0.9;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, (x1 - x0) - 1, (y1 - y0) - 1);
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = zone.color ?? '#38bdf8';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    ctx.globalAlpha = 1;

    // Other builders. Only drawn when the presence record actually carries a
    // position -- plotting every one of them at the world origin because the field
    // is absent would be worse than not plotting them at all, since it looks like
    // data rather than like a gap.
    const selfId = conn?.selfId;
    for (const b of conn?.builders?.values?.() ?? []) {
      if (b.id === selfId) continue;
      if (!Number.isFinite(b.targetX) || !Number.isFinite(b.targetZ)) continue;
      const [px, py] = toPx(b.targetX, b.targetZ);
      ctx.fillStyle = b.color ?? '#94b6d6';
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // The camera: a position dot plus a short heading line, so orientation is
    // readable at a glance rather than inferred from a symmetric dot.
    const t = cameraRig?.target;
    if (t) {
      const [px, py] = toPx(t.x, t.z);
      const heading = cameraRig.theta;
      const dx = Math.sin(heading);
      const dz = Math.cos(heading);

      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + dx * 11, py + dz * 11);
      ctx.stroke();

      ctx.fillStyle = '#fde68a';
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  _drawHover() {
    if (!this.hoverCell) return;
    const ctx = this.ctx;
    const origin = this._origin();
    const px = origin + (this.hoverCell.x + WORLD.RADIUS) * TILE;
    const py = origin + (this.hoverCell.z + WORLD.RADIUS) * TILE;
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, TILE * 2 - 1, TILE * 2 - 1);
  }

  /** @param {{x:number,z:number}} cell */
  setLabel(cell) {
    this.label.textContent = `${cell.x}, ${cell.z}`;
  }

  dispose() {
    this.root.remove();
  }
}
