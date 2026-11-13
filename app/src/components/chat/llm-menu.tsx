'use client';

/**
 * The composer's model chip: a `ModelPickerPopover` (`docs/MODEL-PICKER.md`)
 * opened from the model name in the bar, above it when the bar sits at the
 * foot of the screen.
 *
 * The picker holds the models; this wrapper adds, in its `footer`, what only
 * the composer needs:
 *   - the thinking control, when the selected model has one (a slider over
 *     levels or budget steps, an off / on switch);
 *   - the confirmation of a switch, with the choice of how the context
 *     crosses on a backend handover (whole thread or summary).
 *
 * Compaction (summarize + fork) is NOT here: it loses context, it belongs to
 * the modal reachable from the context gauge. This menu only switches.
 */

import { cloneElement, useEffect, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { BackendLimitsBadge } from '@/components/backend-limits-badge';
import { ModelPickerPopover, type CatalogTarget, type ModelPick } from '@/components/model-picker';
import {
  currentLlm,
  useBackendCatalog,
  type BackendCatalog,
  type BackendName,
} from '@/lib/backends';
import { thinkingBarFor, thinkingLabel, thinkingValues } from '@/lib/thinking-bar';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

/** How the context should cross on a backend handover. Mirrors the daemon's
 *  `SwitchContextChoice`: `auto` leaves the configured threshold to arbitrate,
 *  which is what a switch with no conversation behind it wants. */
export type SwitchContextChoice = 'auto' | 'transcript' | 'summary';

/** The pair awaiting confirmation, with what the confirmation draws. */
type Target = { backend: BackendName; slug: string; label: string; brand?: string; icon?: string };

/** What the trigger must accept: the picker spreads its ref, click and ARIA on it. */
type TriggerElement = React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>>;

/** `500 k` rather than `500000`: the weight of the thread about to cross is
 *  read as an order of magnitude, never as an exact count. */
function formatTokens(tokens: number): string {
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)} M`
    : tokens >= 1_000
      ? `${Math.round(tokens / 1000)} k`
      : String(tokens);
}

function targetOf(catalog: BackendCatalog, pick: ModelPick): Target {
  const entry = catalog.backends.find((b) => b.id === pick.backend);
  const model = entry?.models.find((m) => m.slug === pick.model);
  return {
    backend: pick.backend,
    slug: pick.model,
    label: model ? model.presetLabel ?? model.label : pick.model,
    brand: model?.brand ?? entry?.brand,
    icon: model?.icon ?? entry?.icon,
  };
}

export function LlmMenu({
  children,
  backend,
  model,
  reasoningEffort,
  onReasoningEffort,
  onPick,
  missionId = null,
  busy = false,
  thinking = false,
  align = 'start',
  confirm = true,
  target = null,
}: {
  /** The trigger — the model name in the composer bar. A `<button>`: the
   *  picker hands it its ref, click and ARIA attributes. */
  children: TriggerElement;
  /** Backend + model of the NEXT turn, already resolved by the page. */
  backend: BackendName;
  model: string;
  /** Effective reasoning level for the next turn, `null` = model default. */
  reasoningEffort: string | null;
  /** Absent: the pair carries no thinking level (a setting, not a turn), and
   *  the slider is not shown rather than offering a value nobody stores. */
  onReasoningEffort?: (effort: string | null) => Promise<void>;
  /** Applies the pair: hot switch during a mission, override before it. */
  onPick: (backend: BackendName, model: string, contextMode: SwitchContextChoice) => Promise<void> | void;
  /** The open conversation, or null when none has started. It is what makes
   *  the confirmation worth asking — without a thread nothing is at stake,
   *  the pair only waits for the first message — and it is what the context
   *  preview is fetched for. */
  missionId?: string | null;
  /** A switch is already in flight upstream: rows freeze for the round trip. */
  busy?: boolean;
  /** A turn is running — the model is queued rather than applied at once. */
  thinking?: boolean;
  /** `start` lines the panel up with the trigger's left edge (the composer's
   *  chip), `end` with its right edge (a settings row). */
  align?: 'start' | 'end';
  /** `false`: a click applies the pair at once. The confirmation exists for a
   *  live thread; a stored setting has nothing to restart. */
  confirm?: boolean;
  /** The agent this conversation runs: it is offered what it could run on. A
   *  setting of the whole instance has none. */
  target?: CatalogTarget | null;
}): React.ReactElement {
  const catalog = useBackendCatalog();
  const [open, setOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  /** Pair awaiting confirmation. Changing the LLM mid-thread is not a
   *  preference toggle: on another engine the session is restarted and the
   *  context may come across as a summary. One click was too cheap for
   *  that — the menu asks, and says which of the two cases it is. */
  const [pending, setPending] = useState<Target | null>(null);

  // A versioned slug (`claude-opus-5-…`) must still light up the catalog row
  // it came from.
  const { backend: curBackend, model: curModel } = currentLlm(catalog, backend, model);
  const entry = catalog.backends.find((b) => b.id === curBackend);
  const listed = (slug: string) => !!slug && !!entry?.models.some((m) => m.slug === slug);
  // The raw slug when the catalogue lists it, else its normalised alias, else
  // the raw slug again (typed by hand: the picker shows it at the head of its
  // provider). Nothing at all when no model is known yet.
  const valueModel = listed(model) ? model : listed(curModel) ? curModel : model;
  const value: ModelPick | null = curBackend && valueModel ? { backend: curBackend, model: valueModel } : null;
  const isCurrent = (pick: ModelPick) =>
    pick.backend === curBackend && (pick.model === model || pick.model === curModel);

  // Levels of the SELECTED model. Outside the catalog (hand-typed slug) the
  // list is empty and the slider disappears rather than offering values the
  // CLI would refuse.
  // The RAW slug, not `curModel`: the alias normalisation would turn
  // `claude-sonnet-5-5` into `sonnet`, which a discovered catalog may not list.
  const bar = thinkingBarFor(catalog, curBackend, model ?? '');
  const reasoningLevels = thinkingValues(bar);
  /** `null` first: the leftmost stop is the model's own default, otherwise
   *  there would be no way back to it once the cursor has moved. */
  const stops: (string | null)[] = [null, ...reasoningLevels];
  const stopLabel = (level: string | null) => thinkingLabel(bar, level) ?? t('llm.auto');
  /** A level the current model doesn't know (inherited from another one, or
   *  set elsewhere) has no stop: cursor AND label both fall back to the
   *  default, rather than showing two different things. */
  const knownEffort = reasoningEffort && reasoningLevels.includes(reasoningEffort)
    ? reasoningEffort
    : null;
  const stopIndex = Math.max(0, stops.indexOf(knownEffort));

  function setMenuOpen(next: boolean): void {
    setOpen(next);
    if (!next) setPending(null);
  }

  async function apply(target: Target, contextMode: SwitchContextChoice = 'auto'): Promise<void> {
    if (applying || busy) return;
    setApplying(true);
    // Closed straight away: a backend handover takes as long as the summary
    // it may have to produce, and watching a spinner inside a menu that
    // covers the conversation is the wrong place to wait. The banner above
    // the composer carries the rest.
    setMenuOpen(false);
    try {
      await onPick(target.backend, target.slug, contextMode);
      // A level the new model doesn't know would be refused by its CLI:
      // we fall back to its default rather than carry a dead value over.
      const levels = thinkingValues(thinkingBarFor(catalog, target.backend, target.slug));
      if (onReasoningEffort && reasoningEffort && !levels.includes(reasoningEffort)) {
        await onReasoningEffort(null);
      }
    } finally {
      setApplying(false);
    }
  }

  function choose(pick: ModelPick | null): void {
    if (!pick) return;
    // Re-picking the running model is a no-op.
    if (isCurrent(pick)) { setMenuOpen(false); return; }
    const target = targetOf(catalog, pick);
    // The click ARMS the change, it doesn't apply it: the panel below says
    // what it costs, and only then does the switch leave.
    if (confirm) setPending(target);
    else void apply(target);
  }

  async function setEffort(level: string | null): Promise<void> {
    if (level === knownEffort || !onReasoningEffort) return;
    await onReasoningEffort(level);
  }

  const fromTarget: Target = targetOf(catalog, { backend: curBackend, model: curModel });

  const footer = pending ? (
    <ConfirmSwitch
      catalog={catalog}
      from={fromTarget}
      to={pending}
      missionId={missionId}
      thinking={thinking}
      busy={busy || applying}
      onCancel={() => setPending(null)}
      onConfirm={(contextMode) => { void apply(pending, contextMode); }}
    />
  ) : (thinking || (bar && onReasoningEffort)) ? (
    <div className="flex flex-col gap-1">
      {thinking && (
        <p className="px-1 text-[10px] text-muted-foreground">
          {t('llmDialog.turnInProgress')}
        </p>
      )}
      {/* Reasoning: a row of stops rather than a list, because the levels are
        * ordered — from the model's default to its longest deliberation.
        * A model set by a switch gets three buttons instead. Hidden
        * outright when the model announces nothing to set. */}
      {bar && onReasoningEffort && (
        <div className="rounded-md bg-muted/40 px-2 pb-1.5 pt-1">
          <span className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('llm.thinking')}
          </span>
          {bar.type === 'toggle' ? (
            <div role="radiogroup" aria-label={t('chatPage.reasoningLevelTitle')} className="mt-1 flex gap-0.5 rounded bg-background/60 p-0.5">
              {stops.map((level) => (
                <button
                  key={level ?? 'default'}
                  type="button"
                  role="radio"
                  aria-checked={level === knownEffort}
                  onClick={() => { void setEffort(level); }}
                  className={cn(
                    'flex-1 rounded px-1.5 py-px text-[10px] capitalize transition-colors',
                    level === knownEffort ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {stopLabel(level)}
                </button>
              ))}
            </div>
          ) : (
            <ThinkingStops
              stops={stops}
              index={stopIndex}
              labelOf={stopLabel}
              onPick={(level) => { void setEffort(level); }}
            />
          )}
        </div>
      )}
    </div>
  ) : undefined;

  return (
    <ModelPickerPopover
      value={value}
      onChange={choose}
      target={target}
      footer={footer}
      disabled={busy || applying}
      align={align}
      open={open}
      onOpenChange={setMenuOpen}
      // The confirmation lives in the footer: the panel stays open on a pick
      // and closes once the switch leaves (or right away without `confirm`).
      keepOpenOnPick
      renderTrigger={({ ref, onClick, disabled, ...aria }) => cloneElement(children, {
        ...aria,
        ref,
        onClick,
        disabled: Boolean(children.props.disabled) || disabled || busy,
      } as Partial<React.ButtonHTMLAttributes<HTMLButtonElement>> & React.RefAttributes<HTMLButtonElement>)}
    />
  );
}

/**
 * The thinking levels as a row of stops joined by a line, the chosen one
 * filled, each with its name under it. A native range lies transparent over
 * the dots: it keeps the drag, the arrow keys and the accessible value, the
 * dots only draw it. Its thumb travels half a thumb inside its box, hence the
 * `-inset-x-2` that lines its stops up with the dots' centres.
 */
function ThinkingStops({ stops, index, labelOf, onPick }: {
  stops: (string | null)[];
  index: number;
  labelOf: (level: string | null) => string;
  onPick: (level: string | null) => void;
}): React.ReactElement {
  const last = Math.max(1, stops.length - 1);
  return (
    <div className="px-4 pt-1">
      <div className="relative h-4">
        <input
          type="range"
          min={0}
          max={stops.length - 1}
          step={1}
          value={index}
          onChange={(e) => onPick(stops[Number(e.target.value)] ?? null)}
          // Arrow keys drive the cursor; the picker would otherwise read
          // them as a move between rows and steal the gesture.
          onKeyDown={(e) => e.stopPropagation()}
          aria-label={t('chatPage.reasoningLevelTitle')}
          aria-valuetext={labelOf(stops[index] ?? null)}
          className="peer absolute -inset-x-2 inset-y-0 z-10 m-0 h-full w-[calc(100%+1rem)] cursor-pointer opacity-0"
        />
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/30" />
        {stops.map((level, i) => (
          <span
            key={level ?? 'default'}
            aria-hidden
            style={{ left: `${(i / last) * 100}%` }}
            className={cn(
              'absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors',
              i === index
                ? 'bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-popover'
                : 'border-2 border-muted-foreground/40 bg-popover',
            )}
          />
        ))}
      </div>
      <div className="relative mt-0.5 h-3.5">
        {stops.map((level, i) => (
          <button
            key={level ?? 'default'}
            type="button"
            tabIndex={-1}
            onClick={() => onPick(level)}
            style={{ left: `${(i / last) * 100}%` }}
            className={cn(
              'absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10px] capitalize leading-none transition-colors',
              i === index ? 'font-semibold text-foreground' : 'text-muted-foreground/70 hover:text-foreground',
            )}
          >
            {labelOf(level)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One side of the confirmation, drawn like the handover card in the
 *  thread: the same two tiles and the same arrow, so the panel reads as a
 *  preview of the row that will land in the conversation. */
function SwitchTile({ slug, brand, icon, label, dim }: {
  slug?: string;
  brand?: string;
  icon?: string;
  label: string;
  dim?: boolean;
}): React.ReactElement {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1',
        dim ? 'bg-muted/40' : 'bg-background shadow-sm',
      )}
    >
      <BrandMark slug={slug} fallbackIcon={icon} fallbackBrand={brand} className={cn('size-3.5', dim && 'opacity-60')} />
      <span className={cn(
        'min-w-0 flex-1 truncate text-[10px] font-medium',
        dim ? 'text-muted-foreground' : 'text-foreground',
      )}>
        {label}
      </span>
    </div>
  );
}

/** What the daemon says a switch would do to the context, before doing it.
 *  Mirrors GET /api/ui/missions/:id/switch-preview. */
type SwitchPreview = {
  transcriptTokens: number;
  fitsWhole: boolean;
  /** What `auto` would pick, i.e. what the configured threshold says. */
  mode: 'transcript' | 'summary' | 'tail' | 'none';
};

/**
 * Confirmation, in the picker's footer, under the list.
 *
 * Leaving a backend tears the session down and hands the conversation over to
 * another process. That much is unavoidable; what happens to the CONTEXT is
 * not, and used to be decided for the user by a threshold they never saw. So
 * the panel says how big the thread is and offers both doors: hand it over
 * whole, or compact it into a summary. Staying on the same engine changes
 * nothing but the model, and the panel says so rather than dressing a
 * harmless click as a danger.
 */
function ConfirmSwitch({ catalog, from, to, missionId, thinking, busy, onCancel, onConfirm }: {
  catalog: BackendCatalog;
  from: Target;
  to: Target;
  missionId: string | null;
  thinking: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (contextMode: SwitchContextChoice) => void;
}): React.ReactElement {
  const sameBackend = to.backend === from.backend;
  const live = Boolean(missionId);
  // A turn in flight makes the daemon refuse a backend change outright
  // (409): better to say it here than to let the round trip fail.
  const blocked = live && !sameBackend && thinking;
  // Only a real handover needs a preview: same engine, nothing crosses.
  const handover = live && !sameBackend;
  const [preview, setPreview] = useState<SwitchPreview | null>(null);

  useEffect(() => {
    if (!handover || !missionId) return;
    let alive = true;
    setPreview(null);
    fetch(`/api/ui/missions/${encodeURIComponent(missionId)}/switch-preview`
      + `?backend=${encodeURIComponent(to.backend)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j?.ok) setPreview(j as SwitchPreview); })
      // A preview that doesn't answer must not block the switch: the panel
      // falls back to the wording alone, and `auto` decides as before.
      .catch(() => { /* silent */ });
    return () => { alive = false; };
  }, [handover, missionId, to.backend]);

  const explanation = !live
    ? t('llm.confirmPending')
    : sameBackend
      ? t('llm.confirmSameBackend')
      : t('llm.confirmNewBackend');

  return (
    <div
      role="group"
      aria-label={t('llm.confirmTitle')}
      className="flex flex-col gap-1.5 rounded-md bg-muted/40 p-2"
      // Escape steps back to the list rather than closing the whole panel.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('llm.confirmTitle')}
        </p>
        {/* What the target cannot do (remote agent, no files), before the
          * switch rather than after a refused turn. */}
        {!sameBackend && <BackendLimitsBadge catalog={catalog} backend={to.backend} className="px-1.5 py-0 text-[10px]" />}
      </div>
      <div className="flex items-center gap-2">
        <SwitchTile slug={from.slug} brand={from.brand} icon={from.icon} label={from.label || '—'} dim />
        <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <SwitchTile slug={to.slug} brand={to.brand} icon={to.icon} label={to.label} />
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">{explanation}</p>
      {handover && preview && preview.mode !== 'none' && (
        <p className="text-[10px] text-muted-foreground">
          {t('llm.confirmContextSize', { tokens: formatTokens(preview.transcriptTokens) })}
          {!preview.fitsWhole && ` — ${t('llm.confirmTooLarge')}`}
        </p>
      )}
      {blocked && (
        <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
          {t('llm.confirmTurnBlocked')}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="mr-auto rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          {t('llm.confirmCancel')}
        </button>
        {/* Two doors, and only on a real handover. The secondary one is
          * compaction: it is the lossy path, so it never gets the primary
          * button — but it stays one click away, because a thread one wants
          * to leave behind is a legitimate reason to switch. */}
        {handover && (
          <button
            type="button"
            disabled={busy || blocked}
            onClick={() => onConfirm('summary')}
            className="rounded-md bg-background px-2 py-1 text-[10px] font-medium text-foreground shadow-sm transition-colors hover:bg-foreground/[0.06] disabled:opacity-50"
            title={t('llm.confirmCompactTitle')}
          >
            {t('llm.confirmCompact')}
          </button>
        )}
        <button
          type="button"
          autoFocus
          // The whole thread is the DEFAULT door: nothing is lost, and since
          // codex reads its prompt from stdin no engine caps it any more.
          // Disabled only when the target CLI physically cannot swallow it.
          disabled={busy || blocked || (handover && preview !== null && !preview.fitsWhole)}
          onClick={() => onConfirm(handover ? 'transcript' : 'auto')}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[10px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          title={handover ? t('llm.confirmWholeTitle') : undefined}
        >
          {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
          {handover ? t('llm.confirmWhole') : t('llm.confirmApply')}
        </button>
      </div>
    </div>
  );
}
