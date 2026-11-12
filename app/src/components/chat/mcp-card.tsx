'use client';

import Link from 'next/link';
import { Settings2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { t as i18n } from '@/lib/i18n';
import { widgetButtonClass } from '@/components/widget-toolbar';
import type { Agent, McpItem } from './chat-types';

/**
 * The MCP servers attached to the agent — extracted verbatim from
 * `MissionInfoPanel`, with the "manage" link moved into the body as for the
 * skills.
 */
export function McpCard({
  agent,
  allMcp,
  onToggleMcp,
}: {
  agent: Agent;
  allMcp: McpItem[];
  onToggleMcp: (id: string) => void;
}) {
  const activeMcp = new Set(agent.mcp_servers || []);
  const excludedMcp = new Set(agent.excluded_mcp_servers || []);

  return (
    <div className="px-3 pb-3">
      <div className="flex h-9 items-center justify-end">
        <Link
          prefetch={false}
          href="/mcp"
          title={i18n('widgets.manage')}
          aria-label={i18n('widgets.manage')}
          className={widgetButtonClass({ iconOnly: true })}
        >
          <Settings2 className="size-3.5" />
        </Link>
      </div>
      {allMcp.length === 0 ? (
        <p className="text-[11.5px] text-muted-foreground/70">
          Aucun serveur MCP — ajoute-en depuis{' '}
          <Link prefetch={false} href="/mcp" className="text-primary">
            /mcp
          </Link>
          .
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {allMcp.map((m) => {
            const isExternal = m.source === 'claude_ai' || m.transport_type === 'external';
            // Externals are enabled by default; "on" means not in the
            // exclusion set. ROOKS-managed are off by default; "on" means
            // explicitly listed in mcp_servers.
            const on = isExternal ? !excludedMcp.has(m.id) : activeMcp.has(m.id);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onToggleMcp(m.id)}
                title={
                  isExternal
                    ? `${i18n(`mcpPage.external.${m.source === 'claude_ai' ? 'claudeAi' : 'claudeCli'}.badge`)} · ${m.tools_count} tool${m.tools_count === 1 ? '' : 's'} · toggle to deny via --disallowedTools`
                    : `${m.transport_type} · ${m.tools_count} tool${m.tools_count === 1 ? '' : 's'}`
                }
                className={cn(
                  'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                  isExternal && 'border-dashed',
                  on
                    ? 'border-primary bg-primary/15 text-primary'
                    : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground',
                )}
              >
                {m.name || m.id}
                <span className="ml-1.5 text-[9.5px] opacity-70">
                  ({m.tools_count})
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
