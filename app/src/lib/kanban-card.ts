/**
 * What a Kanban card reads off a task, as pure functions: the page stays a
 * wiring layer and the counts, the model mark and the priority tone are tested
 * without a DOM.
 */
import type { BackendCatalog, CatalogBackend } from '@/lib/backends';
import { t } from '@/lib/i18n';
import { formatDate, formatTime } from '@/lib/intl';

type StatusLookup = ReadonlyMap<string, { status: string }>;

/**
 * Dependencies still to finish. The board only windows DONE tasks: every
 * unfinished task is in the list, so a dependency missing from it is done (or
 * gone) and holds nothing back.
 */
export function waitingOnCount(deps: readonly string[], byId: StatusLookup): number {
  return deps.filter((id) => {
    const task = byId.get(id);
    return task !== undefined && task.status !== 'DONE';
  }).length;
}

/** Unfinished tasks this one releases: explicit dependents and its verification chain. */
export function unblocksCount(dependents: readonly { id: string }[] | undefined, byId: StatusLookup): number {
  return (dependents ?? []).filter((link) => {
    const task = byId.get(link.id);
    return task !== undefined && task.status !== 'DONE';
  }).length;
}

/** The deps column holds a JSON array; a malformed row reads as no dependency. */
export function parseDeps(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** How long a running task has been at it: "26 min", "1 h 05". */
export function formatRunningFor(startedAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
  if (minutes < 1) return t('kanbanPage.card.runningJustNow');
  if (minutes < 60) return t('kanbanPage.card.runningMinutes', { minutes });
  const hours = Math.floor(minutes / 60);
  const rest = String(minutes % 60).padStart(2, '0');
  return t('kanbanPage.card.runningHours', { hours, minutes: rest });
}

/** The "Scheduled" line: short weekday, day and month, then the time. */
export function formatScheduled(ms: number, locale?: string): { date: string; time: string } {
  const d = new Date(ms);
  return {
    date: formatDate(d, { weekday: 'short', day: 'numeric', month: 'short' }, locale),
    time: formatTime(d, { hour: '2-digit', minute: '2-digit' }, locale),
  };
}

export type PriorityTone = 'low' | 'normal' | 'high' | 'urgent';

/** P4 stands out, P5 alarms; below P3 the label fades. */
export function priorityTone(priority: number): PriorityTone {
  if (priority >= 5) return 'urgent';
  if (priority >= 4) return 'high';
  if (priority <= 2) return 'low';
  return 'normal';
}

type TaskLlm = {
  backend_override?: string | null;
  model_override?: string | null;
  effective_backend?: string | null;
  effective_model?: string | null;
};

/** The props `BrandMark` takes, plus what the chip writes beside it. */
export type TaskModelMark = {
  /** Nothing to draw: the server returned neither backend nor model. */
  empty: boolean;
  /** No override on the task: the project role or the agent decides. */
  inherited: boolean;
  icon?: string;
  brand?: string;
  slug?: string;
  fallbackIcon?: string;
  fallbackBrand?: string;
};

function backendOf(catalog: BackendCatalog, id: string): { entry?: CatalogBackend; base?: CatalogBackend } {
  const entry = catalog.backends.find((b) => b.id === id);
  // An account instance (`claude@<id>`) inherits its provider's logo.
  const baseId = entry?.instanceOf ?? id.split('@')[0];
  const base = catalog.backends.find((b) => b.id === baseId);
  return { entry, base };
}

/**
 * The logo of the model a task ACTUALLY runs on: the model's own mark, else its
 * backend's. `BrandMark` resolves the precedence; this only gathers its inputs.
 */
export function taskModelMark(catalog: BackendCatalog, task: TaskLlm): TaskModelMark {
  const inherited = !task.backend_override && !task.model_override;
  const backendId = task.effective_backend ?? task.backend_override ?? '';
  const slug = task.effective_model ?? task.model_override ?? undefined;
  if (!backendId && !slug) return { empty: true, inherited };
  const { entry, base } = backendId ? backendOf(catalog, backendId) : {};
  const model = slug ? entry?.models.find((m) => m.slug === slug) ?? base?.models.find((m) => m.slug === slug) : undefined;
  return {
    empty: false,
    inherited,
    icon: model?.icon,
    brand: model?.brand,
    slug,
    fallbackIcon: entry?.icon ?? base?.icon,
    fallbackBrand: entry?.brand ?? base?.brand,
  };
}

/** The title of every card of the board, task or TO DO idea: one size, one weight. */
export const BOARD_CARD_TITLE_CLASS = 'text-[12.5px] leading-tight';
