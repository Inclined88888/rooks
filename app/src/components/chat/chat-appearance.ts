/**
 * How the central chat paints itself: bubbles, tool calls, composer controls.
 *
 * Pure model — it neither reads nor writes anything. Persistence goes through
 * the existing `loadLayout` / `saveLayout`, on its own `scope`, exactly like
 * `chat-columns.ts`: the placement of cards, the order of the columns and the
 * skin of the thread are three values with three lifetimes, and mixing them
 * into one opaque JSON would buy a migration for nothing.
 *
 * Every default reproduces the behaviour that shipped before this module
 * existed. A value nobody ever set must not change a single pixel.
 */

import type { LayoutIo } from '@/lib/ui-layout-store';

/** How a message's tool calls are rendered inside its bubble. */
export type ToolCallsMode =
  /** Overlapping icon-only chips, opened on demand. The quiet one. */
  | 'stacked'
  /** The tool's name, its content behind a disclosure triangle. */
  | 'dropdown'
  /** Everything unfolded, inline in the thread. */
  | 'full';

export const TOOL_CALLS_MODES: readonly ToolCallsMode[] = ['stacked', 'dropdown', 'full'];

/**
 * What Enter does while the agent is working (TODO #488). The other gesture
 * (Ctrl/Cmd+Enter) always does the other one.
 */
export type WorkingEnterMode =
  /** The message reaches the running turn now: the agent changes course. */
  | 'steer'
  /** The message waits for the turn's end and goes out as the next turn. */
  | 'queue';

export const WORKING_ENTER_MODES: readonly WorkingEnterMode[] = ['steer', 'queue'];

export type ChatAppearance = {
  /**
   * Bubbles without background, border or shadow: the thread becomes one flat
   * surface. With no box left to sit inside, the content takes the message's
   * column: the name's own edge on a phone, a slight inset from it on desktop.
   */
  flatBubbles: boolean;
  toolCalls: ToolCallsMode;
  /** Subscription ceilings strip, below the composer. */
  showUsage: boolean;
  /** The model name (and its brand mark), left of the composer's top bar. */
  showModel: boolean;
  /** The reasoning-effort menu. Only ever painted by models that expose one. */
  showEffort: boolean;
  /** The mission's permission-mode menu. Only painted during a mission whose
   *  backend can change its level, for an account with a choice to make. */
  showPermission: boolean;
  /** The cwd's Git branch / worktree. */
  showBranch: boolean;
  /** The context-window gauge, which also carries the "compact" menu. */
  showContext: boolean;
  /** The border around the input, and the accent it takes on focus. */
  showInputBorder: boolean;
  /**
   * Both side columns slid off screen, for writing without anything else
   * moving in the corner of the eye.
   *
   * A LAYER over the per-column collapse, never a write into it: a focus that
   * folded the columns itself would, on the way out, unfold the one that was
   * deliberately left folded. Leaving focus must give back exactly the screen
   * that entered it.
   */
  focusMode: boolean;
  /** What Enter does while a turn runs; Ctrl/Cmd+Enter does the other. */
  enterWhileWorking: WorkingEnterMode;
};

/**
 * The skin a fresh install opens on — the arrangement shipped with the
 * product, captured from the one it was designed against, not a neutral
 * middle. A flat thread with stacked tool calls and no input border is what
 * the cockpit and the chat starters (`widget-host/widget-defaults.ts`) were
 * composed with; shipping bubbles and dropdowns beside them would show
 * everyone a screen nobody arranged.
 */
export const CHAT_APPEARANCE_DEFAULTS: ChatAppearance = {
  flatBubbles: true,
  toolCalls: 'stacked',
  // Subscription ceilings are a power-user reading, and they push the
  // composer up on every thread.
  showUsage: false,
  showModel: true,
  showEffort: true,
  showPermission: true,
  showBranch: true,
  showContext: true,
  // Outlined since the composer gained its header tab (the maintainer, 04/11/2026): on a
  // dark theme a borderless card melted into the page.
  showInputBorder: true,
  focusMode: false,
  enterWhileWorking: 'steer',
};

