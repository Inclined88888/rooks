/**
 * Random draws over the mascot's lists, shared by every screen that dresses
 * an agent (the configurator's "Surprise me", the onboarding's "Random").
 * Moved out of `components/onboarding/agent-draft.ts`: the shared
 * configurator must not depend on one of the screens that mounts it.
 *
 * A draw takes the mascot packs' parts too (`lookChoices`): a pack the user
 * installed is part of what they can wear, and a random head that never
 * shows it would hide it. The daemon accepts every part drawn, since the
 * registry only holds parts their plugin's manifest declares.
 */
import { ACC, EYES, FURS, SHAPES, type AgentLook } from './agent-look';
import { mascotPartIds } from './mascot-parts';

export type Random = () => number;

export const pick = <T>(list: readonly T[], rng: Random): T => list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!;

/** What a look is drawn from: the product's lists, then the parts the packs registered. */
export type LookChoices = {
  shapes: readonly AgentLook['shape'][];
  colors: readonly AgentLook['color'][];
  eyes: readonly AgentLook['eyes'][];
  accessories: readonly AgentLook['acc'][];
};

export function lookChoices(): LookChoices {
  return {
    shapes: [...SHAPES, ...mascotPartIds('shape')],
    colors: [...FURS, ...mascotPartIds('color')],
    eyes: [...EYES, ...mascotPartIds('eyes')],
    accessories: [...ACC, ...mascotPartIds('acc')],
  };
}

/** Any skull, fur, eyes and tool the pickers offer, packs included. */
export function randomLook(rng: Random = Math.random, choices: LookChoices = lookChoices()): AgentLook {
  return { shape: pick(choices.shapes, rng), color: pick(choices.colors, rng), eyes: pick(choices.eyes, rng), acc: pick(choices.accessories, rng) };
}
