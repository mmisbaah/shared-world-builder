// Available teammates for a solo world. A game activates exactly three.
export const SOLO_BOTS = Object.freeze([
  { id: 'bot_alex', name: 'Alex Voxel', color: '#38bdf8', specialism: 'architect', plan: 'tower', interval: 900, blurb: 'Builds towers and landmarks.' },
  { id: 'bot_maya', name: 'Maya Craft', color: '#a855f7', specialism: 'mason', plan: 'wall', interval: 1200, blurb: 'Shapes sturdy walls and paths.' },
  { id: 'bot_zen', name: 'Zen Architect', color: '#f59e0b', specialism: 'electrician', plan: 'terrace', interval: 1000, blurb: 'Adds light and detail.' },
  { id: 'bot_ivy', name: 'Ivy Green', color: '#34d399', specialism: 'gardener', plan: 'garden', interval: 1600, blurb: 'Plants living spaces.' },
  { id: 'bot_flint', name: 'Flint Forge', color: '#fb923c', specialism: 'mason', plan: 'wall', interval: 1100, blurb: 'Works stone and brick.' },
  { id: 'bot_nova', name: 'Nova Circuit', color: '#f472b6', specialism: 'electrician', plan: 'terrace', interval: 950, blurb: 'Lights up new builds.' },
  { id: 'bot_rowan', name: 'Rowan Grove', color: '#84cc16', specialism: 'gardener', plan: 'garden', interval: 1450, blurb: 'Grows green corners.' },
  { id: 'bot_atlas', name: 'Atlas Beam', color: '#818cf8', specialism: 'architect', plan: 'tower', interval: 1050, blurb: 'Raises bold structures.' },
  { id: 'bot_ember', name: 'Ember Brick', color: '#ef4444', specialism: 'mason', plan: 'wall', interval: 1250, blurb: 'Builds warm foundations.' },
  { id: 'bot_lumen', name: 'Lumen Spark', color: '#22d3ee', specialism: 'electrician', plan: 'terrace', interval: 1000, blurb: 'Makes the island glow.' },
]);

const DISTRICTS = [
  { x: 1, z: 1 }, { x: -1, z: 1 }, { x: -1, z: -1 },
];

export function soloTeam(ids) {
  if (!Array.isArray(ids) || ids.length !== 3 || new Set(ids).size !== 3) return null;
  const selected = ids.map((id) => SOLO_BOTS.find((bot) => bot.id === id));
  if (selected.some((bot) => !bot)) return null;
  return selected.map((bot, index) => ({ ...bot, district: DISTRICTS[index] }));
}