/** The `ui_layout` scope where the chat's skin is persisted. */
export const CHAT_APPEARANCE_SCOPE = 'chat.appearance';

/**
 * The composer controls that can be hidden one by one, in the order the menu
 * lists them. Keeping the list here rather than in the menu means adding a
 * control is one entry, not one entry plus one checkbox.
 */
export const COMPOSER_TOGGLES = [
  'showModel',
  'showEffort',
  'showPermission',
  'showBranch',
  'showContext',
  'showUsage',
] as const satisfies readonly (keyof ChatAppearance)[];

export type ComposerToggle = (typeof COMPOSER_TOGGLES)[number];

/**
 * The accesses to `ui_layout` for the chat's skin.
 *
 * `storage: null` cuts the resumption of the layout left in `localStorage`: it
 * only knows one key, the cockpit's, and would write it here as an appearance.
 */
export function appearanceIo(io: LayoutIo = {}): LayoutIo {
  return { ...io, scope: CHAT_APPEARANCE_SCOPE, storage: null };
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

/**
 * Re-reads the stored value, field by field.
 *
 * Tolerant by construction, like `lireColonnes`: an unknown key is ignored, a
 * missing one falls back to its default, and a mode outside the three known
 * ones is not a broken thread — just the default rendering.
 */
export function readAppearance(raw: unknown): ChatAppearance {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const mode = o.toolCalls;
  return {
    flatBubbles: bool(o.flatBubbles, CHAT_APPEARANCE_DEFAULTS.flatBubbles),
    toolCalls: TOOL_CALLS_MODES.includes(mode as ToolCallsMode)
      ? (mode as ToolCallsMode)
      : CHAT_APPEARANCE_DEFAULTS.toolCalls,
    showUsage: bool(o.showUsage, CHAT_APPEARANCE_DEFAULTS.showUsage),
    showModel: bool(o.showModel, CHAT_APPEARANCE_DEFAULTS.showModel),
    showEffort: bool(o.showEffort, CHAT_APPEARANCE_DEFAULTS.showEffort),
    showPermission: bool(o.showPermission, CHAT_APPEARANCE_DEFAULTS.showPermission),
    showBranch: bool(o.showBranch, CHAT_APPEARANCE_DEFAULTS.showBranch),
    showContext: bool(o.showContext, CHAT_APPEARANCE_DEFAULTS.showContext),
    showInputBorder: bool(o.showInputBorder, CHAT_APPEARANCE_DEFAULTS.showInputBorder),
    focusMode: bool(o.focusMode, CHAT_APPEARANCE_DEFAULTS.focusMode),
    enterWhileWorking: WORKING_ENTER_MODES.includes(o.enterWhileWorking as WorkingEnterMode)
      ? (o.enterWhileWorking as WorkingEnterMode)
      : CHAT_APPEARANCE_DEFAULTS.enterWhileWorking,
  };
}

/** Flips one boolean. The mode is set, not toggled — hence its own setter. */
export function toggleAppearance(a: ChatAppearance, key: ComposerToggle | 'flatBubbles' | 'showInputBorder' | 'focusMode'): ChatAppearance {
  return { ...a, [key]: !a[key] };
}

export function setToolCallsMode(a: ChatAppearance, mode: ToolCallsMode): ChatAppearance {
  return { ...a, toolCalls: mode };
}

export function setWorkingEnterMode(a: ChatAppearance, mode: WorkingEnterMode): ChatAppearance {
  return { ...a, enterWhileWorking: mode };
}

/**
 * What a message typed while the agent works does: Enter follows the
 * preference, Ctrl/Cmd+Enter (`alternate`) the other choice.
 */
export function workingSendMode(preference: WorkingEnterMode, alternate: boolean): WorkingEnterMode {
  if (!alternate) return preference;
  return preference === 'steer' ? 'queue' : 'steer';
}
