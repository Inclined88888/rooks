'use client';

/**
 * One idea of the TO DO widgets, as a compact line (TODO #837): the title that
 * opens the detail, the tags, then a foot line with the id and the gestures
 * (mark done included). Laid out on
 * `BoardCard` in its `row` density, the card of the board column's twin.
 */

import type { ReactElement } from 'react';
import { BoardCard } from '@/components/board-card';
import { t } from '@/lib/i18n';
import type { KanbanTodoCardValue } from './kanban-card-context';
import { AuthorBadge } from './project-todo-tag-chips';
import { TodoActions, TodoAttachmentCount, TodoBadges, todoHasActions, useTodoHasBadges } from './todo-card-parts';

export function TodoRow({ card }: { card: KanbanTodoCardValue }): ReactElement {
  const { item, show } = card;
  const done = item.status === 'done';
  const hasBadges = useTodoHasBadges(item);
  const project = show.project && item.project;
  const author = show.author && item.author;
  const files = (item.attachment_count ?? 0) > 0;
  return (
    <BoardCard
      as="li"
      density="row"
      data-todo-card={item.id}
      corner={show.id ? `#${item.id}` : undefined}
      title={item.text}
      // The row has no meta line: the 📎 joins the tags.
      badges={(hasBadges || project || author || files) ? (
        <>
          {hasBadges && <TodoBadges item={item} />}
          {project && <span>{project}</span>}
          {author && <AuthorBadge author={author} links={item.links} />}
          {files && <TodoAttachmentCount item={item} />}
        </>
      ) : undefined}
      // Shown on hover or focus: a list of ideas stays a list of titles.
      actions={todoHasActions(card) ? (
        <TodoActions
          card={card}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        />
      ) : undefined}
      muted={done}
      onOpen={card.open}
    />
  );
}
