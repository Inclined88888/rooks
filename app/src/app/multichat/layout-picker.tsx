'use client';

/**
 * Grid size of the multichat, as a menu of miniature grids. Emptying the grid
 * sits at the bottom of the same menu: a destructive action one click away
 * from nothing is how a grid of live conversations gets wiped by mistake.
 */

import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Columns2, Trash2 } from 'lucide-react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PRESETS, type GridLayout } from './types';
import { RAIL_CONTROL, RAIL_ICON_BUTTON, type ControlVariant } from './controls';
import { NativeViewCover } from '@/lib/native-view-cover';

function GridGlyph({ cols, rows, className }: GridLayout & { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('grid shrink-0 gap-[1.5px]', className)}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: cols * rows }, (_, i) => (
        <span key={i} className="rounded-[1.5px] bg-current opacity-70" />
      ))}
    </span>
  );
}

const valueOf = (l: GridLayout) => `${l.cols}x${l.rows}`;

export function LayoutPicker({
  layout,
  onChange,
  onClear,
  canClear,
  onOpenWorkspace,
  variant = 'full',
}: {
  layout: GridLayout;
  onChange: (l: GridLayout) => void;
  onClear: () => void;
  /** The grid holds at least one agent. */
  canClear: boolean;
  onOpenWorkspace?: () => void;
  variant?: ControlVariant;
}) {
  const current = PRESETS.find((p) => p.cols === layout.cols && p.rows === layout.rows);
  const label = current?.label ?? `${layout.rows}×${layout.cols}`;
  const name = t('multichat.grid.trigger', { layout: label });
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        {variant === 'icon' ? (
          <button type="button" aria-label={name} title={name} className={RAIL_ICON_BUTTON}>
            <GridGlyph cols={layout.cols} rows={layout.rows} className="size-3.5" />
          </button>
        ) : (
          <button type="button" aria-label={name} title={name} className={cn(RAIL_CONTROL, 'shrink-0')}>
            <GridGlyph cols={layout.cols} rows={layout.rows} className="size-3 text-muted-foreground" />
            <span className="tabular-nums">{label}</span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </button>
        )}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          side={variant === 'icon' ? 'right' : 'bottom'}
          align={variant === 'icon' ? 'start' : 'end'}
          sideOffset={6}
          className="z-50 w-52 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-elev-2"
        >
          <NativeViewCover />
          <Dropdown.Label className="px-1.5 pb-1.5 pt-0.5 text-xs font-medium">{t('multichat.grid.title')}</Dropdown.Label>
          <Dropdown.RadioGroup
            value={valueOf(layout)}
            onValueChange={(value) => {
              const preset = PRESETS.find((p) => valueOf(p) === value);
              if (preset) onChange({ cols: preset.cols, rows: preset.rows });
            }}
            className="grid grid-cols-3 gap-1"
          >
            {PRESETS.map((p) => (
              <Dropdown.RadioItem
                key={p.label}
                value={valueOf(p)}
                aria-label={t('multichat.grid.option', { layout: p.label })}
                className={cn(
                  'flex cursor-pointer flex-col items-center gap-1 rounded-md border border-transparent px-2 py-2 text-muted-foreground outline-none transition-colors',
                  'data-[highlighted]:bg-muted data-[highlighted]:text-foreground',
                  'data-[state=checked]:border-primary/50 data-[state=checked]:bg-primary/10 data-[state=checked]:text-primary',
                )}
              >
                <GridGlyph cols={p.cols} rows={p.rows} className="h-5 w-7" />
                <span className="text-[10px] tabular-nums">{p.label}</span>
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
          {onOpenWorkspace && (
            <Dropdown.Item
              disabled={!canClear}
              onSelect={onOpenWorkspace}
              className="mt-1.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted"
            >
              <Columns2 className="size-3.5" />
              {t('multichat.grid.openWorkspace')}
            </Dropdown.Item>
          )}
          <Dropdown.Item
            disabled={!canClear}
            onSelect={onClear}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground outline-none transition-colors data-[disabled]:pointer-events-none data-[highlighted]:bg-muted data-[highlighted]:text-destructive data-[disabled]:opacity-50"
          >
            <Trash2 className="size-3.5" />
            {t('multichat.grid.clear')}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
