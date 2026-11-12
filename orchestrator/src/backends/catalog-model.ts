/**
 * A model offered to the user. A leaf of the backends module: provider
 * profiles name it without pulling the catalogue (registry, database,
 * discovery). Moved verbatim out of `catalog.ts`.
 */

import type { DeclaredReasoningControl, ModelReasoning } from './reasoning-control.js';

/**
 * How a model ranks inside its own provider's range. The automatic quota fallback
 * (`equivalence.ts`) keeps the calibre of the work it moves: a flagship falls back
 * on a flagship of another backend, never on a small model by accident.
 */
export const MODEL_TIERS = ['flagship', 'mid', 'small'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * A model that can be offered to the user.
 *
 * `contextWindow` is DELIBERATELY optional and must stay absent as long as
 * the value is not known from a reliable source: it depends on the model AND on the
 * subscription tier, and an invented figure would be worse than not
 * displaying anything. Consumers (context gauge) must degrade
 * cleanly when the field is missing, never substitute a default value.
 */
export type CatalogModel = {
  /** Value passed as is to the CLI's `--model` flag. */
  slug: string;
  /** C3 — where this model sits in its provider's range, for the automatic fallback.
   *  Absent = the default model of the profile is a flagship, any other is `mid`. */
  tier?: ModelTier;
  /** Local additions keep their first registration time (milliseconds). */
  addedAt?: number;
  /** Hidden entries remain editable but never appear in the active catalogue. */
  hidden?: boolean;
  /** Label in the backend's "model" dropdown. */
  label: string;
  /** Context window size in tokens, if known from a reliable source. */
  contextWindow?: number;
  /** The user typed `contextWindow` by hand (Settings → Backends, or the file
   *  of a provider they added). The context gauge then trusts it over the
   *  window the runtime reports: the hand-typed figure exists precisely
   *  because the reported one was wrong (TODO #175). */
  contextWindowDeclared?: boolean;
  /** Present = the model appears in the quick-preset grid of the
   *  dialogs (new mission / fork / compact). Absent = menu only. */
  presetLabel?: string;
  /** Global sort rank of the presets (all backends together). */
  presetRank?: number;
  /** Reasoning levels supported by this model (e.g. ["low", "medium", "high", "xhigh"]).
   *  Absent = no reasoning choice for this model. */
  supportedReasoningLevels?: string[];
  /** Effort levels the provider's own model listing reported for this model
   *  (Anthropic `capabilities.effort`), kept by the connection test of the
   *  custom provider form. A source of `reasoning` ranked below declared levels;
   *  it shows no slider by itself. */
  reportedReasoningLevels?: string[];
  /** A budget, a switch or "does not think", declared by hand where levels
   *  cannot say it (custom provider form). Ranked with declared levels, which
   *  win when both are written. */
  reasoningControl?: DeclaredReasoningControl;
  /** How this model's thinking is set (levels, budget, switch), and from which
   *  source: declared levels, the agent, or the embedded models.dev catalogue
   *  (custom providers only). OUTPUT of the catalogue, filled on every read and
   *  never stored: a profile declares levels with `supportedReasoningLevels`.
   *  Unlike that field, it shows no slider by itself — a catalogue entry says
   *  what the model can do, not what the endpoint honours. */
  reasoning?: ModelReasoning;
  /** Brand key of the MODEL, when it differs from the provider's — an
   *  aggregator serves kimi under its own banner. Declared here, it wins over the
   *  slug-based guess the UI makes otherwise. */
  brand?: string;
  /** Pictogram chosen by the user for this model: emoji, or URL served by
   *  our own upload route (never an arbitrary URL). Wins over
   *  `brand`. */
  icon?: string;
};
