/**
 * Run the tone probe over the current palette and lighting rig.
 *
 * Reads both files the renderer actually uses -- `config.js` for exposure and
 * `pipeline.js` for the environment -- so the numbers here cannot drift from what is
 * drawn. Run it after touching either.
 *
 *   node tools/probe-run.mjs
 */

import { probe, printProbe, ENV } from './tone-probe.js';

console.log(`exposure     ${ENV ? '' : ''}${(await import('../public/src/config.js')).CONFIG.exposure}`);
console.log(`sun          [${ENV.sunColor.join(', ')}]  elevation ${ENV.sunElevationDeg.toFixed(0)} deg`);
console.log(`sky fill     [${ENV.skyColor.join(', ')}]`);
console.log(`ground fill  [${ENV.groundColor.join(', ')}]`);

const rows = printProbe('as rendered', probe());

const opaque = rows.filter((r) => !r.missing && !r.emissive && !r.translucent);
const clipped = rows.filter((r) => r.clipped);
const flat = opaque.filter((r) => r.ratio < 2.2);
const worst = opaque.reduce((a, b) => (b.ratio < a.ratio ? b : a));

console.log('\nverdict');
console.log('  clipped        ' + (clipped.length ? clipped.map((r) => r.key).join(', ') : 'none'));
console.log('  no form        ' + (flat.length ? flat.map((r) => `${r.key} ${r.ratio.toFixed(2)}`).join(', ') : 'none'));
console.log('  worst opaque   ' + `${worst.key} ${worst.ratio.toFixed(2)}`);
process.exitCode = clipped.length || flat.length ? 1 : 0;
