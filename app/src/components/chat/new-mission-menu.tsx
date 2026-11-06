'use client';

import { cloneElement, useEffect, useRef, useState, type MouseEvent, type ReactElement } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';

import { t } from '@/lib/i18n';
import { resolveRole } from '@/lib/roles';
import { AgentAvatar, type AgentIdentity } from '@/components/agent-avatar';
import type { NewMissionChoice } from '@/lib/new-mission-agents';
import { NativeViewCover } from '@/lib/native-view-cover';

/** What the chat hands its New buttons: the project's agents, and what a pick does. */
export type NewMissionOptions = {
  choices: NewMissionChoice[];
  identityOf: (name: string) => AgentIdentity;
  onPick: (agent: string) => void;
};

const ITEM = 'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none focus:bg-muted data-[state=checked]:bg-primary/[0.08]';

/**
 * A New button that asks which agent of the project starts the mission
 * (TODO #344). `children` is the button, without its own `onClick`.
 *
 * With fewer than two agents to offer (no project, an agent alone in its
 * project, a chat embedded elsewhere) the button keeps its one click and
 * starts on the agent open. Otherwise it opens the list with the open agent
 * checked AND focused, so Enter repeats the old gesture.
 */
export function NewMissionMenu({
  current,
  options,
  onNew,
  children,
}: {
  current: string;
  options?: NewMissionOptions | null;
  onNew: () => void;
  children: ReactElement<{ onClick?: (e: MouseEvent<HTMLElement>) => void }>;
}) {
  const currentItem = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  // Radix focuses the list itself (or its first row) once it opens; the open
  // agent takes the focus back on the next frame.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => currentItem.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  if (!options || options.choices.length < 2) return cloneElement(children, { onClick: () => onNew() });
  const { choices, identityOf, onPick } = options;
  return (
    <Dropdown.Root open={open} onOpenChange={setOpen}>
      <Dropdown.Trigger asChild>{children}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="end"
          sideOffset={6}
          aria-label={t('chatPage.newMissionWith')}
          className="z-50 max-h-80 min-w-56 overflow-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-elev-2"
        >
          <NativeViewCover />
          <Dropdown.Label className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
            {t('chatPage.newMissionWith')}
          </Dropdown.Label>
          {/* Radix calls `onValueChange` on every pick, the checked one
              included: that pick starts the open agent afresh. */}
          <Dropdown.RadioGroup value={current} onValueChange={(name) => (name === current ? onNew() : onPick(name))}>
            {choices.map((c) => {
              const role = resolveRole(c.role);
              return (
                <Dropdown.RadioItem
                  key={c.name}
                  value={c.name}
                  ref={c.name === current ? currentItem : undefined}
                  className={ITEM}
                >
                  <AgentAvatar identity={identityOf(c.name)} size="sm" live={false} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium" title={c.name}>{c.name}</span>
                    {role && <span className="truncate text-[10.5px] text-muted-foreground">{role.label}</span>}
                  </span>
                  <Dropdown.ItemIndicator>
                    <Check className="size-3.5 text-primary" />
                  </Dropdown.ItemIndicator>
                </Dropdown.RadioItem>
              );
            })}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
