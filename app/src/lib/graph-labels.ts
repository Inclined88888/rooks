/**
 * What the Agents graph writes on a node: one caption under it, and at most
 * two letters inside it. The full name and the project stay in the tooltip.
 */

export type LabelNode = {
  id: string;
  kind: string;
  isMain?: boolean;
  project?: string | null;
  pole?: { name: string } | null;
};

export const CAPTION_MAX = 18;

export function truncate(s: string, max = CAPTION_MAX): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** A project's orchestrator: the name says nothing its project does not. */
export function leadsItsProject(d: LabelNode): boolean {
  return !d.isMain && !!d.project && d.kind === 'orchestrator';
}

/** Caption under the node: the project for its orchestrator, the pole's
 *  name for a pole, the agent's full name otherwise. */
export function nodeCaption(d: LabelNode): string {
  if (d.pole) return truncate(d.pole.name);
  if (leadsItsProject(d)) return truncate(d.project!);
  return truncate(d.id);
}

/** Two letters for a node without a picture: `video-factory` → `VF`,
 *  `_main.perso` → `MP`, `rooks` → `TI`. */
export function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Letters inside a node without a picture: its caption's initials. */
export function nodeInitials(d: LabelNode): string {
  if (d.pole) return initials(d.pole.name);
  return initials(leadsItsProject(d) ? d.project! : d.id);
}
