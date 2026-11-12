'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SlotKeyed, useSlotEntry } from '@/lib/plugin-host/render';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  connectionAction, connectionChanges, createConnection, deleteConnection, patchConnection, reopensApproval, updateConnection,
  type ConnectionInput, type ConnectionSubmitResult, type ConnectionType, type UserConnection,
} from '@/lib/plugin-connections';
import { ConnectionFormProvider, type ConnectionFormContext } from './connection-form-slot';
import { IntegrationReceiptsSettings } from './integration-receipts';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';

const FORM_SLOT = 'settings.connection.form';
const input = 'h-7 w-full rounded-md border border-border bg-background px-2 text-[12px]';

function StatusChip({ connection }: { connection: UserConnection }): ReactElement {
  const tone = !connection.enabled ? 'bg-muted text-muted-foreground'
    : connection.approval === 'approved' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : connection.approval === 'rejected' ? 'bg-destructive/15 text-destructive' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[11px]', tone)}>
      {connection.enabled ? t(`pluginConnections.status.${connection.approval}`) : t('pluginConnections.status.disabled')}
    </span>
  );
}

/** A stored config value as the text of its field. */
const fieldText = (value: unknown) => (value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));

/**
 * Default form: URL, the type's fields, its secrets as password inputs. On an
 * existing connection it opens prefilled, except for the secrets: the daemon
 * never sends a value back, so an empty key field keeps the stored key.
 */
