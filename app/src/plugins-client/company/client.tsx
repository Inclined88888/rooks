import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createTranslator } from '@timon/ui';
import { openAgentEditor } from '@/components/agent-editor/agent-editor-modal';
import { ChatLink } from '@/components/chat/chat-link';
import { chatHref } from '@/lib/chat-island-params';
import type { HierarchyWorkspace } from '@/lib/hierarchy';
import { CARD_HEIGHT, CARD_WIDTH, canReportTo, companyMembers, layoutCompany, legacyManagers, readOrganization, setTitle, withoutManagers, type Agent, type Organization } from './model';

const t = createTranslator({
  en: {
    count: '{count} agents', search: 'Find an agent or role…', fit: 'Fit chart', zoomIn: 'Zoom in', zoomOut: 'Zoom out', refresh: 'Refresh agents',
    loading: 'Loading your organization…', loadError: 'Could not load the organization.', retry: 'Try again', empty: 'No agents yet. Create an agent to start your organization.', create: 'Create an agent',
    title: 'Job title', manager: 'Reports to', root: 'Default · project lead or main agent', save: 'Save position', saving: 'Saving…', saved: 'Position saved', cancel: 'Cancel',
    edit: 'Edit {name}', chat: 'Open chat', saveError: 'Could not save. Your changes are still in the form.', invalid: 'Choose a manager outside this agent’s own team.',
    hint: 'Select an agent to edit its role and reporting line.', noMatch: 'No matching agent or role.', repaired: 'Some reporting lines were invalid. These agents are shown at the top level; select them to choose a manager.',
    report: '1 direct report', reports: '{count} direct reports', reportingTo: 'Reports to {manager}', diagram: 'Agent organization chart', stale: 'The agent list could not be refreshed.', close: 'Close position editor',
  },
  fr: {
    count: '{count} agents', search: 'Chercher un agent ou un rôle…', fit: 'Ajuster la vue', zoomIn: 'Zoom avant', zoomOut: 'Zoom arrière', refresh: 'Actualiser les agents',
    loading: 'Chargement de votre organisation…', loadError: 'Impossible de charger l’organisation.', retry: 'Réessayer', empty: 'Aucun agent pour le moment. Créez un agent pour commencer votre organisation.', create: 'Créer un agent',
    title: 'Poste', manager: 'Responsable', root: 'Par défaut · lead du projet ou agent principal', save: 'Enregistrer le poste', saving: 'Enregistrement…', saved: 'Poste enregistré', cancel: 'Annuler',
    edit: 'Modifier {name}', chat: 'Ouvrir le chat', saveError: 'Enregistrement impossible. Vos modifications restent dans le formulaire.', invalid: 'Choisissez un responsable en dehors de l’équipe de cet agent.',
    hint: 'Sélectionnez un agent pour modifier son poste et son responsable.', noMatch: 'Aucun agent ou rôle correspondant.', repaired: 'Certains liens hiérarchiques étaient invalides. Ces agents apparaissent au premier niveau ; sélectionnez-les pour choisir leur responsable.',
    report: '1 collaborateur direct', reports: '{count} collaborateurs directs', reportingTo: 'Responsable : {manager}', diagram: 'Organigramme des agents', stale: 'La liste des agents n’a pas pu être actualisée.', close: 'Fermer l’éditeur de poste',
  },
});

