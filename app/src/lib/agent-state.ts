/**
 * Visual mapping for the three "agent worth showing right now" states
 * surfaced by GET /api/agents/active. Shared between:
 *   - the chat topbar active-agent strip
 *   - the /agents canvas node rendering
 * so the same colour + animation reads consistently across screens.
 *
 * Colour choices use the shared CSS vars (--warning / --primary /
 * --success) so both light and dark themes stay coherent. The
 * `pulse` flag is the cue for "user attention needed".
 */

export type ActiveState = 'thinking' | 'needs_action' | 'done' | 'idle';

export type ActiveAgent = {
  name: string;
  state: ActiveState;
  mission_id: string;
  at: number;
  /** Start of that mission; turns move `at`, not this. Absent on an older daemon. */
  started_at?: number;
  pending_count: number;
  /** Fine state of that mission, from the daemon (`missions` liveness): `state`
   *  cannot tell a finished turn from a mission that was cut. Absent on an older daemon. */
  liveness?: 'working' | 'turn_done' | 'open' | 'interrupted' | 'ended';
  interrupted_reason?: string | null;
  pending_messages?: number;
  open_deliveries?: number;
  project: string | null;
  emoji?: string | null;
  color?: string | null;
  icon_url?: string | null;
};

export type StateVisual = {
  label: string;
  /** Solid fill / border / glow colour, applied via inline style. */
  colorVar: string;
  /** Tailwind text-* utility for label readability. */
  textClass: string;
  /** Whether the dot/halo should animate. */
  pulse: boolean;
};

export const STATE_VISUALS: Record<ActiveState, StateVisual> = {
  thinking: {
    label: 'thinking',
    colorVar: 'hsl(var(--warning))',
    textClass: 'text-[hsl(var(--warning))]',
    pulse: true,
  },
  needs_action: {
    label: 'needs you',
    colorVar: 'hsl(var(--primary))',
    textClass: 'text-[hsl(var(--primary))]',
    pulse: true,
  },
  done: {
    label: 'done',
    colorVar: 'hsl(var(--success))',
    textClass: 'text-[hsl(var(--success))]',
    pulse: false,
  },
  idle: {
    label: 'idle',
    colorVar: 'hsl(var(--muted-foreground))',
    textClass: 'text-muted-foreground',
    pulse: false,
  },
};
