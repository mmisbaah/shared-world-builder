import test from 'node:test';
import assert from 'node:assert/strict';

import { SOLO_BOTS, soloTeam } from '../shared/soloBots.js';
import { Authority } from '../server/authority.js';
import { BotSwarm } from '../server/bots.js';

test('solo roster offers ten distinct teammates and accepts exactly three', () => {
  assert.equal(SOLO_BOTS.length, 10);
  assert.equal(new Set(SOLO_BOTS.map((bot) => bot.id)).size, 10);
  assert.equal(soloTeam(['bot_alex', 'bot_nova', 'bot_lumen']).length, 3);
  assert.equal(soloTeam(['bot_alex', 'bot_alex', 'bot_nova']), null);
  assert.equal(soloTeam(['bot_alex', 'bot_nova']), null);
  assert.equal(soloTeam(['bot_alex', 'bot_nova', 'bot_unknown']), null);
});

test('a chosen solo team activates only its three bots in separate districts', () => {
  const ids = ['bot_nova', 'bot_rowan', 'bot_atlas'];
  const profiles = soloTeam(ids);
  assert.equal(new Set(profiles.map((bot) => bot.district.x + ',' + bot.district.z)).size, 3);
  const authority = new Authority();
  const swarm = new BotSwarm(authority, () => {}, { profiles });
  try {
    assert.deepEqual(swarm.roster().map((bot) => bot.id), ids);
    assert.equal(swarm.workers.size, 3);
    assert.deepEqual(authority.rivals.map((bot) => bot.id), ids);
  } finally {
    swarm.dispose();
  }
});
