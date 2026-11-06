'use client';

import { KanbanClient } from './kanban-page';

export function KanbanPage(): React.ReactElement {
  return (
    <div className="relative z-[1] flex h-full min-h-0 flex-col px-6 pb-4 pt-3">
      <KanbanClient />
    </div>
  );
}
