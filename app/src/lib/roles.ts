import {
  BookOpen,
  ChefHat,
  Code2,
  GitMerge,
  ScanSearch,
  Telescope,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * SINGLE SOURCE OF TRUTH for how an agent role / task type is shown anywhere
 * in the UI — missions rail, kanban tasks, agents canvas, agent-edit dropdown,
 * chat header. One picto + one colour per role.
 *
 * Built-ins (below) are hardcoded so `resolveRole` stays SYNC and SSR-safe.
 * CUSTOM roles (defined by the user via the UI, persisted server-side) are
 * hydrated into a module cache by <RolesProvider> at runtime — still resolved
 * synchronously, just from data. No async resolveRole (would flicker / break
 * hydration). Custom roles carry only `iconSvg` (captured at icon-pick time),
 * which both the React badge and the D3 canvas render identically.
 */

export type RoleKey =
  | 'coder'
  | 'reviewer'
  | 'merger'
  | 'librarian'
  | 'ops'
  | 'research'
  | 'orchestrator';

export type RoleVisual = {
  key: string;
  label: string;
  color: string;
  /** React component — built-ins only (tree-shaken). */
  icon?: LucideIcon;
  /** Inner SVG (24×24, stroke-based). Built-ins + custom. Used by the canvas
   *  and by custom-role badges (no React component available for those). */
  iconSvg?: string;
};

const BUILTIN: Record<RoleKey, { label: string; color: string; icon: LucideIcon }> = {
  coder:        { label: 'coder',        color: '#3b82f6', icon: Code2 },
  reviewer:     { label: 'reviewer',     color: '#8b5cf6', icon: ScanSearch },
  merger:       { label: 'merger',       color: '#10b981', icon: GitMerge },
  librarian:    { label: 'librarian',    color: '#ec4899', icon: BookOpen },
  ops:          { label: 'ops',          color: '#f97316', icon: Wrench },
  research:     { label: 'research',     color: '#06b6d4', icon: Telescope },
  orchestrator: { label: 'orch',         color: '#64748b', icon: ChefHat },
};

/** Inner SVG markup of each built-in icon (lucide-react v0.460), verbatim. */
const BUILTIN_SVG: Record<RoleKey, string> = {
  coder: '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
  reviewer:
    '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/>',
  merger:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  librarian:
    '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  ops:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  research:
    '<path d="m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44"/><path d="m13.56 11.747 4.332-.924"/><path d="m16 21-3.105-6.21"/><path d="M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z"/><path d="m6.158 8.633 1.114 4.456"/><path d="m8 21 3.105-6.21"/><circle cx="12" cy="13" r="2"/>',
  orchestrator:
    '<path d="M17 21a1 1 0 0 0 1-1v-5.35c0-.457.316-.844.727-1.041a4 4 0 0 0-2.134-7.589 5 5 0 0 0-9.186 0 4 4 0 0 0-2.134 7.588c.411.198.727.585.727 1.041V20a1 1 0 0 0 1 1Z"/><path d="M6 17h12"/>',
};

/** Aliases → canonical built-in key: role ids, task types, agent-name suffix. */
const ALIAS: Record<string, RoleKey> = {
  coder: 'coder', reviewer: 'reviewer', merger: 'merger', librarian: 'librarian',
  ops: 'ops', research: 'research', orchestrator: 'orchestrator',
  code: 'coder', review: 'reviewer', merge: 'merger', doc: 'librarian', chore: 'ops',
  main: 'orchestrator',
};

/** Custom roles hydrated at runtime by <RolesProvider> (keyed by lowercased id). */
const customCache = new Map<string, RoleVisual>();

/** Populate the custom-role cache from GET /api/agent-roles (custom entries only). */
export function hydrateCustomRoles(
  roles: Array<{ id: string; label: string; color: string; iconSvg: string }>,
): void {
  for (const r of roles) {
    customCache.set(r.id.toLowerCase(), {
      key: r.id,
      label: r.label,
      color: r.color,
      iconSvg: r.iconSvg,
    });
  }
}

/** Resolve a role id, task type, or agent-name suffix to its visual (sync). */
export function resolveRole(key: string | null | undefined): RoleVisual | null {
  if (!key) return null;
  const lc = key.toLowerCase();
  const canonical = ALIAS[lc];
  if (canonical) {
    const v = BUILTIN[canonical];
    return { key: canonical, label: v.label, color: v.color, icon: v.icon, iconSvg: BUILTIN_SVG[canonical] };
  }
  return customCache.get(lc) ?? null;
}

/**
 * THE SINGLE RULE for resolving an agent's role, so the same agent wears the
 * same icon everywhere (missions rail, chat header, canvas, editing).
 *
 * Only the config's role counts — it is the field the user edits and the
 * dispatcher reads. The name's suffix used to be a fallback: it forced a
 * reviewer to be called `<project>.reviewer`, and made two readings diverge
 * (the rail read the config, the header read the name, and one agent showed
 * `orch` on one side and `coder` on the other). Historical agents without a
 * role were stamped one last time on the daemon side
 * (`agent-role-backfill.ts`); the name is now only a label.
 */
export function agentRoleKey(role: string | null | undefined): string | null {
  return role && resolveRole(role) ? role : null;
}

/** Inner SVG of the role icon for a role id / task type / suffix, or ''. */
export function roleIconSvg(key: string | null | undefined): string {
  return resolveRole(key)?.iconSvg ?? '';
}
