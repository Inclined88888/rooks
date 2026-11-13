'use client';

import { createContext, useContext } from 'react';
import { DEFAULT_KANBAN_FILTERS, type KanbanFilters } from './kanban-filters';

/** The board's filters for the plugin columns it hosts: a slot component
 *  receives no props, so the TO DO column reads them from here. */
export const KanbanFiltersContext = createContext<KanbanFilters>(DEFAULT_KANBAN_FILTERS);

export function useKanbanFilters(): KanbanFilters {
  return useContext(KanbanFiltersContext);
}
