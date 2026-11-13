'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Copy, Search, X } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { formatDateTime, formatRelativeTime } from '@/lib/intl';
import { AgentAvatar, useAgentIdentities, type AgentIdentity } from '@/components/agent-avatar';
import { mdToSafeHtml } from '@/lib/markdown';
import { useHighlighterVersion } from '@/components/chat/bubble-html';
import { isEmptyValue, isPlainObject, parseMessageBody } from '@/lib/message-body';
import { apiErrorMessage } from '@/lib/api-error';

type MessageKind = 'msg' | 'request' | 'response' | 'notification';
/** `held`: stopped by the daemon's agent-to-agent circuit breaker. */
type MessageStatus = 'pending' | 'picked' | 'expired' | 'held';
/** Derived by the daemon (`message-origin.ts`); absent on rows fetched by id. */
type MessageOrigin =
  | 'agent'
  | 'routine'
  | 'cockpit'
  | 'wake'
  | 'system_alert'
  | 'task_return'
  | 'mission_return';

type Message = {
  id: string;
  from_mission: string;
  from_agent: string;
  to_agent: string;
  to_mission: string | null;
  kind: MessageKind;
  payload: string;
  in_reply_to: string | null;
  created_at: number;
  picked_at: number | null;
  status: MessageStatus;
  origin?: MessageOrigin;
};

type StatusFilter = 'pending' | 'picked' | 'all';

const KIND_TONE: Record<MessageKind, string> = {
  msg: 'bg-muted text-muted-foreground',
  request: 'bg-[hsl(var(--info)/0.10)] text-[hsl(var(--info))]',
  response: 'bg-[hsl(var(--success)/0.10)] text-[hsl(var(--success))]',
  notification: 'bg-[hsl(var(--warning)/0.10)] text-[hsl(var(--warning))]',
};

const KIND_LABEL: Record<MessageKind, string> = {
  msg: 'inboxPage.kindMsg',
  request: 'inboxPage.kindRequest',
  response: 'inboxPage.kindResponse',
  notification: 'inboxPage.kindNotification',
};

const STATUS_TONE: Record<MessageStatus, string> = {
  pending: 'bg-primary/10 text-primary border-primary/30',
  picked: 'bg-muted/60 text-muted-foreground border-border',
  expired: 'bg-destructive/10 text-destructive border-destructive/25',
  held: 'bg-[hsl(var(--warning)/0.10)] text-[hsl(var(--warning))] border-[hsl(var(--warning)/0.30)]',
};

const STATUS_LABEL: Record<MessageStatus, string> = {
  pending: 'inboxPage.unread',
  picked: 'inboxPage.read',
  expired: 'inboxPage.expired',
  held: 'inboxPage.held',
};

const ORIGIN_META: Record<MessageOrigin, { label: string; tone: string }> = {
  agent: { label: 'inboxPage.originAgent', tone: 'bg-muted text-foreground/80 border-border' },
  routine: { label: 'inboxPage.originRoutine', tone: 'bg-[hsl(var(--agenda-3)/0.12)] text-[hsl(var(--agenda-3))] border-[hsl(var(--agenda-3)/0.35)]' },
  cockpit: { label: 'inboxPage.originCockpit', tone: 'bg-[hsl(var(--agenda-2)/0.12)] text-[hsl(var(--agenda-2))] border-[hsl(var(--agenda-2)/0.35)]' },
  wake: { label: 'inboxPage.originWake', tone: 'bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))] border-[hsl(var(--warning)/0.35)]' },
  system_alert: { label: 'inboxPage.originSystemAlert', tone: 'bg-destructive/10 text-destructive border-destructive/30' },
  task_return: { label: 'inboxPage.originTaskReturn', tone: 'bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))] border-[hsl(var(--success)/0.35)]' },
  mission_return: { label: 'inboxPage.originMissionReturn', tone: 'bg-[hsl(var(--info)/0.12)] text-[hsl(var(--info))] border-[hsl(var(--info)/0.35)]' },
};

