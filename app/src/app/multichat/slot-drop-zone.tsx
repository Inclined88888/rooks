'use client';

/**
 * The drop target of one multichat cell.
 *
 * A cell hosts a whole chat — messages, a textarea, a composer that takes file
 * drops of its own — and the browser hands a drag to the deepest element under
 * the pointer. Rather than trusting every one of those to let the event bubble,
 * a layer covers the cell while an AGENT is dragged: the pointer then hits the
 * layer and nothing else. A file drag never raises it, so the composer keeps
 * its attachment drop.
 *
 * The layer shows up on two signals: the page says an agent drag started (the
 * side rail and the cell headers are the only sources), or the drag itself
 * carries the agent type, for a drag the page did not see begin.
 */

import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export const AGENT_DRAG_TYPE = 'text/agent-name';

export function carriesAgent(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer?.types) return false;
  return Array.from(dataTransfer.types).includes(AGENT_DRAG_TYPE);
}

export function SlotDropZone({
  slotIndex,
  draggingAgent,
  occupant,
  swap,
  onDropAgent,
  className,
  style,
  children,
}: {
  slotIndex: number;
  /** Agent the page saw a drag start for, or null. */
  draggingAgent: string | null;
  /** Agent already in this cell, or null when it is empty. */
  occupant: string | null;
  /** The dragged agent sits in another cell: dropping here swaps the two. */
  swap: boolean;
  onDropAgent: (agentName: string, slotIndex: number) => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  // dragenter/dragleave fire for every child crossed: a counter, not a flag,
  // tells "left the cell" from "moved onto a child of it".
  const depth = useRef(0);
  const [over, setOver] = useState(false);

  // A drag that ends outside every cell (Escape, dropped on the rail) leaves
  // no dragleave behind the layer that was raised for it.
  useEffect(() => {
    if (draggingAgent) return;
    depth.current = 0;
    setOver(false);
  }, [draggingAgent]);

  const same = !!draggingAgent && draggingAgent === occupant;

  function onDragEnter(e: DragEvent) {
    if (!carriesAgent(e.dataTransfer)) return;
    depth.current += 1;
    setOver(true);
  }
  function onDragLeave(e: DragEvent) {
    if (!carriesAgent(e.dataTransfer)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  }
  function onDragOver(e: DragEvent) {
    if (!carriesAgent(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = same ? 'none' : 'move';
  }
  function onDrop(e: DragEvent) {
    const name = e.dataTransfer?.getData(AGENT_DRAG_TYPE);
    if (!name) return;
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    if (name !== occupant) onDropAgent(name, slotIndex);
  }

  const label = !occupant
    ? t('multichat.drop.here')
    : swap
      ? t('multichat.drop.swap', { name: occupant })
      : t('multichat.drop.replace', { name: occupant });

  return (
    <div
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={className}
      style={style}
    >
      {children}
      {(draggingAgent || over) && (
        <div
          data-slot-drop-layer=""
          data-over={over && !same ? '' : undefined}
          className={cn(
            'absolute inset-0 z-40 grid place-items-center rounded-[inherit] transition-colors duration-150',
            over && !same && 'bg-primary/10 ring-2 ring-inset ring-primary',
          )}
        >
          {over && !same && (
            <span className="pointer-events-none max-w-[80%] truncate rounded-full border border-primary/40 bg-popover/90 px-3 py-1 text-[11px] text-primary shadow-elev-2 backdrop-blur-sm">
              {label}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
