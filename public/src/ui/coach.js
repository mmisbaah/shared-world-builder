/**
 * First-run coaching.
 *
 * The first objective is the tutorial — it asks for one lantern — but nothing told
 * anyone that. A new player opens this cold: a sky, some terrain, eight goals in a
 * panel they may not read, and no indication that clicking does anything. The ladder
 * was doing the job of a tutorial and doing it badly, because the goal it names
 * (`place a lantern`) is *not* what a new player's hand does first. The obvious first
 * action is "put a block down". So the tutorial's first instruction was effectively
 * invisible.
 *
 * This walks the actual loop, in the order a player would experience it, and advances
 * only on evidence that the player did the thing rather than on a timer:
 *
 *   1. click the world   -- proves building works
 *   2. watch the bots    -- proves the world is not empty and is being worked
 *   3. read the goal     -- proves the panel is worth reading
 *   4. claim ground      -- proves territory is a thing that can be held
 *
 * Deliberately not built:
 *
 * - **Timed advancement.** A tutorial that advances on a clock teaches the player to
 *   ignore it. Every step waits for a real action.
 * - **Modal blocking.** Nothing pauses the game. A player who ignores all of this can
 *   build happily and simply never see it again.
 * - **Repetition.** Once finished, it stays finished, in this browser, permanently.
 *
 * The state machine is pure and separate from the DOM so the sequencing can be tested
 * without a browser -- which is the only way to check the interesting part, which is
 * *when* it advances.
 */

/** Every step the coach knows about, in order. */
export const STEP = {
  WELCOME: 'welcome',
  PLACE: 'place',
  BOTS: 'bots',
  GOAL: 'goal',
  DONE: 'done',
};

/**
 * One step, in the player's own terms.
 *
 * `title` is what the step is called internally; `body` is one sentence of instruction
 * written the way a person would say it. `needs` is the state that completes it, which
 * is what makes advancement evidence-based rather than timed.
 *
 * The id and the `needs` must correspond, and that is worth stating because it was
 * once wrong: the step titled "Others are building" waited on a claim, and the step
 * about holding ground waited on the goal panel arriving. Nothing errored -- the coach
 * simply sat on a step whose evidence could never arrive, so it looked like a tutorial
 * that worked for most people and then stopped. There is now a test asserting every
 * step can be satisfied.
 */
/**
 * One step, in the player's own terms.
 *
 * `title` is what the step is called internally; `body` is one sentence of instruction
 * written the way a person would say it. `needs` is the state that completes it, which
 * is what makes advancement evidence-based rather than timed.
 *
 * The id and the `needs` must correspond, and that is worth stating because it was
 * once wrong: the step titled "Others are building" waited on a claim, and the step
 * about holding ground waited on the goal panel arriving. Nothing errored -- the coach
 * simply sat on a step whose evidence could never arrive, so it looked like a tutorial
 * that worked for most people and then stopped. There is now a test asserting every
 * step can be satisfied.
 *
 * **Every step's requirement must be something the player can always do.** This is the
 * second version of that same lesson. The "others are building" step originally
 * completed on the swarm having committed a block -- which is exactly what does *not*
 * happen when the objective ladder is already finished and the bots have correctly
 * stood down. On a returning player's world the coach waited forever on evidence that
 * would never come. Requirements are now all either a click the player makes or a
 * press they can always perform; nothing depends on what other agents happen to be
 * doing, because the player cannot control that and should not be gated on it.
 */
export const STEPS = [
  {
    id: STEP.WELCOME,
    title: 'Welcome',
    body: 'Click anywhere on the ground to build. Try it now.',
    needs: 'place',
    anchor: null,
  },
  {
    id: STEP.PLACE,
    title: 'It is yours',
    body: 'That is yours to keep — it saves when you leave. Click the builders list.',
    needs: 'clickBuilders',
    anchor: '#builders',
  },
  {
    id: STEP.BOTS,
    title: 'Others are here',
    body: 'Four bots work toward the same goals as you. Now click the goals panel.',
    needs: 'clickGoals',
    anchor: '#objectives',
  },
  {
    id: STEP.GOAL,
    title: 'Shared goals',
    body: 'That is the first one, and it is worth reading. Press C to claim a district.',
    needs: 'claim',
    anchor: '#btn-claim',
  },
  {
    id: STEP.DONE,
    title: 'You have the idea',
    // The closing line carries the one rule that is easy to get wrong: a fading claim
    // takes the ground, not the work. Worth saying once, here, where it costs a
    // sentence.
    body: 'Build whatever you like. Your blocks outlive your claim. Press F for frame stats.',
    needs: null,
    anchor: null,
  },
];

/** @returns {object} the step descriptor for an id */
export function stepById(id) {
  return STEPS.find((s) => s.id === id) ?? STEPS[STEPS.length - 1];
}

/**
 * The coach's state machine.
 *
 * Pure: it takes events in and produces the new state, with no DOM and no timers.
 * That is what makes the sequencing testable, which matters because "advances at the
 * right moment" is the entire behaviour and it is invisible when it is wrong.
 */
