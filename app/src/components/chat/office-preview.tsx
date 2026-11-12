'use client';

import { Fragment, useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import { t as i18n } from '@/lib/i18n';
import type { DocBlock, Run } from '@/lib/file-preview/docx';
import type { OfficeKind, OfficePreviewData } from '@/lib/file-preview/load';
import type { SheetPreview, XlsxPreview } from '@/lib/file-preview/xlsx';
import { PreviewError } from '@/lib/file-preview/zip';
import type { PptxPreview } from '@/lib/file-preview/pptx';

/* ─────────────────────────────────────────────────────────────────
   Office preview — docx / xlsx / pptx read in the browser.
   The readers return plain data; everything below is React nodes, so
   nothing a document contains can become markup.
   ──────────────────────────────────────────────────────────────────── */

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: OfficePreviewData };

function failureMessage(status: number): string {
  if (status === 413) return i18n('filePreview.tooLarge');
  if (status === 415) return i18n('filePreview.noPreview');
  return i18n('filePreview.openFailed');
}

export function OfficePreview({ url, kind }: { url: string; kind: OfficeKind }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    (async () => {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new HttpFailure(r.status);
      const buffer = await r.arrayBuffer();
      // The readers load with the first Office file, not with the chat.
      const { loadOffice } = await import('@/lib/file-preview/load');
      return loadOffice(kind, buffer);
    })().then(
      (data) => { if (!cancelled) setState({ status: 'ready', data }); },
      (err: unknown) => {
        if (cancelled) return;
        const message = err instanceof HttpFailure
          ? failureMessage(err.status)
          : err instanceof PreviewError && err.code === 'too_large'
            ? i18n('filePreview.tooLarge')
            : err instanceof PreviewError
              ? i18n('filePreview.damaged')
              : i18n('filePreview.openFailed');
        setState({ status: 'error', message });
      },
    );
    return () => { cancelled = true; };
  }, [url, kind]);

  if (state.status === 'loading') return <Notice>{i18n('filePreview.checking')}</Notice>;
  if (state.status === 'error') return <Notice>{state.message}</Notice>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="bg-muted/30 px-4 py-1 text-[11px] text-muted-foreground">
        {i18n('filePreview.officeNote')}
      </div>
      {state.data.kind === 'docx' && <DocxView blocks={state.data.blocks} truncated={state.data.truncated} />}
      {state.data.kind === 'xlsx' && <XlsxView book={state.data} />}
      {state.data.kind === 'pptx' && <PptxView deck={state.data} />}
    </div>
  );
}

class HttpFailure extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="grid flex-1 place-items-center p-8 text-center text-[12.5px] text-muted-foreground">{children}</div>;
}

/* ── docx ─────────────────────────────────────────────────────────── */

const HEADING_CLASS: Record<number, string> = {
  1: 'mt-4 mb-2 text-2xl font-semibold',
  2: 'mt-4 mb-2 text-xl font-semibold',
  3: 'mt-3 mb-1.5 text-lg font-semibold',
  4: 'mt-3 mb-1 text-base font-semibold',
  5: 'mt-2 mb-1 text-sm font-semibold',
  6: 'mt-2 mb-1 text-sm font-medium italic',
};

function Runs({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((run, i) => (
        <span
          key={i}
          className={cn(
            run.bold && 'font-semibold',
            run.italic && 'italic',
            run.underline && 'underline',
            run.strike && 'line-through',
          )}
        >
          {run.text}
        </span>
      ))}
    </>
  );
}

function Blocks({ blocks }: { blocks: DocBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === 'table') {
          return (
            <div key={i} className="my-2 overflow-x-auto">
              <table className="border-collapse text-[13px]">
                <tbody>
                  {block.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td key={c} className="border border-border px-2 py-1 align-top"><Blocks blocks={cell} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.heading) {
          const Tag = `h${block.heading}` as 'h1';
          return <Tag key={i} className={HEADING_CLASS[block.heading]}><Runs runs={block.runs} /></Tag>;
        }
        return (
          <p
            key={i}
            className={cn('my-1 min-h-[1.2em] whitespace-pre-wrap break-words', block.marker !== undefined && 'flex gap-2')}
            style={block.level ? { marginLeft: block.level * 20 } : undefined}
          >
            {block.marker !== undefined && <span className="shrink-0 text-muted-foreground">{block.marker}</span>}
            <span><Runs runs={block.runs} /></span>
          </p>
        );
      })}
    </>
  );
}

