/**
 * The thinking bar of a model, as every selector draws it (agent editor, chat
 * LLM menu, composer, LLM dialog, workflow node): which kind of control, and
 * the value each position sends as `reasoningEffort`.
 *
 * The kind follows what the dialect drives (`claude-thinking.ts` in the
 * orchestrator), so the bar never offers a setting that would be dropped:
 *   - a choice made by hand (`source: 'declared'`) first, a model declared as
 *     not thinking included: discovery may still list levels on the model,
 *     and they must not hide the correction;
 *   - then levels the catalogue lists for the model (`reasoningLevelsFor`) —
 *     discovered, or the Codex account's;
 *   - else the model's resolved `reasoning`: a declared or reported control
 *     first, then for a catalogue answer budget > levels > switch;
 *   - only the kinds the backend's dialect can send (`thinkingControls`,
 *     levels alone when absent);
 *   - nothing when the model does not think or nothing sets it.
 */
import { reasoningLevelsFor, type BackendCatalog, type BackendName, type ModelReasoning, type ReasoningControl } from './backends';
import { t } from './i18n';

/** A position of the bar: what it sends, what it shows. */
export type ThinkingStop = { value: string; label: string };

export type ThinkingBar = {
  type: ReasoningControl['type'];
  /** Ordered, lowest first. The model's own default (no value) is not one of
   *  them: each selector puts it first. */
  stops: ThinkingStop[];
};

/** Budget of each named step, in thinking tokens. Same values as
 *  `BUDGET_STEPS` in `orchestrator/official-providers/provider-claude/lib/thinking.js`. */
export const BUDGET_STEPS = { low: 2_000, medium: 8_000, high: 32_000 } as const;
/** The Claude CLI raises any smaller budget to this. */
const MIN_BUDGET = 1_024;

const BUDGET_LABEL_KEY: Record<keyof typeof BUDGET_STEPS, string> = {
  low: 'thinking.budgetLow',
  medium: 'thinking.budgetMedium',
  high: 'thinking.budgetHigh',
};

/** Low / medium / high, each sending its budget clamped to the model's
 *  bounds. Steps that the bounds merge into one value are shown once. */
export function budgetStops(control: { min?: number; max?: number }): ThinkingStop[] {
  const floor = Math.max(MIN_BUDGET, control.min ?? 0);
  const stops: ThinkingStop[] = [];
  for (const step of Object.keys(BUDGET_STEPS) as (keyof typeof BUDGET_STEPS)[]) {
    const raw = Math.max(floor, BUDGET_STEPS[step]);
    const value = String(control.max !== undefined ? Math.min(raw, Math.max(control.max, floor)) : raw);
    if (stops.some((stop) => stop.value === value)) continue;
    stops.push({ value, label: t(BUDGET_LABEL_KEY[step]) });
  }
  return stops;
}

function barOf(control: ReasoningControl): ThinkingBar | null {
  if (control.type === 'levels') {
    return control.values.length ? { type: 'levels', stops: control.values.map((value) => ({ value, label: value })) } : null;
  }
  if (control.type === 'budget') return { type: 'budget', stops: budgetStops(control) };
  return { type: 'toggle', stops: [{ value: 'off', label: t('thinking.off') }, { value: 'on', label: t('thinking.on') }] };
}

const DECLARED_ORDER: ReasoningControl['type'][] = ['levels', 'budget', 'toggle'];
const CATALOG_ORDER: ReasoningControl['type'][] = ['budget', 'levels', 'toggle'];

/** The control of `reasoning` the bar is drawn from, among the kinds the
 *  dialect sends (`allowed`, levels alone when absent), or null. */
export function pickControl(reasoning: ModelReasoning | undefined, allowed: readonly ReasoningControl['type'][] = ['levels']): ReasoningControl | null {
  if (!reasoning?.thinks) return null;
  const order = reasoning.source === 'catalog' ? CATALOG_ORDER : DECLARED_ORDER;
  for (const type of order) {
    if (!allowed.includes(type)) continue;
    const control = reasoning.controls.find((item) => item.type === type);
    if (control && (control.type !== 'levels' || control.values.length)) return control;
  }
  return null;
}

/** The bar of `model` on `backend`, or null when there is nothing to set. */
export function thinkingBarFor(cat: BackendCatalog, backend: BackendName, model: string): ThinkingBar | null {
  const entry = cat.backends.find((item) => item.id === backend);
  const reasoning = entry?.models.find((item) => item.slug === model)?.reasoning;
  if (entry && reasoning?.source === 'declared') {
    const declared = pickControl(reasoning, entry.thinkingControls);
    return declared ? barOf(declared) : null;
  }
  const levels = reasoningLevelsFor(cat, backend, model);
  if (levels.length) return { type: 'levels', stops: levels.map((value) => ({ value, label: value })) };
  const control = entry ? pickControl(reasoning, entry.thinkingControls) : null;
  return control ? barOf(control) : null;
}

/** The values the bar can send, for the "does the new model still take this
 *  value?" checks of a model switch. */
export function thinkingValues(bar: ThinkingBar | null): string[] {
  return bar?.stops.map((stop) => stop.value) ?? [];
}

/** What to show for `value` on this bar, or null when it has no position. */
export function thinkingLabel(bar: ThinkingBar | null, value: string | null | undefined): string | null {
  if (!value) return null;
  return bar?.stops.find((stop) => stop.value === value)?.label ?? null;
}
