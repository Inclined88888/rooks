'use client';

/**
 * The team dialog of the bots rail: create a team, or rename one.
 *
 * The rail opens it from its foot ("New team") and from the menu of a team's
 * heading. A team carries no colour any more in the rail: the sections read
 * as plain headings, so the dialog asks for a name alone and leaves the stored
 * colour as it is.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/lib/i18n';
import { createTeam, deleteTeam, updateTeam } from './teams-api';
import type { Team } from './types';

/** `team: null` creates one. */
export type TeamEditing = { team: Team | null };

export function TeamDialog({ open, editing, onClose, onChanged }: {
  open: boolean;
  editing: TeamEditing | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setName(editing?.team?.name ?? ''); }, [open, editing]);

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (!editing || trimmed.length === 0) return;
    setBusy(true);
    const error = editing.team
      ? await updateTeam(editing.team.id, { name: trimmed })
      : await createTeam(trimmed, null);
    setBusy(false);
    if (error) { toast.error(error); return; }
    toast.success(editing.team ? t('bots.teamRenamed') : t('bots.teamCreated'));
    onClose();
    await onChanged();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {editing?.team ? t('bots.renameTeam') : t('bots.newTeam')}
          </DialogTitle>
          <DialogDescription className="text-[12px]">{t('bots.teamsExplain')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="bots-team-name" className="text-[11px]">{t('bots.teamName')}</Label>
          <Input
            id="bots-team-name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
        </div>
        <DialogFooter>
          <Button size="sm" disabled={busy || name.trim().length === 0} onClick={() => { void submit(); }}>
            {editing?.team ? t('bots.save') : t('bots.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Deleting a team deletes no bot: the daemon puts its members back outside any team. */
export async function removeTeam(team: Team, onChanged: () => Promise<void>): Promise<void> {
  const error = await deleteTeam(team.id);
  if (error) { toast.error(error); return; }
  toast.success(t('bots.teamDeleted', { team: team.name }));
  await onChanged();
}