const ENDPOINT = '/api/ui/layout?scope=company.hierarchy';
const ROLES = ['CEO', 'CTO', 'COO', 'CFO', 'Sales', 'Marketing', 'SEO Expert', 'Product Manager', 'Developer', 'Designer'];
const CSS = `
.timon-company { color:hsl(var(--foreground)); display:flex; flex-direction:column; flex:1; min-height:0; height:100%; font:13px var(--font-sans); }
.timon-company * { box-sizing:border-box; }
.timon-company button, .timon-company input, .timon-company select { font:inherit; }
.timon-company button, .timon-company .co-link { cursor:pointer; border:1px solid hsl(var(--border)); background:hsl(var(--card)); color:hsl(var(--foreground)); border-radius:6px; padding:7px 10px; text-decoration:none; }
.timon-company button:hover, .timon-company .co-link:hover { background:hsl(var(--muted)); }
.timon-company button:disabled { opacity:.5; cursor:wait; }
.timon-company :is(button,input,select,a):focus-visible { outline:2px solid hsl(var(--ring)); outline-offset:2px; }
.timon-company .co-primary { background:hsl(var(--primary)); color:hsl(var(--primary-foreground)); border-color:transparent; }
.timon-company .co-primary:hover { background:hsl(var(--primary)); filter:brightness(.95); }
.timon-company .co-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:12px 0; border-bottom:1px solid hsl(var(--border)); }
.timon-company h1 { font-size:16px; font-weight:600; margin:0; }
.timon-company .co-muted { color:hsl(var(--muted-foreground)); }
.timon-company .co-search { margin-left:auto; width:220px; min-width:120px; }
.timon-company input, .timon-company select { min-width:0; border:1px solid hsl(var(--input)); border-radius:6px; padding:8px; background:hsl(var(--card)); color:hsl(var(--foreground)); }
.timon-company input::placeholder { color:hsl(var(--muted-foreground)); }
.timon-company .co-search input { width:100%; }
.timon-company .co-tools { display:flex; align-items:center; gap:4px; }
.timon-company .co-tools output { min-width:40px; text-align:center; font-variant-numeric:tabular-nums; font-size:11px; }
.timon-company .co-hint { margin:10px 0; font-size:12px; color:hsl(var(--muted-foreground)); }
.timon-company .co-notice { margin:8px 0; font-size:12px; color:hsl(var(--warning)); }
.timon-company .co-error { color:hsl(var(--destructive)); margin:8px 0; }
.timon-company .co-editor { display:flex; flex-wrap:wrap; align-items:end; gap:10px; padding:12px 0; border-bottom:1px solid hsl(var(--border)); }
.timon-company .co-editor fieldset { display:contents; border:0; padding:0; margin:0; }
.timon-company .co-editor label { display:flex; flex:1; min-width:140px; flex-direction:column; gap:5px; font-size:12px; }
.timon-company .co-editor strong { flex-basis:100%; overflow-wrap:anywhere; font-weight:600; }
.timon-company .co-editor .co-error { flex-basis:100%; }
.timon-company .co-viewport { flex:1; min-height:200px; overflow:auto; overscroll-behavior:contain; }
.timon-company .co-world { position:relative; transform-origin:0 0; }
.timon-company .co-edges { position:absolute; inset:0; overflow:visible; pointer-events:none; }
.timon-company .co-node { position:absolute; display:flex; flex-direction:column; gap:5px; padding:14px 16px; text-align:left; border-radius:10px; transition:background-color 150ms,border-color 150ms; }
.timon-company .co-node[aria-pressed=true] { border-color:hsl(var(--primary)); outline:2px solid hsl(var(--primary) / .3); outline-offset:2px; }
.timon-company .co-node[data-dim=true] { opacity:.35; }
.timon-company .co-node strong { font-size:15px; font-weight:600; }
.timon-company .co-node :is(strong,span) { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; width:100%; }
.timon-company .co-node small { font-size:11px; color:hsl(var(--muted-foreground)); }
.timon-company .co-empty { flex:1; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:12px; padding:32px; text-align:center; }
@media(max-width:600px) { .timon-company .co-search { order:3; width:100%; margin-left:0; } .timon-company .co-tools { margin-left:auto; } .timon-company .co-editor { max-height:40dvh; overflow:auto; } }
@media(prefers-reduced-motion:reduce) { .timon-company .co-node { transition:none; } }
`;

async function readWorkspaces(signal: AbortSignal): Promise<HierarchyWorkspace[]> {
  // Without poles the chart still stands: projects then report to the main agent.
  const res = await fetch('/api/ui/workspaces', { cache: 'no-store', signal }).catch(() => null);
  if (!res?.ok) return [];
  const body = await res.json().catch(() => ({}));
  return Array.isArray(body.workspaces) ? body.workspaces : [];
}

/** Writes an agent's manager (null = back to the default). */
async function writeReportsTo(agent: string, manager: string | null, signal?: AbortSignal): Promise<boolean> {
  const res = await fetch(`/api/ui/agents/${encodeURIComponent(agent)}/config`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reports_to: manager }), signal,
  }).catch(() => null);
  return !!res?.ok;
}

async function readAgents(signal: AbortSignal): Promise<Agent[]> {
  const res = await fetch('/api/ui/agents', { cache: 'no-store', signal });
  if (!res.ok) throw new Error('agents');
  const body = await res.json();
  if (!Array.isArray(body.agents)) throw new Error('agents');
  return body.agents.filter((agent: Agent) => agent && typeof agent.name === 'string' && agent.name.trim());
}