function fmtTime(ms: number): string {
  if (!ms) return '—';
  // Past a week, the date itself says more than "12 days ago".
  if (Date.now() - ms < 7 * 86_400_000) return formatRelativeTime(ms);
  return formatDateTime(ms, { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Subject line of a message. Daemon-generated payloads are JSON with a
 * `title` or `task_title`; hand-written ones are free text whose first line
 * is the closest thing to a subject.
 */
function subjectOf(payload: string): string {
  if (payload.startsWith('{')) {
    try {
      const p: unknown = JSON.parse(payload);
      if (p && typeof p === 'object') {
        const o = p as Record<string, unknown>;
        for (const k of ['title', 'task_title', 'kind']) {
          if (typeof o[k] === 'string' && o[k]) return o[k] as string;
        }
      }
    } catch {
      // free text that happens to start with a brace
    }
  }
  const line = payload.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > 90 ? line.slice(0, 89) + '…' : line;
}

function OriginBadge({ origin, className }: { origin: MessageOrigin | undefined; className?: string }) {
  const meta = ORIGIN_META[origin ?? 'agent'];
  return (
    <Badge variant="outline" className={cn('h-5 shrink-0 px-1.5 text-[10px] font-medium', meta.tone, className)}>
      {t(meta.label)}
    </Badge>
  );
}

function KindChip({ kind }: { kind: MessageKind }) {
  return (
    <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase', KIND_TONE[kind])}>
      {t(KIND_LABEL[kind])}
    </span>
  );
}

function StatusChip({ status }: { status: MessageStatus }) {
  return (
    <Badge variant="outline" className={cn('h-5 shrink-0 px-1.5 text-[10px]', STATUS_TONE[status])}>
      {t(STATUS_LABEL[status])}
    </Badge>
  );
}

/** `from → to`, each with its avatar and accent colour. */
function Correspondents({ from, to, size, className }: {
  from: AgentIdentity;
  to: AgentIdentity;
  size: 'sm' | 'md';
  className?: string;
}) {
  const text = size === 'sm' ? 'text-[11.5px]' : 'text-[13px]';
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <AgentAvatar identity={from} size={size} live={false} />
      <span className={cn('truncate font-medium', text)} style={{ color: from.accent }}>
        {from.name}
      </span>
      <ArrowRight className="size-3 shrink-0 text-muted-foreground/60" />
      <AgentAvatar identity={to} size={size} live={false} />
      <span className={cn('truncate', text)} style={{ color: to.accent }}>
        {to.name}
      </span>
    </div>
  );
}

/**
 * One value of the field table. Nested objects become a sub-table, arrays
 * and anything else non-scalar fall back to indented JSON: the point is that
 * nothing ever prints as `[object Object]`.
 */
function FieldValue({ value, depth }: { value: unknown; depth: number }) {
  if (isEmptyValue(value)) return <span className="text-muted-foreground/50">—</span>;
  if (typeof value === 'boolean') return <span>{value ? t('inboxPage.yes') : t('inboxPage.no')}</span>;
  if (typeof value === 'number') return <span className="tabular-nums">{String(value)}</span>;
  if (typeof value === 'string') return <span className="whitespace-pre-wrap break-words">{value}</span>;
  // Two levels of nesting is where a table stops helping and JSON takes over.
  if (isPlainObject(value) && depth < 2 && Object.keys(value).length > 0) {
    return <FieldTable fields={Object.entries(value)} depth={depth + 1} />;
  }
  const count = Array.isArray(value) ? value.length : isPlainObject(value) ? Object.keys(value).length : 1;
  return <span className="text-muted-foreground">{t('inboxPage.nested', { count })}</span>;
}

function FieldTable({ fields, depth = 0 }: { fields: Array<[string, unknown]>; depth?: number }) {
  return (
    <table className={cn('w-full border-collapse text-[12px]', depth > 0 && 'rounded border border-border/60')}>
      <tbody>
        {fields.map(([k, v]) => (
          <tr key={k} className="align-top even:bg-muted/20">
            <th scope="row" className="w-[1%] whitespace-nowrap py-1 pr-3 text-left font-medium text-muted-foreground">
              {k}
            </th>
            <td className="py-1 text-foreground/90">
              <FieldValue value={v} depth={depth} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CopyRawButton({ raw }: { raw: string }) {
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(raw);
      toast.success(t('inboxPage.copied'));
    } catch {
      toast.error(t('inboxPage.copyFailed'));
    }
  }, [raw]);
  return (
    <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10.5px] text-muted-foreground" onClick={copy}>
      <Copy className="mr-1 size-3" />
      {t('inboxPage.copyRaw')}
    </Button>
  );
}

/**
 * Mail-style body: the prose first (markdown, sanitized by the same pipe as
 * the chat bubbles), then the machine fields as a key → value table, folded
 * when it is more debugging material than context. A payload that is not a
 * JSON object is shown as-is — the inbox must never show an error or a blank.
 */
function MessageBody({ payload, compact, className }: { payload: string; compact?: boolean; className?: string }) {
  const parsed = useMemo(() => parseMessageBody(payload), [payload]);
  // Keyed on the highlighter too: a message opened before the grammars land
  // would otherwise keep its code blocks uncoloured.
  const highlighter = useHighlighterVersion();
  const html = useMemo(() => (parsed.text ? mdToSafeHtml(parsed.text) : ''), [parsed.text, highlighter]);
  const fieldsShown = parsed.fields.filter(([, v]) => !isEmptyValue(v));
  const [open, setOpen] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  const hiddenEmpty = parsed.fields.length - fieldsShown.length;
  const tableFields = showEmpty ? parsed.fields : fieldsShown;

  return (
    <div className={cn('space-y-3', className)}>
      {parsed.text ? (
        <div
          className={cn('chat-bubble min-w-0 max-w-full overflow-x-auto text-[13px] leading-relaxed', compact && 'max-h-40 overflow-y-auto')}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="text-[12px] italic text-muted-foreground">{t('inboxPage.noText')}</div>
      )}
      {parsed.json && (
        <div className="rounded-md border border-border/70 bg-background/40">
          <div className="flex items-center gap-1 px-2 py-1">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="flex flex-1 items-center gap-1 text-left text-[10.5px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
              aria-expanded={open}
            >
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              {t('inboxPage.fields', { count: parsed.fields.length })}
            </button>
            <CopyRawButton raw={parsed.raw} />
          </div>
          {open && (
            <div className="mt-1 rounded bg-muted/20 px-2 py-1.5">
              {tableFields.length > 0 ? (
                <FieldTable fields={tableFields} />
              ) : (
                <div className="py-1 text-[11.5px] text-muted-foreground">{t('inboxPage.noFields')}</div>
              )}
              {hiddenEmpty > 0 && (
                <button
                  type="button"
                  onClick={() => setShowEmpty((v) => !v)}
                  className="mt-1 text-[10.5px] text-muted-foreground hover:underline"
                >
                  {showEmpty ? t('inboxPage.hideEmpty') : t('inboxPage.showEmpty', { count: hiddenEmpty })}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MessagesClient({ initialAgent }: { initialAgent?: string }) {
  const { agents, identityOf } = useAgentIdentities();
  const [agent, setAgent] = useState<string>(initialAgent || '*');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sender, setSender] = useState<string>('*');
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Parent of the selected message when it is not in the loaded list (it
  // usually sits in the other agent's inbox). `null` = looked up, not found.
  const [parent, setParent] = useState<{ id: string; msg: Message | null } | null>(null);

  const fetchMessages = useCallback(async () => {
    if (!agent) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ to: agent, limit: '200' });
      if (status !== 'all') qs.set('status', status);
      const r = await fetch(`/api/ui/messages?${qs.toString()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { messages?: Message[] };
      setMessages(j.messages ?? []);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agent, status]);

  useEffect(() => {
    fetchMessages();
    const id = setInterval(fetchMessages, 3000);
    return () => clearInterval(id);
  }, [fetchMessages]);

  const pick = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/ui/messages/${id}/pick`, { method: 'POST' });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(apiErrorMessage(j, { status: r.status }));
      }
      toast.success(t('inboxPage.picked'));
      fetchMessages();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [fetchMessages]);

  const counts = useMemo(() => {
    const c = { pending: 0, picked: 0, expired: 0, held: 0 };
    for (const m of messages) c[m.status]++;
    return c;
  }, [messages]);

  const senders = useMemo(
    () => Array.from(new Set(messages.map((m) => m.from_agent))).sort(),
    [messages],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return messages.filter((m) => {
      if (sender !== '*' && m.from_agent !== sender) return false;
      if (!q) return true;
      return (
        m.payload.toLowerCase().includes(q)
        || m.from_agent.toLowerCase().includes(q)
        || m.to_agent.toLowerCase().includes(q)
      );
    });
  }, [messages, sender, query]);

  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const replies = useMemo(
    () => (selected ? messages.filter((m) => m.in_reply_to === selected.id).sort((a, b) => a.created_at - b.created_at) : []),
    [messages, selected],
  );

  useEffect(() => {
    const parentId = selected?.in_reply_to ?? null;
    if (!parentId) { setParent(null); return; }
    const local = byId.get(parentId);
    if (local) { setParent({ id: parentId, msg: local }); return; }
    let off = false;
    fetch(`/api/ui/messages/${encodeURIComponent(parentId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { message: null }))
      .then((j: { message?: Message | null }) => {
        if (!off) setParent({ id: parentId, msg: j.message ?? null });
      })
      .catch(() => { if (!off) setParent({ id: parentId, msg: null }); });
    return () => { off = true; };
  }, [selected?.in_reply_to, byId, selected]);

  const emptyText = agent ? t('inboxPage.empty') : t('inboxPage.noAgent');

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-end gap-3 bg-background px-4 py-3">
        <div className="flex min-w-[180px] flex-col gap-1">
          <label className="text-xs text-muted-foreground">{t('inboxPage.inboxOf')}</label>
          <Select value={agent} onValueChange={(v) => { setAgent(v); setSelectedId(null); setSender('*'); }}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder={t('inboxPage.pickAgent')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="*">⊕ {t('inboxPage.allAgents')}</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.name} value={a.name}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">{t('inboxPage.status')}</label>
          <Select value={status} onValueChange={(v) => { setStatus(v as StatusFilter); setSelectedId(null); }}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">{t('inboxPage.statusPending', { count: counts.pending })}</SelectItem>
              <SelectItem value="picked">{t('inboxPage.statusPicked', { count: counts.picked })}</SelectItem>
              <SelectItem value="all">{t('inboxPage.statusAll')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-[160px] flex-col gap-1">
          <label className="text-xs text-muted-foreground">{t('inboxPage.from')}</label>
          <Select value={sender} onValueChange={setSender}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="*">{t('inboxPage.anySender')}</SelectItem>
              {senders.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="relative flex min-w-[200px] flex-1 flex-col gap-1">
          <label className="text-xs text-muted-foreground">&nbsp;</label>
          <Search className="pointer-events-none absolute bottom-2.5 left-2.5 size-3 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('inboxPage.search')}
            className="h-8 pl-7 pr-7 text-xs"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute bottom-2 right-2 text-muted-foreground hover:text-foreground"
              aria-label={t('common.close')}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={fetchMessages} disabled={loading}>
          {loading ? '…' : t('inboxPage.refresh')}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* List — full width on mobile, fixed column on md+; hidden on mobile once a message is open. */}
        <div className={cn(
          'flex min-h-0 w-full flex-col md:w-[380px] md:shrink-0 md:bg-muted/20',
          selected && 'hidden md:flex',
        )}>
          <div className="px-4 py-1.5 text-[11px] text-muted-foreground">
            {t('inboxPage.count', { count: visible.length })}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {visible.length === 0 ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
                {emptyText}
              </div>
            ) : (
              <ul className="space-y-0.5 px-1.5 pb-2">
                {visible.map((m) => {
                  const active = m.id === selectedId;
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(m.id)}
                        className={cn(
                          'flex w-full flex-col gap-1 rounded-md px-2.5 py-2.5 text-left hover:bg-muted/40',
                          active && 'bg-muted/50',
                          m.status === 'pending' && 'border-l-2 border-l-primary',
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Correspondents from={identityOf(m.from_agent)} to={identityOf(m.to_agent)} size="sm" className="flex-1" />
                          <span className="shrink-0 text-[10.5px] text-muted-foreground/70">{fmtTime(m.created_at)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <OriginBadge origin={m.origin} />
                          <span className={cn('min-w-0 flex-1 truncate text-[12px]', m.status === 'pending' ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                            {subjectOf(m.payload)}
                          </span>
                          {m.in_reply_to && <span className="text-[10px] text-muted-foreground/70">↳</span>}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Reading pane — hidden on mobile until a message is selected. */}
        <div className={cn('min-h-0 flex-1 flex-col', selected ? 'flex' : 'hidden md:flex')}>
          {!selected ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('inboxPage.noSelection')}
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2 px-5 py-3">
                <div className="flex items-center gap-2 md:hidden">
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSelectedId(null)}>
                    <ArrowLeft className="mr-1 size-3.5" />
                    {t('inboxPage.back')}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Correspondents from={identityOf(selected.from_agent)} to={identityOf(selected.to_agent)} size="md" />
                  <span className="ml-auto flex items-center gap-1.5">
                    {selected.status === 'pending' && (
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => pick(selected.id)}>
                        {t('inboxPage.pick')}
                      </Button>
                    )}
                  </span>
                </div>
                <div className="text-[14px] font-semibold">{subjectOf(selected.payload)}</div>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <OriginBadge origin={selected.origin} />
                  <KindChip kind={selected.kind} />
                  <StatusChip status={selected.status} />
                  <span>{fmtTime(selected.created_at)}</span>
                  <Link href={`/missions?selected=${selected.from_mission}`} className="hover:underline">
                    {t('inboxPage.openMission')}
                  </Link>
                  {selected.to_mission && (
                    <span className="tabular-nums">{t('inboxPage.toMission', { id: selected.to_mission.slice(0, 8) })}</span>
                  )}
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
                {selected.in_reply_to && (
                  <div className="rounded-md border border-dashed border-border p-3">
                    <div className="mb-2 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                      {t('inboxPage.inReplyTo')}
                    </div>
                    {parent?.id === selected.in_reply_to && parent.msg ? (
                      <ThreadItem msg={parent.msg} identityOf={identityOf} onOpen={byId.has(parent.msg.id) ? setSelectedId : undefined} />
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        {parent?.id === selected.in_reply_to ? t('inboxPage.parentMissing') : t('common.loading')}
                      </div>
                    )}
                  </div>
                )}
                <MessageBody key={selected.id} payload={selected.payload} />
                {replies.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
                      {t('inboxPage.replies', { count: replies.length })}
                    </div>
                    {replies.map((r) => (
                      <ThreadItem key={r.id} msg={r} identityOf={identityOf} onOpen={setSelectedId} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Compact rendering of a message that belongs to the open thread. */
function ThreadItem({ msg, identityOf, onOpen }: {
  msg: Message;
  identityOf: (name: string) => AgentIdentity;
  onOpen?: (id: string) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-background/60 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Correspondents from={identityOf(msg.from_agent)} to={identityOf(msg.to_agent)} size="sm" />
        <OriginBadge origin={msg.origin} />
        <span className="text-[10.5px] text-muted-foreground/70">{fmtTime(msg.created_at)}</span>
        {onOpen && (
          <button type="button" onClick={() => onOpen(msg.id)} className="ml-auto text-[10.5px] text-muted-foreground hover:underline">
            {t('inboxPage.thread')} →
          </button>
        )}
      </div>
      <MessageBody key={msg.id} payload={msg.payload} compact />
    </div>
  );
}
