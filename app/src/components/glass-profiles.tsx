'use client';

import { useMemo, useState, type ReactElement } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, Pencil, Save, Sparkles, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useStoredLayout } from '@/hooks/use-stored-layout';
import { t } from '@/lib/i18n';
import { loadLayout, saveLayout } from '@/lib/ui-layout-store';
import { cn } from '@/lib/utils';
import {
  GLASS_PROFILES_SCOPE, MAX_GLASS_PROFILES, MAX_GLASS_PROFILE_NAME,
  editGlassProfiles, glassSettingsOf, newProfileId, readGlassProfiles, sameGlassSettings, writeGlassProfiles,
  type GlassProfile, type GlassSettings, type ProfileEdit,
} from '@/lib/glass-profiles';
import {
  APPEARANCE_EVENT, APPEARANCE_SCOPE, applyGlassAttributes, readNativeAppearance, type NativeAppearance,
} from '@/plugins-client/ui-theme-variants';

/** The saved glass profiles of the account, and one way to edit them. */
export function useGlassProfiles(): { profiles: GlassProfile[]; ready: boolean; edit: (edit: ProfileEdit) => Promise<boolean> } {
  const stored = useStoredLayout(GLASS_PROFILES_SCOPE);
  const profiles = useMemo(() => readGlassProfiles(stored.raw), [stored.raw]);
  const edit = async (change: ProfileEdit) => {
    let refused = false;
    const ok = await stored.update((raw: unknown) => {
      const next = editGlassProfiles(readGlassProfiles(raw), change);
      if (!next) { refused = true; return raw; }
      return writeGlassProfiles(next);
    });
    return ok && !refused;
  };
  return { profiles, ready: stored.ready, edit };
}

/**
 * Writes a profile into the Appearance row from outside the Appearance screen
 * (the Customize interface menu): read the row, lay the glass fields over it,
 * write it whole, then tell the theme and `<html>` — what the screen does for
 * its own changes. The screen, when open, follows the same event.
 */
export async function applyGlassSettings(settings: GlassSettings): Promise<boolean> {
  const out = await loadLayout({ scope: APPEARANCE_SCOPE, storage: null });
  if (!out.ok) return false;
  const next: NativeAppearance = { ...readNativeAppearance(out.raw), ...settings };
  if (!await saveLayout(next, { scope: APPEARANCE_SCOPE, storage: null })) return false;
  window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: next }));
  applyGlassAttributes(next);
  return true;
}

const ICON_BUTTON = 'rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50';
const FIELD = 'min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-[13px] outline-none focus:border-primary';

function NameForm({ initial, busy, onConfirm, onCancel, label }: { initial: string; busy: boolean; onConfirm: (name: string) => void; onCancel?: () => void; label: string }): ReactElement {
  const [name, setName] = useState(initial);
  return (
    <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onConfirm(name); }}>
      <input value={name} maxLength={MAX_GLASS_PROFILE_NAME} onChange={(e) => setName(e.target.value)} placeholder={t('appearance.glassProfiles.namePlaceholder')} aria-label={t('appearance.glassProfiles.namePlaceholder')} className={FIELD} autoFocus={!!onCancel} />
      <button type="submit" disabled={busy || !name.trim()} className="rounded-md border border-border px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60">{label}</button>
      {onCancel && <button type="button" onClick={onCancel} aria-label={t('appearance.glassProfiles.cancel')} title={t('appearance.glassProfiles.cancel')} className={ICON_BUTTON}><X className="size-3.5" /></button>}
    </form>
  );
}

/**
 * Saved glass profiles on the Appearance screen: apply, rename, overwrite with
 * the current glass, delete, and save the current glass under a new name.
 * `onApply` goes through the screen's own write, so the row stays whole.
 */
