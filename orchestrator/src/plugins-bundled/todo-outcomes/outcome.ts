/**
 * The outcome as an extension of the TO DO PATCH: `resolution`, `public_note`
 * and `duplicate_of` ride in the body of `PATCH /api/project-todo/:id`, are
 * checked before the write, stored here inside it, and announced with
 * `todo_resolved` before the core publishes `todo_done`.
 *
 * The rules are those `dbApi.updateProjectTodo` applied when the fields were
 * columns of `project_todo`; `todo-outcome-contract.test.ts` holds them.
 */
import { z } from 'zod';
import { bus } from '../../bus.js';
import { settingBool } from '../../settings.js';
import { TodoExtensionError, type TodoExtension } from '../../project-todo-extensions.js';
import {
  assertTodoResolutionFields, CLOSING_TODO_RESOLUTIONS, TODO_DUPLICATE_OF_RE, TODO_PUBLIC_NOTE_MAX,
  TODO_RESOLUTIONS, TodoResolutionError,
} from './vocabulary.js';
import { getOutcome, putOutcome, type TodoOutcome } from './store.js';

export const OUTCOME_SETTING = 'TIMON_TODO_OUTCOME_ENABLED';
export const OUTCOME_FIELDS = ['resolution', 'public_note', 'duplicate_of'] as const;

/**
 * Outcome fields of a PATCH. `public_note` leaves Timon with `todo_resolved`,
 * so its bound holds at the door too; the cross-field rule (`duplicate_of`
 * only with `duplicate`) needs the stored outcome and is checked below.
 */
const TodoOutcomePatch = z.object({
  resolution: z.enum(TODO_RESOLUTIONS).nullable().optional(),
  public_note: z.string().max(TODO_PUBLIC_NOTE_MAX).nullable().optional(),
  duplicate_of: z.string().regex(TODO_DUPLICATE_OF_RE).nullable().optional(),
});

export const outcomeExtension: TodoExtension = {
  id: '@timon/todo-outcomes',
  fields: OUTCOME_FIELDS,
  prepare(existing, body) {
    if (!settingBool(OUTCOME_SETTING)) {
      throw new TodoExtensionError(`idea outcomes are disabled (${OUTCOME_SETTING})`, 403);
    }
    const parsed = TodoOutcomePatch.safeParse(body);
    if (!parsed.success) {
      throw new TodoExtensionError(
        `resolution must be ${TODO_RESOLUTIONS.join('|')} or null, public_note at most `
          + `${TODO_PUBLIC_NOTE_MAX} characters, duplicate_of like TIM-0001 or SUG-0001`,
      );
    }
    const fields = { ...parsed.data };
    const before = getOutcome(existing.id);
    const resolutionChanged = fields.resolution !== undefined && fields.resolution !== before.resolution;
    // Leaving `duplicate` drops the reference it carried, unless the caller
    // sends one, which the check below then refuses.
    if (resolutionChanged && fields.resolution !== 'duplicate' && fields.duplicate_of === undefined) {
      fields.duplicate_of = null;
    }
    if (fields.public_note !== undefined && fields.public_note !== null) {
      fields.public_note = fields.public_note.trim() || null;
    }
    const next: TodoOutcome = {
      resolution: fields.resolution !== undefined ? fields.resolution : before.resolution,
      public_note: fields.public_note !== undefined ? fields.public_note : before.public_note,
      duplicate_of: fields.duplicate_of !== undefined ? fields.duplicate_of : before.duplicate_of,
    };
    try {
      assertTodoResolutionFields(next);
    } catch (err) {
      if (err instanceof TodoResolutionError) throw new TodoExtensionError(err.message);
      throw err;
    }
    return {
      // An outcome that settles the idea closes it, through the same progress
      // the checkbox uses; the core skips a promoted idea and an explicit
      // progress or status in the same write.
      close: resolutionChanged && next.resolution !== null && CLOSING_TODO_RESOLUTIONS.includes(next.resolution),
      commit(updated) {
        putOutcome(updated.id, next);
        // On a new non-null outcome only: re-saving it, or clearing it,
        // announces nothing. The core publishes `todo_done` after this, so a
        // listener told about the outcome first recognises the closure.
        if (next.resolution && next.resolution !== before.resolution) {
          const todo = Object.freeze({
            id: updated.id, text: updated.text, project: updated.project, resolution: next.resolution,
            public_note: next.public_note, duplicate_of: next.duplicate_of, owner_user_id: updated.owner_user_id,
          });
          bus.publish({ kind: 'todo_resolved', todoId: updated.id, previousResolution: before.resolution, todo });
        }
      },
    };
  },
};
