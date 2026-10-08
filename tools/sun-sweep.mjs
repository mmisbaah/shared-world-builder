import { MATERIALS } from "../shared/materials.js";
import { probe, readEnvironment } from "./tone-probe.js";

// A top face (ny=1) and a sun-facing wall face (ny=0) under the same sun. The gap
// between those two IS the terracing read -- it is what draws every step edge.
function faceContrast(env) {
  const sun = env.sunColor, sky = env.skyColor, grd = env.groundColor;
  const nTop = env.sunDir[1];
  const hTop = sky, hSide = sky.map((s, i) => grd[i] + (s - grd[i]) * 0.5);
  // Horizontal component of the sun, for a wall square to it.
  const hlen = Math.hypot(env.sunDir[0], env.sunDir[2]) || 1;
  const nWall = hlen;
  return { topNdl: nTop, wallNdl: nWall, gain: nWall / nTop };
}

const base = readEnvironment();
console.log("elevation | top ndl | wall ndl | wall/top |  sand ratio  sand lit");
for (const elev of [20, 26, 32, 38, 45, 51, 60]) {
  const e = (elev * Math.PI) / 180;
  // Keep the same azimuth, change only the elevation.
  const az = Math.atan2(base.sunDir[2], base.sunDir[0]);
  const hxz = Math.cos(e);
  const dir = [Math.cos(az) * hxz, Math.sin(e), Math.sin(az) * hxz];
  const env = { ...base, sunDir: dir };
  const fc = faceContrast(env);
  const sand = probe(env, ["sand"])[0];
  console.log(
    "  " + String(elev).padStart(2) + " deg  |  " + fc.topNdl.toFixed(3) +
    "   |   " + fc.wallNdl.toFixed(3) + "   |  " + fc.gain.toFixed(2) + "x   |   " +
    sand.ratio.toFixed(2) + "     |  " + sand.lit.toFixed(3));
}
console.log("\n(wall/top gain is how much brighter a sun-facing wall is than the flat top;");
console.log(" higher means the terraces separate.)");
