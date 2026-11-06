'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  useBackendCatalog,
  presetsOf,
  backendLabel,
  isAccountInstance,
  isPickable,
  currentLlm,
  type BackendName,
} from '@/lib/backends';
import { BrandMark } from '@/components/brand-mark';
import { ModelPickerPanel, pickLabel, type CatalogTarget, type ModelPick } from '@/components/model-picker';
import { t } from '@/lib/i18n';
import { compactStore, isRunning, useMissionCompaction } from '@/lib/mission-compact';
import { thinkingBarFor, thinkingValues } from '@/lib/thinking-bar';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Mission concerned, or `null` when none has started yet.
   *
   * This is what distinguishes the two modes: with a mission we act on a live
   * thread (switch / compact), without a mission we only choose the LLM for
   * the upcoming first turn.
   */
  missionId: string | null;
  /** Current backend / model of the live mission, used to pre-select
   *  the matching preset and badge it "current". */
  currentBackend?: string;
  currentModel?: string;
  currentReasoningEffort?: string | null;
  /**
   * Switches the LLM of the CURRENT thread, without compacting or forking
   * (POST /missions/:id/model or /backend depending on whether the backend
   * changes). Absent → the modal only offers compaction.
   */
  onSwitch?: (backend: BackendName, model: string, reasoningEffort: string | null) => Promise<void>;
  /**
   * Remembers the chosen pair for the NEXT mission (per-mission override,
   * the agent's config is not touched). Used when `missionId` is null.
   */
  onPick?: (backend: BackendName, model: string, reasoningEffort: string | null) => void;
  /** A switch is already in flight on the parent side. */
  switching?: boolean;
  /** A turn is running: the model is queued, the backend would be refused. */
  thinking?: boolean;
  /** The agent this conversation runs: it is offered what it could run on. */
  target?: CatalogTarget | null;
};

/**
 * LLM picker modal — the ONLY place in the app where a backend+model pair is
 * chosen for a conversation. Same picker (`ModelPickerPanel`), same catalog, whether
 * the conversation has started or not; only the actions offered at the
 * bottom change:
 *
 *   - **before the 1st message** (`missionId` null): "Use this LLM" sets an
 *     override for the mission about to be born.
 *   - **during the mission**, opened from the gauge's "compact onto another
 *     model": "Compact" starts the compaction at once (POST /compact — in
 *     place when the pair is the current one and the backend can, else a
 *     summary and a fork), its progress shows on the gauge. "Switch"
 *     (`onSwitch`) keeps the thread without compacting.
 *
 * One single modal rather than a selector here and another popup there: the
 * choice is the same, only the consequence differs — and a menu that doesn't
 * show the same models depending on where it's opened is a trap in itself.
 */
