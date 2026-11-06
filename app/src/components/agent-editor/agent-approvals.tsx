'use client';

import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { formatDate } from '@/lib/intl';

type Approval = { id: string; tool_name: string; command: string | null; created_at: number };

/** How the card named it: the tool, or the shell command it ran. */
function approvalLabel(a: Approval): string {
  return a.command === null ? a.tool_name : `${a.tool_name}(${a.command})`;
}

/**
 * The "Always allow" answers the viewer gave this agent's permission cards.
 * Timon answers them in the viewer's place from then on, so they sit next to
 * the agent's own allow and deny lists, each one revocable.
 */
export function AgentApprovals({ agentName }: { agentName: string }) {
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/api/ui/agents/${encodeURIComponent(agentName)}/approvals`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(base, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { approvals?: Approval[] };
      setApprovals(body.approvals ?? []);
    } catch {
      setApprovals([]);
      toast.error(t('agentApprovals.loadFailed'));
    }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (a: Approval) => {
    setBusy(a.id);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(String(res.status));
      setApprovals((list) => (list ?? []).filter((x) => x.id !== a.id));
      toast.success(t('agentApprovals.revoked'));
    } catch {
      toast.error(t('agentApprovals.revokeFailed'));
    } finally {
      setBusy(null);
    }
  };

  if (approvals === null) return null;
  if (approvals.length === 0) {
    return <p className="text-[11.5px] text-muted-foreground/80">{t('agentApprovals.empty')}</p>;
  }
  return (
    <ul data-agent-approvals className="flex flex-col gap-1">
      {approvals.map((a) => (
        <li key={a.id} className="flex items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5">
          {/* code-font: a tool name or the shell command the approval covers */}
          <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={approvalLabel(a)}>
            {approvalLabel(a)}
          </code>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatDate(a.created_at, { year: 'numeric', month: 'numeric', day: 'numeric' })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 w-7 shrink-0 p-0"
            disabled={busy === a.id}
            aria-label={t('agentApprovals.revoke', { motif: approvalLabel(a) })}
            title={t('agentApprovals.revoke', { motif: approvalLabel(a) })}
            onClick={() => void revoke(a)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
