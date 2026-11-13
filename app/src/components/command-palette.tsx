'use client';

/**
 * First-class ⌘K palette: grouped navigation, quiet blur overlay, keycap footer.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

type PaletteItem = {
  id: string;
  group: string;
  label: string;
  href: string;
  hint?: string;
};

function usePaletteItems(): PaletteItem[] {
  return useMemo(
    () => [
      { id: 'desk', group: t('commandPalette.group.go'), label: t('nav.cockpit'), href: '/', hint: 'G D' },
      { id: 'chat', group: t('commandPalette.group.go'), label: t('nav.chat'), href: '/chat', hint: 'G C' },
      { id: 'agents', group: t('commandPalette.group.go'), label: t('nav.agents'), href: '/agents', hint: 'G A' },
      { id: 'bots', group: t('commandPalette.group.go'), label: t('nav.bots'), href: '/bots', hint: 'G B' },
      { id: 'terminal', group: t('commandPalette.group.go'), label: t('nav.terminal'), href: '/terminal' },
      { id: 'settings', group: t('commandPalette.group.customize'), label: t('nav.settings'), href: '/settings', hint: 'G S' },
      { id: 'capabilities', group: t('commandPalette.group.customize'), label: t('nav.capabilities'), href: '/capabilities' },
      { id: 'appearance', group: t('commandPalette.group.customize'), label: t('commandPalette.appearance'), href: '/settings?section=appearance' },
    ],
    [],
  );
}

export function CommandPaletteHost() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const router = useRouter();
  const items = usePaletteItems();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.label.toLowerCase().includes(q) || item.group.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => { setActive(0); }, [query, open]);

  useEffect(() => {
    const openPalette = () => { setOpen(true); setQuery(''); };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery('');
      }
    };
    const onBus = () => openPalette();
    window.addEventListener('keydown', onKey);
    window.addEventListener('rooks:command-palette', onBus);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('rooks:command-palette', onBus);
    };
  }, []);

  const run = useCallback((item: PaletteItem) => {
    setOpen(false);
    setQuery('');
    router.push(item.href);
  }, [router]);

  const groups = useMemo(() => {
    const map = new Map<string, PaletteItem[]>();
    for (const item of filtered) {
      const list = map.get(item.group) ?? [];
      list.push(item);
      map.set(item.group, list);
    }
    return [...map.entries()];
  }, [filtered]);

  const flat = filtered;

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}>
      <DialogContent
        hideClose
        overlayClassName="bg-background/40 backdrop-blur-[6px]"
        className="top-[18%] w-[min(560px,calc(100vw-2rem))] translate-y-0 gap-0 overflow-hidden rounded-[12px] border border-border bg-popover p-0 shadow-none"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            const item = flat[active];
            if (item) {
              e.preventDefault();
              run(item);
            }
          }
        }}
      >
        <DialogTitle className="sr-only">{t('commandPalette.title')}</DialogTitle>
        <div className="flex items-center gap-2 bg-muted/40 px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('commandPalette.placeholder')}
            className="h-11 w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            aria-label={t('commandPalette.placeholder')}
          />
          {/* code-font: keycap glyph */}
          <kbd className="hidden rounded-[6px] border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline">esc</kbd>
        </div>
        <div className="max-h-[min(360px,50vh)] overflow-y-auto p-2">
          {flat.length === 0 && (
            <p className="px-2 py-6 text-center text-[13px] text-muted-foreground">{t('commandPalette.empty')}</p>
          )}
          {groups.map(([group, list]) => (
            <div key={group} className="mb-2 last:mb-0">
              <p className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group}</p>
              <ul role="listbox" aria-label={group}>
                {list.map((item) => {
                  const index = flat.indexOf(item);
                  const selected = index === active;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => run(item)}
                        className={cn(
                          'flex h-[30px] w-full items-center justify-between rounded-[6px] px-2 text-left text-[13px] transition-colors duration-100',
                          selected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                        )}
                      >
                        <span>{item.label}</span>
                        {item.hint && (
                          // code-font: shortcut keycap
                          <span className="font-mono text-[11px] text-muted-foreground/80">{item.hint}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <span>{t('commandPalette.footer')}</span>
          <span className="flex items-center gap-1">
            {/* code-font: keycap glyphs */}
            <kbd className="rounded-[6px] border border-border bg-muted px-1.5 py-0.5 font-mono">↑↓</kbd>
            <kbd className="rounded-[6px] border border-border bg-muted px-1.5 py-0.5 font-mono">↵</kbd>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Compact ⌘K affordance for the content top bar. */
export function CommandPaletteTrigger() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event('rooks:command-palette'))}
      className="hidden h-8 items-center gap-2 rounded-[8px] border border-border bg-background px-2.5 text-[12px] text-muted-foreground transition-colors duration-150 hover:text-foreground md:inline-flex"
      aria-label={t('commandPalette.title')}
    >
      <Search className="size-3.5" aria-hidden />
      <span>{t('commandPalette.placeholderShort')}</span>
      {/* code-font: keycap glyph */}
      <kbd className="rounded-[6px] border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
    </button>
  );
}
