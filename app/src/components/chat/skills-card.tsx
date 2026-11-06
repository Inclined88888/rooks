'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Settings2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { widgetButtonClass } from '@/components/widget-toolbar';
import { t as i18n } from '@/lib/i18n';
import { BRAND } from '@/lib/brand';
import type { Agent, SkillItem, SkillSource } from './chat-types';

/** Skill display sections (panel + popup), in order. */
// Project first, like the composer's slash popup: the rail and the popup
// disagreeing on what comes first is how one learns to trust neither.
const SKILL_SECTIONS: { source: SkillSource; label: string }[] = [
  { source: 'project', label: 'Project' },
  { source: 'timon', label: BRAND.displayName },
  { source: 'claude-user', label: 'Global' },
  { source: 'plugin', label: 'Plugins' },
];

/** Number of skills shown per section before collapsing the rest behind an
 *  arrow (≈ 2 lines in the right panel's narrow column). */
const SKILL_COLLAPSED = 6;

/**
 * The agent's skills — extracted verbatim from `MissionInfoPanel`.
 *
 * The "manage" link was the action of the section header; a card's header
 * belongs to the host (handle, close cross), so it moves back into the body.
 */
export function SkillsCard({
  agent,
  allSkills,
  onToggleSkill,
}: {
  agent: Agent;
  allSkills: SkillItem[];
  onToggleSkill: (id: string) => void;
}) {
  const [expandedSkills, setExpandedSkills] = useState<Set<SkillSource>>(new Set());
  const activeSkills = new Set(agent.skills || []);

  return (
    <div className="px-3 pb-3">
      <div className="flex h-9 items-center justify-end">
        <Link
          prefetch={false}
          href="/skills"
          title={i18n('widgets.manage')}
          aria-label={i18n('widgets.manage')}
          className={widgetButtonClass({ iconOnly: true })}
        >
          <Settings2 className="size-3.5" />
        </Link>
      </div>
      {allSkills.length === 0 ? (
        <p className="text-[11.5px] text-muted-foreground/70">
          No skills installed — create one from{' '}
          <Link prefetch={false} href="/skills" className="text-primary">
            /skills
          </Link>
          .
        </p>
      ) : (
        <div className="space-y-2.5">
          {SKILL_SECTIONS.map((sec) => {
            const items = allSkills.filter((s) => s.source === sec.source && !s.shadowed);
            if (items.length === 0) return null;
            const expanded = expandedSkills.has(sec.source);
            const collapsible = items.length > SKILL_COLLAPSED;
            const shown = expanded || !collapsible ? items : items.slice(0, SKILL_COLLAPSED);
            return (
              <div key={sec.source}>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                    {sec.label}
                  </span>
                  {collapsible && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedSkills((prev) => {
                          const next = new Set(prev);
                          if (next.has(sec.source)) next.delete(sec.source);
                          else next.add(sec.source);
                          return next;
                        })
                      }
                      className="inline-flex items-center gap-0.5 text-[9.5px] text-muted-foreground/70 hover:text-foreground"
                    >
                      {expanded ? (
                        <>
                          {i18n('chatPage.less')} <ChevronDown className="size-3" />
                        </>
                      ) : (
                        <>
                          +{items.length - SKILL_COLLAPSED} <ChevronRight className="size-3" />
                        </>
                      )}
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {shown.map((s) => {
                    const timon = s.source === 'timon';
                    const on = timon && activeSkills.has(s.id);
                    return (
                      <button
                        key={s.source + ':' + s.id}
                        type="button"
                        onClick={() => onToggleSkill(s.id)}
                        title={timon
                          ? (on ? i18n('chatPage.attachedClickToDetach') : i18n('chatPage.clickToAttach'))
                          : s.source === 'project'
                            ? i18n('chatPage.availableNatively')
                            : i18n('skillMission.notAttachable', { brand: BRAND.displayName })}
                        className={cn(
                          'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                          on
                            ? 'border-primary bg-primary/15 text-primary'
                            : timon
                              ? 'border-border bg-muted/40 text-muted-foreground hover:text-foreground'
                              : 'cursor-default border-dashed border-border/70 bg-transparent text-muted-foreground/70',
                        )}
                      >
                        /{s.id}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
