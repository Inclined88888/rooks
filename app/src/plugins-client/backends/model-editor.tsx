'use client';

/**
 * The shared model list for built-in, plugin and user-added backends.
 *
 * It exists because a provider is not obliged to enumerate what it serves: the
 * Anthropic gateway of DeepSeek answers `/v1/messages` and nothing else, so
 * the "Test" button comes back with no list at all. Before this editor the
 * only way out was to write `~/.timon/backends/<id>.json` by hand — a config
 * file, for a product whose whole point is not to need one.
 *
 * A row is a slug (what the CLI is given), a label (what a menu shows) and a
 * picture. The default model is a radio on the list rather than a field of its
 * own: it is one OF these models, never a free-standing value. A provider the
 * user added also gets, per model, how its thinking is set (`ThinkingPanel`).
 */

import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Brain, CircleDot, Eye, EyeOff, GripVertical, Image as ImageIcon, Plus, Trash2 } from 'lucide-react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PictoPanel } from './picto-panel';
import type { ReasoningControl } from '@/lib/backends';
import { contextWindowTextOf, thinkingChoiceOf, type ModelDraft } from './form';
import { formatContextWindow, parseContextWindow } from '@/lib/context-window';
import { ThinkingPanel, reasoningText } from './thinking-panel';
import { HINT, LABEL } from './type-scale';

/** Same handle and keyboard behaviour as a row of the backend list. */
function SortableModelRow({ id, children, below }: { id: string; children: ReactNode; below: ReactNode }): ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  return (
    <li ref={setNodeRef} data-model-row style={{ transform: CSS.Transform.toString(transform), transition }}
      className="rounded-md border border-border bg-background/60 p-1">
      <div className="flex flex-nowrap items-center gap-1">
        <button type="button" {...attributes} {...listeners} aria-label={t('backendsSettings.models.reorder')}
          className="shrink-0 touch-none rounded p-0.5 text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
          <GripVertical className="size-3.5" />
        </button>
        {children}
      </div>
      {below}
    </li>
  );
}

