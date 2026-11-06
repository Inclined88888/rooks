'use client';

import type { ReactElement } from 'react';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { KANBAN_CARD_SLOT } from '@/lib/plugin-host/slots';
import { KanbanCardProvider, type KanbanCardValue } from './kanban-card-context';
import { ProductKanbanCard } from './product-kanban-card';

/**
 * One item's tile: the occupant of `kanban.card` — the plugin that took it,
 * else the product's card. The product's card is painted directly while no
 * plugin claims the slot: a host still has a tile with the Kanban module off,
 * and the registered fallback, loaded on demand, never leaves a board of
 * empty tiles while its chunk arrives.
 */
export function KanbanCardHost({ value }: { value: KanbanCardValue }): ReactElement {
  const occupant = useSlotEntries(KANBAN_CARD_SLOT)[0];
  return (
    <KanbanCardProvider value={value}>
      {occupant && !occupant.fallback ? <SlotSingle name={KANBAN_CARD_SLOT} /> : <ProductKanbanCard />}
    </KanbanCardProvider>
  );
}
