'use client';

import Link from 'next/link';
import { Plus, Tag } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { NewMissionMenu, type NewMissionOptions } from './new-mission-menu';
import type { Agent, MissionSummary } from './chat-types';
import { formatNumber, formatRelativeTime } from '@/lib/intl';

/**
 * The current mission's sheet — extracted verbatim from `MissionInfoPanel`.
 *
 * It was the central block of a fixed rail; it is now a card that the user
 * moves, removes and restores like the others. It no longer paints its own
 * frame: the card gives it one (title included).
 */
export function MissionCard({
  agent,
  agentId,
  missions,
  currentMissionId,
  currentSessionId,
  stats,
  onNew,
  newMission,
}: {
  agent: Agent;
  agentId: string;
  missions: MissionSummary[];
  currentMissionId: string | null;
  currentSessionId: string | null;
  stats: { tok: number; cost: number };
  onNew: () => void;
  newMission?: NewMissionOptions | null;
}) {
  const current = missions.find((m) => m.id === currentMissionId) ?? null;
  // Cost/tokens: prefer the live SSE-driven `stats` (updates while a mission
  // runs), fall back to the mission row (covers historical / replayed views
  // where `stats` is reset to 0).
  const mergedCost: number | null =
    stats.cost > 0 ? stats.cost : current?.total_cost_usd ?? null;
  const mergedTokens: string | null =
    stats.tok > 0
      ? formatNumber(stats.tok)
      : current && (current.tokens_in || current.tokens_out)
        ? `${formatNumber(current.tokens_in || 0)} / ${formatNumber(current.tokens_out || 0)}`
        : null;

  return (
    <div className="p-3">
      <div className="grid grid-cols-[68px_1fr] gap-y-1.5 text-[12px]">
        {current && (
          <>
            <span className="text-muted-foreground">id</span>
            <span className="truncate tabular-nums text-[11px]">
              {current.id.slice(0, 8)}
            </span>
            <span className="text-muted-foreground">status</span>
            <span className="text-[11px]">
              {current.running ? 'running' : current.status}
            </span>
            <span className="text-muted-foreground">started</span>
            <span className="tabular-nums text-[11px]" suppressHydrationWarning>
              {formatRelativeTime(current.started_at)}
            </span>
          </>
        )}
        {mergedCost != null && (
          <>
            <span className="text-muted-foreground">cost</span>
            <span className="tabular-nums text-[11px]">
              ${mergedCost.toFixed(3)}
            </span>
          </>
        )}
        {mergedTokens && (
          <>
            <span className="text-muted-foreground">tokens</span>
            <span className="tabular-nums text-[11px]">{mergedTokens}</span>
          </>
        )}
        {currentSessionId && (
          <>
            <span className="text-muted-foreground">session</span>
            <span
              className="truncate tabular-nums text-[10.5px] text-muted-foreground/80"
              title={currentSessionId}
            >
              {currentSessionId.slice(0, 8)}…
            </span>
          </>
        )}
        <span className="text-muted-foreground">model</span>
        <span className="text-[11px]">
          {(agent.model || 'sonnet').replace('claude-', '')}
        </span>
        <span className="text-muted-foreground">agent</span>
        <span className="truncate text-[11px]">{agent.name}</span>
      </div>
      {!current && (
        <p className="mt-2 text-[11.5px] text-muted-foreground/70">
          No active mission yet. Type a message to create one.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {current && (
          <NewMissionMenu current={agentId} options={newMission} onNew={onNew}>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px]"
            >
              <Plus className="size-3" />
              New conv
            </Button>
          </NewMissionMenu>
        )}
        <Button
          asChild
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px]"
        >
          <Link prefetch={false} href={`/memory?agent=${encodeURIComponent(agentId)}`}>
            <Tag className="size-3" />
            Memory
          </Link>
        </Button>
      </div>
    </div>
  );
}
