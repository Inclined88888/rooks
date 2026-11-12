/**
 * Glass profiles: the whole glass look under a name (Settings → Appearance,
 * the Customize interface menu). A profile holds every glass field of the
 * native Appearance row — the two switches, the scope, the general tuning,
 * each zone's and the readability floor — and applying one writes them back
 * into that row, so the theme paints it like any other change.
 *
 * Pure data: no React, no fetch. The row is `{ profiles: [...] }` under
 * `GLASS_PROFILES_SCOPE`, read without trust like every layout row.
 */
import { readNativeAppearance, type NativeAppearance } from '@/plugins-client/ui-theme-variants';

export const GLASS_PROFILES_SCOPE = 'appearance.glass-profiles';
export const MAX_GLASS_PROFILES = 24;
export const MAX_GLASS_PROFILE_NAME = 60;

export const GLASS_SETTING_FIELDS = ['glass', 'glassBubbles', 'glassScope', 'glassBlur', 'glassTransparency', 'glassTint', 'glassZones', 'glassFloor'] as const;
export type GlassSettings = Pick<NativeAppearance, typeof GLASS_SETTING_FIELDS[number]>;
export type GlassProfile = { id: string; name: string; settings: GlassSettings };

export function glassSettingsOf(appearance: NativeAppearance): GlassSettings {
  const out = {} as Record<string, unknown>;
  for (const field of GLASS_SETTING_FIELDS) out[field] = appearance[field];
  return out as GlassSettings;
}

/** Field by field through the Appearance reader: a profile saved by an older build reads with today's defaults. */
function readSettings(raw: unknown): GlassSettings {
  return glassSettingsOf(readNativeAppearance(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}));
}

export function cleanProfileName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_GLASS_PROFILE_NAME);
}

export function readGlassProfiles(raw: unknown): GlassProfile[] {
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { profiles?: unknown }).profiles : null;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: GlassProfile[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { id, name, settings } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !id || seen.has(id) || typeof name !== 'string') continue;
    const clean = cleanProfileName(name);
    if (!clean) continue;
    seen.add(id);
    out.push({ id, name: clean, settings: readSettings(settings) });
    if (out.length >= MAX_GLASS_PROFILES) break;
  }
  return out;
}

export function writeGlassProfiles(profiles: readonly GlassProfile[]): { profiles: GlassProfile[] } {
  return { profiles: profiles.slice(0, MAX_GLASS_PROFILES).map((p) => ({ id: p.id, name: p.name, settings: p.settings })) };
}

/** Key order and absent zones do not tell two looks apart. */
export function sameGlassSettings(a: GlassSettings, b: GlassSettings): boolean {
  const norm = (s: GlassSettings) => JSON.stringify(GLASS_SETTING_FIELDS.map((field) => (
    field === 'glassZones'
      ? Object.entries(s.glassZones).sort(([x], [y]) => x.localeCompare(y)).map(([zone, tuning]) => [zone, tuning?.blur, tuning?.transparency, tuning?.tint])
      : s[field]
  )));
  return norm(a) === norm(b);
}

/** `crypto.randomUUID` only exists in a secure context; a LAN address over http is not one. */
export function newProfileId(): string {
  return `gp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export type ProfileEdit =
  | { kind: 'add'; id: string; name: string; settings: GlassSettings }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'overwrite'; id: string; settings: GlassSettings }
  | { kind: 'remove'; id: string };

/** One edit of the list; `null` when it would change nothing or break a limit (empty name, full list). */
export function editGlassProfiles(profiles: readonly GlassProfile[], edit: ProfileEdit): GlassProfile[] | null {
  switch (edit.kind) {
    case 'add': {
      const name = cleanProfileName(edit.name);
      if (!name || profiles.length >= MAX_GLASS_PROFILES) return null;
      return [...profiles, { id: edit.id, name, settings: edit.settings }];
    }
    case 'rename': {
      const name = cleanProfileName(edit.name);
      if (!name || !profiles.some((p) => p.id === edit.id)) return null;
      return profiles.map((p) => (p.id === edit.id ? { ...p, name } : p));
    }
    case 'overwrite':
      if (!profiles.some((p) => p.id === edit.id)) return null;
      return profiles.map((p) => (p.id === edit.id ? { ...p, settings: edit.settings } : p));
    case 'remove':
      return profiles.some((p) => p.id === edit.id) ? profiles.filter((p) => p.id !== edit.id) : null;
  }
}
