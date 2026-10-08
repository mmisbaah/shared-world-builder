import { generateIsland } from "../shared/atoll.js";
function ringReport(thr) {
  const isl = generateIsland(38);
  const trunks = new Set();
  for (const [x, , z, m] of isl.blocks) if (m === 12) trunks.add(x + "," + z);
  const pts = [...trunks].map((k) => k.split(",").map(Number));
  // Bucket by angle in 16 sectors; a complete ring has every sector occupied.
  const sectors = new Array(16).fill(0);
  for (const [x, z] of pts) {
    let a = Math.atan2(z, x); if (a < 0) a += Math.PI * 2;
    sectors[Math.floor(a / (Math.PI * 2) * 16)]++;
  }
  const gaps = sectors.filter((s) => s === 0).length;
  console.log("thr " + thr.toFixed(2) + ": " + pts.length + " palms, empty sectors " + gaps + "/16, per sector " + sectors.join(","));
}
ringReport(0.22);
