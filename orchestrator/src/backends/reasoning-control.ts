/**
 * What a model's thinking looks like: the kinds of control it can offer, how
 * one is declared by hand, and what is known of it. A leaf of the backends
 * module: provider contracts name it without pulling the models.dev catalogue.
 * Moved verbatim out of `reasoning.ts`.
 */

/** One way of setting a model's thinking. */
export type ReasoningControl =
  /** Graded levels, in the model's own vocabulary (`none` means off). */
  | { type: 'levels'; values: string[] }
  /** A budget of thinking tokens, within bounds when known. */
  | { type: 'budget'; min?: number; max?: number }
  /** Thinking switched on or off. */
  | { type: 'toggle' };

/** What is known of a model's thinking, and where it comes from. */
export type ModelReasoning = {
  source: 'declared' | 'agent' | 'catalog';
  /** False: the model does not think at all. True with no `controls`: it thinks
   *  and nothing sets it. */
  thinks: boolean;
  controls: ReasoningControl[];
  /** The models.dev entry that answered (`provider/model`), source `catalog` only. */
  catalogEntry?: string;
};

/**
 * A control declared by hand on a model, for what levels cannot say: a budget,
 * a switch, or a model that does not think. Levels are declared with
 * `supportedReasoningLevels`, which the agent editor and every dialect already
 * read, so they are not repeated here.
 */
export type DeclaredReasoningControl =
  | { type: 'budget'; min?: number; max?: number }
  | { type: 'toggle' }
  | { type: 'none' };
