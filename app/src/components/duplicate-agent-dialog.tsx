'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { announceAgentsChanged } from '@/lib/agents-changed';
import { duplicateAgent, duplicateNameProblem, listAgentNames } from '@/lib/agent-duplicate';
import { t } from '@/lib/i18n';

/**
 * Asks for the name of the copy of `source`, then creates it. The user edits
 * the new agent by hand afterwards: nothing is opened or pre-filled for them.
 * Shared by the chat avatars' menu and the Agents page's node menu.
 */
export function DuplicateAgentDialog({ source, onClose }: { source: string; onClose: () => void }) {
  const [name, setName] = useState(source + '-copy');
  const [existing, setExisting] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void listAgentNames().then((names) => { if (alive) setExisting(names); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const problem = duplicateNameProblem(name, existing);
  // An empty field is not an error to shout about: the button just stays off.
  const shown = problem && problem !== 'empty' ? t('agentChat.duplicate.' + problem) : failure;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (problem || busy) return;
    setBusy(true);
    setFailure(null);
    const result = await duplicateAgent(source, name);
    setBusy(false);
    if (result.ok) {
      if (result.skillsNotCopied?.length) {
        toast.warning(t('agentChat.duplicate.skillsNotCopied', { source, name: result.name, skills: result.skillsNotCopied.join(', ') }));
      } else {
        toast.success(t('agentChat.duplicate.done', { source, name: result.name }));
      }
      announceAgentsChanged();
      onClose();
      return;
    }
    if ('problem' in result) {
      // Taken between the dialog's list and the click: refresh it and say so.
      void listAgentNames().then(setExisting).catch(() => {});
      setFailure(result.problem === 'empty' ? null : t('agentChat.duplicate.' + result.problem));
      return;
    }
    setFailure(t('agentChat.duplicate.failed', { error: result.error }));
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogTitle>{t('agentChat.duplicate.title', { name: source })}</DialogTitle>
        <DialogDescription>{t('agentChat.duplicate.description')}</DialogDescription>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-[12px] font-medium">
            {t('agentChat.duplicate.nameLabel')}
            <Input
              autoFocus
              required
              maxLength={64}
              value={name}
              aria-invalid={!!shown}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => { setName(e.target.value); setFailure(null); }}
            />
          </label>
          {shown && <p role="alert" className="text-[12px] text-destructive">{shown}</p>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('agentChat.duplicate.cancel')}</Button>
            <Button type="submit" disabled={busy || !!problem}>{t('agentChat.duplicate.confirm')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
