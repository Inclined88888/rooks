import type { KeyboardCoordinateGetter } from '@dnd-kit/core';

/** Navigate real insertion/docking rectangles, rather than sortable item IDs.
 * Dock targets group widgets; insertion gaps put them in separate rows. */
export const widgetKeyboardCoordinates: KeyboardCoordinateGetter = (event, { active, currentCoordinates, context }) => {
  const direction = event.code;
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(direction)) return;
  event.preventDefault();
  const source = context.collisionRect;
  if (!source) return;
  const x = source.left + source.width / 2;
  const y = source.top + source.height / 2;
  const self = String(active).replace(/^frame:/, '');
  const candidates = context.droppableContainers.getEnabled().flatMap((container) => {
    const id = String(container.id);
    if (!/^(dock:|insert:|rail:)/.test(id) || id === `dock:${self}` || id === `insert:${self}`) return [];
    const rect = context.droppableRects.get(container.id);
    if (!rect || rect.width === 0 || rect.height === 0) return [];
    const dx = rect.left + rect.width / 2 - x;
    const dy = rect.top + rect.height / 2 - y;
    const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
    const forward = direction === 'ArrowRight' ? dx : direction === 'ArrowLeft' ? -dx : direction === 'ArrowDown' ? dy : -dy;
    if (forward < 2) return [];
    return [{ dx, dy, score: forward + Math.abs(horizontal ? dy : dx) * 3 }];
  }).sort((a, b) => a.score - b.score);
  const target = candidates[0];
  if (!target) return;
  return { x: currentCoordinates.x + target.dx, y: currentCoordinates.y + target.dy };
};
