/**
 * Reset the objective ladder in a saved world, leaving the built world intact.
 *
 * Why this exists: the ladder completes off *world state*, and metrics are
 * satisfied by whatever is already standing. Four automated sessions connecting at
 * once is enough to clear `Room For Everyone` (three distinct builders) and then
 * everything behind it, so a save can arrive with all eight objectives done and
 * nothing left to do -- not through play, but through testing.
 *
 * Deleting `data/world.json` would fix that by throwing the island away too. This
 * keeps every block and claim, and resets only the progress fields:
 *
 *   index         which objective is active (0 = start of the ladder)
 *   completed     what has been credited
 *   humanTouched  which objectives a person has unlocked -- cleared, so the bots
 *                 still cannot carry the ladder after the reset
 *   contributors  builder ids counted toward `distinctBuilders`. These are socket
 *                 ids from sessions that are long gone, so they are stale by
 *                 definition and dropping them is part of the reset, not a side
 *                 effect of it.
 *
 * The world file is gzipped JSON written atomically by Persistence; this mirrors
 * that exactly, and always writes a `.bak` beside the original first.
 *
 * Usage:
 *   node tools/reset-ladder.js              reset to the start of the ladder
 *   node tools/reset-ladder.js --dry-run    report what would change, write nothing
 *   node tools/reset-ladder.js --index 6    start at a specific objective
 *
 * Stop the server first: it holds the ladder in memory and will overwrite the file
 * on its next autosave.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { OBJECTIVE_IDS } from '../shared/objectives.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'world.json');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const indexArg = argv.indexOf('--index');
const wanted = indexArg >= 0 ? Number(argv[indexArg + 1]) : 0;

if (!Number.isInteger(wanted) || wanted < 0) {
  console.error('--index must be a non-negative integer');
  process.exit(1);
}

if (!fs.existsSync(FILE)) {
  console.log(`no save at ${FILE} -- nothing to reset`);
  process.exit(0);
}

const gz = fs.readFileSync(FILE);
const save = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
const before = save.objectives;

console.log(`save      : ${FILE} (${gz.length} bytes, gzipped)`);
console.log(`world     : ${save.chunks?.length ?? 0} chunks, ${save.zones?.length ?? 0} claims`);
console.log(`ladder    : index ${before?.index ?? 0}/${before?.total ?? '?'}, `
  + `${before?.completed?.length ?? 0} completed, `
  + `${before?.humanTouched?.length ?? 0} human-touched, `
  + `${before?.contributors?.length ?? 0} contributors`);

// Reaching past the end of the ladder is how you get a save with nothing to do,
// so clamp against the real ladder length rather than trusting the saved number
// that produced the problem in the first place.
const index = Math.min(wanted, OBJECTIVE_IDS.length - 1);

save.objectives = {
  index,
  completed: [],
  contributors: [],
  humanTouched: [],
  total: index + 1,
};

console.log(`-> reset to index ${index}; the world's blocks and claims are untouched`);

if (dryRun) {
  console.log('dry run: nothing written');
  process.exit(0);
}

const backup = `${FILE}.bak`;
fs.copyFileSync(FILE, backup);
console.log(`backup    : ${backup}`);

// Same temp-then-rename the server uses, so an interrupted write cannot leave a
// half-written save at the live path.
const tmp = `${FILE}.tmp`;
fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(JSON.stringify(save), 'utf8'), { level: 6 }));
fs.renameSync(tmp, FILE);
console.log('done');
