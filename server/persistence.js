/**
 * World persistence.
 *
 * Until this existed the "shared world" was shared between everyone currently
 * connected and nobody else. Restart the server and every block anyone had built
 * was gone. That is not a missing feature, it is a missing foundation: a game you
 * cannot return to has no reason to return to, and it makes the whole objective
 * ladder meaningless because completed objectives quietly reset.
 *
 * Design constraints, all learned the hard way:
 *
 * - **Never write on every op.** The bots alone commit a steady stream, so a
 *   write-per-op would mean constant disk I/O for a world that changes by a
 *   handful of voxels between writes. Dirty flag plus a debounce.
 * - **Always write atomically.** `writeFileSync` to the live path can be
 *   interrupted by a crash or a kill mid-write, leaving truncated JSON that fails
 *   to parse on the next boot -- which then looks like "the world corrupted
 *   itself" and loses everything. Write to a temp file and `rename`, which is
 *   atomic within a filesystem.
 * - **A corrupt save must not stop the server booting.** A save that fails to
 *   parse is quarantined under a `.corrupt` name and the world re-seeds. Losing a
 *   world is bad; refusing to start and losing everything else too is worse.
 * - **The seeded world is only used when there is no save.** Seeding over a loaded
 *   world would bury everyone's work in a fresh plaza.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  COLUMN_VOLUME, CHUNK_AREA, WORLD, chunkKey, encodeCells, decodeCells,
} from '../shared/protocol.js';

const SAVE_VERSION = 1;
const DEFAULT_INTERVAL_MS = 4000;

/** `0xFF` marks a column of pure air, so empty chunks collapse in the file. */
export class Persistence {
  /**
   * @param {object} opts
   * @param {import('./authority.js').Authority} opts.authority
   * @param {import('./objectives.js').ObjectiveTracker} [opts.objectives]
   * @param {string} opts.dir where the save lives
   * @param {number} [opts.intervalMs] debounce between autosaves
   */
  constructor({ authority, objectives = null, dir, intervalMs = DEFAULT_INTERVAL_MS }) {
    this.authority = authority;
    this.objectives = objectives;
    this.dir = dir;
    this.file = path.join(dir, 'world.json');
    this.tmpFile = path.join(dir, 'world.json.tmp');
    this.intervalMs = intervalMs;

    this.dirty = false;
    this.lastSaveAt = 0;
    this.stats = { saves: 0, loads: 0, bytesWritten: 0, lastSaveMs: 0, recovered: null };

    // Captured before anything can mutate state, so a load is a true restore
    // rather than a merge onto a half-seeded world.
    this._seedBaseline = this._capture();
  }

  /** Snapshot of current state, used both for saving and for detecting a first boot. */
  _capture() {
    const chunks = [];
    let maxRev = 0;
    for (const c of this.authority.chunks.values()) {
      let occupied = 0;
      for (let i = 0; i < c.cells.length; i++) if (c.cells[i] !== 0) occupied++;
      if (occupied === 0 && c.props.size === 0) continue;
      maxRev = Math.max(maxRev, c.rev);
      chunks.push({
        cx: c.cx, cz: c.cz, rev: c.rev,
        cells: encodeCells(c.cells),
        props: [...c.props.entries()],
      });
    }
    return { chunks, maxRev };
  }

  /** True when the world still holds exactly what was seeded and nothing else. */
  isPristine() {
    const now = this._capture();
    return now.chunks.length === this._seedBaseline.chunks.length;
  }

