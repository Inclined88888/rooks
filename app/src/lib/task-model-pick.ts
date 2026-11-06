/**
 * A Kanban task's LLM override seen through the ModelPicker
 * (`docs/MODEL-PICKER.md`): the form and the card chip read and write the pair
 * `backend_override` + `model_override` through these helpers, so both
 * surfaces agree on what "inherit" and a pick mean.
 */
import type { ModelPick } from '@/components/model-picker';
import { defaultModelFor, type BackendCatalog } from '@/lib/backends';
import { apiErrorMessage } from '@/lib/api-error';

export type TaskOverrides = { backend_override: string | null; model_override: string | null };

/**
 * The picker value for a task's overrides; `null` = inherit the project role.
 * Tasks written before the picker may carry only one half: a backend alone
 * runs on its default model, a model alone on the provider that lists it
 * (else the default backend). Display only: the stored half-pair is kept until
 * the user picks.
 */
export function taskModelPick(
  cat: BackendCatalog,
  backend: string | null | undefined,
  model: string | null | undefined,
): ModelPick | null {
  const b = backend?.trim() ?? '';
  const m = model?.trim() ?? '';
  if (!b && !m) return null;
  if (b) return { backend: b, model: m || defaultModelFor(cat, b) };
  const owner = cat.backends.find((e) => !e.instanceOf && e.models.some((x) => x.slug === m));
  return { backend: owner?.id ?? cat.defaultBackend ?? '', model: m };
}

/** What a pick writes: both halves, or both cleared for "inherit". */
export function taskOverrides(pick: ModelPick | null): TaskOverrides {
  return pick
    ? { backend_override: pick.backend, model_override: pick.model }
    : { backend_override: null, model_override: null };
}

/** The dispatcher owns a task once it runs; only a queued or blocked one is ours to change. */
export function canEditTaskModel(status: string | null | undefined): boolean {
  return status === 'PENDING' || status === 'BLOCKED';
}

type TaskLlmFields = TaskOverrides & {
  effective_backend?: string | null;
  effective_model?: string | null;
};

/**
 * The card as it should read before the daemon answers. "Inherit" keeps the
 * effective pair shown until the board's next read: only the server resolves
 * the project role.
 */
export function withTaskModel<T extends Partial<TaskLlmFields>>(task: T, pick: ModelPick | null): T {
  return {
    ...task,
    ...taskOverrides(pick),
    ...(pick ? { effective_backend: pick.backend, effective_model: pick.model } : {}),
  };
}

/** `PUT /api/ui/tasks/:id` with the pick's two halves; the daemon's error text on a refusal. */
export async function saveTaskModel(
  taskId: string,
  pick: ModelPick | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/ui/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(taskOverrides(pick)),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => null) as { error?: unknown } | null;
    return { ok: false, error: apiErrorMessage(body, { status: res.status }) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
