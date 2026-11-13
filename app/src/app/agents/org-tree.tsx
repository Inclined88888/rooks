'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { workspaceNodeId, type Hierarchy } from '@/lib/hierarchy';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { PoleRecord } from './agents-client';
import type { MenuTarget } from './node-menu';

type Row = { id: string; label: string; pole: boolean; children: Row[] };

/** Id dropped on the tree's own root zone: back to the default manager. */
export const ORG_ROOT = '';

/** The hierarchy as an indented list, beside the graph: the precise way to
 *  reorganise a hundred agents. Drag a row onto another, or use its menu. */
export function OrgTree({ open, onOpenChange, agents, poles, hierarchy, main, notice, menuOpen, onDrop, onMenu }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: readonly { name: string }[];
  poles: readonly PoleRecord[];
  hierarchy: Hierarchy;
  main: string | null;
  /** Shown above the tree: the empty main seat warning (TIM-0143). */
  notice?: React.ReactNode;
  /** A node menu is open: Escape closes it, not the panel. */
  menuOpen: boolean;
  onDrop: (source: string, target: string) => void;
  onMenu: (target: MenuTarget) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const roots = useMemo(() => {
    const kids = new Map<string, string[]>();
    const top: string[] = [];
    for (const a of agents) {
      const parent = hierarchy.parentOf.get(a.name) ?? null;
      if (!parent) { top.push(a.name); continue; }
      const key = parent.kind === 'agent' ? parent.id : workspaceNodeId(parent.slug);
      kids.set(key, [...(kids.get(key) ?? []), a.name]);
    }
    const lonePoles = poles.filter((p) => !hierarchy.leadOfWorkspace.has(p.slug));
    const poleName = new Map(poles.map((p) => [workspaceNodeId(p.slug), p.name]));
    const leadLabel = (id: string) => {
      const slug = hierarchy.workspaceOfLead.get(id);
      const pole = slug ? poles.find((p) => p.slug === slug) : null;
      return pole ? `${id} · ${pole.name}` : id;
    };
    const build = (id: string, seen: Set<string>): Row => {
      seen.add(id);
      const children = (kids.get(id) ?? [])
        .filter((c) => !seen.has(c))
        .sort((a, b) => a.localeCompare(b))
        .map((c) => build(c, seen));
      const pole = poleName.has(id);
      return { id, label: pole ? poleName.get(id)! : leadLabel(id), pole, children };
    };
    const seen = new Set<string>();
    // The main agent first, then the poles, then whoever else stands alone.
    const order = (id: string) => (id === main ? 0 : hierarchy.workspaceOfLead.has(id) ? 1 : 2);
    const agentRoots = top.sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map((id) => build(id, seen));
    const poleRoots = lonePoles.map((p) => build(workspaceNodeId(p.slug), seen));
    return [...agentRoots.slice(0, 1), ...poleRoots, ...agentRoots.slice(1)];
  }, [agents, poles, hierarchy, main]);

  const dropProps = (id: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragging || dragging === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (over !== id) setOver(id);
    },
    onDragLeave: () => { if (over === id) setOver(null); },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const source = e.dataTransfer.getData('text/plain') || dragging;
      setOver(null);
      setDragging(null);
      if (source && source !== id) onDrop(source, id);
    },
  });

  const renderRow = (row: Row, depth: number): React.ReactNode => {
    const isOpen = !collapsed.has(row.id);
    return (
      <li key={row.id}>
        <div
          draggable={!row.pole}
          onDragStart={(e) => { e.dataTransfer.setData('text/plain', row.id); e.dataTransfer.effectAllowed = 'move'; setDragging(row.id); }}
          onDragEnd={() => { setDragging(null); setOver(null); }}
          onContextMenu={(e) => { e.preventDefault(); onMenu({ id: row.id, x: e.clientX, y: e.clientY }); }}
          {...dropProps(row.id)}
          className={cn(
            'group flex items-center gap-1 rounded px-1 py-1 text-[12.5px]',
            !row.pole && 'cursor-grab active:cursor-grabbing',
            over === row.id ? 'bg-primary/15 ring-1 ring-primary' : 'hover:bg-muted/60',
            dragging === row.id && 'opacity-50',
          )}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          {row.children.length ? (
            <button
              type="button"
              aria-label={row.label}
              aria-expanded={isOpen}
              className="flex size-4 items-center justify-center text-muted-foreground"
              onClick={() => setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
                return next;
              })}
            >
              {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
          ) : <span className="size-4" />}
          <span className={cn('min-w-0 flex-1 truncate', row.pole && 'font-semibold uppercase tracking-[0.06em]')}>
            {row.label}
          </span>
          {row.children.length > 0 && <span className="text-[10.5px] text-muted-foreground">{row.children.length}</span>}
          <button
            type="button"
            aria-label={t('agentsPage.orgActions', { name: row.label })}
            className="flex size-6 items-center justify-center rounded text-muted-foreground opacity-60 hover:bg-muted hover:opacity-100 group-hover:opacity-100"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onMenu({ id: row.id, x: r.left, y: r.bottom + 4 });
            }}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </div>
        {isOpen && row.children.length > 0 && <ul>{row.children.map((c) => renderRow(c, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    // Not modal: the graph stays usable beside the panel, and the node menu
    // (rendered outside it) stays clickable.
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="right"
        className="flex w-[380px] flex-col gap-3 sm:max-w-[420px]"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => { if (menuOpen) e.preventDefault(); }}
      >
        <SheetHeader>
          <SheetTitle>{t('agentsPage.orgTitle')}</SheetTitle>
          <SheetDescription className="text-[12px]">{t('agentsPage.orgHint')}</SheetDescription>
        </SheetHeader>
        {notice}
        <div
          {...dropProps(ORG_ROOT)}
          className={cn(
            'rounded-md border border-dashed px-2 py-1.5 text-center text-[11px] text-muted-foreground',
            over === ORG_ROOT ? 'border-primary bg-primary/10 text-foreground' : 'border-border',
            !dragging && 'opacity-60',
          )}
        >
          {t('agentsPage.orgRootDrop')}
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto pr-1">{roots.map((r) => renderRow(r, 0))}</ul>
      </SheetContent>
    </Sheet>
  );
}