  /**
   * Load a save if one exists. Returns true when a save was restored.
   *
   * Never throws: a bad file is moved aside and reported through `stats`.
   */
  load() {
    if (!fs.existsSync(this.file)) return false;

    let raw;
    try {
      raw = fs.readFileSync(this.file);
    } catch (err) {
      this.stats.recovered = `unreadable: ${err.message}`;
      return false;
    }

    let data;
    try {
      data = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
    } catch (err) {
      // Quarantine rather than delete: the bytes are the only copy of the world.
      const quarantine = `${this.file}.corrupt`;
      try { fs.renameSync(this.file, quarantine); } catch { /* best effort */ }
      this.stats.recovered = `corrupt save moved to ${path.basename(quarantine)}: ${err.message}`;
      return false;
    }

    if (!data || data.version !== SAVE_VERSION || !Array.isArray(data.chunks)) {
      const quarantine = `${this.file}.v${data?.version ?? '?'}`;
      try { fs.renameSync(this.file, quarantine); } catch { /* best effort */ }
      this.stats.recovered = `unsupported save version ${data?.version}, moved aside`;
      return false;
    }

    let restored = 0;
    let maxRev = 0;
    // Collected locally and published at the end. Assigning straight to
    // stats.recovered inside the loop and then clearing it on the success path
    // reported a partially-recovered save as clean, which is the one case an
    // operator most needs to be told about.
    const warnings = [];
    for (const saved of data.chunks) {
      const key = chunkKey(saved.cx, saved.cz);

      // Validate *before* touching the authority. Creating the chunk first and
      // then rejecting its contents leaves an empty chunk registered in the map,
      // which reads as "a chunk was restored" to anything counting chunks and
      // costs a full COLUMN_VOLUME allocation for nothing.
      let cells;
      try {
        cells = decodeCells(saved.cells);
      } catch (err) {
        warnings.push(`chunk ${key} could not be decoded: ${err.message}`);
        continue;
      }
      if (cells.length !== COLUMN_VOLUME) {
        warnings.push(`chunk ${key} had ${cells.length} voxels, expected ${COLUMN_VOLUME}`);
        continue;
      }

      let c = this.authority.chunks.get(key);
      if (!c) {
        c = {
          cx: saved.cx, cz: saved.cz,
          cells: new Uint16Array(COLUMN_VOLUME),
          revs: new Uint32Array(COLUMN_VOLUME),
          props: new Map(),
          rev: 0,
        };
        this.authority.chunks.set(key, c);
      }

      c.cells.set(cells);
      c.rev = saved.rev | 0;
      maxRev = Math.max(maxRev, c.rev);

      c.props.clear();
      for (const [pkey, rec] of saved.props ?? []) c.props.set(pkey, rec);
      restored++;
    }

    // New revisions must not collide with restored ones, or a client's optimistic
    // concurrency check could pass against a stale value.
    this.authority.revCounter = Math.max(this.authority.revCounter, maxRev + 1);

    if (this.objectives && data.objectives) {
      this.objectives.index = Number.isInteger(data.objectives.index) ? data.objectives.index : 0;
      this.objectives.completed = Array.isArray(data.objectives.completed)
        ? data.objectives.completed.filter((id) => typeof id === 'string') : [];
      this.objectives.contributors = new Set(
        Array.isArray(data.objectives.contributors)
          ? data.objectives.contributors.filter((id) => typeof id === 'string') : [],
      );
      this.objectives.humanTouched = new Set(
        Array.isArray(data.objectives.humanTouched)
          ? data.objectives.humanTouched.filter((id) => typeof id === 'string') : [],
      );
      this.objectives.awaitingHuman = false;

      // Stashed for the host, which restores them into the authority. Filtered here
      // rather than at restore time so a corrupt entry cannot reach the zone logic.
      this._savedZones = Array.isArray(data.zones)
        ? data.zones.filter((z) => z && typeof z.ownerId === 'string'
          && Number.isFinite(z.cx) && Number.isFinite(z.cz))
        : [];
    }

    this.dirty = false;
    this.stats.loads++;
    // Null only when the load was completely clean.
    this.stats.recovered = warnings.length ? warnings.join('; ') : null;
    if (warnings.length) {
      console.warn(`[persistence] restored ${restored} chunks with problems: ${this.stats.recovered}`);
    }
    console.log(
      `[persistence] restored ${restored} chunks`
      + (this.objectives ? `, objective ${this.objectives.index}/${data.objectives?.total ?? '?'}` : ''),
    );
    return true;
  }

  /** Call after any world mutation. Cheap: it only sets a flag. */
  markDirty() {
    this.dirty = true;
  }

  /**
   * Debounced autosave.
   *
   * @param {number} now
   * @param {boolean} [force] ignore the debounce (shutdown, manual)
   */
  maybeSave(now, force = false) {
    if (!this.dirty) return false;
    if (!force && now - this.lastSaveAt < this.intervalMs) return false;
    return this.save();
  }

  /** Write the world. Returns false on failure rather than throwing. */
  save() {
    const t0 = Date.now();
    const { chunks, maxRev } = this._capture();

    const payload = {
      version: SAVE_VERSION,
      savedAt: new Date().toISOString(),
      revCounter: maxRev + 1,
      chunks,
      // Claims persist; their decay clock deliberately does not. See
      // Authority#restoreZones for why a restart must not renew a claim.
      zones: [...this.authority.zones.values()].map((z) => ({
        id: z.id,
        ownerId: z.ownerId,
        ownerName: z.ownerName,
        color: z.color,
        cx: z.cx,
        cz: z.cz,
        half: z.half,
      })),
      objectives: this.objectives ? {
        index: this.objectives.index,
        completed: this.objectives.completed,
        contributors: [...this.objectives.contributors],
        // Persisted so an objective a human has already unlocked stays unlocked
        // across a restart. Losing it would re-lock work that was legitimately
        // in progress and quietly reset the ladder's gate.
        humanTouched: [...this.objectives.humanTouched],
        total: this.objectives.index + 1,
      } : null,
    };

    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 6 });

      // Atomic: temp file then rename. A crash between the two leaves the old
      // save intact and a stray .tmp, which is recoverable; a partial write to the
      // live path is not.
      fs.writeFileSync(this.tmpFile, gz);
      fs.renameSync(this.tmpFile, this.file);

      this.dirty = false;
      this.lastSaveAt = Date.now();
      this.stats.saves++;
      this.stats.bytesWritten = gz.length;
      this.stats.lastSaveMs = Date.now() - t0;
      return true;
    } catch (err) {
      console.error(`[persistence] save failed: ${err.message}`);
      try { if (fs.existsSync(this.tmpFile)) fs.unlinkSync(this.tmpFile); } catch { /* best effort */ }
      return false;
    }
  }

  /** Best-effort synchronous save for a clean shutdown. */
  saveNow() {
    return this.save();
  }

  /**
   * The saved claim list, for the host to hand to `Authority#restoreZones`.
   *
   * Held from the last load rather than read back off disk, so boot does not have to
   * decompress the world a second time just to get eight small records.
   */
  zoneRecords() {
    return this._savedZones ?? [];
  }

  /**
   * Compact stats for the status endpoint and the HUD.
   */
  report() {
    return {
      ...this.stats,
      bytesWritten: this.stats.bytesWritten,
      approxKiB: Math.round(this.stats.bytesWritten / 102.4) / 10,
      dirty: this.dirty,
      /** Claims present in the last load. 0 on a genuine first boot. */
      zones: (this._savedZones ?? []).length,
    };
  }
}
