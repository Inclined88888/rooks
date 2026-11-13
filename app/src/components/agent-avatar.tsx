'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { paletteFor } from '@/components/chat/chat-format';
import type { ProjectMeta } from '@/hooks/use-project-meta';
import { useProjectMeta } from '@/hooks/use-project-meta';
import { agentRoleKey, resolveRole } from '@/lib/roles';
import { cn } from '@/lib/utils';
import { accentVars } from '@/lib/accent-color';
import { type ActiveState } from '@/lib/agent-state';
import { chatSenderName } from '@/lib/main-agent';
import { defaultLookFor, normalizeAgentLook, type AgentLook } from '@/components/mascot/agent-look';

/**
 * Visual identity of an agent, shared outside the chat.
 *
 * The rules below are the ones `chat-client.tsx` applies to its bubbles
 * (accent colour, logo, initial fallback, role sub-badge). They live here so
 * the inbox shows the same face for the same agent; the chat still carries
 * its own copy until its own refactor imports this module.
 */

export type AgentIdentitySource = {
  name: string;
  role?: string | null;
  project?: string | null;
  emoji?: string | null;
  color?: string | null;
  icon_url?: string | null;
  /** Mascot look (`config.look`), drawn when the agent has no picture. Any value: checked field by field. */
  look?: unknown;
  /** Which head the agent shows (`config.avatar`): `emoji`, `image`, `mascot`; absent or unknown = the historical order. */
  avatar?: unknown;
  /** Flagged by the daemon on the agent it addresses its recaps to. */
  main?: boolean;
  /** Read by the New mission picker (`lib/new-mission-agents.ts`). */
  orchestrator?: boolean;
  ephemeral?: boolean;
};

export type AgentIdentity = {
  name: string;
  /** Accent colour: agent config, else project colour, else hashed palette. */
  accent: string;
  iconUrl: string | null;
  fallback: string;
  roleKey: string | null;
  /** False for pseudo senders the daemon uses (`orchestrator`, `cockpit`…). */
  known: boolean;
  /** The agent's mascot, shown instead of the initial when there is no picture. */
  look?: AgentLook | null;
  /** What a part of `look` whose mascot pack is not here draws instead: its role's default. */
  lookBase?: AgentLook;
};

/** The heads an agent can pick (`config.avatar`), same list as the daemon's `AGENT_AVATAR_MODES`. */
export const AGENT_AVATAR_MODES = ['emoji', 'image', 'mascot'] as const;
export type AgentAvatarMode = typeof AGENT_AVATAR_MODES[number];

/** The mode an agent row carries; a value a newer daemon knows and this app does not reads as none. */
export function avatarModeOf(value: unknown): AgentAvatarMode | null {
  return (AGENT_AVATAR_MODES as readonly unknown[]).includes(value) ? value as AgentAvatarMode : null;
}

/**
 * The look an agent row carries, or null: a field that fails the check falls
 * back to its role's default. A mascot pack's part is kept even before (or
 * after) its pack is here: the row is often read before the plugins load, and
 * the editor sends it back whole — dropping it would overwrite the agent's
 * part. The drawing falls back to the role's default while the pack is away.
 */
export function lookOfAgent(agent: Pick<AgentIdentitySource, 'look' | 'role'>): AgentLook | null {
  if (typeof agent.look !== 'object' || agent.look === null) return null;
  return normalizeAgentLook(agent.look, defaultLookFor(agent.role ?? ''), { keepPackIds: true });
}

