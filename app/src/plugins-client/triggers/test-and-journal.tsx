'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/intl';
import { requestJson, triggerApi } from './api';
import { isScriptRun, type ActionOutcome, type Delivery, type DeliveryStatus, type ScriptRun, type TriggerPublic } from './model';
import { TriggerModal, TriggerModalTitle } from './modal';
import { INPUT } from './trigger-editor';

const STATUS_TONE: Record<DeliveryStatus, string> = {
  received: 'border-[hsl(var(--success)/0.4)] text-[hsl(var(--success))]',
  test: 'border-[hsl(var(--success)/0.4)] text-[hsl(var(--success))]',
  ignored: 'border-border text-muted-foreground',
  coalesced: 'border-border text-muted-foreground',
  duplicate: 'border-border text-muted-foreground',
  error: 'border-destructive/50 text-destructive',
  rejected: 'border-destructive/50 text-destructive',
};

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const tone = status in STATUS_TONE ? STATUS_TONE[status as DeliveryStatus] : 'border-border text-muted-foreground';
  return <span className={cn('rounded border px-1.5 py-0.5 text-[10.5px]', tone)}>{t(`triggersPage.status.${status}`)}</span>;
}

function Outcomes({ outcomes }: { outcomes: readonly ActionOutcome[] }): React.ReactElement {
  return (
    <ul className="space-y-1.5">
      {outcomes.map((outcome, index) => (
        <li key={index} className="text-[12px]">
          <span className="font-medium">{t(`triggersPage.actions.${outcome.type}`)}</span>{' — '}
          {outcome.ok
            ? (outcome.preview
              // code-font: the JSON preview of the action
              ? <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px]">{JSON.stringify(outcome.preview, null, 2)}</pre>
              : t('triggersPage.test.done', { id: outcome.id === null ? '—' : String(outcome.id) }))
            : <span className="text-destructive">{outcome.error}</span>}
        </li>
      ))}
    </ul>
  );
}

/** How a script run ended: exit code, duration, the end of what it printed. */
function ScriptRunResult({ run }: { run: ScriptRun }): React.ReactElement {
  const outcome = run.timed_out ? t('triggersPage.journal.scriptTimedOut')
    : run.code === null ? t('triggersPage.journal.scriptNotStarted')
      : t('triggersPage.journal.scriptExit', { code: run.code });
  return (
    <div className="space-y-1 text-[12px]">
      <p>
        <span className="font-medium">{t('triggersPage.actions.script')}</span>{' — '}{outcome}
        {' · '}<span className="tabular-nums">{t('triggersPage.journal.scriptDuration', { s: (run.duration_ms / 1000).toFixed(1) })}</span>
      </p>
      {[run.stderr_tail, run.stdout_tail].filter(Boolean).map((text, index) => (
        // code-font: program output
        <pre key={index} className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px]">{text}</pre>
      ))}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): React.ReactElement {
  return (
    <TriggerModal onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <TriggerModalTitle>{title}</TriggerModalTitle>
        <button type="button" onClick={onClose} aria-label={t('routinesPage.close')} className="text-muted-foreground hover:text-foreground">✕</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pr-1">{children}</div>
    </TriggerModal>
  );
}

type TestAnswer = { status: string; reason?: string; outcomes?: ActionOutcome[] };

function parseObject(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text.trim()) return { ok: true, value: undefined };
  try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false }; }
}

/**
 * "Send an example": a pasted payload goes through the trigger's filter and
 * templates. A dry run by default — it shows what the actions would create;
 * running them for real is a choice, logged in the journal as a test.
 */
