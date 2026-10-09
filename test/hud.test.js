/**
 * The builders panel -- the on-screen half of attribution.
 *
 * `setPresence` is the only place that answers "who is in this world and how
 * much have they actually done", which makes it worth pinning: the audio system
 * already tells you who changed the world *near* you, and a panel that rendered
 * `NaN` or dropped the count would be the half of that answer which is always
 * visible.
 *
 * There is no DOM here. `HUD` is built to read `this.el` and write strings, so
 * the elements are stubbed and the markup itself is what is asserted on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { HUD } from '../public/src/ui/hud.js';

function hud() {
  const h = Object.create(HUD.prototype);
  h.el = { builders: { innerHTML: '' } };
  return h;
}

const person = (over = {}) => ({ id: 'b1', name: 'Maya_Craft', color: '#a855f7', ...over });
const bot = (over = {}) => ({ id: 'bot_alex', name: 'Alex_Voxel', color: '#38bdf8', ...over });

test('every row shows how much that builder has contributed', () => {
  const h = hud();
  h.setPresence([person({ edits: 42 })], [bot({ edits: 7 })], 'nobody');
  const html = h.el.builders.innerHTML;

  assert.match(html, /class="count"[^>]*>42</, 'the player count is on screen');
  assert.match(html, /class="count"[^>]*>7</, 'and so is the bot count');
  assert.match(html, /title="42 edits committed this session"/, 'so a bare number can be read');
});

test('a single edit is described as one, not as "1 edits"', () => {
  const h = hud();
  h.setPresence([person({ edits: 1 })], [], 'nobody');
  assert.match(h.el.builders.innerHTML, /title="1 edit committed this session"/);
});

test('an absent or malformed count reads as zero, never as NaN', () => {
  // A payload the server has not counted yet, or one that arrived as a string,
  // must not put `NaN` into a panel whose whole job is to state a fact.
  for (const edits of [undefined, null, NaN, '12', -3]) {
    const h = hud();
    h.setPresence([person({ edits })], [], 'nobody');
    const match = /class="count"[^>]*>([^<]*)</.exec(h.el.builders.innerHTML);
    assert.ok(match, 'a count is always rendered');
    assert.equal(match[1], '0', `edits=${String(edits)} must read as 0`);
  }
});

test('a fractional count is floored rather than shown', () => {
  const h = hud();
  h.setPresence([person({ edits: 4.7 })], [], 'nobody');
  assert.match(h.el.builders.innerHTML, /class="count"[^>]*>4</);
});

test('your own row is marked out from everyone else', () => {
  const h = hud();
  h.setPresence([person({ edits: 3 }), person({ id: 'b2', name: 'Them', edits: 9 })], [], 'b1');
  const html = h.el.builders.innerHTML;

  assert.match(html, /class="row me"/, 'the reader is one of these rows');
  assert.match(html, /\(you\)/, 'and says so in words as well');
  assert.equal((html.match(/class="row"/g) ?? []).length, 1, 'the other row is not marked');
  assert.match(html, /class="count"[^>]*>9</, 'and still carries their count');
});

test('a bot row keeps its intent and gains a count', () => {
  // The intent is what makes three bots read as collaborators rather than as
  // idle chatter, so it must survive the row gaining a second figure.
  const h = hud();
  h.setPresence([], [bot({ edits: 12, specialism: 'mason', intent: 'placing Brick' })], 'nobody');
  const html = h.el.builders.innerHTML;

  assert.match(html, /row dim/);
  assert.match(html, /placing Brick/, 'intent is still shown');
  assert.match(html, /mason/, 'and so is the specialism');
  assert.match(html, /class="count"[^>]*>12</, 'alongside the contribution');
});

test('a builder name cannot inject markup into the panel', () => {
  // Counts are interpolated into the same attribute as the name, so a name
  // carrying markup must be neutralised before either can be read as HTML.
  const h = hud();
  h.setPresence([person({ name: '<img src=x onerror=alert(1)>' })], [], 'nobody');
  const html = h.el.builders.innerHTML;

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/, 'and the text still reaches the reader');
});

test('an empty world says so rather than rendering an empty box', () => {
  const h = hud();
  h.setPresence([], [], 'nobody');
  assert.match(h.el.builders.innerHTML, /alone in here/);
});
