/**
 * Saved multichat setups: a grid size and which agent sits in which cell.
 *
 * A template recalls the agents, never the conversations. A mission is the
 * state of one day's work; the setup is what comes back every day, and a
 * template that reopened last week's missions would have to be fixed by hand
 * each time it is used — the very gesture it exists to remove.
 *
 * Stored by the daemon under one account-scoped row (`/api/layout`), so the
 * list follows the user across browsers and the desktop client instead of
 * living in one browser's `localStorage` like the grid itself.
 *
 * Every function here is pure and takes the stored JSON as an opaque value: a
 * row written by an older build must degrade to "no template" rather than
 * throw inside a dropdown.
 */

import { MAX_NAME_LENGTH, MAX_PRESETS_BYTES, normaliseName, sameName } from './layout-presets';

/** Scope of the row. Fixed rather than derived from the workspace key: the
 *  multichat has one grid per account, whatever project is selected. */
export const TEMPLATES_SCOPE = 'multichat.templates';

export const MAX_TEMPLATES = 20;
export { MAX_NAME_LENGTH };

/** The multichat's own bounds (`decodeUrl` in `multichat-client.tsx`). */
const MIN_SIDE = 1;
const MAX_SIDE = 4;

export type MultichatGrid = {
  cols: number;
  rows: number;
  /** One entry per cell, row by row; `null` is an empty cell. */
  agents: (string | null)[];
};

export type MultichatTemplate = MultichatGrid & {
  id: string;
  name: string;
  createdAt: number;
};