export function TestDialog({ trigger, onClose }: { trigger: TriggerPublic; onClose: () => void }): React.ReactElement {
  const [payload, setPayload] = useState('');
  const [headers, setHeaders] = useState('');
  const [execute, setExecute] = useState(false);
  const [sending, setSending] = useState(false);
  const [answer, setAnswer] = useState<TestAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasPayload = trigger.source !== 'schedule';

  async function send() {
    setError(null);
    setAnswer(null);
    const body = parseObject(payload);
    if (!body.ok) { setError(t('triggersPage.test.badPayload')); return; }
    const head = parseObject(headers);
    const headerValue = head.ok ? head.value : null;
    if (!head.ok || (headerValue !== undefined && (typeof headerValue !== 'object' || headerValue === null || Array.isArray(headerValue)
      || !Object.values(headerValue).every((v) => typeof v === 'string')))) {
      setError(t('triggersPage.test.badHeaders'));
      return;
    }
    setSending(true);
    const res = await requestJson<TestAnswer>('POST', triggerApi(trigger.id, 'test'), {
      ...(hasPayload && body.value !== undefined ? { payload: body.value } : {}),
      ...(hasPayload && headerValue !== undefined ? { headers: headerValue } : {}),
      ...(execute ? { execute: true } : {}),
    });
    setSending(false);
    if (!res.ok) { setError(res.error); return; }
    setAnswer(res.data);
  }

  return (
    <Modal title={t('triggersPage.test.title', { name: trigger.name })} onClose={onClose}>
      <div className="space-y-3">
        {hasPayload ? (
          <>
            <div>
              <label htmlFor="trigger-test-payload" className="mb-1 block text-[11px] text-muted-foreground">{t('triggersPage.test.payload')}</label>
              <textarea
                id="trigger-test-payload" rows={8} value={payload} onChange={(e) => setPayload(e.target.value)}
                // code-font: a JSON payload
                className={cn(INPUT, 'font-mono text-xs')} spellCheck={false}
                placeholder={'{\n  "action": "opened",\n  "issue": { "title": "Crash on start" }\n}'}
              />
            </div>
            {trigger.source === 'webhook' && (
              <div>
                <label htmlFor="trigger-test-headers" className="mb-1 block text-[11px] text-muted-foreground">{t('triggersPage.test.headers')}</label>
                <textarea
                  id="trigger-test-headers" rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)}
                  // code-font: JSON headers
                  className={cn(INPUT, 'font-mono text-xs')} spellCheck={false} placeholder={'{ "X-GitHub-Event": "issues" }'}
                />
              </div>
            )}
          </>
        ) : (
          <p className="text-[12px] text-muted-foreground">{t('triggersPage.test.schedule')}</p>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={execute} onChange={(e) => setExecute(e.target.checked)} />
          {t('triggersPage.test.execute')}
        </label>
        <p className="text-[11px] text-muted-foreground">{t(execute ? 'triggersPage.test.executeHint' : 'triggersPage.test.dryRunHint')}</p>
        <div className="flex justify-end">
          <Button type="button" size="sm" disabled={sending} onClick={() => void send()}>{t('triggersPage.test.send')}</Button>
        </div>
        {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
        {answer && (
          <div className="space-y-2 rounded-lg border border-border p-3" data-testid="trigger-test-result">
            <StatusBadge status={answer.status} />
            {answer.status === 'ignored' && <p className="text-[12px] text-muted-foreground">{t('triggersPage.test.ignored')}</p>}
            {answer.outcomes && <Outcomes outcomes={answer.outcomes} />}
          </div>
        )}
      </div>
    </Modal>
  );
}

function fmtTime(ms: number): string {
  return formatDateTime(ms, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** The last calls of a trigger: received, ignored, error, duplicate… */
export function JournalDialog({ trigger, onClose }: { trigger: TriggerPublic; onClose: () => void }): React.ReactElement {
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const res = await requestJson<{ deliveries: Delivery[] }>('GET', `${triggerApi(trigger.id, 'deliveries')}?limit=50`);
    if (res.ok) { setRows(res.data.deliveries); setError(null); } else setError(res.error);
  }, [trigger.id]);
  useEffect(() => { void load(); }, [load]);

  return (
    <Modal title={t('triggersPage.journal.title', { name: trigger.name })} onClose={onClose}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">{t('triggersPage.journal.hint')}</p>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => void load()}>{t('triggersPage.journal.refresh')}</Button>
      </div>
      {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
      {rows === null && !error && <p className="text-[12px] text-muted-foreground">{t('triggersPage.loading')}</p>}
      {rows?.length === 0 && <p className="text-[12px] text-muted-foreground">{t('triggersPage.journal.empty')}</p>}
      <ol className="space-y-2" data-testid="trigger-journal">
        {rows?.map((row) => (
          <li key={row.id} className="rounded-lg border border-border px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
              <StatusBadge status={row.status} />
              <span className="tabular-nums text-muted-foreground">{fmtTime(row.at)}</span>
              {row.reason && <span className="text-muted-foreground">{row.reason}</span>}
              {/* code-font: a delivery key */}
              {row.delivery_key && <span className="truncate font-mono text-[10.5px] text-muted-foreground/70">{row.delivery_key}</span>}
            </div>
            {isScriptRun(row.result)
              ? <div className="mt-1.5"><ScriptRunResult run={row.result} /></div>
              : row.result && row.result.length > 0 && <div className="mt-1.5"><Outcomes outcomes={row.result} /></div>}
            {row.excerpt && (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-[11px] text-muted-foreground">{t('triggersPage.journal.payload')}</summary>
                {/* code-font: a payload excerpt */}
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px]">{row.excerpt}</pre>
              </details>
            )}
          </li>
        ))}
      </ol>
    </Modal>
  );
}
