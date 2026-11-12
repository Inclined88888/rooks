'use client';

import { useId, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';

import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { FramedFace } from './agent-avatar';
import { AgentPicker } from './agent-picker';
import {
  nouvelIdInstance,
  type AgentChatInstance,
  type SubAgent,
} from './instances';
import { useAgents, useProjets, visageAgent, type AgentChoisissable } from './use-agents';

const CHAMP =
  'w-full rounded-lg border border-border bg-background/60 px-2.5 py-1.5 text-[12px] outline-none focus:border-primary/60';
const BOUTON_ICONE =
  'grid size-6 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:text-primary disabled:opacity-30';

/** Ordered move inside the sub-agent list. Out-of-range moves are no-ops so the
 *  arrows can stay in the DOM at both ends (a disabled button explains itself
 *  where a missing one does not). */
function deplacer(liste: SubAgent[], index: number, delta: number): SubAgent[] {
  const cible = index + delta;
  if (cible < 0 || cible >= liste.length) return liste;
  const suivante = [...liste];
  const [item] = suivante.splice(index, 1);
  if (item) suivante.splice(cible, 0, item);
  return suivante;
}

/**
 * The per-instance config: which agent the card shows, and the other agents of
 * its avatar row — picked from the installed agents, pictured and named by
 * them.
 *
 * The form edits a draft and only calls `onSave` on submit: an instance is
 * persisted daemon-side, and writing on every keystroke would send a request
 * per typed character — and half-typed agent names to the chat.
 */
export function InstanceConfig({
  instance,
  onSave,
  onCancel,
  onDelete,
}: {
  /** `null` on the creation card: the config is then the only thing it shows. */
  instance: AgentChatInstance | null;
  onSave: (instance: AgentChatInstance) => void | boolean | Promise<void | boolean>;
  onCancel: () => void;
  /** Absent on the creation card — there is nothing yet to remove. */
  onDelete?: () => void;
}) {
  const agents = useAgents();
  const projets = useProjets();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [brouillon, setBrouillon] = useState<AgentChatInstance>(
    () => instance ?? { id: nouvelIdInstance(), agent: '', title: '', avatar: '', zone: '', subAgents: [] },
  );

  const patch = (champs: Partial<AgentChatInstance>) =>
    setBrouillon((b) => ({ ...b, ...champs }));

  const ajouterSousAgent = (agent: string) =>
    patch({ subAgents: [...brouillon.subAgents, { agent }] });

  const surLaCarte = useMemo(
    () => new Set([brouillon.agent, ...brouillon.subAgents.map((s) => s.agent)].map((n) => n.trim().toLowerCase())),
    [brouillon.agent, brouillon.subAgents],
  );

  return (
    <form
      className="flex flex-col gap-3 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving || !brouillon.agent.trim()) return;
        setSaving(true);
        setSaveError(false);
        try {
          const ok = await onSave({
            ...brouillon,
            agent: brouillon.agent.trim(),
          });
          setSaveError(ok === false);
        } catch {
          setSaveError(true);
        } finally {
          setSaving(false);
        }
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t('agentChat.config.agent')}
        </span>
        <ChoixAgent
          agents={agents}
          value={brouillon.agent}
          onChange={(agent) => patch({ agent })}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t('agentChat.config.title')}
        </span>
        <input
          className={CHAMP}
          value={brouillon.title}
          placeholder={brouillon.agent || t('agentChat.config.titlePlaceholder')}
          onChange={(e) => patch({ title: e.target.value })}
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {t('agentChat.config.subAgents')}
        </span>

        {brouillon.subAgents.length === 0 ? (
          <p className="text-[11px] leading-snug text-muted-foreground/70">
            {t('agentChat.config.subAgentsHint')}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {brouillon.subAgents.map((sous, index) => (
              // The name is the key: the list holds each agent once
              // (`normaliserSousAgents`, and the picker greys those present).
              <li
                key={sous.agent}
                className="group flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-muted/40"
              >
                <FramedFace visage={visageAgent(sous.agent, agents, projets)} className="size-6" glyphClassName="text-[10px]" />
                <span className="min-w-0 flex-1 truncate text-[12px]">{sous.agent}</span>
                <button
                  type="button"
                  className={BOUTON_ICONE}
                  disabled={index === 0}
                  onClick={() => patch({ subAgents: deplacer(brouillon.subAgents, index, -1) })}
                  aria-label={t('agentChat.config.moveUp', { name: sous.agent })}
                  title={t('agentChat.config.moveUp', { name: sous.agent })}
                >
                  <ArrowUp className="size-3.5" />
                </button>
                <button
                  type="button"
                  className={BOUTON_ICONE}
                  disabled={index === brouillon.subAgents.length - 1}
                  onClick={() => patch({ subAgents: deplacer(brouillon.subAgents, index, 1) })}
                  aria-label={t('agentChat.config.moveDown', { name: sous.agent })}
                  title={t('agentChat.config.moveDown', { name: sous.agent })}
                >
                  <ArrowDown className="size-3.5" />
                </button>
                <button
                  type="button"
                  className={cn(BOUTON_ICONE, 'hover:text-destructive')}
                  onClick={() =>
                    patch({ subAgents: brouillon.subAgents.filter((_, i) => i !== index) })
                  }
                  aria-label={t('agentChat.config.removeSubAgent', { name: sous.agent })}
                  title={t('agentChat.config.removeSubAgent', { name: sous.agent })}
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <AgentPicker agents={agents} projets={projets} exclus={surLaCarte} onPick={ajouterSousAgent} />
      </div>

      {saveError && <p role="alert" className="text-xs text-destructive">{t('widgets.saveError')}</p>}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={saving || brouillon.agent.trim() === ''}
          className={cn(
            'rounded-lg border border-primary/60 bg-primary/15 px-3 py-1.5 text-[11px] font-medium text-primary',
            'transition-colors hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          {instance ? t('agentChat.config.save') : t('agentChat.config.create')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('agentChat.config.cancel')}
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="ml-auto rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground/70 transition-colors hover:text-destructive"
          >
            {t('agentChat.config.delete')}
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Agent picker. A datalist rather than a `select`: agent names are free-form on
 * disk (`alice.main`), and an agent created after this page loaded — or one
 * on a daemon that did not answer — must still be typeable.
 */
function ChoixAgent({
  agents,
  value,
  onChange,
}: {
  agents: readonly AgentChoisissable[];
  value: string;
  onChange: (value: string) => void;
}) {
  // Several cards can be configured at once: a fixed id would put duplicate
  // `datalist` ids in the document, and the browser would bind them all to the
  // first one.
  const listeId = useId();
  return (
    <>
      <input
        className={CHAMP}
        list={listeId}
        value={value}
        placeholder={t('agentChat.config.agentPlaceholder')}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listeId}>
        {agents.map((a) => (
          <option key={a.name} value={a.name} />
        ))}
      </datalist>
    </>
  );
}
