/**
 * Turning network events into sound.
 *
 * This is extracted from the frame loop for one reason: it is the part of the
 * audio system that contains decisions, and inside a `requestAnimationFrame`
 * closure it cannot be tested at all. That is not a theoretical concern -- an
 * earlier version of this mapping did double-strike every placement, because the
 * server broadcasts a delta back to its own author and both the delta and the
 * `accepted` event carried "a block appeared". The bug was invisible in a headless
 * environment, because `requestAnimationFrame` does not run there and the only way
 * to exercise the frame loop is to look at it.
 *
 * So the mapping lives here, takes its sound function by injection, and is driven
 * directly in tests with a recorder. `sfx` is never imported here; there is no Web
 * Audio in this module at all.
 */

import { SFX, editSound } from './voice.js';
import { OP } from '../../../shared/protocol.js';

/**
 * Decide who caused a change.
 *
 * Bots get their own tier because they are not occasional visitors -- they commit
 * every second or so each -- and because a bot working steadily in its own district
 * should sound like part of the background rather than like another player.
 *
 * The id-prefix fallback matters on first contact: a delta can arrive carrying a
 * `by` for a bot before the presence message that lists the roster has landed, and
 * that first delta should not be classified as a human at full volume.
 *
 * @param {string|null} by
 * @param {string|null} selfId
 * @param {Set<string>} botIds
 * @returns {'self'|'human'|'bot'}
 */
export function classify(by, selfId, botIds) {
  if (!by) return 'human';
  if (by === selfId) return 'self';
  if (botIds.has(by) || by.startsWith('bot_')) return 'bot';
  return 'human';
}

/**
 * Play a batch of drained events.
 *
 * @param {object[]} events from Connection#drainEvents
 * @param {object} deps
 * @param {(name:string, opts:object, who:string)=>boolean} deps.play
 * @param {string|null} deps.selfId
 * @param {Set<string>} deps.botIds
 * @param {(text:string, kind:string)=>void} [deps.log]
 * @param {(text:string, kind:string)=>void} [deps.toast]
 * @returns {{sounded:number, self:number, remote:number, bots:number, denied:number}}
 */
export function playEvents(events, deps) {
  const { play, selfId, botIds, log, toast } = deps;
  const tally = { sounded: 0, self: 0, remote: 0, bots: 0, denied: 0 };

  for (const ev of events) {
    switch (ev.type) {
      case 'delta': {
        // The server broadcasts every delta to every client *including the author*,
        // so a delta for our own edit arrives here as well as the `accepted` event.
        // Playing both double-strikes every placement the player makes -- which is
        // the single most audible event in the game. `accepted` is the authoritative
        // "you did this" signal, so deltas are only sounded for other builders.
        const who = classify(ev.by, selfId, botIds);
        if (who === 'self') break;
        const kind = ev.propCount > 0 ? 'prop' : 'place';
        if (play(editSound(kind, false), {
          x: ev.x, y: ev.y, z: ev.z, mat: ev.mat,
        }, who)) {
          tally.sounded++;
          if (who === 'bot') tally.bots++; else tally.remote++;
        }
        break;
      }

      case 'accepted': {
        // opType distinguishes a block from a prop. Both arrive with no material,
        // so without it a lantern and a cube would make the same sound.
        const kind = ev.opType === OP.PLACE_PROP ? 'prop' : 'place';
        if (play(editSound(kind, true), {
          x: ev.x, y: ev.y, z: ev.z, mat: ev.mat,
        }, 'self')) {
          tally.sounded++;
          tally.self++;
        }
        break;
      }

      case 'denied': {
        log?.(`op ${ev.opId} denied: ${ev.reason}`, ev.conflict ? 'bad' : 'warn');
        if (ev.conflict) toast?.(`${ev.winner?.name} beat you to it`, 'bad');
        if (play(ev.conflict ? SFX.CONFLICT : SFX.DENY, {
          x: ev.x, y: ev.y, z: ev.z,
        }, 'self')) {
          tally.sounded++;
          tally.denied++;
        }
        break;
      }

      case 'conflict': {
        // Reported by the `denied` handler above, which is the only place that knows
        // whether the denial came with a winner. Sounding it here as well would
        // double the loudest sound the game has.
        log?.(`lost a race at ${ev.x},${ev.y},${ev.z}`, 'bad');
        break;
      }

      default:
        // `bot` (an intent announcement, sent before the commit) is deliberately
      // ignored: the resulting delta is the authoritative event, and playing both
        // would double every bot placement. `botAction` exists so clients can draw
      // a targeting ray while the change is in flight, not to be heard.
        break;
    }
  }

  return tally;
}