export class Coach {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.started] true when the player has been here before
   */
  constructor(opts = {}) {
    this.finished = !!opts.started;
    /** @type {string} current step id */
    this.step = this.finished ? STEP.DONE : STEP.WELCOME;
    /** Ids of steps already shown, so a returning player is not re-taught mid-run. */
    this.seen = new Set();
    // Storage is injected so the persistence can be tested. `localStorage` does not
    // exist in Node, so a test that reached for it directly could only ever assert
    // the try/catch fallback -- which is exactly the kind of test that passes while
    // proving nothing.
    this._store = opts.storage ?? null;
  }

  get active() {
    return !this.finished;
  }

  /** @returns {object} the descriptor to render right now */
  current() {
    return stepById(this.step);
  }

  /**
   * Advance on evidence.
   *
   * @param {string} signal one of the `needs` values across STEPS, or null for
   *   anything unrecognised
   * @returns {{changed:boolean, step?:object, finished?:boolean}}
   */
  advance(signal) {
    if (this.finished) return { changed: false };

    const now = this.current();
    // Ignoring signals that are not what this step is waiting for is deliberate. A
    // player who clicks forty times must not blow through four steps and end up
    // believing they have been taught something.
    if (!now.needs || signal !== now.needs) return { changed: false };

    const i = STEPS.findIndex((s) => s.id === now.id);
    const next = STEPS[i + 1] ?? STEPS[STEPS.length - 1];
    this.step = next.id;
    this.seen.add(now.id);

    if (next.id === STEP.DONE) {
      this.finished = true;
      return { changed: true, finished: true };
    }
    return { changed: true, step: next };
  }

  /**
   * Advance if the world state now satisfies the current step.
   *
   * The intended entry point. It asks about the step being displayed, so it cannot
   * advance on evidence meant for a later step, and it cannot stall because a later
   * step's evidence happened to arrive first -- once the state is true it stays true,
   * so a player who claims ground during the first step simply sails through the rest
   * when they next look.
   *
   * Exactly one step per call, always. That is what makes a caught-up player who is
   * already holding ground and has already built see the sequence *read* rather than
   * blink: the caller advances at most once per frame, so the whole thing takes as
   * many frames as it has steps. Collapsing it in one call was worse -- a returning
   * player would have the entire tutorial flash and vanish in a single frame, which
   * reads as a glitch rather than as anything having been taught.
   *
   * @param {object} s world state
   * @returns {{changed:boolean, step?:object, finished?:boolean}}
   */
  pump(s) {
    if (this.finished) return { changed: false };
    if (!isSatisfied(this.current(), s)) return { changed: false };
    return this.advance(this.current().needs);
  }

  /** Player dismissed it. Not the same as finishing: they may come back. */
  dismiss() {
    if (this.finished) return false;
    this.finished = true;
    return true;
  }
}

const KEY = 'swb.coached.v1';

/**
 * Storage indirection, so persistence is testable and private mode is survivable.
 *
 * `localStorage` throws rather than returning null in some privacy modes, and a
 * tutorial that crashes the game on load is worse than one that repeats. Both of the
 * exported helpers take a store so the browser passes the real one and tests pass a
 * fake, rather than having the only testable path be the fallback.
 *
 * @param {object|null} store anything with getItem/setItem
 * @returns {object|null}
 */
export function defaultStore(store) {
  if (store) return store;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Whether this browser has been coached before. */
export function wasCoached(store) {
  const s = defaultStore(store);
  if (!s) return false;
  try {
    return s.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberCoached(store) {
  const s = defaultStore(store);
  if (!s) return false;
  try {
    s.setItem(KEY, '1');
    return true;
  } catch {
    return false; // private mode: the coach simply reappears next time
  }
}

/**
 * Whether a step's requirement is met by the current world state.
 *
 * Each step is answered on its *own* terms, which is the only design that composes.
 * An earlier version derived a single "most advanced true condition" signal and fed
 * that to a strictly sequential machine, and the two disagreed: the machine advanced
 * on `claim` while sitting on a step that wanted `ackGoal`, and then sat there
 * forever. Asking "is what *this* step needs true yet?" cannot get out of step with
 * itself, because it only ever asks about the step being displayed.
 *
 * @param {object} step a descriptor from STEPS
 * @param {object} s world state, where `clicked` is a Set of anchors the player
 *   has activated this session
 * @returns {boolean}
 */
export function isSatisfied(step, s) {
  switch (step.needs) {
    case 'place': return s.accepted > 0;
    case 'clickBuilders': return hasClicked(s, '#builders');
    case 'clickGoals': return hasClicked(s, '#objectives');
    case 'claim': return s.hasClaim;
    // The final step asks for nothing, so it is never "satisfied" -- it is reached
    // by advancing past the one before it.
    default: return false;
  }
}

/**
 * Whether the player has activated a given anchor.
 *
 * Tolerates `clicked` being absent, an array, or a Set: it is populated from DOM
 * events, and a coach that throws because of how a caller tracked a click would be a
 * cosmetic bug that silently ends onboarding.
 */
function hasClicked(s, selector) {
  const c = s?.clicked;
  if (!c) return false;
  if (typeof c.has === 'function') return c.has(selector);
  return Array.isArray(c) && c.includes(selector);
}