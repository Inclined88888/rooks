'use client';

import { Settings2 } from 'lucide-react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { widgetButtonClass } from '@/components/widget-toolbar';
import { t } from '@/lib/i18n';
import type { WorkingAgentsOptions, WorkingAgentsShow } from '@/lib/working-agents';
import { NativeViewCover } from '@/lib/native-view-cover';

const ITEM = 'flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 outline-none focus:bg-muted data-[disabled]:cursor-default data-[disabled]:opacity-50';

/**
 * What the widget shows: the agents at work or every agent, the orchestrators
 * only, one tab per agent or per project. The menu stays open on a choice —
 * these are usually set together.
 */
export function WorkingAgentsOptionsMenu({ options, onChange, disabled }: {
  options: WorkingAgentsOptions;
  onChange: (patch: Partial<WorkingAgentsOptions>) => void;
  /** The stored row has not answered yet: a write now could overwrite it. */
  disabled: boolean;
}) {
  const keep = (e: Event) => e.preventDefault();
  const check = (key: 'orchestratorOnly' | 'groupByProject' | 'projectHoverList', label: string, enabled = true) => (
    <Dropdown.CheckboxItem
      checked={options[key]}
      disabled={disabled || !enabled}
      onSelect={keep}
      onCheckedChange={(v) => onChange({ [key]: v === true })}
      className={ITEM}
      data-option={key}
    >
      <span className="w-3">{options[key] ? '✓' : ''}</span>{label}
    </Dropdown.CheckboxItem>
  );
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        {/* A plain button: Radix anchors the menu through a ref, which a
            function component does not forward on React 18. */}
        <button type="button" data-working-agents-options title={t('workingAgents.options')} aria-label={t('workingAgents.options')} className={widgetButtonClass({ iconOnly: true })}>
          <Settings2 className="size-3" />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          sideOffset={6}
          align="end"
          // Portalled, but React events still bubble through the card: a press
          // in the menu must not start a drag of the widget.
          onPointerDown={(e) => e.stopPropagation()}
          className="z-50 min-w-52 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-elev-2"
        >
          <NativeViewCover />
          <Dropdown.Label className="px-2 py-1.5 font-medium">{t('workingAgents.show')}</Dropdown.Label>
          <Dropdown.RadioGroup value={options.show} onValueChange={(v) => onChange({ show: v as WorkingAgentsShow })}>
            {(['working', 'all'] as const).map((value) => (
              <Dropdown.RadioItem key={value} value={value} disabled={disabled} onSelect={keep} className={ITEM} data-option={`show-${value}`}>
                <span className="w-3">{options.show === value ? '•' : ''}</span>{t(value === 'working' ? 'workingAgents.showWorking' : 'workingAgents.showAll')}
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
          <div className="mt-1.5">
            {check('orchestratorOnly', t('workingAgents.orchestratorOnly'))}
            {check('groupByProject', t('workingAgents.groupByProject'))}
            {check('projectHoverList', t('workingAgents.projectHoverList'), options.groupByProject)}
          </div>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
