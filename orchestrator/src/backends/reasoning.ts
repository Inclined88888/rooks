/**
 * How a model's thinking is set, resolved from the best source available.
 *
 * Thinking is driven by one of three mechanisms that belong to the MODEL, not to
 * the provider: graded levels (`effort`: Claude 4.6+, GPT, Grok), a token budget
 * (Qwen `thinking_budget`, Gemini 2.5, classic Claude `budget_tokens`), or an
 * on/off switch (Qwen `enable_thinking`, DeepSeek V4, older GLM). A model may
 * offer several. The resolution says which, with their values, instead of a bare
 * list of levels.
 *
 * Order, first answer wins:
 *   (a) declared — the levels a profile or the user wrote on the model, or the
 *       control the user picked by hand (budget, switch, no thinking at all);
 *   (b) agent — the levels the agent itself reported (ACP config, discovery,
 *       the Codex account's model cache);
 *   (c) catalog — the embedded models.dev snapshot (`reasoning-catalog.ts`),
 *       consulted only when the caller allows it (custom providers);
 *   (d) nothing.
 *
 * The result is information. A catalogue answer (c) never feeds
 * `supportedReasoningLevels`: that field is what makes the agent editor show a
 * slider and the dialect send a level, and a catalogue entry is not proof that
 * THIS endpoint honours it. Levels from (a) and (b) already sit there.
 */

import { lookupCatalogReasoning, type CatalogOption } from './reasoning-catalog.js';
import type { BackendProfile } from './types.js';

export type { DeclaredReasoningControl, ModelReasoning, ReasoningControl } from './reasoning-control.js';
import type { DeclaredReasoningControl, ModelReasoning, ReasoningControl } from './reasoning-control.js';

function controlOf(option: CatalogOption): ReasoningControl | null {
  if (option.type === 'toggle') return { type: 'toggle' };
  if (option.type === 'effort') return option.values.length ? { type: 'levels', values: [...option.values] } : null;
  return {
    type: 'budget',
    ...(option.min !== undefined ? { min: option.min } : {}),
    ...(option.max !== undefined ? { max: option.max } : {}),
  };
}

function fromDeclaredControl(control: DeclaredReasoningControl): ModelReasoning {
  if (control.type === 'none') return { source: 'declared', thinks: false, controls: [] };
  if (control.type === 'toggle') return { source: 'declared', thinks: true, controls: [{ type: 'toggle' }] };
  return {
    source: 'declared',
    thinks: true,
    controls: [{
      type: 'budget',
      ...(control.min !== undefined ? { min: control.min } : {}),
      ...(control.max !== undefined ? { max: control.max } : {}),
    }],
  };
}

function fromLevels(source: 'declared' | 'agent', levels: readonly string[]): ModelReasoning {
  return { source, thinks: true, controls: levels.length ? [{ type: 'levels', values: [...levels] }] : [] };
}

export type ReasoningSources = {
  slug: string;
  /** (a) Levels the profile or the user declared on the model. Empty counts as
   *  nothing declared: the form saves an emptied list as no declaration, and
   *  the agent editor treats both alike. */
  declaredLevels?: readonly string[];
  /** (a) The control declared by hand. Declared levels win over it: a file
   *  that carries both was written by hand, and levels are what the dialects
   *  already send. */
  declaredControl?: DeclaredReasoningControl;
  /** (b) Levels the agent reported for the model. Empty is an answer, not a
   *  silence: the source says it offers no level (an Anthropic listing that
   *  marks effort unsupported). It stops the resolution so the catalogue
   *  cannot contradict the endpoint; whether the model thinks is not what it
   *  answered, hence `thinks` with nothing to set. */
  agentLevels?: readonly string[];
  /** (c) Consult the catalogue, with the provider's base URL when known so a
   *  listed host answers before the lab. Absent: no catalogue lookup. */
  catalog?: { baseUrl?: string | null };
};

/** The thinking controls of a model, or undefined when no source knows them. */
export function resolveModelReasoning(sources: ReasoningSources): ModelReasoning | undefined {
  if (sources.declaredLevels?.length) return fromLevels('declared', sources.declaredLevels);
  if (sources.declaredControl) return fromDeclaredControl(sources.declaredControl);
  if (sources.agentLevels) return fromLevels('agent', sources.agentLevels);
  if (!sources.catalog) return undefined;
  const found = lookupCatalogReasoning(sources.slug, sources.catalog.baseUrl);
  if (!found) return undefined;
  if (!found.options) return { source: 'catalog', thinks: false, controls: [], catalogEntry: found.entry };
  const controls = found.options.map(controlOf).filter((control): control is ReasoningControl => control !== null);
  return { source: 'catalog', thinks: true, controls, catalogEntry: found.entry };
}

/**
 * Where a custom profile sends its requests: the provider block of the `codex`
 * dialect, or the Anthropic base URL of the `claude` one. Null when the profile
 * names neither (a first-party CLI, a plugin resolving its env at spawn).
 */
export function profileBaseUrl(profile: Pick<BackendProfile, 'env' | 'providerConfig'>): string | null {
  const anthropic = profile.env?.['ANTHROPIC_BASE_URL'];
  return profile.providerConfig?.baseUrl ?? (typeof anthropic === 'string' ? anthropic : null);
}
