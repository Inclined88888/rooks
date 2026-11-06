'use client';

/**
 * "Add" panel of the builder: the daemon's node registry, grouped by family,
 * searchable, draggable onto the canvas (or click to add at a free spot).
 */
import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { CATEGORY_ORDER, CATEGORY_TONE, categoryLabel, nodeTypeDescription, nodeTypeLabel, presentationFor, type NodeCategory } from './node-catalog';
import type { NodeType } from './types';

export function NodePalette({ nodeTypes, onAdd }: { nodeTypes: NodeType[]; onAdd: (type: string) => void }) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byCategory = new Map<NodeCategory, NodeType[]>();
    for (const item of nodeTypes) {
      const haystack = `${item.type} ${nodeTypeLabel(item.type)} ${nodeTypeDescription(item.type)}`.toLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      const category = presentationFor(item.type).category;
      byCategory.set(category, [...(byCategory.get(category) ?? []), item]);
    }
    return CATEGORY_ORDER.filter((category) => byCategory.has(category)).map((category) => ({ category, items: byCategory.get(category)! }));
  }, [nodeTypes, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative px-3 pb-2 pt-3">
        <Search className="pointer-events-none absolute left-5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('workflows.palette.search')} className="h-8 pl-8 text-xs" />
      </div>
      <p className="px-4 pb-2 text-[10.5px] text-muted-foreground/80">{t('workflows.palette.hint')}</p>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {groups.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('workflows.palette.noMatch')}</p>}
        {groups.map(({ category, items }) => (
          <section key={category} className="mb-3">
            <h3 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{categoryLabel(category)}</h3>
            <ul className="space-y-0.5">
              {items.map((item) => {
                const pres = presentationFor(item.type);
                const Icon = pres.icon;
                const tone = CATEGORY_TONE[pres.category];
                return (
                  <li key={item.type}>
                    <button
                      type="button"
                      draggable
                      onDragStart={(event) => { event.dataTransfer.setData('application/timon-node', item.type); event.dataTransfer.effectAllowed = 'move'; }}
                      onClick={() => onAdd(item.type)}
                      className={cn('group flex w-full cursor-grab items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted active:cursor-grabbing')}
                    >
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70" style={{ background: `color-mix(in srgb, ${tone} 14%, transparent)` }}>
                        <Icon className="size-3.5" style={{ color: tone }} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium">{nodeTypeLabel(item.type)}</span>
                        <span className="block truncate text-[10.5px] text-muted-foreground">{nodeTypeDescription(item.type) || item.type}</span>
                      </span>
                      <Plus className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
