'use client';

/**
 * Emoji picker — a real dropdown: every Unicode emoji, by category, searchable.
 *
 * The list lives in `lib/emoji-data.ts` (generated, ~75 KB) and is pulled with
 * a dynamic import when the panel first opens, so a page that never shows the
 * picker never pays for it.
 *
 * The panel is plain absolute positioning rather than a Radix popover: it is
 * mounted inside a Radix dialog in its only caller today, and nesting two
 * focus-trapping primitives is how a search field stops receiving keystrokes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Smile } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { t } from '@/lib/i18n';
import type { EmojiEntry, EmojiGroup } from '@/lib/emoji-data';
import { EMOJI_GROUP_KEYS, EMOJI_GROUP_TABS, searchEmojis } from '@/lib/emoji-search';

function groupLabel(name: string): string {
  const key = EMOJI_GROUP_KEYS[name];
  return key ? t(`emojiPicker.groups.${key}`) : name;
}

export type EmojiPickerProps = {
  onPick: (emoji: string) => void;
  disabled?: boolean;
  /** Extra classes for the trigger button. */
  className?: string;
  /** Makes the trigger icon-only; this text becomes its tooltip and
   *  `aria-label`. */
  iconLabel?: string;
  /** Which edge of the trigger the list lines up with — `end` for a trigger
   *  near the right edge of a narrow container. */
  align?: 'start' | 'end';
};

export function EmojiPicker({ onPick, disabled, className, iconLabel, align = 'start' }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click outside and Escape close the panel; without this a picker opened in
  // a dialog stays on screen under the next click.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        variant={iconLabel ? 'ghost' : 'outline'}
        size={iconLabel ? 'icon' : 'sm'}
        className={`gap-1.5 ${className ?? ''}`}
        disabled={disabled}
        title={iconLabel}
        aria-label={iconLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <Smile className="size-3.5" />
        {iconLabel ? null : t('emojiPicker.trigger')}
      </Button>
      {open && (
        <EmojiPanel
          align={align}
          onPick={(emoji) => {
            onPick(emoji);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function EmojiPanel({ onPick, align }: { onPick: (emoji: string) => void; align: 'start' | 'end' }) {
  const [groups, setGroups] = useState<readonly EmojiGroup[] | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(null);
  // ~1900 buttons is a visible hitch if they all mount in the opening frame.
  // The first category is enough to paint; the rest follows one frame later.
  const [full, setFull] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void import('@/lib/emoji-data').then((m) => {
      if (cancelled) return;
      setGroups(m.EMOJI_GROUPS);
      setActive(m.EMOJI_GROUPS[0]?.name ?? null);
      requestAnimationFrame(() => {
        if (!cancelled) setFull(true);
      });
    });
    searchRef.current?.focus();
    return () => {
      cancelled = true;
    };
  }, []);

  // `null` = no search in progress, so the categorized list stays on screen.
  const results = useMemo(
    () => (groups && query.trim() ? searchEmojis(groups, query) : null),
    [groups, query],
  );

  const scrollToGroup = useCallback((name: string) => {
    setActive(name);
    const section = listRef.current?.querySelector<HTMLElement>(
      `[data-group="${CSS.escape(name)}"]`,
    );
    if (section && listRef.current) {
      listRef.current.scrollTop = section.offsetTop - listRef.current.offsetTop;
    }
  }, []);

  return (
    <div
      role="dialog"
      aria-label={t('emojiPicker.title')}
      className={`absolute ${align === 'end' ? 'right-0' : 'left-0'} top-[calc(100%+6px)] z-50 w-[min(320px,calc(100vw-2rem))] rounded-md border border-border bg-popover p-2 shadow-elev-3`}
    >
      <Input
        ref={searchRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('emojiPicker.search')}
        className="h-8 text-xs"
        onKeyDown={(e) => {
          // Enter takes the first match — the fast path when you know the name.
          const first = results?.[0];
          if (e.key === 'Enter' && first) {
            e.preventDefault();
            onPick(first[0]);
          }
        }}
      />
      {!results && groups && (
        <div className="mt-2 flex items-center justify-between gap-0.5">
          {groups.map((group) => (
            <button
              key={group.name}
              type="button"
              title={groupLabel(group.name)}
              aria-label={groupLabel(group.name)}
              onClick={() => scrollToGroup(group.name)}
              className={`grid size-7 place-items-center rounded text-[15px] transition-colors hover:bg-muted ${
                active === group.name ? 'bg-muted' : ''
              }`}
            >
              {EMOJI_GROUP_TABS[group.name] ?? '•'}
            </button>
          ))}
        </div>
      )}
      <div ref={listRef} className="mt-2 h-[240px] overflow-y-auto overscroll-contain pr-1">
        {!groups && (
          <div className="grid h-full place-items-center text-[11px] text-muted-foreground">
            {t('emojiPicker.loading')}
          </div>
        )}
        {results && results.length === 0 && (
          <div className="grid h-full place-items-center text-[11px] text-muted-foreground">
            {t('emojiPicker.noResults')}
          </div>
        )}
        {results && results.length > 0 && <EmojiGrid emojis={results} onPick={onPick} />}
        {!results &&
          (full ? groups : groups?.slice(0, 1))?.map((group) => (
            <section key={group.name} data-group={group.name} className="mb-1">
              <h4 className="sticky top-0 bg-popover py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                {groupLabel(group.name)}
              </h4>
              <EmojiGrid emojis={group.emojis} onPick={onPick} />
            </section>
          ))}
      </div>
    </div>
  );
}

function EmojiGrid({
  emojis,
  onPick,
}: {
  emojis: readonly EmojiEntry[];
  onPick: (emoji: string) => void;
}) {
  return (
    <div className="grid grid-cols-8 gap-0.5">
      {emojis.map((entry) => (
        <button
          key={entry[0]}
          type="button"
          title={entry[1]}
          aria-label={entry[1]}
          onClick={() => onPick(entry[0])}
          className="grid size-8 place-items-center rounded text-[19px] leading-none transition-colors hover:bg-muted"
        >
          {entry[0]}
        </button>
      ))}
    </div>
  );
}
