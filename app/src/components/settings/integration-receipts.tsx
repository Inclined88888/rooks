'use client';

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/intl';
import { cn } from '@/lib/utils';
import {
  byAttention, discardReceipt, loadIntegrationReceipts, replayFailedReceipts, replayReceipt,
  type IntegrationReceipt, type IntegrationReceiptConnection,
} from '@/lib/integration-receipts';

function Count({ value, label, tone }: { value: number; label: string; tone?: string }): ReactElement | null {
  if (value === 0) return null;
  return <span className={cn('rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums', tone)}>{t(label, { count: value })}</span>;
}

function ReceiptRow({ receipt, busy, act }: {
  receipt: IntegrationReceipt;
  busy: boolean;
  act: (work: () => Promise<Response>, success: string) => Promise<void>;
}): ReactElement {
  const failed = receipt.status === 'failed';
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/30 px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate text-[12px]">{receipt.preview || receipt.externalId}</p>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {t(`integrationReceipts.stage.${receipt.stage}`)}
          {' · '}
          {t(failed ? 'integrationReceipts.gaveUp' : 'integrationReceipts.attempts', {
            count: receipt.attempts, date: formatDateTime(receipt.failedAt ?? receipt.createdAt),
          })}
        </p>
        {receipt.lastError && <p className="break-words text-[11px] text-destructive">{receipt.lastError}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" disabled={busy}
          onClick={() => void act(() => replayReceipt(receipt.id), 'integrationReceipts.replayed')}>
          {t('integrationReceipts.replay')}
        </Button>
        {failed && (
          <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px] text-destructive" disabled={busy}
            onClick={() => { void confirmAction({ title: t('integrationReceipts.discardConfirm'), confirmLabel: t('confirmDialog.discard'), destructive: true }).then((yes) => { if (yes) void act(() => discardReceipt(receipt.id), 'integrationReceipts.discarded'); }); }}>
            {t('integrationReceipts.discard')}
          </Button>
        )}
      </div>
    </div>
  );
}

function ConnectionBlock({ connection, onChanged }: { connection: IntegrationReceiptConnection; onChanged: () => void }): ReactElement {
  const [busy, setBusy] = useState(false);
  const act = useCallback(async (work: () => Promise<Response>, success: string) => {
    setBusy(true);
    const response = await work().catch(() => null);
    setBusy(false);
    if (!response?.ok) { toast.error(t('integrationReceipts.actionError')); onChanged(); return; }
    toast.success(t(success));
    onChanged();
  }, [onChanged]);
  const { counts } = connection;
  return (
    <section className="space-y-2">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-[13px] font-medium">{connection.transport}</h4>
            {!connection.enabled && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t('integrationReceipts.disabled')}</span>}
            <Count value={counts.failed} label="integrationReceipts.countFailed" tone="bg-destructive/15 text-destructive" />
            <Count value={counts.retrying} label="integrationReceipts.countRetrying" tone="bg-amber-500/15 text-amber-700 dark:text-amber-300" />
            <Count value={counts.queued} label="integrationReceipts.countQueued" />
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            {t('integrationReceipts.handledBy', { agent: connection.agent })}
            {connection.owner && <> · {t('integrationReceipts.ownedBy', { name: connection.owner.name ?? connection.owner.email ?? connection.owner.id })}</>}
          </p>
        </div>
        {counts.failed > 1 && (
          <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 text-[12px]" disabled={busy}
            onClick={() => void act(() => replayFailedReceipts(connection.id), 'integrationReceipts.replayedAll')}>
            {t('integrationReceipts.replayAll', { count: counts.failed })}
          </Button>
        )}
      </div>
      {connection.receipts.map((receipt) => <ReceiptRow key={receipt.id} receipt={receipt} busy={busy} act={act} />)}
    </section>
  );
}

/**
 * Settings › Connections: the messages a messaging integration could not
 * process, and the gesture that sends them back. Hidden without a connection:
 * most installs have none, and an empty section would only add noise.
 */
export function IntegrationReceiptsSettings(): ReactElement | null {
  const [connections, setConnections] = useState<IntegrationReceiptConnection[]>([]);
  const refresh = useCallback(() => {
    void loadIntegrationReceipts().then((next) => { if (next) setConnections(next); }).catch(() => undefined);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  if (connections.length === 0) return null;
  const healthy = connections.every(({ counts }) => counts.failed === 0 && counts.retrying === 0);
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[13px] font-medium">{t('integrationReceipts.title')}</h3>
        <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('integrationReceipts.description')}</p>
      </div>
      {healthy && <p className="text-[12px] text-muted-foreground">{t('integrationReceipts.healthy')}</p>}
      {byAttention(connections).map((connection) => <ConnectionBlock key={connection.id} connection={connection} onChanged={refresh} />)}
    </section>
  );
}
