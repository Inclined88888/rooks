'use client';

/**
 * Named island arrangements, in the appearance menu, under the presets of
 * the view.
 *
 * Same home as the presets (`layout-presets-menu.tsx`) and for the same
 * reason: an arrangement is a property of the layout system, whose chrome
 * belongs to `@timon/ui-layout` (`docs/LAYOUT-PRESETS.md` §6). The two lists
 * differ in reach: a preset is every row of one kind of view, an arrangement
 * is the island workspace alone, for the whole account — it is laid on any
 * view, and it can be an entry of the main menu that opens it as a page
 * (`/islands/<id>`).
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ExternalLink, Pencil, Pin, PinOff, Plus, Save, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { t } from '@/lib/i18n';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { useIslandContentTypes } from '@/components/islands/island-content';
import {
  addArrangement,
  arrangementHref,
  removeArrangement,
  renameArrangement,
  replaceArrangement,
  setArrangementMenu,
  type ArrangementError,
  type ArrangementResult,
  type IslandArrangement,
} from '@/lib/island-arrangements';
import { mutateArrangements, useArrangements } from '@/lib/island-arrangements-store';
import { captureArrangement, recallArrangement } from '@/lib/island-arrangements-io';
import type { IslandTree } from '@/lib/island-tree';
import { MAX_NAME_LENGTH } from '@/lib/layout-presets';

const ITEM = 'flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-xs outline-none focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50';
const ICON_BUTTON = 'rounded p-1 text-muted-foreground/70 outline-none transition-colors hover:text-primary focus-visible:text-primary disabled:pointer-events-none disabled:opacity-50';
const KEY = 'appearance.menu.arrangements';

export function IslandArrangementsSection() {
  const { key, owner } = useWorkspaceLayout();
  const router = useRouter();
  const { arrangements, ready } = useArrangements(owner);
  const registered = useIslandContentTypes();
  const types = useMemo(() => new Map([...registered].map(([id, type]) => [id, type.options])), [registered]);

  // `null` = no form open, `''` = saving a new one, an id = renaming that one.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);
  // Persistent, like the presets' one: a toast would fade while its form is still open.
  const [error, setError] = useState<ArrangementError | 'capture' | null>(null);

  const closeForm = useCallback(() => { setEditing(null); setDraft(''); }, []);

  /** Runs one change of the list; `true` only once the daemon took it. */
  const commit = useCallback(async (op: (list: readonly IslandArrangement[]) => ArrangementResult): Promise<IslandArrangement | null> => {
    const out = await mutateArrangements(op);
    if (!out.ok) { setError(out.error); return null; }
    setError(null);
    return out.arrangement;
  }, []);

  /** The view's tree, or an error already on screen. */
  const capture = useCallback(async (): Promise<IslandTree | null> => {
    if (!key) return null;
    const tree = await captureArrangement(key, types);
    if (tree === null) { setError('capture'); return null; }
    if (tree === 'empty') { setError('empty-tree'); return null; }
    return tree;
  }, [key, types]);

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } finally { setBusy(false); }
  }, []);

  const onSave = () => run(async () => {
    const tree = await capture();
    if (tree && await commit((list) => addArrangement(list, draft, tree))) closeForm();
  });

  const onRename = (id: string) => run(async () => {
    if (await commit((list) => renameArrangement(list, id, draft))) closeForm();
  });

  const onOverwrite = (arrangement: IslandArrangement) => run(async () => {
    const tree = await capture();
    if (tree && await commit((list) => replaceArrangement(list, arrangement.id, tree))) {
      toast.success(t(`${KEY}.overwritten`, { name: arrangement.name }));
    }
  });

  const onMenu = (arrangement: IslandArrangement) => run(async () => {
    await commit((list) => setArrangementMenu(list, arrangement.id, !arrangement.menu));
  });

  const onDelete = (arrangement: IslandArrangement) => run(async () => {
    if (await commit((list) => removeArrangement(list, arrangement.id))) {
      toast.success(t(`${KEY}.deleted`, { name: arrangement.name }));
    }
  });

  const onRecall = (arrangement: IslandArrangement) => run(async () => {
    if (!key) return;
    // Selecting closes the menu: the failure has to outlive this section.
    if (await recallArrangement(key, arrangement, types) === 'failed') {
      toast.error(t(`${KEY}.error.recall`), { id: 'island-arrangements', duration: Infinity, closeButton: true });
    }
  });

  // No resolved view yet: nothing to save from, nothing to lay an arrangement on.
  if (!key || !owner) return null;

  const form = (onConfirm: () => void) => (
    <div className="flex items-center gap-1 px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={draft}
        maxLength={MAX_NAME_LENGTH}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
          if (e.key === 'Escape') { e.preventDefault(); closeForm(); }
        }}
        placeholder={t(`${KEY}.namePlaceholder`)}
        aria-label={t(`${KEY}.namePlaceholder`)}
        className="min-w-0 flex-1 rounded border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-primary"
      />
      <button type="button" disabled={busy} onClick={onConfirm} aria-label={t(`${KEY}.confirm`)} title={t(`${KEY}.confirm`)} className={ICON_BUTTON}>
        <Check className="size-3.5" />
      </button>
      <button type="button" onClick={closeForm} aria-label={t(`${KEY}.cancel`)} title={t(`${KEY}.cancel`)} className={ICON_BUTTON}>
        <X className="size-3.5" />
      </button>
    </div>
  );

  const action = (label: string, onClick: () => void, icon: ReactNode, pressed?: boolean) => (
    <button
      type="button"
      disabled={!ready || busy}
      onClick={onClick}
      aria-label={label}
      title={label}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      className={ICON_BUTTON}
    >
      {icon}
    </button>
  );

  return <>
    {/* Set apart by space, not by a rule (AGENTS.md rule 16). */}
    <div className="mt-2 flex items-center gap-2 px-3 py-2">
      <span className="flex-1 text-xs font-medium">{t(`${KEY}.title`)}</span>
      {arrangements.length > 0 && (
        <button
          type="button"
          onClick={() => { setManaging((on) => !on); closeForm(); }}
          aria-pressed={managing}
          aria-label={t(`${KEY}.manage`)}
          title={t(`${KEY}.manage`)}
          className={`flex items-center gap-1 rounded px-1 py-0.5 text-[11px] outline-none transition-colors focus-visible:text-primary ${managing ? 'text-primary' : 'text-muted-foreground/70 hover:text-primary'}`}
        >
          <SlidersHorizontal className="size-3.5" />
          <span>{managing ? t(`${KEY}.manageDone`) : t(`${KEY}.manageShort`)}</span>
        </button>
      )}
    </div>

    {error && (
      <p role="alert" className="px-3 pb-2 text-xs leading-snug text-destructive">
        {t(`${KEY}.error.${error}`)}
      </p>
    )}

    {managing && arrangements.length > 0 && (
      <p className="px-3 pb-1 text-[11px] leading-snug text-muted-foreground">{t(`${KEY}.manageHint`)}</p>
    )}

    {ready && arrangements.length === 0 && (
      <p className="px-3 pb-2 text-xs leading-snug text-muted-foreground">{t(`${KEY}.empty`)}</p>
    )}

    {arrangements.map((arrangement) => (
      editing === arrangement.id ? (
        <div key={arrangement.id}>{form(() => void onRename(arrangement.id))}</div>
      ) : managing ? (
        // Not menu items: a row whose click recalls cannot also rename.
        <div key={arrangement.id} className="flex items-center gap-0.5 px-3 py-1.5 text-xs">
          <span className="min-w-0 flex-1 truncate" title={arrangement.name}>{arrangement.name}</span>
          {action(t(`${KEY}.rename`, { name: arrangement.name }), () => { setError(null); setEditing(arrangement.id); setDraft(arrangement.name); }, <Pencil className="size-3.5" />)}
          {action(t(`${KEY}.overwrite`, { name: arrangement.name }), () => void onOverwrite(arrangement), <Save className="size-3.5" />)}
          {action(
            t(arrangement.menu ? `${KEY}.removeFromMenu` : `${KEY}.addToMenu`, { name: arrangement.name }),
            () => void onMenu(arrangement),
            arrangement.menu ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />,
            arrangement.menu,
          )}
          {action(t(`${KEY}.delete`, { name: arrangement.name }), () => void onDelete(arrangement), <Trash2 className="size-3.5" />)}
        </div>
      ) : (
        <div key={arrangement.id} className="flex items-center">
          <Dropdown.Item disabled={busy} onSelect={() => void onRecall(arrangement)} className={`${ITEM} min-w-0 flex-1`}>
            <span className="min-w-0 flex-1 truncate" title={arrangement.name}>{arrangement.name}</span>
            {arrangement.menu && <Pin aria-label={t(`${KEY}.inMenu`)} className="size-3 shrink-0 text-muted-foreground/70" />}
          </Dropdown.Item>
          <Dropdown.Item
            onSelect={() => router.push(arrangementHref(arrangement.id))}
            aria-label={t(`${KEY}.openPage`, { name: arrangement.name })}
            title={t(`${KEY}.openPage`, { name: arrangement.name })}
            className="cursor-pointer rounded-md p-2 text-muted-foreground/70 outline-none focus:bg-muted focus:text-primary"
          >
            <ExternalLink className="size-3.5" />
          </Dropdown.Item>
        </div>
      )
    ))}

    {editing === '' ? form(() => void onSave()) : (
      <Dropdown.Item
        disabled={!ready || busy}
        onSelect={(e) => { e.preventDefault(); setError(null); setManaging(false); setEditing(''); setDraft(''); }}
        className={ITEM}
      >
        <Plus className="size-4" />
        <span className="flex-1">{t(`${KEY}.save`)}</span>
      </Dropdown.Item>
    )}
  </>;
}