export function LlmDialog({
  open,
  onOpenChange,
  missionId,
  currentBackend,
  currentModel,
  currentReasoningEffort = null,
  onSwitch,
  onPick,
  switching = false,
  thinking = false,
  target = null,
}: Props): React.ReactElement {
  // Catalog loaded at runtime from the orchestrator: empty on first paint,
  // then filled in. Everything derived from it must tolerate the empty list.
  const catalog = useBackendCatalog();
  // Preset display order = section order: the catalog's `presetRank`
  // already decides which backend comes first, we don't redecide it.
  const presets = presetsOf(catalog);
  // Normalised current backend/model: a versioned slug lights up the
  // catalogue row it came from.
  const { backend: curB, model: curM } = currentLlm(catalog, currentBackend, currentModel);

  /** The current pair, even off the catalogue (the picker shows a typed slug
   *  at the head of its provider, a gone account disabled); the first preset
   *  when nothing runs yet. */
  const initialPick = (): ModelPick | null =>
    curM
      ? { backend: curB, model: curM }
      : presets[0] ? { backend: presets[0].backend, model: presets[0].model } : null;
  const [pick, setPick] = useState<ModelPick | null>(initialPick);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const compaction = useMissionCompaction(missionId);
  const compacting = compaction.starting || isRunning(compaction.operation);
  /* The reasoning level is no longer SET here: it lives in the composer
     bar, next to the LLM name, because it's adjusted turn by turn while the
     model only changes occasionally. The modal still carries it along — it
     must pass it back unchanged to the switch, the pick and the fork,
     otherwise choosing a model would reset the level to zero. */
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);

  // Reset every time we re-open so a previous run's choices don't bleed.
  useEffect(() => {
    if (open) {
      setPick(initialPick());
      setMessage('');
      setReasoningEffort(currentReasoningEffort);
    }
    // initialPick depends on currentBackend/Model props which the parent
    // re-passes each render — including it would reset on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The catalog arrives after the first paint: if the modal opened before
  // that, `pick` is still empty → we reseed it as soon as presets are there,
  // without overwriting a choice the user already made.
  useEffect(() => {
    if (!pick && presets.length > 0) setPick(initialPick());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets.length]);

  const effective: ModelPick = pick ?? { backend: catalog.defaultBackend, model: '' };
  /** The thread runs on something else than the pick: said above the picker,
   *  whose check mark follows the pick. */
  const showCurrent = !!curM && (effective.backend !== curB || effective.model !== curM);
  // A subscription account to sign in again, out of quota, or no longer
  // listed may be the CURRENT pair (shown, never replaced), but nothing is
  // sent to it: the mission would fail and never move to another account.
  const effectiveEntry = catalog.backends.find((b) => b.id === effective.backend);
  const offered = catalog.backends.length === 0
    || (effectiveEntry ? isPickable(effectiveEntry) : !isAccountInstance(effective.backend));
  // Memoised: a fresh array on every render would re-run the reset below.
  const reasoningLevels = useMemo(
    () => thinkingValues(thinkingBarFor(catalog, effective.backend, effective.model)),
    [catalog, effective.backend, effective.model],
  );
  useEffect(() => {
    if (reasoningLevels.length === 0) setReasoningEffort(null);
    else if (reasoningEffort && !reasoningLevels.includes(reasoningEffort)) {
      setReasoningEffort(null);
    }
  }, [effective.backend, effective.model, reasoningEffort, reasoningLevels]);

  /**
   * Switches the current thread to the chosen pair. All the work (calls,
   * toasts, optimistic rewind) lives on the parent side: the modal only
   * closes once the request is sent — the SSE will confirm it.
   */
  async function doSwitch(): Promise<void> {
    if (busy || switching || !onSwitch || !missionId) return;
    if (!effective.model) {
      toast.error(t('llmDialog.missingModel'));
      return;
    }
    if (
      effective.backend === curB
      && effective.model === curM
      && reasoningEffort === currentReasoningEffort
    ) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    try {
      await onSwitch(effective.backend, effective.model, reasoningEffort);
      onOpenChange(false);
    } catch (error) {
      toast.error(t('llmDialog.switchFailed'), {
        description: error instanceof Error ? error.message : t('llmDialog.unknownError'),
      });
    } finally {
      setBusy(false);
    }
  }

  /** "Before the 1st message" mode: we only remember the choice. */
  function doPick(): void {
    if (!onPick) return;
    if (!effective.model) {
      toast.error(t('llmDialog.missingModel'));
      return;
    }
    onPick(effective.backend, effective.model, reasoningEffort);
    onOpenChange(false);
  }

  /** One click: the daemon picks native or summary + fork, answers at once,
   *  and the gauge shows the progress; the chat opens the new conversation
   *  when a fork ends. */
  async function doCompact(): Promise<void> {
    if (busy || !missionId) return;
    if (!effective.model) {
      toast.error(t('llmDialog.missingModel'));
      return;
    }
    setBusy(true);
    try {
      const result = await compactStore.start(missionId, {
        backend: effective.backend,
        model: effective.model,
        reasoning_effort: reasoningEffort,
        message: message.trim() || undefined,
      });
      if (!result.ok) {
        toast.error(result.failure);
        return;
      }
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl overflow-hidden p-0">
        <DialogHeader className="space-y-1 px-5 pb-2 pt-5">
          <DialogTitle>
            {!missionId ? t('llmDialog.titlePick') : t('llmDialog.titleCompact')}
          </DialogTitle>
          <DialogDescription>
            {!missionId
              ? t('llmDialog.descPick')
              : onSwitch ? t('llmDialog.descCompactSwitch') : t('llmDialog.descCompactOnly')}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[72vh] space-y-3 overflow-y-auto px-5 pb-3 pt-1">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <label className="text-xs font-medium text-muted-foreground">
                {t('llmDialog.targetLlm')}
              </label>
              {/* The pick, wherever the picker's opened view is: a search or
                * another provider would otherwise hide which row is chosen. */}
              {effective.model && (
                <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
                  <BrandMark slug={effective.model} className="size-3.5" />
                  <span className="truncate text-foreground">{pickLabel(catalog, effective)}</span>
                  <span className="truncate text-muted-foreground">
                    {isAccountInstance(effective.backend) ? backendLabel(catalog, effective.backend) : effective.backend}
                  </span>
                </span>
              )}
            </div>
            {showCurrent && (
              <p className="truncate text-[11px] text-muted-foreground/80">
                {t('llmDialog.current')} : {isAccountInstance(curB) ? backendLabel(catalog, curB) : curB} · {curM}
              </p>
            )}
            {thinking && onSwitch && (
              <p className="text-[10px] text-muted-foreground/70">
                {t('llmDialog.turnInProgress')}
              </p>
            )}
            <ModelPickerPanel
              value={pick}
              onChange={(next) => { if (next) setPick(next); }}
              target={target}
              autoFocusSearch
              className="h-[300px] max-h-[46vh]"
            />
          </div>

          {/* The follow-up message only makes sense for compaction: it's what
            * kicks off the forked mission. Outside a mission, the composer plays
            * that role — showing it here would be a second input field for the
            * same sentence. */}
          {missionId && (
            <div className="space-y-1.5">
              <label
                htmlFor="compact-message"
                className="text-xs font-medium text-muted-foreground"
                title={t('llmDialog.compactHelp')}
              >
                {t('llmDialog.followupMessage')} <span className="text-muted-foreground/60">({t('llmDialog.optional')})</span>
              </label>
              <Textarea
                id="compact-message"
                placeholder={t('llmDialog.followupPlaceholder')}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={1}
                className="min-h-9 resize-none py-2 text-xs"
              />
            </div>
          )}
        </div>

        <DialogFooter className="bg-muted/20 px-5 py-3 sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t('common.cancel')}
          </Button>
          <div className="flex gap-2">
            {/* Switching without compacting stays here: it is the one surface
              * that carries a hand-typed slug mid-thread. */}
            {missionId && onSwitch && (
              <Button
                variant="outline"
                onClick={doSwitch}
                disabled={busy || switching || compacting || !effective.model || !offered}
                title={
                  thinking
                    ? t('llmDialog.turnInProgressTitle')
                    : undefined
                }
              >
                {switching ? t('llmDialog.switching') : t('llmDialog.switch')}
              </Button>
            )}
            {/* Opened from the gauge's "compact onto another model": the
              * button compacts at once, no second confirmation. */}
            {missionId && (
              <Button
                onClick={() => void doCompact()}
                disabled={busy || switching || compacting || !effective.model || !offered}
              >
                {busy || compacting ? t('llmDialog.compacting') : t('llmDialog.compact')}
              </Button>
            )}
            {!missionId && onPick && (
              <Button onClick={doPick} disabled={!effective.model || !offered}>
                {t('llmDialog.useThisLlm')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
