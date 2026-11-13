'use client';

/**
 * The "Discover Timon" drawings, one per slide (`discover-slides.ts`): schematics of the
 * product's views, never screenshots — a screenshot ages with every release
 * and reads in one language only. Drawn with the theme's tokens, so they
 * follow light and dark; animated by the `timon-discover-*` classes of
 * `globals.css`, which the reduced-motion query stills.
 *
 * The person's own TIM, just made on the agent step, plays the lead in every
 * drawing: the slides are about their TIMs, not about a stock character.
 */
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import {
  Brain, CalendarDays, Check, Clock, FolderOpen, Mail, MessageSquare, Plug, Puzzle, ScrollText, Workflow, Wrench, Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { AgentMascotHost } from '@/components/mascot/agent-mascot';
import { defaultLookFor, type AgentLook } from '@/components/mascot/agent-look';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { DiscoverSlideId } from '../discover-slides';

export type DiscoverDrawingProps = { look: AgentLook };

const delay = (seconds: number): CSSProperties => ({ animationDelay: `${seconds}s` });

/** A small label with its icon, the drawings' one building block. */
function Chip({ icon: Icon, children, className, style }: {
  icon: LucideIcon; children: ReactNode; className?: string; style?: CSSProperties;
}): ReactElement {
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-card px-2.5 py-1 text-[12px] font-medium shadow-elev-2 ring-1 ring-border', className)}
      style={style}
    >
      <Icon className="size-3.5 text-primary" aria-hidden />
      {children}
    </span>
  );
}

/** Lines from the centre to points given in percent of the drawing (`[x, y]`). */
function Spokes({ to, flow = false }: { to: readonly (readonly [number, number])[]; flow?: boolean }): ReactElement {
  return (
    <svg aria-hidden className="absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none">
      {to.map(([x, y], i) => (
        <line
          key={i}
          x1={50}
          y1={50}
          x2={x}
          y2={y}
          pathLength={100}
          vectorEffect="non-scaling-stroke"
          className={flow ? 'timon-discover-flow' : 'timon-discover-draw'}
          style={{ stroke: 'hsl(var(--primary) / 0.45)', strokeWidth: 1.5, ...delay(0.15 * i) }}
        />
      ))}
    </svg>
  );
}

/** Slide 1, "Agent canvas": the TIM at the centre of what it can use. */
function AutonomousDrawing({ look }: DiscoverDrawingProps): ReactElement {
  const nodes: readonly { icon: LucideIcon; key: string; at: readonly [number, number] }[] = [
    { icon: Sparkles, key: 'skills', at: [20, 20] },
    { icon: Wrench, key: 'tools', at: [80, 20] },
    { icon: Brain, key: 'memory', at: [20, 80] },
    { icon: Clock, key: 'schedule', at: [80, 80] },
  ];
  return (
    <div className="timon-discover-grid relative size-full">
      <Spokes to={nodes.map((n) => n.at)} />
      {nodes.map((node, i) => (
        <Chip
          key={node.key}
          icon={node.icon}
          className="timon-discover-pop absolute -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${node.at[0]}%`, top: `${node.at[1]}%`, ...delay(0.25 + 0.15 * i) }}
        >
          {t(`onboarding.discover.autonomous.nodes.${node.key}`)}
        </Chip>
      ))}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="timon-discover-pop" style={delay(0.05)}>
          <AgentMascotHost look={look} size={84} live />
        </div>
        <Chip
          icon={Check}
          className="timon-discover-pop absolute -top-7 left-1/2 -translate-x-1/2 text-emerald-600 dark:text-emerald-400"
          style={delay(2.4)}
        >
          {t('onboarding.discover.autonomous.done')}
        </Chip>
      </div>
    </div>
  );
}

const TEAM_COLUMNS = ['todo', 'doing', 'done'] as const;
/** When the travelling card reaches each column, in seconds: the column's TIM hops then. */
const TEAM_ARRIVALS = [0.4, 2.3, 4.3] as const;