export function CompanyView() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [workspaces, setWorkspaces] = useState<HierarchyWorkspace[]>([]);
  const [error, setError] = useState(false);
  const [stale, setStale] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: '', manager: '', initialManager: '' });
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const fitted = useRef(true);
  const mounted = useRef(false);
  const pendingSave = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    setError(false);
    let loaded = false;
    let polling = false;
    void Promise.all([
      readAgents(abort.signal),
      fetch(ENDPOINT, { cache: 'no-store', signal: abort.signal }).then(async res => {
        if (!res.ok) throw new Error('layout');
        return readOrganization((await res.json()).layout);
      }),
      readWorkspaces(abort.signal),
    ]).then(async ([roster, layout, poles]) => {
      if (abort.signal.aborted) return;
      // Reporting lines this chart used to store on its own move into the
      // agents' `reports_to`, once, so the Agents graph shows the same tree.
      // A line the daemon refuses stays in the layout and is retried next time.
      const legacy = legacyManagers(roster, layout);
      if (legacy.length) {
        const moved = new Set<string>();
        for (const line of legacy) if (await writeReportsTo(line.agent, line.manager, abort.signal)) moved.add(line.agent);
        if (moved.size === legacy.length) {
          const clean = withoutManagers(layout);
          const put = await fetch(ENDPOINT, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: clean }), signal: abort.signal }).catch(() => null);
          if (put?.ok) layout = clean;
        }
        if (moved.size) roster = roster.map(agent => moved.has(agent.name) ? { ...agent, reports_to: legacy.find(line => line.agent === agent.name)!.manager } : agent);
      }
      if (abort.signal.aborted) return;
      setAgents(roster); setOrganization(layout); setWorkspaces(poles); loaded = true;
    }).catch(() => { if (!abort.signal.aborted) setError(true); });
    const timer = setInterval(() => {
      if (!loaded || polling) return;
      polling = true;
      void readAgents(abort.signal).then(roster => {
        if (!abort.signal.aborted) { setAgents(roster); setStale(false); }
      }).catch(() => { if (!abort.signal.aborted) setStale(true); }).finally(() => { polling = false; });
    }, 20000);
    return () => { mounted.current = false; abort.abort(); pendingSave.current?.abort(); clearInterval(timer); };
  }, [revision]);

  const { members, repaired } = useMemo(() => companyMembers(agents, organization ?? readOrganization(null), workspaces), [agents, organization, workspaces]);
  const scene = useMemo(() => layoutCompany(members), [members]);
  const selected = members.find(member => member.id === selection);
  const search = query.trim().toLocaleLowerCase();
  const matches = (id: string, title: string) => !search || `${id} ${title}`.toLocaleLowerCase().includes(search);
  const found = members.some(member => matches(member.id, member.title));

  const fit = useCallback((overview = false) => {
    const area = viewport.current;
    if (!area) return;
    // Automatic fitting keeps labels readable on narrow screens. The Fit
    // action explicitly opts into an overview of the entire organization.
    const next = Math.max(overview ? 0.25 : 0.8, Math.min(1, (area.clientWidth - 16) / scene.width, (area.clientHeight - 16) / scene.height));
    setZoom(next);
    area.scrollTo({ left: Math.max(0, (scene.width * next - area.clientWidth) / 2), top: 0 });
  }, [scene.width, scene.height]);
  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(() => { if (fitted.current) fit(); });
    observer.observe(viewport.current);
    if (fitted.current) fit();
    return () => observer.disconnect();
  }, [fit, organization !== null]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !organization || pendingSave.current) return;
    const manager = draft.manager || null;
    if (!canReportTo(members, selected.id, manager)) { setSaveError(t('invalid')); return; }
    const next = setTitle(organization, selected.id, draft.title);
    const abort = new AbortController();
    pendingSave.current = abort;
    setSaving(true); setSaveError(''); setSaved(false);
    try {
      // Only a manager the user actually changed is written: re-saving a
      // title must not freeze a default line into an explicit one.
      if (draft.manager !== draft.initialManager && !(await writeReportsTo(selected.id, manager, abort.signal))) throw new Error('save');
      const res = await fetch(ENDPOINT, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: next }), signal: abort.signal });
      if (!res.ok) throw new Error('save');
      const roster = draft.manager !== draft.initialManager ? await readAgents(abort.signal).catch(() => null) : null;
      if (mounted.current) { if (roster) setAgents(roster); setOrganization(next); setSelection(null); setSaved(true); fitted.current = true; }
    } catch { if (mounted.current && !abort.signal.aborted) setSaveError(t('saveError')); }
    finally { pendingSave.current = null; if (mounted.current) setSaving(false); }
  }

  return <section className="timon-company" aria-label="Company">
    <style>{CSS}</style>
    <header className="co-toolbar">
      <h1>Company</h1><span className="co-muted">{organization && t('count', { count: members.length })}</span>
      <label className="co-search"><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('search')} aria-label={t('search')} /></label>
      <div className="co-tools">
        <button type="button" aria-label={t('zoomOut')} title={t('zoomOut')} disabled={zoom <= 0.25} onClick={() => { fitted.current = false; setZoom(value => Math.max(0.25, value - 0.15)); }}>−</button>
        <output aria-live="polite">{Math.round(zoom * 100)}%</output>
        <button type="button" aria-label={t('zoomIn')} title={t('zoomIn')} disabled={zoom >= 1.75} onClick={() => { fitted.current = false; setZoom(value => Math.min(1.75, value + 0.15)); }}>+</button>
        <button type="button" onClick={() => { fitted.current = false; fit(true); }}>{t('fit')}</button>
      </div>
    </header>
    {error ? <div className="co-empty" role="alert"><p>{t('loadError')}</p><button type="button" onClick={() => setRevision(value => value + 1)}>{t('retry')}</button></div>
      : !organization ? <p className="co-hint" role="status">{t('loading')}</p>
      : members.length === 0 ? <div className="co-empty"><p>{t('empty')}</p><a className="co-link" href="/edit?new=1" onClick={(e) => { e.preventDefault(); openAgentEditor({ isNew: true }); }}>{t('create')}</a></div>
      : <>
        {stale && <p className="co-notice" role="status">{t('stale')}</p>}
        {repaired.length > 0 && <p className="co-notice" role="status">{t('repaired')}</p>}
        {selected ? <form className="co-editor" onSubmit={save} aria-label={t('edit', { name: selected.id })}>
          <fieldset disabled={saving}>
            <strong>{selected.id}</strong>
            <label>{t('title')}<input list="company-roles" required maxLength={80} value={draft.title} onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} /></label>
            <datalist id="company-roles">{ROLES.map(role => <option key={role} value={role} />)}</datalist>
            <label>{t('manager')}<select value={draft.manager} onChange={event => setDraft(value => ({ ...value, manager: event.target.value }))}>
              <option value="">{t('root')}</option>
              {members.filter(member => canReportTo(members, selected.id, member.id)).map(member => <option key={member.id} value={member.id}>{member.title} · {member.id}</option>)}
            </select></label>
            <button type="submit" className="co-primary">{t(saving ? 'saving' : 'save')}</button>
            <button type="button" onClick={() => setSelection(null)}>{t('cancel')}</button>
            <ChatLink className="co-link" href={chatHref(selected.id)}>{t('chat')}</ChatLink>
          </fieldset>
          {saveError && <p className="co-error" role="alert">{saveError}</p>}
        </form> : <p className="co-hint" role="status">{saved ? t('saved') : t('hint')}</p>}
        {search && !found && <p className="co-hint" role="status">{t('noMatch')}</p>}
        <div ref={viewport} className="co-viewport" role="region" aria-label={t('diagram')} tabIndex={0}>
          <div style={{ width: scene.width * zoom, height: scene.height * zoom, margin: '0 auto' }}>
            <div className="co-world" style={{ width: scene.width, height: scene.height, transform: `scale(${zoom})` }}>
              <svg className="co-edges" width={scene.width} height={scene.height} aria-hidden="true"><g fill="none" stroke="hsl(var(--muted-foreground) / 0.6)" strokeWidth="1.5">{scene.edges.map(edge => <path key={edge.id} d={edge.path} />)}</g></svg>
              {scene.nodes.map(node => <button type="button" className="co-node" key={node.id} data-agent={node.id} aria-pressed={selection === node.id} data-dim={!matches(node.id, node.title)} aria-label={`${node.title} · ${node.id} · ${t('reportingTo', { manager: node.manager ?? t('root') })}`} disabled={saving} style={{ width: CARD_WIDTH, height: CARD_HEIGHT, left: node.x, top: node.y }} onClick={() => { setSelection(node.id); setDraft({ title: node.title, manager: node.manager ?? '', initialManager: node.manager ?? '' }); setSaveError(''); setSaved(false); }}>
                <strong title={node.title}>{node.title}</strong><span className="co-muted" title={node.id}>{node.id}</span><small>{t(members.filter(member => member.manager === node.id).length === 1 ? 'report' : 'reports', { count: members.filter(member => member.manager === node.id).length })}</small>
              </button>)}
            </div>
          </div>
        </div>
      </>}
  </section>;
}

type ClientContext = { slots: { register(options: { slot: string; key: string }, Component: React.ComponentType): () => void } };
export function apply(ctx: ClientContext) {
  const disposePage = ctx.slots.register({ slot: 'page', key: '/company' }, CompanyView);
  const disposeView = ctx.slots.register({ slot: 'agents.view', key: 'company' }, CompanyView);
  return () => { disposeView(); disposePage(); };
}