export function isHttpUrl(s: string | null | undefined): s is string {
  // http(s) OR a relative path served by TIMON (uploaded icon `/api/uploads/...`).
  return !!s && (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/'));
}

/**
 * Same derivation as the chat header: config wins, project fills in, name
 * hashes last. A picked head (`avatar`) is shown whatever else the agent has —
 * the mascot over a picture or a project logo — as long as its own setting
 * exists; otherwise, and without a pick, the historical order: picture,
 * project logo, mascot, emoji (or the project's emoji), initial. That order
 * is what keeps the existing agents' faces (docs/AGENT-AVATAR.md).
 */
export function agentIdentity(
  agent: AgentIdentitySource,
  project: Partial<ProjectMeta> | null | undefined,
): AgentIdentity {
  const projectIcon = project?.icon ?? null;
  const projectColor = project?.color ?? null;
  const accent = agent.color || projectColor || paletteFor(agent.name);
  // A stored mascot or emoji stays on the agent. The desk draws a picture or
  // the initial: those faces are the ones a person can see and change.
  const own = isHttpUrl(agent.icon_url) ? agent.icon_url : null;
  const projectPicture = isHttpUrl(projectIcon) ? projectIcon : null;
  const letter = agent.name.trim().charAt(0).toLowerCase() || '?';
  return {
    name: agent.name,
    accent,
    roleKey: agentRoleKey(agent.role),
    known: true,
    iconUrl: own ?? projectPicture,
    fallback: letter,
  };
}

/** True when the identity's head is its mascot: no picture, and a look. */
export function showsMascot(identity: Pick<AgentIdentity, 'iconUrl' | 'look'>): boolean {
  return !isHttpUrl(identity.iconUrl) && !!identity.look;
}

/**
 * The inside of a round avatar, from an identity: the mascot when the agent's
 * head is one, else its picture, else its glyph. The frame (size, border,
 * ring) is the caller's, as for `FaceAgent`: the Multichat cell and rail do
 * not draw it the way `AgentAvatar` does. A caller that frames a mascot in a
 * clipped disc should drop the frame when `showsMascot(identity)`.
 */
export function AgentHead({ identity, glyphClassName, glyphStyle }: {
  identity: AgentIdentity;
  /** Edge of the caller's frame, in CSS pixels. Kept for callers that sized a mascot. */
  px?: number;
  glyphClassName?: string;
  glyphStyle?: CSSProperties;
  /** Kept so a caller can still say the face is still. Faces are a picture or an initial. */
  live?: boolean;
}) {
  if (isHttpUrl(identity.iconUrl)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={identity.iconUrl} alt="" className="size-full object-cover" />;
  }
  return <span className={glyphClassName} style={glyphStyle}>{identity.fallback}</span>;
}

/** Identity for a sender that is not a configured agent (daemon pseudo names). */
export function pseudoIdentity(name: string): AgentIdentity {
  return {
    name,
    accent: paletteFor(name),
    iconUrl: null,
    fallback: name.charAt(0).toLowerCase() || '?',
    roleKey: null,
    known: false,
  };
}

/**
 * Resolver `name → identity` backed by one fetch of `/api/ui/agents` and the
 * shared project table. Unknown names still get a stable colour so a
 * `orchestrator-wake` sender is recognisable across rows.
 */
export function useAgentIdentities(opts: { daemonAsMain?: boolean } = {}): {
  agents: AgentIdentitySource[];
  identityOf: (name: string) => AgentIdentity;
} {
  const [agents, setAgents] = useState<AgentIdentitySource[]>([]);
  const projects = useProjectMeta();

  useEffect(() => {
    let off = false;
    fetch('/api/ui/agents', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((j: { agents?: AgentIdentitySource[] }) => {
        if (!off) setAgents(j.agents ?? []);
      })
      .catch(() => {});
    return () => { off = true; };
  }, []);

  const identityOf = useMemo(() => {
    const byName = new Map<string, AgentIdentity>();
    for (const a of agents) {
      byName.set(a.name, agentIdentity(a, a.project ? projects.get(a.project) ?? null : null));
    }
    // Chat only: the Inbox keeps `orchestrator` for what the daemon says to the
    // human, the chat names the agent that actually receives the recaps.
    const daemonAsMain = opts.daemonAsMain === true;
    return (name: string) => {
      const shown = daemonAsMain ? chatSenderName(name, agents) : name;
      return byName.get(shown) ?? pseudoIdentity(shown);
    };
  }, [agents, projects, opts.daemonAsMain]);

  return { agents, identityOf };
}

const SIZE = {
  sm: { disc: 'size-6 text-[10px]', badge: 'size-3', icon: 'size-2', px: 24 },
  md: { disc: 'size-[34px] text-[13px]', badge: 'size-4', icon: 'size-2.5', px: 34 },
  lg: { disc: 'size-12 text-[17px]', badge: 'size-4', icon: 'size-2.5', px: 48 },
  xl: { disc: 'size-[72px] text-[26px]', badge: 'size-5', icon: 'size-3', px: 72 },
} as const;

/** Round avatar shared by all agent bubbles: colored round disc, project/
 *  agent logo image if available else initial/emoji, + role badge. */
export function AgentAvatar({ identity, size = 'md', className, roleBadge = true }: {
  identity: AgentIdentity;
  size?: keyof typeof SIZE;
  className?: string;
  /** Off where the role is written beside the avatar and the corner carries another mark. */
  roleBadge?: boolean;
  /** A mascot shows what the agent does (docs/AGENT-MASCOT.md); `false`: its bare look, still — menus, very long lists. */
  live?: boolean;
}) {
  const { accent: color, iconUrl, fallback, roleKey } = identity;
  // Tiny role sub-badge bottom-right. Skip `main` (orchestrator) — the
  // avatar disc already carries project identity; a Network glyph here is noise.
  const roleVisual = roleBadge && roleKey && roleKey !== 'main' ? resolveRole(roleKey) : null;
  const RoleIcon = roleVisual?.icon ?? null;
  const s = SIZE[size];
  return (
    <div className={cn('relative shrink-0', s.disc.split(' ')[0], className)}>
      {/* Soft project-tinted disc, same tint as ProjectBadge and published the
          same way — two variants, CSS picks the readable one per theme.
          The logo fills the disc (`object-cover`, no padding): logos are
          framed at upload time, so a square picture in a round bubble is now
          the uploader's own crop rather than a letterboxed thumbnail. */}
      <div
        className={cn('grid place-items-center overflow-hidden rounded-[var(--avatar-radius)] border font-semibold bg-[var(--accent-soft)] border-[var(--accent-border)] text-[var(--accent)] dark:bg-[var(--accent-soft-dark)] dark:border-[var(--accent-border-dark)] dark:text-[var(--accent-dark)]', s.disc)}
        style={accentVars(color)}
      >
        {isHttpUrl(iconUrl) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={iconUrl} alt="" className="size-full object-cover" />
        ) : (
          <span>{fallback}</span>
        )}
      </div>
      {RoleIcon && roleVisual && (
        <span
          className={cn('absolute -bottom-1 -right-1 grid place-items-center rounded-full ring-2 ring-background', s.badge)}
          style={{ background: roleVisual.color }}
        >
          <RoleIcon className={cn('text-white', s.icon)} />
        </span>
      )}
    </div>
  );
}

/** The agent's face. The state is the word beside it, not a glow around the picture. */
export function ActiveAgentAvatar({ identity, state, size, className, label, live }: {
  identity: AgentIdentity;
  state: ActiveState;
  size?: keyof typeof SIZE;
  className?: string;
  live?: boolean;
  /** Names the state for assistive tech where no word beside the face says it. */
  label?: string;
}) {
  return (
    <span
      className="relative inline-grid shrink-0 place-items-center"
      data-chip-avatar
      data-state={state}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {/* The face sits above a role badge, with no glow around it. */}
      <span className="relative z-10 inline-grid">
        <AgentAvatar identity={identity} size={size} className={className} live={live} />
      </span>
    </span>
  );
}
