/**
 * The layer of states over the eyes: what an agent is doing (idle, thinking,
 * waiting for you…) or how it reacts. A state picks expressions from its pool
 * at its own cadence, blinks at its own rhythm (or not) and looks somewhere.
 */

import { packEyesBlink, type MascotExpression, type MascotEyesKey } from './mascot-geometry';

/** `pointer` follows the pointer; `glance` looks aside, the other side at each change; `scan` sweeps; a pair is a fixed offset. */
export type MascotGaze = 'pointer' | 'glance' | 'scan' | readonly [number, number];

export type MascotStateSpec = {
  group: 'agent' | 'reaction';
  /** `base` stands for the look's own eyes. */
  pool: readonly (MascotExpression | 'base')[];
  /** Milliseconds between two expressions, drawn in this range. */
  every: readonly [number, number];
  /** Milliseconds between two blinks; `null`: never blinks. */
  blink: readonly [number, number] | null;
  gaze: MascotGaze;
  /** A one-off body move as the state starts. */
  enter?: 'jump' | 'wiggle';
  /** Keeps hopping while the state lasts. */
  bounce?: boolean;
  /** The screen breathes (sleeping). */
  breathe?: boolean;
};

export const STATES = {
  idle: { group: 'agent', pool: ['base', 'base', 'base', 'big', 'happy'], every: [7000, 13000], blink: [2500, 6500], gaze: 'pointer' },
  listening: { group: 'agent', pool: ['big', 'pill'], every: [2800, 5000], blink: [3000, 6500], gaze: [0, -1.3] },
  thinking: { group: 'agent', pool: ['dots', 'quizzical', 'skeptic', 'dots'], every: [1800, 3200], blink: [3500, 7000], gaze: 'glance' },
  working: { group: 'agent', pool: ['squint', 'pill', 'squint'], every: [1800, 3000], blink: [2800, 5500], gaze: [0, 1.4] },
  searching: { group: 'agent', pool: ['pill', 'big', 'surprised'], every: [1000, 1800], blink: [1600, 4000], gaze: 'scan' },
  waiting: { group: 'agent', pool: ['big', 'pill', 'big'], every: [3000, 5500], blink: [2200, 4500], gaze: [0, 0.4], bounce: true },
  done: { group: 'agent', pool: ['happy', 'star', 'happy'], every: [2200, 4000], blink: null, gaze: 'pointer', enter: 'jump' },
  error: { group: 'agent', pool: ['x', 'sad', 'x'], every: [2600, 4200], blink: null, gaze: [0, 1.2], enter: 'wiggle' },
  sleeping: { group: 'agent', pool: ['sleepy'], every: [6000, 10000], blink: null, gaze: [0, 1.2], breathe: true },
  happy: { group: 'reaction', pool: ['happy', 'wink', 'happy'], every: [2200, 4000], blink: [2500, 5000], gaze: 'pointer' },
  celebrate: { group: 'reaction', pool: ['star', 'heart', 'happy'], every: [1100, 2000], blink: null, gaze: 'pointer', enter: 'jump', bounce: true },
  confused: { group: 'reaction', pool: ['quizzical', 'skeptic'], every: [2000, 3400], blink: [2800, 5500], gaze: 'glance' },
  surprised: { group: 'reaction', pool: ['surprised', 'big'], every: [2400, 4000], blink: [1800, 3500], gaze: [0, -0.8], enter: 'jump' },
  sad: { group: 'reaction', pool: ['sad', 'sleepy'], every: [4000, 7000], blink: [4000, 8000], gaze: [0, 1.6] },
  angry: { group: 'reaction', pool: ['angry', 'squint'], every: [2200, 3800], blink: [3500, 7000], gaze: [0, 0] },
  love: { group: 'reaction', pool: ['heart', 'happy'], every: [1800, 3200], blink: null, gaze: 'pointer' },
  shy: { group: 'reaction', pool: ['happy', 'sleepy'], every: [2600, 4600], blink: [3000, 6000], gaze: [-2.2, 1.3] },
  coding: { group: 'reaction', pool: ['code', 'squint', 'code'], every: [2600, 4400], blink: null, gaze: [0, 1] },
} as const satisfies Record<string, MascotStateSpec>;

export type MascotState = keyof typeof STATES;
export const MASCOT_STATES = Object.keys(STATES) as MascotState[];

export function isMascotState(value: unknown): value is MascotState {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STATES, value);
}

export const stateLabelKey = (state: MascotState): string => `mascot.state.${state}`;

/** Expressions that never blink: closed, drawn or symbolic eyes. */
export const NO_BLINK: ReadonlySet<MascotExpression> = new Set<MascotExpression>(['sleepy', 'happy', 'x', 'heart', 'star', 'code', 'dots', 'sad', 'squint']);

export function stateSpec(state: MascotState): MascotStateSpec {
  return STATES[state];
}

/** Whether these eyes blink: never for the closed or drawn ones, as a pack says for its own. */
export function blinks(expr: MascotEyesKey): boolean {
  return packEyesBlink(expr) ?? !NO_BLINK.has(expr as MascotExpression);
}

/** The expression a state shows first — and the only one, without motion. */
export function stateExpression(state: MascotState, base: MascotEyesKey): MascotEyesKey {
  const first = STATES[state].pool[0];
  return first === undefined || first === 'base' ? base : first;
}
