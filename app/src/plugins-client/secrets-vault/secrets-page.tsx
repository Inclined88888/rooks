'use client';

/**
 * Secrets vault, write-only by default (spec `docs/SECRETS-VAULT.md` §9.2).
 *
 * The value input is empty on load, always — an existing secret is edited
 * through a *Replace* button, never by seeing what is stored. Reading it again
 * is a separate gesture (*Show*, `reveal-dialog.tsx`): account password, value
 * kept in that dialog's state only and wiped on close. The list and the editor
 * never hold a value.
 *
 * All the derivation lives in `@/lib/secrets` so it can be tested without a
 * DOM: this file is wiring and markup.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { KeyRound, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { refreshBackendCatalog } from '@/lib/backends';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/intl';
import { RevealDialog } from './reveal-dialog';
import { PluginGrantDialog } from './plugin-grant-dialog';
import {
  BROKER_PRESETS,
  BROKER_PRESET_HINT_KEYS,
  BROKER_PRESET_LABEL_KEYS,
  MODE_HINT_KEYS,
  MODE_LABEL_KEYS,
  SCOPE_CHOICE_LABEL_KEYS,
  SECRET_MODES,
  addGrant,
  blankEditor,
  configuredLabelKey,
  buildCreatePayload,
  buildUpdatePayload,
  editorErrorKey,
  editorFromSecret,
  filterSecrets,
  grantFromChoice,
  grantableBackends,
  hasReservation,
  isBrokerErrorKey,
  grantKey,
  isDaemonOnly,
  pluginGrantRequest,
  removeGrant,
  scopeBadge,
  setEditorMode,
  scopeChoicesFor,
  setEditorPreset,
  sortSecrets,
  type BackendRow,
  type BrokerPreset,
  type ScopeChoice,
  type SecretEditor,
  type SecretMode,
  type SecretSummary,
} from '@/lib/secrets';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';

type Project = { slug: string; name?: string };
type Agent = { name: string };
/** A third-party plugin: the only kind that reads the vault through grants. */
type Plugin = { id: string; label: string | null };

/** The upstream names the conflicting secret on a 409 (§5.3); swallowing that
 *  body would turn a precise message into a useless "failed". */
