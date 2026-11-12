'use client';

/**
 * The product's occupant of `kanban.card`: today's tiles, read from the host
 * (`useKanbanCard()`) instead of props — the task card of the board, the idea
 * card of the TO DO column and the idea row of the TO DO widgets. Volets B and
 * C of TODO #837 lay them out on `BoardCard`; the contract does not move.
 */

import type { ReactElement } from 'react';
import { KanbanTaskCard } from './kanban-task-card';
import { KanbanTodoCard } from './kanban-todo-card';
import { useKanbanCard } from './kanban-card-context';

export function ProductKanbanCard(): ReactElement | null {
  const card = useKanbanCard();
  if (!card) return null;
  if (card.kind === 'task') {
    return (
      <KanbanTaskCard
        task={card.task}
        byId={card.board}
        now={card.now}
        agent={card.agent}
        agentRole={card.agentRole}
        todo={card.todo}
        needsAction={card.needsAction}
        dragging={card.dragging}
        modelTarget={card.modelTarget}
        onOpen={card.open}
        onStop={card.stop}
        onMarkMerged={card.markMerged}
        onOpenGraph={card.openGraph}
        onSaved={card.refresh}
        onDragStart={card.drag.onDragStart}
        onDragEnd={card.drag.onDragEnd}
      />
    );
  }
  return <KanbanTodoCard card={card} />;
}