function GenericForm({ type, initial, approvalRequired, onSubmit, onCancel }: {
  type: ConnectionType;
  initial: UserConnection | null;
  approvalRequired: boolean;
  onSubmit: (input: ConnectionInput) => Promise<boolean>;
  onCancel: () => void;
}): ReactElement {
  const [label, setLabel] = useState(initial?.label ?? type.label);
  const [url, setUrl] = useState(initial?.url ?? '');
  const [allowPrivateNetwork, setAllowPrivate] = useState(initial?.allowPrivateNetwork ?? false);
  const [config, setConfig] = useState<Record<string, string>>(() => Object.fromEntries(
    type.fields.map((field) => [field.key, fieldText(initial?.config[field.key])]),
  ));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const editing = initial !== null;
  const reapproval = editing && approvalRequired && reopensApproval(initial, connectionChanges(initial, { label, url, allowPrivateNetwork }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const filled = Object.fromEntries(Object.entries(config).filter(([, value]) => value.trim() !== ''));
    // Keys the plugin stores but shows no field for stay as they were.
    const hidden = Object.fromEntries(Object.entries(initial?.config ?? {}).filter(([key]) => !type.fields.some((field) => field.key === key)));
    const keys = Object.fromEntries(Object.entries(secrets).filter(([, value]) => value !== ''));
    const ok = await onSubmit({ label, url, allowPrivateNetwork, config: { ...hidden, ...filled }, secrets: keys });
    setBusy(false);
    if (ok) setSecrets({});
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 rounded-md bg-muted/30 p-3">
      <label className="block space-y-1">
        <span className="text-[12px] font-medium">{t('pluginConnections.label')}</span>
        <input className={input} value={label} maxLength={80} required onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="text-[12px] font-medium">{t('pluginConnections.url')}</span>
        <input className={input} type="url" value={url} required placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
      </label>
      {type.fields.map((field) => (
        <label key={field.key} className="block space-y-1">
          <span className="text-[12px] font-medium">{field.label}</span>
          <input className={input} value={config[field.key] ?? ''} required={field.required} placeholder={field.placeholder}
            onChange={(e) => setConfig((all) => ({ ...all, [field.key]: e.target.value }))} />
        </label>
      ))}
      {type.secrets.map((field) => {
        const stored = initial?.secrets.includes(field.name) ?? false;
        return (
          <label key={field.name} className="block space-y-1">
            <span className="text-[12px] font-medium">{field.label}</span>
            <input className={input} type="password" autoComplete="new-password" value={secrets[field.name] ?? ''}
              required={field.required && !stored} placeholder={stored ? t('pluginConnections.secretKeep') : undefined}
              onChange={(e) => setSecrets((all) => ({ ...all, [field.name]: e.target.value }))} />
          </label>
        );
      })}
      {type.secrets.length > 0 && <p className="text-[11px] text-muted-foreground">{t('pluginConnections.secretHint')}</p>}
      <label className="flex items-start gap-2 text-[12px]">
        <input type="checkbox" className="mt-0.5" checked={allowPrivateNetwork} onChange={(e) => setAllowPrivate(e.target.checked)} />
        <span>
          {t('pluginConnections.privateNetwork')}
          <span className="block text-[11px] text-muted-foreground">{t('pluginConnections.privateNetworkHint')}</span>
        </span>
      </label>
      {editing && approvalRequired && (
        <p role="note" className={cn('text-[11px] leading-snug', reapproval ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>
          {t(reapproval ? 'pluginConnections.reapprovalNow' : 'pluginConnections.reapprovalHint')}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={onCancel}>{t('pluginConnections.cancel')}</Button>
        <Button type="submit" size="sm" className="h-7 text-[12px]" disabled={busy}>{t('pluginConnections.save')}</Button>
      </div>
    </form>
  );
}

/** The type's own form when its plugin registered one, the generic one otherwise. */
function ConnectionForm({ type, custom, initial, approvalRequired, submit, cancel }: {
  type: ConnectionType;
  custom: boolean;
  initial: UserConnection | null;
  approvalRequired: boolean;
  submit: (input: ConnectionInput) => Promise<ConnectionSubmitResult>;
  cancel: () => void;
}): ReactElement {
  const context = useMemo<ConnectionFormContext>(() => ({
    type, mode: initial ? 'edit' : 'create', initial, approvalRequired, submit, cancel,
  }), [approvalRequired, cancel, initial, submit, type]);
  return custom
    ? <ConnectionFormProvider value={context}><SlotKeyed name={FORM_SLOT} entryKey={type.id} /></ConnectionFormProvider>
    : <GenericForm type={type} initial={initial} approvalRequired={approvalRequired} onCancel={cancel} onSubmit={async (value) => (await submit(value)).ok} />;
}

function ConnectionRow({ connection, onChanged, onEdit }: { connection: UserConnection; onChanged: () => void; onEdit: () => void }): ReactElement {
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<Response>, success?: string) => {
    setBusy(true);
    const response = await work();
    setBusy(false);
    if (!response.ok) { toast.error(t('pluginConnections.actionError')); return null; }
    if (success) toast.success(t(success));
    onChanged();
    return response;
  };
  const test = async () => {
    setBusy(true);
    const response = await connectionAction(connection.id, 'test');
    setBusy(false);
    const body = await response.json().catch(() => ({})) as { ok?: boolean; message?: string; status?: number };
    if (response.ok && body.ok) toast.success(body.message ?? t('pluginConnections.testOk'));
    else toast.error(body.message ?? t('pluginConnections.testFailed'));
  };
  const usable = connection.enabled && connection.approval === 'approved';
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/30 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{connection.label}</span>
          <StatusChip connection={connection} />
        </div>
        <p className="truncate text-[11px] text-muted-foreground">
          {connection.url}
          {connection.allowPrivateNetwork && <> · {t('pluginConnections.privateShort')}</>}
        </p>
        {connection.enabled && connection.approval === 'pending' && (
          <p className="text-[11px] text-muted-foreground">{t('pluginConnections.awaiting')}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" disabled={busy || !usable} onClick={() => void test()}>
          {t('pluginConnections.test')}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" disabled={busy} onClick={onEdit}>
          {t('pluginConnections.edit')}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" disabled={busy}
          onClick={() => void run(() => patchConnection(connection.id, { enabled: !connection.enabled }))}>
          {connection.enabled ? t('pluginConnections.disable') : t('pluginConnections.enable')}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px] text-destructive" disabled={busy}
          onClick={() => { void confirmAction({ title: t('pluginConnections.deleteConfirm', { label: connection.label }), confirmLabel: t('confirmDialog.delete'), destructive: true }).then((yes) => { if (yes) void run(() => deleteConnection(connection.id), 'pluginConnections.deleted'); }); }}>
          {t('pluginConnections.delete')}
        </Button>
      </div>
    </div>
  );
}

function TypeBlock({ type, connections, approvalRequired, onChanged }: {
  type: ConnectionType;
  connections: UserConnection[];
  approvalRequired: boolean;
  onChanged: () => void;
}): ReactElement {
  // One form at a time: `new`, or the id of the connection being edited.
  const [open, setOpen] = useState<string | null>(null);
  const entry = useSlotEntry(FORM_SLOT, type.id);
  // Only the plugin that declared the type may replace its form: another
  // plugin's form would collect keys meant for someone else.
  const custom = entry?.pluginId === type.pluginId;
  const close = useCallback(() => setOpen(null), []);
  const create = useCallback(async (value: ConnectionInput) => {
    const result = await createConnection(type.id, value);
    if (!result.ok) { toast.error(result.error); return result; }
    toast.success(t(result.connection.approval === 'approved' ? 'pluginConnections.created' : 'pluginConnections.requested'));
    setOpen(null);
    onChanged();
    return result;
  }, [onChanged, type.id]);
  const editing = connections.find((connection) => connection.id === open) ?? null;
  const update = useCallback(async (value: ConnectionInput): Promise<ConnectionSubmitResult> => {
    if (!editing) return { ok: false, error: t('pluginConnections.actionError') };
    const patch = connectionChanges(editing, value);
    if (Object.keys(patch).length === 0) { setOpen(null); return { ok: true, connection: editing }; }
    const result = await updateConnection(editing.id, patch);
    if (!result.ok) { toast.error(result.error); return result; }
    const waiting = result.connection.approval === 'pending' && editing.approval !== 'pending';
    toast.success(t(waiting ? 'pluginConnections.updatedPending' : 'pluginConnections.updated'));
    setOpen(null);
    onChanged();
    return result;
  }, [editing, onChanged]);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[13px] font-medium">{type.label}</h3>
          {type.description && <p className="text-[12px] leading-snug text-muted-foreground">{type.description}</p>}
        </div>
        {open === null && (
          <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 text-[12px]" onClick={() => setOpen('new')}>
            {t('pluginConnections.add')}
          </Button>
        )}
      </div>
      {connections.map((connection) => (connection.id === open
        ? <ConnectionForm key={connection.id} type={type} custom={custom} initial={connection}
          approvalRequired={approvalRequired} submit={update} cancel={close} />
        : <ConnectionRow key={connection.id} connection={connection} onChanged={onChanged} onEdit={() => setOpen(connection.id)} />))}
      {open === 'new' && <ConnectionForm type={type} custom={custom} initial={null} approvalRequired={approvalRequired} submit={create} cancel={close} />}
    </section>
  );
}

/** Every connection, for an administrator: approve or refuse its destination. */
function Approvals({ rows, types, onChanged }: { rows: UserConnection[]; types: Map<string, ConnectionType>; onChanged: () => void }): ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (id: string, action: 'approve' | 'reject') => {
    setBusy(id);
    const response = await connectionAction(id, action);
    setBusy(null);
    if (!response.ok) { toast.error(t('pluginConnections.actionError')); return; }
    onChanged();
  };
  const ordered = [...rows].sort((a, b) => Number(b.approval === 'pending') - Number(a.approval === 'pending'));
  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-medium">{t('pluginConnections.approvalsTitle')}</h3>
      <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('pluginConnections.approvalsDescription')}</p>
      {ordered.length === 0 && <p className="text-[12px] text-muted-foreground">{t('pluginConnections.noRequests')}</p>}
      {ordered.map((row) => (
        <div key={row.id} className="flex flex-col gap-2 rounded-md bg-muted/30 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium">{row.label}</span>
              <StatusChip connection={row} />
            </div>
            <p className="truncate text-[11px] text-muted-foreground">
              {t('pluginConnections.requestedBy', { name: row.owner?.name ?? row.owner?.email ?? '?', type: types.get(row.type)?.label ?? row.type })}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {row.url}
              {row.allowPrivateNetwork && <> · {t('pluginConnections.privateShort')}</>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {row.approval !== 'approved' && (
              <Button type="button" size="sm" className="h-7 text-[12px]" disabled={busy === row.id} onClick={() => void decide(row.id, 'approve')}>
                {t('pluginConnections.approve')}
              </Button>
            )}
            {row.approval !== 'rejected' && (
              <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" disabled={busy === row.id} onClick={() => void decide(row.id, 'reject')}>
                {row.approval === 'approved' ? t('pluginConnections.revoke') : t('pluginConnections.reject')}
              </Button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

/**
 * Settings › Secrets › Connections: the signed-in account's own connections to
 * the services plugins talk to, and — for an administrator — the destinations
 * waiting for approval.
 */
export function PluginConnectionsSettings(): ReactElement {
  const [types, setTypes] = useState<ConnectionType[]>([]);
  const [connections, setConnections] = useState<UserConnection[]>([]);
  const [approvals, setApprovals] = useState<UserConnection[] | null>(null);
  const [policy, setPolicy] = useState<'admin' | 'owner'>('admin');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const read = async <T,>(path: string): Promise<T | null> => {
      const response = await fetch(path, { cache: 'no-store' });
      return response.ok ? await response.json() as T : null;
    };
    const [typeBody, ownBody, adminBody] = await Promise.all([
      read<{ types: ConnectionType[] }>('/api/ui/plugin-connections/types'),
      read<{ connections: UserConnection[]; approvalPolicy?: 'admin' | 'owner' }>('/api/ui/plugin-connections'),
      // 403 for anyone but an administrator: the section then stays hidden.
      read<{ connections: UserConnection[] }>('/api/ui/plugin-connections/approvals'),
    ]);
    setTypes(typeBody?.types ?? []);
    setConnections(ownBody?.connections ?? []);
    setPolicy(ownBody?.approvalPolicy === 'owner' ? 'owner' : 'admin');
    setApprovals(adminBody?.connections ?? null);
    setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const refresh = useCallback(() => { void load(); }, [load]);
  const typeById = useMemo(() => new Map(types.map((type) => [type.id, type])), [types]);
  // An administrator's change, or anyone's under the `owner` policy, is
  // approved on save; everyone else waits for an administrator.
  const approvalRequired = approvals === null && policy !== 'owner';

  return (
    <div className="space-y-6">
      <p className="max-w-[65ch] text-[13px] leading-snug text-muted-foreground">{t('pluginConnections.description')}</p>
      {loaded && types.length === 0 && <p className="text-[12px] text-muted-foreground">{t('pluginConnections.noTypes')}</p>}
      {types.map((type) => (
        <TypeBlock key={type.id} type={type} connections={connections.filter((c) => c.type === type.id)}
          approvalRequired={approvalRequired} onChanged={refresh} />
      ))}
      {approvals !== null && <Approvals rows={approvals} types={typeById} onChanged={refresh} />}
      <IntegrationReceiptsSettings />
    </div>
  );
}
