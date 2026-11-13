/**
 * Hermes Gateway — browser half: the plugin's own settings category. Shows the
 * caller's gateways, their state and the agents that reach each one, links to
 * the connection form (the product's generic one, built from the connection
 * type), and creates the agents of the connected profiles.
 */
import React from 'react';
import type { ComponentType, ReactNode } from 'react';
import * as ui from '@rooks/ui';
import type { ClientContext } from '@rooks/sdk';
import messages from './messages.json';

const t = ui.createTranslator(messages);
// The SDK leaves React out of its types; narrowed at this boundary.
const Button = ui.Button as ComponentType<{ onClick?: () => void; disabled?: boolean; variant?: string; size?: string; children?: ReactNode }>;

const RECOMMENDED = '0.21.6';

type Connection = {
  id: string;
  label: string;
  profile: string;
  origin: string;
  state: 'ok' | 'pending' | 'off' | 'error';
  version: string | null;
  message: string | null;
  agents?: string[];
};
type Report = { created: string[]; updated: string[]; kept: string[]; skipped: string[] };

const DOT: Record<Connection['state'], string> = {
  ok: 'hsl(142 71% 40%)',
  pending: 'hsl(38 92% 50%)',
  off: 'hsl(var(--muted-foreground))',
  error: 'hsl(var(--destructive))',
};

function older(version: string | null): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null;
  const a = version ? parse(version) : null;
  const b = parse(RECOMMENDED);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

function stateText(c: Connection): string {
  if (c.state === 'ok') return c.version ? t('state.okVersion', { version: c.version }) : t('state.ok');
  if (c.state === 'error') return c.message ?? t('state.error');
  return t(`state.${c.state}`);
}

function ConnectionRow({ connection }: { connection: Connection }) {
  return (
    <li className="flex items-start gap-3 rounded-md bg-muted/40 px-3 py-2">
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 9999, marginTop: 6, flexShrink: 0, background: DOT[connection.state] }} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">
          {connection.label} <span className="text-xs font-normal text-muted-foreground">· {t('profile', { profile: connection.profile })} · {connection.origin}</span>
        </span>
        <span className="text-xs text-muted-foreground" role={connection.state === 'error' ? 'alert' : undefined}>{stateText(connection)}</span>
        {connection.agents && connection.agents.length > 0
          ? <span className="text-xs text-muted-foreground">{t('agents', { names: connection.agents.join(', ') })}</span>
          : null}
        {connection.state === 'ok' && older(connection.version)
          ? <span className="text-xs text-muted-foreground">{t('upgrade', { recommended: RECOMMENDED })}</span>
          : null}
      </div>
    </li>
  );
}

function ReportLines({ report }: { report: Report }) {
  const lines = (['created', 'updated', 'kept', 'skipped'] as const)
    .filter((key) => report[key].length > 0)
    .map((key) => t(`report.${key}`, { names: report[key].join(', ') }));
  return <p className="text-xs text-muted-foreground" role="status">{lines.length > 0 ? lines.join(' · ') : t('report.none')}</p>;
}

function HermesSettings({ ctx }: { ctx: ClientContext }) {
  const [connections, setConnections] = React.useState<Connection[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [report, setReport] = React.useState<Report | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await ctx.api('status');
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { connections?: Connection[] };
      setConnections(body.connections ?? []);
    } catch {
      setError(t('error.load'));
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  React.useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setCreating(true);
    setError(null);
    setReport(null);
    try {
      const response = await ctx.api('agents', { method: 'POST' });
      const body = await response.json().catch(() => ({})) as Report & { error?: string };
      if (!response.ok) setError(t('error.create', { message: body.error ?? String(response.status) }));
      else setReport(body);
    } catch {
      setError(t('error.create', { message: 'network' }));
    } finally {
      setCreating(false);
    }
  };

  const openConnections = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('settings', 'secrets/connections');
    ctx.navigate(`${url.pathname}${url.search}`);
  };

  const anyConnected = connections?.some((c) => c.state === 'ok') ?? false;

  return (
    <section className="flex flex-col gap-5 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t('connections')}</h3>
        {connections && connections.length === 0
          ? <p className="text-sm text-muted-foreground">{t('empty')}</p>
          : null}
        {connections && connections.length > 0
          ? <ul className="flex flex-col gap-2">{connections.map((c) => <ConnectionRow key={c.id} connection={c} />)}</ul>
          : null}
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={openConnections}>{t('add')}</Button>
          <Button variant="outline" size="sm" onClick={() => { void load(); }} disabled={loading}>{loading ? t('checking') : t('refresh')}</Button>
          <Button size="sm" onClick={() => { void create(); }} disabled={creating || !anyConnected}>{creating ? t('creating') : t('create')}</Button>
        </div>
        {report ? <ReportLines report={report} /> : null}
      </div>

      <div className="flex flex-col gap-1 rounded-md bg-muted/40 p-3">
        <p className="text-xs text-muted-foreground">{t('note.agents')}</p>
        <p className="text-xs text-muted-foreground">{t('note.limits')}</p>
      </div>
    </section>
  );
}

export function apply(ctx: ClientContext): () => void {
  return ctx.slots.register({ slot: 'settings.section' }, () => <HermesSettings ctx={ctx} />);
}