export function ModelEditor({ models, defaultModel, onChange, thinkingControls = null, savedSlugs = [] }: {
  models: ModelDraft[];
  defaultModel: string | null;
  onChange: (next: { models: ModelDraft[]; defaultModel: string | null }) => void;
  /** Kinds of thinking control the provider's protocol can send; null hides
   *  the thinking setting (a built-in provider declares its own). */
  thinkingControls?: readonly ReasoningControl['type'][] | null;
  /** Models the daemon already holds, hence has run its detection on. */
  savedSlugs?: readonly string[];
}): ReactElement {
  /** Index of the row whose picture is being picked, if any. */
  const [picking, setPicking] = useState<number | null>(null);
  /** Index of the row whose thinking is being set, if any. */
  const [thinking, setThinking] = useState<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  // A slug can be blank or typed twice while editing, so it cannot key a
  // sortable row: each row gets an id of its own, moved along with it.
  const nextId = useRef(0);
  const ids = useRef<string[]>([]);
  const mint = () => `model-${nextId.current++}`;
  while (ids.current.length < models.length) ids.current.push(mint());
  ids.current.length = models.length;

  const replace = (index: number, patch: Partial<ModelDraft>) => {
    const next = models.map((model, at) => (at === index ? { ...model, ...patch } : model));
    // A default is a slug: renaming the slug it points at must carry it along,
    // or the backend would keep a default nothing serves.
    const renamed = patch.slug !== undefined && models[index]?.slug === defaultModel ? patch.slug : defaultModel;
    onChange({ models: next, defaultModel: renamed });
  };

  const remove = (index: number) => {
    const gone = models[index];
    const next = models.filter((_, at) => at !== index);
    ids.current.splice(index, 1);
    setPicking(null);
    setThinking(null);
    onChange({
      models: next,
      defaultModel: gone?.slug === defaultModel ? next[0]?.slug ?? null : defaultModel,
    });
  };

  const add = () => {
    ids.current.unshift(mint());
    setPicking(null);
    setThinking(null);
    onChange({ models: [{ slug: '', label: '' }, ...models], defaultModel });
  };

  const reorder = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.current.indexOf(String(active.id));
    const to = ids.current.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    ids.current = arrayMove(ids.current, from, to);
    setPicking(null);
    setThinking(null);
    onChange({ models: arrayMove(models, from, to), defaultModel });
  };
  const toggleHidden = (index: number) => {
    const next = models.map((model, at) => at === index ? { ...model, hidden: !model.hidden } : model);
    const selected = next.find((model) => model.slug === defaultModel && !model.hidden);
    onChange({ models: next, defaultModel: selected?.slug ?? next.find((model) => !model.hidden)?.slug ?? null });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className={LABEL}>{t('backendsSettings.fields.models')}</span>
        <Button type="button" size="sm" variant="ghost" onClick={add}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t('backendsSettings.models.add')}
        </Button>
      </div>
      <p className={HINT}>{t('backendsSettings.models.hint')}</p>

      {models.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted-foreground">
          {t('backendsSettings.models.empty')}
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}>
        <div data-model-column-headings className="flex items-center gap-1 px-1 pb-0.5 text-[11px] font-medium leading-none text-muted-foreground">
          <span aria-hidden="true" className="w-[18px] shrink-0" />
          <span aria-hidden="true" className="size-7 shrink-0" />
          <span className="min-w-0 flex-[2] px-2">{t('backendsSettings.models.columnSlug')}</span>
          <span className="min-w-0 flex-[3] px-2">{t('backendsSettings.models.columnLabel')}</span>
          <span className="min-w-0 flex-[1.4] px-2">{t('backendsSettings.models.columnContext')}</span>
          {thinkingControls ? <span aria-hidden="true" className="size-7 shrink-0" /> : null}
          <span role="img" title={t('backendsSettings.models.defaultColumn')} aria-label={t('backendsSettings.models.defaultColumn')}
            className="mx-1 flex size-3.5 shrink-0 items-center justify-center">
            <CircleDot className="size-3.5" aria-hidden="true" />
          </span>
          <span role="img" title={t('backendsSettings.models.visibleColumn')} aria-label={t('backendsSettings.models.visibleColumn')}
            className="flex size-7 shrink-0 items-center justify-center">
            <Eye className="size-3.5" aria-hidden="true" />
          </span>
          <span aria-hidden="true" className="size-7 shrink-0" />
        </div>
        <SortableContext items={[...ids.current]} strategy={verticalListSortingStrategy}>
        <ul className="flex flex-col gap-1">
          {models.map((model, index) => (
            <SortableModelRow key={ids.current[index]} id={ids.current[index]!} below={<>
              {picking === index ? (
                <PictoPanel
                  className="mt-1"
                  value={{ icon: model.icon ?? null, brand: model.brand ?? null }}
                  onChange={(picto) => replace(index, {
                    ...(picto.icon ? { icon: picto.icon } : { icon: undefined }),
                    ...(picto.brand ? { brand: picto.brand } : { brand: undefined }),
                  })}
                />
              ) : null}
              {thinkingControls && thinking === index ? (
                <ThinkingPanel
                  className="mt-1"
                  model={model}
                  saved={savedSlugs.includes(model.slug)}
                  controls={thinkingControls}
                  onChange={(next) => onChange({ models: models.map((entry, at) => (at === index ? next : entry)), defaultModel })}
                />
              ) : null}
            </>}>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className={cn('size-7 shrink-0', picking === index && 'bg-muted')}
                title={t('backendsSettings.picto.choose')}
                aria-label={t('backendsSettings.picto.choose')}
                aria-expanded={picking === index}
                onClick={() => setPicking(picking === index ? null : index)}
              >
                {model.icon || model.brand ? (
                  <BrandMark icon={model.icon} brand={model.brand} className="size-4" />
                ) : (
                  <ImageIcon className="size-3.5 text-muted-foreground" />
                )}
              </Button>
              <Input
                aria-label={t('backendsSettings.models.slugPlaceholder')}
                value={model.slug}
                placeholder={t('backendsSettings.models.slugPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                // code-font: a model id sent to the CLI
                className="h-7 w-0 min-w-0 flex-[2] px-2 font-mono text-[12px] md:text-[12px]"
                onChange={(e) => replace(index, { slug: e.target.value })}
              />
              <Input
                aria-label={t('backendsSettings.models.labelPlaceholder')}
                value={model.label}
                placeholder={t('backendsSettings.models.labelPlaceholder')}
                autoComplete="off"
                className="h-7 w-0 min-w-0 flex-[3] px-2 text-[12px] md:text-[12px]"
                onChange={(e) => replace(index, { label: e.target.value })}
              />
              {/* Typed by hand, it wins over what the runtime reports: it is
                  there for the plans and gateways the detection gets wrong. */}
              <Input
                aria-label={t('backendsSettings.models.contextWindow')}
                title={t('backendsSettings.models.contextWindowHint')}
                value={contextWindowTextOf(model)}
                placeholder={model.detectedContextWindow
                  ? t('backendsSettings.models.contextWindowDetected', { window: formatContextWindow(model.detectedContextWindow) })
                  : t('backendsSettings.models.contextWindowAuto')}
                aria-invalid={parseContextWindow(contextWindowTextOf(model)) === undefined}
                autoComplete="off"
                spellCheck={false}
                className="h-7 w-0 min-w-0 flex-[1.4] px-2 text-[12px] tabular-nums aria-[invalid=true]:border-destructive md:text-[12px]"
                onChange={(e) => replace(index, { contextWindowText: e.target.value })}
              />
              {thinkingControls ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className={cn('size-7 shrink-0', thinking === index && 'bg-muted')}
                  title={`${t('backendsSettings.thinking.open')}\n${reasoningText(model.reasoning)}`}
                  aria-label={t('backendsSettings.thinking.open')}
                  aria-expanded={thinking === index}
                  onClick={() => setThinking(thinking === index ? null : index)}
                >
                  <Brain className={cn('size-3.5', thinkingChoiceOf(model) === 'auto' ? 'text-muted-foreground' : 'text-primary')} />
                </Button>
              ) : null}
              <input
                type="radio"
                name="backend-default-model"
                title={t('backendsSettings.models.default')}
                aria-label={t('backendsSettings.models.default')}
                className="mx-1 size-3.5 shrink-0 accent-primary"
                checked={!!model.slug && model.slug === defaultModel}
                onChange={() => onChange({ models: models.map((entry, at) => at === index ? { ...entry, hidden: false } : entry), defaultModel: model.slug })}
              />
              <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0"
                title={t(model.hidden ? 'backendsSettings.models.show' : 'backendsSettings.models.hide')}
                aria-label={t(model.hidden ? 'backendsSettings.models.show' : 'backendsSettings.models.hide')}
                onClick={() => toggleHidden(index)}>
                {model.hidden ? <EyeOff className="size-3.5 text-muted-foreground" /> : <Eye className="size-3.5" />}
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                title={t('backendsSettings.models.remove')}
                aria-label={t('backendsSettings.models.remove')}
                onClick={() => remove(index)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </SortableModelRow>
          ))}
        </ul>
        </SortableContext>
        </DndContext>
      )}

      {models.length > 0 && !models.some((model) => model.slug && model.slug === defaultModel) ? (
        <p className={HINT}>{t('backendsSettings.models.noDefault')}</p>
      ) : null}
    </div>
  );
}
