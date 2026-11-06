/**
 * What an agent is doing in its conversation, as the chat sees it, and the
 * mascot state that shows it (docs/AGENT-MASCOT.md, "Le vivant"). Pure: the
 * chat reports an `AgentActivity` (`ChatClient`'s `onAgentActivity`), a screen
 * that draws the agent's face turns it into a `MascotState` here.
 */
import type { MascotState } from './mascot-states';

export type AgentActivity = {
  /** A turn is running: the agent thinks or acts. */
  busy: boolean;
  /** The tool it is running now, by the name the harness gives it; `null` while it writes. */
  tool: string | null;
  /** A card waits for the user (a question, a permission, a picture…). */
  awaitingUser: boolean;
};

export const IDLE_ACTIVITY: AgentActivity = Object.freeze({ busy: false, tool: null, awaitingUser: false });

/** Tools that look things up rather than change them: the mascot scans instead of working. */
const SEARCHING = /(search|grep|glob|fetch|find|_list$|_get$|read)/i;

/** The short name of an MCP tool (`mcp__timon__setup_set_soul` → `setup_set_soul`). */
export function toolShortName(tool: string): string {
  const parts = tool.split('__');
  return parts[parts.length - 1] ?? tool;
}

/**
 * The state a turn shows, without its reactions: waiting on the user first
 * (the agent stopped to ask), then the tool it runs, then thinking. Outside a
 * turn: `listening` while the user types to it, otherwise idle (`null`).
 */
export function activityState(activity: AgentActivity, opts: { typing?: boolean } = {}): MascotState | null {
  if (activity.awaitingUser) return 'waiting';
  if (activity.busy) {
    if (activity.tool === null) return 'thinking';
    return SEARCHING.test(toolShortName(activity.tool)) ? 'searching' : 'working';
  }
  return opts.typing ? 'listening' : null;
}

/**
 * A short reaction when the activity changes: a celebration when a tool that
 * counts has just finished (`celebrateTools`: its soul written, its team
 * recruited), content when a turn ends on the agent's answer. `null`: none.
 */
export function activityReaction(
  previous: AgentActivity,
  next: AgentActivity,
  celebrateTools: ReadonlySet<string>,
): MascotState | null {
  if (previous.tool !== null && previous.tool !== next.tool && celebrateTools.has(toolShortName(previous.tool))) return 'celebrate';
  if (previous.busy && !next.busy && !next.awaitingUser) return 'happy';
  return null;
}

/** How long a reaction shows before the face goes back to the activity. */
export const REACTION_MS = 2200;
