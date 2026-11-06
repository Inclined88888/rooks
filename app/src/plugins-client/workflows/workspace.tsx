'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { useStoredLayout } from '@/hooks/use-stored-layout';
import { workspaceRowHandover } from '@/lib/workspace-route';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 280;

export function WorkflowWorkspace({ children, chat, open }: { children: ReactNode; chat: ReactNode; open: boolean }) {
  const workspace = useWorkspaceLayout();
  const { raw, update, ready } = useStoredLayout(
    workspace.key ? `${workspace.key}.workflow-chat` : null,
    workspaceRowHandover(workspace.previousKey, 'workflow-chat'),
    { cancelQueuedOnUnmount: true },
  );
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const [available, setAvailable] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setAvailable(entry.contentRect.width); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const stored = raw && typeof raw === 'object' && 'width' in raw ? raw.width : DEFAULT_WIDTH;
  const preferred = typeof stored === 'number' && Number.isFinite(stored) ? stored : DEFAULT_WIDTH;
  // On small workspaces the chat overlays the canvas instead of squeezing it to zero.
  const overlay = available > 0 && available < 928;
  const maxWidth = available > 0 ? Math.max(0, Math.min(800, overlay ? available : available - 608)) : DEFAULT_WIDTH;
  const minWidth = Math.min(MIN_WIDTH, maxWidth);
  const clamp = (value: number) => Math.round(Math.max(minWidth, Math.min(maxWidth, value)));
  const width = clamp(preferred);
  // Clamped once, against the workspace on screen: replayed over another
  // window's row (TODO #647), the width is this gesture's, the rest is theirs.
  const setWidth = (value: number, persist = true) => {
    const next = clamp(value);
    void update((row) => ({ ...(row && typeof row === 'object' ? row : {}), width: next }), persist);
  };

  useEffect(() => {
    drag.current = null;
    setDragging(false);
  }, [open, workspace.key]);

  return (
    <div ref={container} className="relative grid min-h-0 min-w-0 flex-1" style={{ gridTemplateColumns: `288px minmax(0,1fr) ${open && !overlay ? `${width}px` : '0px'}` }}>
      {children}
      {open && (
        <aside id="workflow-chat-panel" className={cn('relative min-h-0 min-w-0 bg-card', overlay && 'absolute inset-y-0 right-0 z-20')} style={{ width }}>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('workflows.resizeChat')}
            aria-controls="workflow-chat-panel"
            aria-valuemin={minWidth}
            aria-valuemax={maxWidth}
            aria-valuenow={width}
            aria-disabled={!ready}
            tabIndex={ready ? 0 : -1}
            className={cn('absolute inset-y-0 -left-1 z-10 w-2 touch-none cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px hover:after:bg-primary focus-visible:after:bg-primary', dragging && 'after:bg-primary')}
            onPointerDown={(event) => {
              if (!ready || event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { pointer: event.pointerId, x: event.clientX, width };
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              if (start?.pointer === event.pointerId) setWidth(start.width + start.x - event.clientX, false);
            }}
            onPointerUp={(event) => {
              const start = drag.current;
              if (start?.pointer !== event.pointerId) return;
              setWidth(start.width + start.x - event.clientX);
              drag.current = null;
              setDragging(false);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onLostPointerCapture={() => {
              if (drag.current) setWidth(drag.current.width);
              drag.current = null;
              setDragging(false);
            }}
            onKeyDown={(event) => {
              if (!ready) return;
              const step = event.shiftKey ? 50 : 10;
              const next = { ArrowLeft: width + step, ArrowRight: width - step, Home: minWidth, End: maxWidth }[event.key];
              if (next === undefined) return;
              event.preventDefault();
              setWidth(next);
            }}
            onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
          />
          <div className="h-full min-h-0 overflow-hidden">{chat}</div>
        </aside>
      )}
    </div>
  );
}
