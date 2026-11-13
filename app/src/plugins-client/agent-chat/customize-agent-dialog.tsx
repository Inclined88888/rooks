'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { LogoField } from '@/components/logo-field';
import { t } from '@/lib/i18n';
import type { Personnalisation } from './instances';
import type { Visage } from './use-agents';

/**
 * Nickname and photo of one agent, on this card only: the agent itself is not
 * touched (that is "Edit agent"). Both fields empty put the agent's own name
 * and picture back.
 */
export function CustomizeAgentDialog({
  agent,
  initial,
  visage,
  onSave,
  onClose,
}: {
  agent: string;
  initial: Personnalisation;
  /** The agent's own face, for the preview when the card has no photo of its own. */
  visage: Visage;
  onSave: (value: Personnalisation) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(initial.label);
  const [avatar, setAvatar] = useState(initial.avatar);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      {/* Wide enough for the photo buttons to share one row, and told not to wrap. */}
      <DialogContent className="max-w-md [&_.flex-wrap]:flex-nowrap">
        <DialogTitle>{t('agentChat.customize.title')}</DialogTitle>
        <DialogDescription>{t('agentChat.customize.description', { name: agent })}</DialogDescription>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSave({ label, avatar });
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {t('agentChat.customize.nickname')}
            </span>
            <Input value={label} placeholder={agent} onChange={(e) => setLabel(e.target.value)} autoFocus />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {t('agentChat.customize.photo')}
            </span>
            <LogoField
              value={avatar || visage.image || ''}
              onChange={setAvatar}
              accent={visage.couleur}
              fallback={visage.glyphe}
              withValueInput={false}
              size={72}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm">{t('agentChat.customize.save')}</Button>
            <Button type="button" size="sm" variant="outline" onClick={onClose}>{t('agentChat.config.cancel')}</Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto text-muted-foreground"
              onClick={() => { setLabel(''); setAvatar(''); }}
            >
              {t('agentChat.customize.reset')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