export function GlassProfilesSection({ native, onApply }: { native: NativeAppearance; onApply: (settings: GlassSettings) => void }): ReactElement {
  const { profiles, ready, edit } = useGlassProfiles();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = glassSettingsOf(native);
  const run = async (change: ProfileEdit, done?: () => void) => {
    setBusy(true);
    const ok = await edit(change);
    setBusy(false);
    if (!ok) { toast.error(t('appearance.glassProfiles.saveError')); return; }
    done?.();
  };
  return (
    <div className="mt-6">
      <span className="text-[13px] font-medium leading-snug">{t('appearance.glassProfiles.title')}</span>
      <p className="mt-0.5 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('appearance.glassProfiles.hint')}</p>
      <div className="mt-3 flex max-w-xl flex-col gap-0.5">
        {ready && profiles.length === 0 && <p className="text-[12px] text-muted-foreground">{t('appearance.glassProfiles.empty')}</p>}
        {profiles.map((profile) => {
          const active = sameGlassSettings(profile.settings, current);
          if (renaming === profile.id) {
            return <div key={profile.id} className="px-2 py-1"><NameForm initial={profile.name} busy={busy} label={t('appearance.glassProfiles.rename')} onCancel={() => setRenaming(null)} onConfirm={(name) => void run({ kind: 'rename', id: profile.id, name }, () => setRenaming(null))} /></div>;
          }
          if (confirmDelete === profile.id) {
            return (
              <div key={profile.id} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px]">
                <span className="min-w-0 flex-1">{t('appearance.glassProfiles.deleteConfirm', { name: profile.name })}</span>
                <button type="button" disabled={busy} onClick={() => void run({ kind: 'remove', id: profile.id }, () => setConfirmDelete(null))} aria-label={t('appearance.glassProfiles.delete', { name: profile.name })} className={cn(ICON_BUTTON, 'text-destructive hover:text-destructive')}><Check className="size-3.5" /></button>
                <button type="button" onClick={() => setConfirmDelete(null)} aria-label={t('appearance.glassProfiles.cancel')} className={ICON_BUTTON}><X className="size-3.5" /></button>
              </div>
            );
          }
          return (
            <div key={profile.id} data-glass-profile={profile.id} className={cn('group flex items-center gap-1 rounded-lg px-2 py-1 text-[13px]', active ? 'bg-foreground/[0.08]' : 'hover:bg-foreground/[0.05]')}>
              <button type="button" onClick={() => onApply(profile.settings)} className={cn('flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left', active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')} title={t('appearance.glassProfiles.apply', { name: profile.name })}>
                <span className="flex size-3.5 shrink-0 items-center justify-center">{active && <Check className="size-3.5 text-primary" />}</span>
                <span className="truncate">{profile.name}</span>
              </button>
              <button type="button" disabled={busy} onClick={() => setRenaming(profile.id)} aria-label={t('appearance.glassProfiles.renameOne', { name: profile.name })} title={t('appearance.glassProfiles.renameOne', { name: profile.name })} className={ICON_BUTTON}><Pencil className="size-3.5" /></button>
              <button type="button" disabled={busy || active} onClick={() => void run({ kind: 'overwrite', id: profile.id, settings: current }, () => toast.success(t('appearance.glassProfiles.overwritten', { name: profile.name })))} aria-label={t('appearance.glassProfiles.overwrite', { name: profile.name })} title={t('appearance.glassProfiles.overwrite', { name: profile.name })} className={ICON_BUTTON}><Save className="size-3.5" /></button>
              <button type="button" disabled={busy} onClick={() => setConfirmDelete(profile.id)} aria-label={t('appearance.glassProfiles.delete', { name: profile.name })} title={t('appearance.glassProfiles.delete', { name: profile.name })} className={ICON_BUTTON}><Trash2 className="size-3.5" /></button>
            </div>
          );
        })}
        {profiles.length < MAX_GLASS_PROFILES && <div className="mt-2">
          <NameForm key={profiles.length} initial="" busy={busy || !ready} label={t('appearance.glassProfiles.save')} onConfirm={(name) => void run({ kind: 'add', id: newProfileId(), name, settings: current })} />
        </div>}
      </div>
    </div>
  );
}

/** Same look as the menu's own items (`theme-toggle.tsx`). */
const MENU_ITEM = 'flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-xs outline-none focus:bg-muted';

/** The saved glass profiles in the Customize interface menu, one click to apply; nothing when none is saved. */
export function GlassProfilesMenuSection(): ReactElement | null {
  const { profiles } = useGlassProfiles();
  if (profiles.length === 0) return null;
  return (
    <>
      <Dropdown.Label className="mt-2 px-3 py-2 text-xs font-medium">{t('appearance.glassProfiles.title')}</Dropdown.Label>
      {profiles.map((profile) => (
        <Dropdown.Item
          key={profile.id}
          data-glass-profile-item={profile.id}
          className={MENU_ITEM}
          onSelect={() => { void applyGlassSettings(profile.settings).then((ok) => { if (!ok) toast.error(t('appearance.glassProfiles.saveError')); }); }}
        >
          <Sparkles className="size-4" /><span className="min-w-0 flex-1 truncate">{profile.name}</span>
        </Dropdown.Item>
      ))}
    </>
  );
}