function DocxView({ blocks, truncated }: { blocks: DocBlock[]; truncated: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 text-[13.5px] text-foreground">
      <div className="mx-auto max-w-3xl">
        {blocks.length === 0 ? <Notice>{i18n('filePreview.emptyDoc')}</Notice> : <Blocks blocks={blocks} />}
        {truncated && <p className="mt-4 text-[11px] text-muted-foreground">{i18n('filePreview.longDoc')}</p>}
      </div>
    </div>
  );
}

/* ── xlsx ─────────────────────────────────────────────────────────── */

function columnName(index: number): string {
  let out = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

function XlsxView({ book }: { book: XlsxPreview }) {
  const [active, setActive] = useState(0);
  const [sheet, setSheet] = useState<SheetPreview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSheet(null);
    setFailed(false);
    book.load(active).then(
      (s) => { if (!cancelled) setSheet(s); },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => { cancelled = true; };
  }, [book, active]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {failed ? <Notice>{i18n('filePreview.damaged')}</Notice>
          : !sheet ? <Notice>{i18n('filePreview.checking')}</Notice>
            : sheet.rows.length === 0 ? <Notice>{i18n('filePreview.emptySheet')}</Notice>
              : (
                <table className="border-collapse tabular-nums text-[12px]">
                  <thead>
                    <tr>
                      <th className="sticky left-0 top-0 z-20 border border-border bg-muted px-2 py-0.5" />
                      {Array.from({ length: sheet.columns }, (_, c) => (
                        <th key={c} className="sticky top-0 z-10 border border-border bg-muted px-2 py-0.5 font-medium text-muted-foreground">{columnName(c)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.rows.map((row, r) => (
                      <tr key={r}>
                        <th className="sticky left-0 border border-border bg-muted px-2 py-0.5 text-right font-medium text-muted-foreground">{r + 1}</th>
                        {Array.from({ length: sheet.columns }, (_, c) => (
                          <td key={c} className="max-w-[320px] truncate border border-border px-2 py-0.5" title={row[c] ?? ''}>{row[c] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
        {sheet?.truncated && (
          <p className="p-2 text-[11px] text-muted-foreground">
            {i18n('filePreview.sheetRows', { count: sheet.rows.length })}
          </p>
        )}
      </div>
      {book.sheetNames.length > 1 && (
        <div role="tablist" aria-label={i18n('filePreview.sheets')} className="flex shrink-0 gap-1 overflow-x-auto bg-muted/30 px-2 py-1">
          {book.sheetNames.map((name, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={cn(
                'shrink-0 rounded px-2.5 py-1 text-[12px] transition-colors',
                i === active ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── pptx ─────────────────────────────────────────────────────────── */

function PptxView({ deck }: { deck: PptxPreview }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-muted/20 px-6 py-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {deck.slides.map((slide) => (
          <section key={slide.index} className="rounded-lg border border-border bg-background p-5 shadow-sm">
            <div className="mb-2 text-[10.5px] uppercase tracking-wide text-muted-foreground">
              {i18n('filePreview.slide', { n: slide.index })}
            </div>
            <h3 className={cn('mb-2 text-lg font-semibold', !slide.title && 'text-muted-foreground')}>
              {slide.title || i18n('filePreview.untitledSlide')}
            </h3>
            {slide.paragraphs.map((p, i) => (
              <p key={i} className="my-1 whitespace-pre-wrap break-words text-[13.5px]" style={{ marginLeft: p.level * 18 }}>{p.text}</p>
            ))}
            {slide.tables.map((rows, i) => (
              <div key={i} className="my-2 overflow-x-auto">
                <table className="border-collapse text-[12.5px]">
                  <tbody>
                    {rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => <Fragment key={c}><td className="border border-border px-2 py-1">{cell}</td></Fragment>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        ))}
        {deck.truncated && <p className="text-[11px] text-muted-foreground">{i18n('filePreview.moreSlides', { count: deck.slides.length })}</p>}
      </div>
    </div>
  );
}
