/**
 * Reading a model list out of what a CLI or an endpoint answers. A leaf of the
 * backends module, moved verbatim out of `dialects/copilot-models.ts`.
 */

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The values of a select option's choices. A choice may itself be a group
 *  (`{ group, name, options: [...] }`) — an agent that serves several providers
 *  files its models by provider — so nested choices are read too, one level. */
function collectChoices(choices: unknown, into: string[], depth = 0): void {
  for (const choice of Array.isArray(choices) ? choices : []) {
    const c = asRecord(choice);
    if (!c) continue;
    if (typeof c.value === 'string' && c.value.length > 0) into.push(c.value);
    else if (depth === 0) collectChoices(c.options, into, 1);
  }
}

/**
 * Model ids from a `session/new` result. Two shapes, read in turn: the ACP
 * `models.availableModels[].modelId` of the session-model extension, and the
 * newer `configOptions` whose `model` category lists its `options[].value`.
 */
export function modelIdsFromSessionNew(result: unknown): string[] {
  const r = asRecord(result);
  if (!r) return [];
  const ids: string[] = [];
  const available = asRecord(r.models)?.availableModels;
  if (Array.isArray(available)) {
    for (const m of available) {
      const id = asRecord(m)?.modelId;
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
  }
  if (ids.length === 0 && Array.isArray(r.configOptions)) {
    for (const opt of r.configOptions) {
      const o = asRecord(opt);
      if (!o || (o.category !== 'model' && o.id !== 'model')) continue;
      collectChoices(o.options, ids);
    }
  }
  return [...new Set(ids)];
}

/**
 * `Dialect.discoverModels` may answer plain ids or `{ slug, … }` objects; this
 * is the one reading of both, dropping what has no usable slug. (The catalogue
 * treats an empty answer as a failure, so a provider whose probe finds nothing
 * should reject rather than resolve `[]`.)
 */
export function normalizeDiscoveredModels(
  found: ReadonlyArray<string | { slug: string; supportedReasoningLevels?: string[] }>,
): Array<{ slug: string; supportedReasoningLevels?: string[] }> {
  return found
    .map((m) => (typeof m === 'string' ? { slug: m } : m))
    .filter((m) => typeof m.slug === 'string' && m.slug.length > 0);
}

/** The ids of an OpenAI-style `GET /models` body (`{ data: [{ id }] }`). Rejects
 *  a body of another shape or an empty list, as the catalogue's own fetch does. */
export function modelIdsFromList(body: unknown): string[] {
  const data = asRecord(body)?.data;
  if (!Array.isArray(data)) throw new Error('response without a `data` array');
  const ids = data
    .map((m) => asRecord(m)?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) throw new Error('no model in the response');
  return ids;
}
