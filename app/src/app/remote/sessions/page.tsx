import { notFound } from 'next/navigation';
import { listTokens } from '@/lib/remote/token';
import { recentForToken } from '@/lib/remote/audit';
import { localSuperadmin } from '@/lib/remote/sessions-access';
import { resolveTarget } from '@/lib/machines/target';
import { t } from '@/lib/i18n';
import { applyRequestLocale } from '@/lib/locale-server';

export const dynamic = 'force-dynamic';

function fmtDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toISOString().replace('T', ' ').replace(/\..+/, '');
}

export default async function SessionsPage() {
  // This computer's tokens, read from its disk: a superadmin of this computer
  // only, whichever machine the interface is switched to.
  if (!(await localSuperadmin())) notFound();
  const switched = (await resolveTarget()).kind !== 'local';
  await applyRequestLocale();
  const tokens = listTokens();
  const now = Date.now();

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24, maxWidth: 1100 }}>
      <h1>Remote Sessions</h1>
      {switched && <p role="note">{t('machines.localOnly.remoteSessions')}</p>}
      <p style={{ color: '#666' }}>
        Active and historical remote tokens. Revoke through{' '}
        <code>POST /api/remote/sessions/&lt;id&gt;/revoke</code> with master auth.
      </p>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead>
          <tr style={{ textAlign: 'left' }}>
            <th style={{ padding: 6 }}>Client</th>
            <th style={{ padding: 6 }}>ID</th>
            <th style={{ padding: 6 }}>Issued</th>
            <th style={{ padding: 6 }}>Expires</th>
            <th style={{ padding: 6 }}>State</th>
            <th style={{ padding: 6 }}>Calls</th>
            <th style={{ padding: 6 }}>Last call</th>
            <th style={{ padding: 6 }}>Recent</th>
          </tr>
        </thead>
        <tbody>
          {tokens.length === 0 && (
            <tr>
              <td colSpan={8} style={{ padding: 12, color: '#999' }}>
                No tokens issued.
              </td>
            </tr>
          )}
          {tokens.map((t) => {
            const expired = t.expires_at < now;
            const state = t.revoked ? 'revoked' : expired ? 'expired' : 'active';
            const recent = recentForToken(t.id, 5) as { method: string; path: string; status: number; timestamp: number }[];
            return (
              <tr key={t.id} style={{ verticalAlign: 'top' }}>
                <td style={{ padding: 6 }}>{t.client_name}</td>
                <td style={{ padding: 6, fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{t.id}</td>
                <td style={{ padding: 6 }}>{fmtDate(t.issued_at)}</td>
                <td style={{ padding: 6 }}>{fmtDate(t.expires_at)}</td>
                <td style={{ padding: 6, color: state === 'active' ? '#080' : '#a00' }}>{state}</td>
                <td style={{ padding: 6 }}>{t.call_count}</td>
                <td style={{ padding: 6 }}>{fmtDate(t.last_called_at)}</td>
                <td /* code-font: HTTP request log */ style={{ padding: 6, fontSize: 12, fontFamily: 'monospace' }}>
                  {recent.map((r, i) => (
                    <div key={i}>
                      {r.method} {r.path} → {r.status}
                    </div>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
