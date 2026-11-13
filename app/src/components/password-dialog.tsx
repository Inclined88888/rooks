'use client';

/**
 * secu-9 — self-service password rotation, from the header chip.
 *
 * Deliberately minimal and reachable by ANY signed-in account: the whole
 * point of the finding is that needing a superadmin to rotate a password
 * pushes people towards sharing credentials. Every other session of the
 * account is dropped daemon-side, so the form warns about it.
 */
import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/lib/i18n';

const MIN_PASSWORD = 8;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function PasswordDialog({ open, onOpenChange }: Props): ReactElement {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  function reset(): void {
    setCurrent('');
    setNext('');
    setConfirm('');
  }

  async function submit(): Promise<void> {
    if (next.length < MIN_PASSWORD) {
      toast.error(t('session.passwordTooShort', { min: String(MIN_PASSWORD) }));
      return;
    }
    if (next !== confirm) {
      toast.error(t('session.passwordMismatch'));
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/ui/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current_password: current, password: next }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        toast.error((err as { error?: string }).error ?? t('session.passwordError'));
        return;
      }
      toast.success(t('session.passwordChanged'));
      reset();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => { if (!value) reset(); onOpenChange(value); }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t('session.changePassword')}</DialogTitle>
          <DialogDescription>{t('session.passwordHint')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="current-password">{t('session.currentPassword')}</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => { setCurrent(e.target.value); }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-password">{t('session.newPassword')}</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => { setNext(e.target.value); }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-password">{t('session.confirmPassword')}</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); }}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || current.length === 0 || next.length === 0}>
              {busy ? t('session.passwordSaving') : t('session.changePassword')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
