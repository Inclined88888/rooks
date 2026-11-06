/**
 * Who is writing a TO DO idea right now (`write-origin.ts` carries the logic,
 * shared with the agent events). The names below are the TO DO spelling of the
 * same store: a write wrapped by `withTodoOrigin` is seen by
 * `currentWriteOrigin()` and the other way round.
 */
export {
  currentWriteOrigin as currentTodoOrigin,
  withWriteOrigin as withTodoOrigin,
  writeOriginFromRequest as todoOriginFromRequest,
  type WriteOrigin as TodoOrigin,
} from './write-origin.js';
