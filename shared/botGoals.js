/**
 * Bot goal derivation.
 *
 * Kept pure and in `shared/` for two reasons. The server needs it to decide what
 * to build, and the client needs it to *show* what each builder is working on --
 * a bot that says it is raising a beacon and then erects a random wall reads as
 * broken, whereas a bot visibly working the shared objective reads as a
 * collaborator. Both sides derive the intent from the same objective id, so they
 * cannot disagree.
 *
 * The previous bot behaviour was "pick a random material and a random shape",
 * which served no goal at all. A cooperative world needs the other builders to be
 * visibly pulling on the same objective as you.
 */

import { OBJECTIVES, OBJECTIVE_IDS } from './objectives.js';
import { MATERIALS, PROPS } from './materials.js';

/**
 * What a bot should be doing to advance a given objective.
 *
 * @typedef {object} BuildIntent
 * @property {'material'|'prop'|'tower'|'idle'} kind
 * @property {string} label human-readable, shown in the UI
 * @property {number} [material] material id for `material`
 * @property {string} [prop] prop key for `prop`
 * @property {number} [height] target height for `tower`
 */

/**
 * Derive the build intent for an objective.
 *
 * Accepts the objective **definition**, or the id of one of the eight scripted
 * objectives as a convenience. The id form cannot resolve a generated tail
 * entry -- there is nowhere to look one up -- so anything past the campaign must
 * pass the definition itself. Getting that wrong is not loud: an unknown id
 * falls through to the idle branch and every bot simply stops working.
 *
 * @param {object|string|null} objective definition, or a scripted objective id
 * @returns {BuildIntent}
 */
export function intentFor(objective) {
  const o = typeof objective === 'string'
    ? OBJECTIVES.find((x) => x.id === objective)
    : (objective ?? null);
  if (!o) return { kind: 'idle', label: 'tidying up' };

  switch (o.metric) {
    case 'materialPresent':
      return {
        kind: 'material',
        material: Array.isArray(o.material) ? o.material[0] : o.material,
        label: `placing ${nameOf(o.material)}`,
      };

    case 'materialCount': {
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      return { kind: 'material', material: mat, label: `stockpiling ${nameOf(mat)}` };
    }

    case 'propCount':
      return { kind: 'prop', prop: o.prop, label: `placing ${PROPS[o.prop]?.name ?? o.prop}` };

    case 'columnHeight':
      return { kind: 'tower', height: o.goal, label: `raising the beacon to ${o.goal}` };

    case 'distinctBuilders':
      // A bot cannot make a human appear. Bots stand down here on purpose rather
      // than doing busy work that does not advance the objective -- standing down
      // is also a readable signal that this goal needs a person.
      return { kind: 'idle', label: 'waiting for other builders to join' };

    default:
      return { kind: 'idle', label: 'tidying up' };
  }
}

/**
 * Which objective a bot should be working on, given its specialism.
 *
 * Bots pick from the *same* active objective as everyone else -- that is what
 * makes the world feel cooperative rather than three projects running in
 * parallel. The specialism only decides *how* each one contributes, so you get
 * variety in method without variety in objective.
 *
 * @param {object|string|null} activeObjective definition, or a scripted objective id
 * @param {string} specialism one of the keys in SPECIALISMS
 * @returns {BuildIntent}
 */
export function chooseIntent(activeObjective, specialism) {
  const intent = intentFor(activeObjective);
  if (intent.kind === 'idle') return intent;

  // A specialism only re-frames the work; it never diverts from the objective.
  // The one exception is height: a bricklayer cannot usefully build a tower, so
  // a height objective falls back to everyone's least-preferred method rather than
  // stalling.
  if (intent.kind === 'tower' && specialism !== 'architect') {
    return { ...intent, label: `${intent.label} (assisting)` };
  }
  if (intent.kind === 'prop' && specialism === 'electrician') {
    return { ...intent, label: `${intent.label} -- wiring the plaza` };
  }
  if (intent.kind === 'material' && specialism === 'mason') {
    return { ...intent, label: `${intent.label} -- coursing the walls` };
  }
  return intent;
}

/**
 * Bot specialisms.
 *
 * Not flavour text: each one changes what a bot does with the same objective, and
 * each maps to a distinct kind of contribution, which is what stops three bots
 * from stacking identical blocks on top of each other.
 */
export const SPECIALISMS = {
  /** Towers, height, structures. */
  architect: { label: 'architect', blurb: 'builds upward' },
  /** Runs of the same material. */
  mason: { label: 'mason', blurb: 'lays material in runs' },
  /** Lanterns and torches, i.e. the light objectives. */
  electrician: { label: 'electrician', blurb: 'hangs lanterns' },
  /** Props and dressing. */
  gardener: { label: 'gardener', blurb: 'plants and dresses' },
};

/** Convenience for the client: the full ladder annotated with bot intents. */
export function ladderWithIntents(activeIndex) {
  return OBJECTIVES.map((o, i) => ({
    id: o.id,
    title: o.title,
    goal: o.goal,
    active: i === activeIndex,
    intent: chooseIntent(o.id, 'mason'),
  }));
}

export { OBJECTIVE_IDS };

function nameOf(material) {
  if (Array.isArray(material)) return MATERIALS[material[0]]?.name ?? 'material';
  return MATERIALS[material]?.name ?? 'material';
}
