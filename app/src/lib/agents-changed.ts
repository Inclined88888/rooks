/** Tells the open views that the agent list changed (an agent saved from the editor). */
export const AGENTS_CHANGED_EVENT = 'timon:agents-changed';

export function announceAgentsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));
}