type Stored = { v: 1; templates: MultichatTemplate[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function side(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= MIN_SIDE && value <= MAX_SIDE ? value : null;
}

/**
 * The cells of a grid, padded or cut to its size.
 *
 * An agent appears once at most: the multichat swaps an agent dropped on a
 * second cell rather than duplicating it, and two cells bound to the same
 * agent would open the same conversation twice.
 */
export function normaliseGrid(cols: number, rows: number, agents: readonly unknown[]): MultichatGrid {
  const out: (string | null)[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < cols * rows; i++) {
    const a = agents[i];
    if (typeof a === 'string' && a !== '' && !seen.has(a)) {
      seen.add(a);
      out.push(a);
    } else {
      out.push(null);
    }
  }
  return { cols, rows, agents: out };
}

function readTemplate(value: unknown): MultichatTemplate | null {
  if (!isRecord(value)) return null;
  const { id, name, createdAt, agents } = value;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof name !== 'string' || name.trim() === '') return null;
  const cols = side(value.cols);
  const rows = side(value.rows);
  if (cols === null || rows === null || !Array.isArray(agents)) return null;
  return {
    id,
    name,
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
    ...normaliseGrid(cols, rows, agents),
  };
}

/** The saved templates, in the order they were saved. A corrupted entry is
 *  dropped alone; a duplicate id keeps the first. */
export function readTemplates(raw: unknown): MultichatTemplate[] {
  const list = isRecord(raw) && Array.isArray(raw.templates) ? raw.templates : [];
  const out: MultichatTemplate[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const template = readTemplate(entry);
    if (!template || seen.has(template.id)) continue;
    seen.add(template.id);
    out.push(template);
  }
  return out;
}

export function writeTemplates(templates: readonly MultichatTemplate[]): Stored {
  return { v: 1, templates: [...templates] };
}

/** Measured the way the daemon measures a layout row (`JSON.stringify` of the
 *  value, UTF-8), against the same cap. */
export function fitsTemplates(templates: readonly MultichatTemplate[]): boolean {
  return new TextEncoder().encode(JSON.stringify(writeTemplates(templates))).length <= MAX_PRESETS_BYTES;
}

/** Whether the grid on screen is this template: same size, same agent in each
 *  cell. Drives the check mark in the menu. */
export function matchesTemplate(template: MultichatGrid, grid: MultichatGrid): boolean {
  if (template.cols !== grid.cols || template.rows !== grid.rows) return false;
  const current = normaliseGrid(grid.cols, grid.rows, grid.agents).agents;
  return template.agents.every((a, i) => a === current[i]);
}

/**
 * The agents a recall puts on screen.
 *
 * An agent deleted since the template was saved leaves its cell empty rather
 * than a slot bound to a name nothing answers to. `known` is `null` while the
 * agent list has not loaded, in which case every name is kept: emptying the
 * grid because a request is still on the wire would be worse.
 */
export function recallAgents(
  template: MultichatGrid,
  known: ReadonlySet<string> | null,
): (string | null)[] {
  return template.agents.map((a) => (a !== null && (known === null || known.has(a)) ? a : null));
}

/**
 * The cells after a recall: each recalled agent keeps the conversation it
 * already had on screen, the others open on a fresh one.
 */
export function slotsForRecall<S extends { agentName: string | null; missionId: string | null }>(
  prev: readonly S[],
  names: readonly (string | null)[],
): (S | { agentName: string | null; missionId: null })[] {
  return names.map((agentName) => {
    if (!agentName) return { agentName: null, missionId: null };
    return prev.find((s) => s.agentName === agentName) ?? { agentName, missionId: null };
  });
}

/** `crypto.randomUUID` is not offered on a plain-HTTP origin outside
 *  localhost, and a template must still be savable there. */
function newId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export type TemplateError =
  | 'empty-name'
  | 'duplicate-name'
  | 'too-many'
  | 'too-large'
  | 'empty-grid'
  | 'unknown'
  /** The daemon did not take the row: nothing is wrong with the request. */
  | 'write-failed';

export type TemplateResult =
  | { ok: true; templates: MultichatTemplate[]; template: MultichatTemplate }
  | { ok: false; error: TemplateError };

function done(templates: MultichatTemplate[], template: MultichatTemplate): TemplateResult {
  return fitsTemplates(templates) ? { ok: true, templates, template } : { ok: false, error: 'too-large' };
}

export function addTemplate(
  templates: readonly MultichatTemplate[],
  rawName: string,
  grid: MultichatGrid,
  now: number = Date.now(),
): TemplateResult {
  const name = normaliseName(rawName);
  if (name === '') return { ok: false, error: 'empty-name' };
  const cells = normaliseGrid(grid.cols, grid.rows, grid.agents);
  // A template with no agent recalls nothing a layout button would not.
  if (cells.agents.every((a) => a === null)) return { ok: false, error: 'empty-grid' };
  if (templates.some((t) => sameName(t.name, name))) return { ok: false, error: 'duplicate-name' };
  if (templates.length >= MAX_TEMPLATES) return { ok: false, error: 'too-many' };
  const template: MultichatTemplate = { id: newId(), name, createdAt: now, ...cells };
  return done([...templates, template], template);
}

export function renameTemplate(
  templates: readonly MultichatTemplate[],
  id: string,
  rawName: string,
): TemplateResult {
  const name = normaliseName(rawName);
  if (name === '') return { ok: false, error: 'empty-name' };
  const index = templates.findIndex((t) => t.id === id);
  const current = templates[index];
  if (!current) return { ok: false, error: 'unknown' };
  if (templates.some((t) => t.id !== id && sameName(t.name, name))) {
    return { ok: false, error: 'duplicate-name' };
  }
  const template: MultichatTemplate = { ...current, name };
  const out = [...templates];
  out[index] = template;
  return done(out, template);
}

/** Overwrites a template's grid, keeping its name, id and place in the list:
 *  the user is correcting an entry, not adding one at the end. */
export function replaceTemplate(
  templates: readonly MultichatTemplate[],
  id: string,
  grid: MultichatGrid,
): TemplateResult {
  const index = templates.findIndex((t) => t.id === id);
  const current = templates[index];
  if (!current) return { ok: false, error: 'unknown' };
  const cells = normaliseGrid(grid.cols, grid.rows, grid.agents);
  if (cells.agents.every((a) => a === null)) return { ok: false, error: 'empty-grid' };
  const template: MultichatTemplate = { ...current, ...cells };
  const out = [...templates];
  out[index] = template;
  return done(out, template);
}

export function removeTemplate(templates: readonly MultichatTemplate[], id: string): MultichatTemplate[] {
  return templates.filter((t) => t.id !== id);
}