async function errorText(res: Response): Promise<string> {
  const raw = (await res.text().catch(() => '')).trim();
  if (!raw) return `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(raw) as { error?: string; message?: string };
    return parsed.error || parsed.message || raw;
  } catch {
    return raw;
  }
}

export function SecretsClient() {
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [backends, setBackends] = useState<{ value: string; label: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<SecretEditor | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [revealing, setRevealing] = useState<{ id: string; name: string } | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  // A plugin consent card lands here (`?grant=<NAME>&plugin=<id>`, TODO #597).
  const grantRequest = useMemo(
    () => (searchParams ? pluginGrantRequest(searchParams) : null),
    [searchParams],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = projectFilter ? `?project=${encodeURIComponent(projectFilter)}` : '';
      const res = await fetch(`/api/ui/secrets${qs}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(await errorText(res));
      const json = (await res.json()) as { secrets?: SecretSummary[] };
      setSecrets(sortSecrets(json.secrets ?? []));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const [rp, ra, rg, rm, rc] = await Promise.all([
        fetch('/api/ui/projects', { cache: 'no-store' }),
        fetch('/api/ui/agents', { cache: 'no-store' }),
        fetch('/api/ui/plugins', { cache: 'no-store' }),
        // Superadmin only, and the one list with a provider that still waits for its key.
        fetch('/api/ui/backends/manage', { cache: 'no-store' }),
        fetch('/api/ui/backends/catalog', { cache: 'no-store' }),
      ]);
      const backendRows = async (res: Response): Promise<BackendRow[]> =>
        (res.ok ? ((await res.json()) as { backends?: BackendRow[] }).backends : null) ?? [];
      setBackends(grantableBackends(await backendRows(rm), await backendRows(rc)));
      const jp = rp.ok ? ((await rp.json()) as { projects?: Project[] }) : {};
      const ja = ra.ok ? ((await ra.json()) as { agents?: Agent[] }) : {};
      const jg = rg.ok
        ? ((await rg.json()) as { plugins?: (Plugin & { source?: string })[] })
        : {};
      setProjects(jp.projects ?? []);
      setAgents(ja.agents ?? []);
      // Bundled modules are product code: they never ask the vault by grant.
      setPlugins(
        (jg.plugins ?? [])
          .filter((p) => p.source === 'third-party')
          .map((p) => ({ id: p.id, label: p.label ?? null })),
      );
    })();
  }, []);

  async function save() {
    if (!editor) return;
    const errKey = editorErrorKey(editor);
    if (errKey) {
      toast.error(t(errKey));
      return;
    }
    setSaving(true);
    try {
      const res = editor.id
        ? await fetch(`/api/ui/secrets/${encodeURIComponent(editor.id)}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildUpdatePayload(editor)),
          })
        : await fetch('/api/ui/secrets', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildCreatePayload(editor)),
          });
      if (!res.ok) throw new Error(await errorText(res));
      setEditor(null);
      // A key or a grant decides which backends a picker may offer.
      refreshBackendCatalog();
      await load();
      toast.success(t('secretsPage.saved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(secret: SecretSummary) {
    if (!(await confirmAction({ title: t('secretsPage.confirmDelete', { name: secret.name }), confirmLabel: t('confirmDialog.delete'), destructive: true }))) return;
    try {
      const res = await fetch(`/api/ui/secrets/${encodeURIComponent(secret.id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await errorText(res));
      refreshBackendCatalog();
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const visible = useMemo(() => filterSecrets(secrets, query), [secrets, query]);

  return (
    <div className="mt-5">
      <p className="max-w-3xl text-[13px] leading-relaxed text-muted-foreground">
        {t('secretsPage.writeOnlyNotice')}
      </p>

      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" onClick={() => setEditor(blankEditor())}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t('secretsPage.new')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {t('secretsPage.refresh')}
        </Button>
        <div className="relative ml-auto w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('secretsPage.search')}
            aria-label={t('secretsPage.search')}
            className="h-8 pl-8 text-[13px]"
          />
        </div>
        <select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          aria-label={t('secretsPage.filterProject')}
          title={t('secretsPage.filterProjectHint')}
          className="h-8 rounded-md border border-input bg-background px-2 text-[13px]"
        >
          <option value="">{t('secretsPage.allProjects')}</option>
          {projects.map((p) => (
            <option key={p.slug} value={p.slug}>{p.name ?? p.slug}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="mt-6 text-[13px] text-muted-foreground">{t('common.loading')}</div>
      ) : visible.length === 0 ? (
        <div className="mt-6 rounded-md border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
          {t(secrets.length === 0 && !projectFilter ? 'secretsPage.empty' : 'secretsPage.noMatch')}
        </div>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {visible.map((s) => (
            <li
              key={s.id}
              className="flex items-start gap-3 rounded-md border border-border bg-card px-3 py-2.5"
            >
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                {/* code-font: an environment variable name */}
                <span className="break-all font-mono text-[13px] font-semibold">{s.name}</span>
                <span className="flex flex-wrap gap-1.5">
                  <Badge variant={s.configured ? 'default' : 'outline'}>
                    {t(configuredLabelKey(s))}
                  </Badge>
                  <Badge variant="secondary">{t(MODE_LABEL_KEYS[s.mode])}</Badge>
                  {isDaemonOnly(s) ? (
                    <Badge variant="outline">{t('secretsPage.daemonOnly')}</Badge>
                  ) : (
                    s.grants.map((g) => (
                      <Badge key={grantKey(g)} variant="outline">
                        {scopeBadge(g, t)}
                      </Badge>
                    ))
                  )}
                </span>
              </div>
              <span className="shrink-0 pt-1 text-right text-[12px] tabular-nums text-muted-foreground">
                {t('secretsPage.updatedAt', {
                  date: formatDateTime(s.updated_at),
                })}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setEditor(editorFromSecret(s))}>
                {t('secretsPage.edit')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void remove(s)}>
                <Trash2 className="h-3.5 w-3.5" />
                <span className="sr-only">{t('secretsPage.delete')}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      <RevealDialog secret={revealing} onClose={() => setRevealing(null)} />

      <PluginGrantDialog
        request={grantRequest}
        pluginLabel={plugins.find((p) => p.id === grantRequest?.plugin)?.label ?? null}
        onClose={() => router.replace('/secrets')}
        onGranted={() => {
          router.replace('/secrets');
          void load();
        }}
      />

      <Dialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t(editor?.id ? 'secretsPage.editTitle' : 'secretsPage.newTitle')}
            </DialogTitle>
          </DialogHeader>
          {editor ? (
            <EditorForm
              editor={editor}
              projects={projects}
              agents={agents}
              plugins={plugins}
              backends={backends}
              onChange={setEditor}
              onReveal={() => {
                if (editor.id) setRevealing({ id: editor.id, name: editor.name });
              }}
            />
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditor(null)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={saving} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditorForm({
  editor,
  projects,
  agents,
  plugins,
  backends,
  onChange,
  onReveal,
}: {
  editor: SecretEditor;
  projects: Project[];
  agents: Agent[];
  plugins: Plugin[];
  backends: { value: string; label: string }[];
  onChange: (next: SecretEditor) => void;
  onReveal: () => void;
}) {
  const [pickedKind, setScopeKind] = useState<ScopeChoice>('global');
  const [scopeRef, setScopeRef] = useState('');
  // Switching to broker takes `backend` off the list: nothing stays picked that is not offered.
  const scopeChoices = scopeChoicesFor(editor.mode);
  const scopeKind = scopeChoices.includes(pickedKind) ? pickedKind : 'global';

  const refOptions = useMemo<{ value: string; label: string }[]>(
    () =>
      scopeKind === 'project'
        ? projects.map((p) => ({ value: p.slug, label: p.slug }))
        : scopeKind === 'agent'
          ? agents.map((a) => ({ value: a.name, label: a.name }))
          : scopeKind === 'plugin'
            ? plugins.map((p) => ({ value: p.id, label: p.label && p.label !== p.id ? `${p.label} (${p.id})` : p.id }))
            : scopeKind === 'backend'
              ? backends
              : [],
    [scopeKind, projects, agents, plugins, backends],
  );

  useEffect(() => {
    setScopeRef(refOptions[0]?.value ?? '');
  }, [refOptions]);

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium">{t('secretsPage.field.name')}</span>
        <Input
          value={editor.name}
          disabled={editor.id !== null}
          placeholder="GITHUB_TOKEN"
          onChange={(e) => onChange({ ...editor, name: e.target.value.toUpperCase() })}
          // code-font: an environment variable name
          className="font-mono"
        />
        <span className="text-[11px] text-muted-foreground">{t('secretsPage.field.nameHint')}</span>
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-[12px] font-medium">{t('secretsPage.field.value')}</span>
        {editor.replacingValue ? (
          <>
            <Input
              type="password"
              autoComplete="new-password"
              value={editor.value}
              placeholder={t('secretsPage.field.valuePlaceholder')}
              onChange={(e) => onChange({ ...editor, value: e.target.value })}
            />
            {editor.id ? (
              <button
                type="button"
                className="self-start text-[11px] text-muted-foreground underline"
                onClick={() => onChange({ ...editor, value: '', replacingValue: false })}
              >
                {t('secretsPage.keepValue')}
              </button>
            ) : null}
          </>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-muted-foreground">
              {t('secretsPage.valueHidden')}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onChange({ ...editor, replacingValue: true, value: '' })}
            >
              {t('secretsPage.replace')}
            </Button>
            {editor.id ? (
              <Button size="sm" variant="outline" onClick={onReveal}>
                {t('secretsPage.reveal.button')}
              </Button>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium">{t('secretsPage.field.mode')}</span>
        {SECRET_MODES.map((mode: SecretMode) => (
          <label
            key={mode}
            className={cn(
              'flex cursor-pointer gap-2 rounded-md border border-border p-2',
              editor.mode === mode && 'border-primary bg-primary/5',
            )}
          >
            <input
              type="radio"
              className="mt-1"
              checked={editor.mode === mode}
              onChange={() => onChange(setEditorMode(editor, mode))}
            />
            <span className="flex flex-col">
              <span className="text-[13px] font-medium">{t(MODE_LABEL_KEYS[mode])}</span>
              <span className="text-[11px] text-muted-foreground">{t(MODE_HINT_KEYS[mode])}</span>
            </span>
          </label>
        ))}
      </div>

      {editor.mode === 'broker' ? <BrokerFields editor={editor} onChange={onChange} /> : null}

      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium">{t('secretsPage.field.grants')}</span>
        <span className="text-[11px] text-muted-foreground">{t('secretsPage.grantsHint')}</span>
        {(scopeKind === 'backend' || hasReservation(editor.grants)) && (
          <span data-backend-reservation-hint className="text-[11px] text-muted-foreground">
            {t('secretsPage.backendReservationHint')}
          </span>
        )}
        <div className="flex flex-wrap gap-1.5">
          {editor.grants.length === 0 ? (
            <Badge variant="outline">{t('secretsPage.daemonOnly')}</Badge>
          ) : (
            editor.grants.map((g) => (
              <Badge key={grantKey(g)} variant="outline" className="gap-1">
                {scopeBadge(g, t)}
                <button
                  type="button"
                  aria-label={t('secretsPage.removeGrant')}
                  onClick={() =>
                    onChange({ ...editor, grants: removeGrant(editor.grants, grantKey(g)) })
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-[12px]"
            value={scopeKind}
            onChange={(e) => setScopeKind(e.target.value as ScopeChoice)}
          >
            {scopeChoices.map((kind) => (
              <option key={kind} value={kind}>
                {t(SCOPE_CHOICE_LABEL_KEYS[kind])}
              </option>
            ))}
          </select>
          {scopeKind === 'global' ? null : (
            <select
              className="h-8 min-w-[10rem] rounded-md border border-border bg-background px-2 text-[12px]"
              value={scopeRef}
              onChange={(e) => setScopeRef(e.target.value)}
            >
              {refOptions.length === 0 ? (
                <option value="">{t('secretsPage.noScopeRef')}</option>
              ) : (
                refOptions.map((ref) => (
                  <option key={ref.value} value={ref.value}>
                    {ref.label}
                  </option>
                ))
              )}
            </select>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onChange({
                ...editor,
                grants: addGrant(editor.grants, grantFromChoice(scopeKind, scopeRef)),
              })
            }
          >
            {t('secretsPage.addGrant')}
          </Button>
        </div>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium">{t('secretsPage.field.note')}</span>
        <Textarea
          rows={2}
          value={editor.note}
          onChange={(e) => onChange({ ...editor, note: e.target.value })}
        />
      </label>
    </div>
  );
}

/** Broker configuration (§9.2). Presets produce a valid `broker_spec`; the
 *  raw template stays an advanced option. A broker without a spec is a secret
 *  the daemon cannot use at all, so these fields are part of choosing the mode. */
function BrokerFields({
  editor,
  onChange,
}: {
  editor: SecretEditor;
  onChange: (next: SecretEditor) => void;
}) {
  if (!editor.brokerSpecKnown) {
    // The list didn't return the stored spec; showing empty inputs would invite
    // the operator to overwrite a host allowlist they can't see.
    return (
      <div className="flex items-center gap-2 rounded-md border border-border p-2">
        <span className="text-[12px] text-muted-foreground">
          {t('secretsPage.brokerSpecKept')}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChange({ ...editor, brokerSpecKnown: true })}
        >
          {t('secretsPage.brokerSpecEdit')}
        </Button>
      </div>
    );
  }
  const extra = editor.brokerPreset;
  const errKey = editorErrorKey(editor);
  const brokerErr = isBrokerErrorKey(errKey) ? errKey : null;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium">{t('secretsPage.field.brokerPreset')}</span>
        {BROKER_PRESETS.map((preset: BrokerPreset) => (
          <label
            key={preset}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-md border border-border px-2 py-1.5',
              editor.brokerPreset === preset && 'border-primary bg-primary/5',
            )}
          >
            <input
              type="radio"
              checked={editor.brokerPreset === preset}
              onChange={() => onChange(setEditorPreset(editor, preset))}
            />
            <span className="text-[13px] font-medium">{t(BROKER_PRESET_LABEL_KEYS[preset])}</span>
          </label>
        ))}
        <span className="text-[11px] text-muted-foreground">
          {t(BROKER_PRESET_HINT_KEYS[editor.brokerPreset])}
        </span>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium">{t('secretsPage.field.brokerHosts')}</span>
        <Textarea
          rows={2}
          value={editor.brokerHosts}
          placeholder="api.github.com"
          // code-font: host names
          className="font-mono"
          onChange={(e) => onChange({ ...editor, brokerHosts: e.target.value })}
        />
        <span className="text-[11px] text-muted-foreground">
          {t('secretsPage.field.brokerHostsHint')}
        </span>
      </label>

      {extra === 'header' || extra === 'advanced' ? (
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium">{t('secretsPage.field.brokerHeader')}</span>
          <Input
            value={editor.brokerHeaderName}
            placeholder="Authorization"
            // code-font: an HTTP header name
            className="font-mono"
            onChange={(e) => onChange({ ...editor, brokerHeaderName: e.target.value })}
          />
        </label>
      ) : null}

      {extra === 'query' ? (
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium">{t('secretsPage.field.brokerQuery')}</span>
          <Input
            value={editor.brokerQueryName}
            placeholder="access_token"
            // code-font: a query parameter name
            className="font-mono"
            onChange={(e) => onChange({ ...editor, brokerQueryName: e.target.value })}
          />
        </label>
      ) : null}

      {extra === 'advanced' ? (
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium">{t('secretsPage.field.brokerTemplate')}</span>
          <Input
            value={editor.brokerTemplate}
            // code-font: a header value template
            className="font-mono"
            onChange={(e) => onChange({ ...editor, brokerTemplate: e.target.value })}
          />
          <span className="text-[11px] text-muted-foreground">
            {t('secretsPage.field.brokerTemplateHint')}
          </span>
        </label>
      ) : null}

      {brokerErr ? <p className="text-[12px] text-destructive">{t(brokerErr)}</p> : null}
    </div>
  );
}