/** Slide 2, "Kanban": one task goes from TIM to TIM. */
function TeamsDrawing({ look }: DiscoverDrawingProps): ReactElement {
  const team: readonly AgentLook[] = [look, defaultLookFor('code'), defaultLookFor('review')];
  return (
    <div className="flex size-full flex-col justify-center gap-3 px-5">
      <div className="relative grid grid-cols-3 gap-2.5">
        {TEAM_COLUMNS.map((column, i) => (
          <div key={column} className="timon-discover-pop flex h-[150px] flex-col gap-1.5 rounded-xl bg-muted/70 p-2" style={delay(0.08 * i)}>
            <span className="px-0.5 text-[11.5px] font-semibold text-muted-foreground">{t(`onboarding.discover.teams.columns.${column}`)}</span>
            <span aria-hidden className="mt-9 h-5 rounded-md bg-card/60" />
            {i !== 1 && <span aria-hidden className="h-5 rounded-md bg-card/60" />}
          </div>
        ))}
        {/* The card rides above the columns, on the same grid, so one step is one column. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-7 grid grid-cols-3 gap-2.5 px-2">
          <span className="timon-discover-travel flex h-8 items-center gap-1.5 rounded-lg bg-card px-2 text-[11.5px] font-medium shadow-elev-3 ring-1 ring-primary/40">
            <span className="size-2 shrink-0 rounded-full bg-primary" />
            <span className="truncate">{t('onboarding.discover.teams.card')}</span>
          </span>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        {team.map((member, i) => (
          <div key={i} className="flex justify-center">
            <span className="timon-mascot-jump" style={{ ...delay(TEAM_ARRIVALS[i] ?? 0), animationFillMode: 'both' }}>
              <AgentMascotHost look={member} size={50} live={i === 0} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Slide 3, the point of the slides: your TIMs go everywhere, a project's TIMs stay home. */
function ProjectsDrawing({ look }: DiscoverDrawingProps): ReactElement {
  const projects: readonly { key: 'alpha' | 'beta'; team: readonly AgentLook[] }[] = [
    { key: 'alpha', team: [defaultLookFor('code'), defaultLookFor('review')] },
    { key: 'beta', team: [defaultLookFor(['mail']), defaultLookFor(['research'])] },
  ];
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 px-4">
      <div className="timon-discover-pop flex items-center gap-2" style={delay(0.05)}>
        <AgentMascotHost look={look} size={44} live />
        <span className="text-[12px] font-medium text-muted-foreground">{t('onboarding.discover.projects.general')}</span>
      </div>
      <div className="grid w-full grid-cols-2 gap-3">
        {projects.map((project, i) => (
          <div
            key={project.key}
            className="timon-discover-pop timon-discover-ring flex flex-col gap-2 rounded-2xl bg-muted/70 p-3"
            style={delay(0.3 + 0.2 * i)}
          >
            <span className="flex items-center gap-1.5 text-[12.5px] font-semibold">
              <FolderOpen className="size-4 text-primary" aria-hidden />
              {t(`onboarding.discover.projects.${project.key}`)}
            </span>
            <div className="flex justify-center gap-2 py-1">
              {project.team.map((member, k) => (
                <span key={k} className="timon-discover-bob" style={delay(0.6 * k + 0.4 * i)}>
                  <AgentMascotHost look={member} size={40} />
                </span>
              ))}
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              <Chip icon={ScrollText} className="timon-discover-pop px-2 text-[11px]" style={delay(1.1 + 0.2 * i)}>
                {t('onboarding.discover.projects.rules')}
              </Chip>
              <Chip icon={Brain} className="timon-discover-pop px-2 text-[11px]" style={delay(1.3 + 0.2 * i)}>
                {t('onboarding.discover.projects.memory')}
              </Chip>
            </div>
            {/* The project's chat with its widgets, sketched. */}
            <div aria-hidden className="timon-discover-pop grid grid-cols-[1fr_32%] gap-1.5" style={delay(1.6 + 0.2 * i)}>
              <span className="h-7 rounded-md bg-card/70" />
              <span className="h-7 rounded-md bg-primary/15" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Slide 4, "Connectors, Workflows, Plugins": everything else plugs into the TIM. */
function ConnectedDrawing({ look }: DiscoverDrawingProps): ReactElement {
  const around: readonly { key: string; icon: LucideIcon; at: readonly [number, number]; extra?: readonly LucideIcon[] }[] = [
    { key: 'connectors', icon: Plug, at: [22, 24], extra: [Mail, CalendarDays, MessageSquare] },
    { key: 'workflows', icon: Workflow, at: [78, 24] },
    { key: 'plugins', icon: Puzzle, at: [50, 86] },
  ];
  return (
    <div className="timon-discover-grid relative size-full">
      <Spokes to={around.map((a) => a.at)} flow />
      {around.map((item, i) => (
        <div
          key={item.key}
          className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5"
          style={{ left: `${item.at[0]}%`, top: `${item.at[1]}%` }}
        >
          <Chip icon={item.icon} className="timon-discover-pop" style={delay(0.2 + 0.2 * i)}>
            {t(`onboarding.discover.views.${item.key}`)}
          </Chip>
          {item.extra && (
            <span className="flex gap-1">
              {item.extra.map((Icon, k) => (
                <span key={k} className="timon-discover-pop grid size-6 place-items-center rounded-md bg-card shadow-elev-2 ring-1 ring-border" style={delay(0.9 + 0.15 * k)}>
                  <Icon className="size-3.5 text-muted-foreground" aria-hidden />
                </span>
              ))}
            </span>
          )}
        </div>
      ))}
      <div className="timon-discover-pop absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" style={delay(0.05)}>
        <AgentMascotHost look={look} size={76} live />
      </div>
    </div>
  );
}

export const DISCOVER_DRAWINGS: Readonly<Record<DiscoverSlideId, (props: DiscoverDrawingProps) => ReactElement>> = {
  autonomous: AutonomousDrawing,
  teams: TeamsDrawing,
  projects: ProjectsDrawing,
  connected: ConnectedDrawing,
};
