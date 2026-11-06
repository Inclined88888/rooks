'use client';

/**
 * One terminal session on screen: xterm.js wired to the session's WebSocket.
 *
 * The shell lives on the host and outlives this view. Every (re)connection
 * starts from a reset screen, because the daemon replays the session's
 * scrollback first: a phone that locked its screen comes back to the exact
 * state, without the output doubled. A dropped socket is retried with a
 * backoff, and at once when the page becomes visible again (screen unlocked,
 * app brought back) — that is when the user is looking.
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { ClipboardPaste, Copy, Loader2, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { FileContextMenu, type FileMenuItem } from '@/components/chat/file-context-menu';
import { copyToClipboard } from '@/lib/clipboard';
import { t } from '@/lib/i18n';
import { detectTerminalPlatform, terminalClipboardAction } from '@/lib/terminal-keys';
import { ctrlSequence, fetchTerminalStatus, terminalStreamUrl } from '@/lib/terminal-web';
import { cn } from '@/lib/utils';
import { TerminalKeyBar } from './terminal-key-bar';

type ConnectionState = 'connecting' | 'open' | 'retrying' | 'ended' | 'unauthorized';

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000];

/**
 * A terminal keeps its own dark palette, whatever the app's theme. Borrowing
 * the app's foreground painted dark text on xterm's black viewport in the
 * light theme (invisible), and shells colour their output for a dark
 * background anyway (`ls`, prompts, `git diff`).
 */
export const TERMINAL_BACKGROUND = '#111114';

const TERMINAL_THEME = {
  background: TERMINAL_BACKGROUND,
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  cursorAccent: TERMINAL_BACKGROUND,
  selectionBackground: 'rgba(160, 170, 190, 0.35)',
  black: '#1e1e22', red: '#f07178', green: '#a6d189', yellow: '#e5c07b',
  blue: '#82aaff', magenta: '#c792ea', cyan: '#89ddff', white: '#d0d0d0',
  brightBlack: '#6b6b76', brightRed: '#ff8b92', brightGreen: '#c3e88d', brightYellow: '#ffd68a',
  brightBlue: '#a5c3ff', brightMagenta: '#ddb3ff', brightCyan: '#a8ebff', brightWhite: '#ffffff',
};

/** Nerd Font icons fall back on the symbols face declared in globals.css. */
const SYMBOL_FONT = 'Timon Nerd Symbols';
// code-font: a terminal is code; the glyph grid needs a fixed advance.
const TERMINAL_FONT_FAMILY = `ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", "${SYMBOL_FONT}", monospace`;
const SYMBOL_FONT_WAIT_MS = 1_500;

/**
 * The symbols face must be loaded before xterm draws: its DOM renderer caches
 * each glyph's measured width, and a width taken while the face was still
 * missing misaligns every cell after an icon until the cache is dropped. Its
 * unicode-range means nothing else would trigger the download in time. A slow
 * network does not hold the shell back: past the wait, the terminal opens anyway.
 */
function loadSymbolFont(): Promise<unknown> {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts;
  if (!fonts) return Promise.resolve();
  return Promise.race([
    fonts.load(`13px "${SYMBOL_FONT}"`, '').catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, SYMBOL_FONT_WAIT_MS)),
  ]);
}

export function TerminalView({
  sessionId,
  active = true,
  showKeyBar = false,
  onEnded,
  insert = null,
}: {
  sessionId: string;
  /** False when another tab is shown: no refit, no focus. */
  active?: boolean;
  /** The extra keys a phone keyboard lacks (Esc, Ctrl, Tab, arrows). */
  showKeyBar?: boolean;
  /** The shell exited or the session is gone. */
  onEnded?: (exitCode: number | null) => void;
  /** Text to type at the prompt, once, when `nonce` changes. Never followed by Enter. */
  insert?: { nonce: number; text: string } | null;
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endedRef = useRef(false);
  const ctrlRef = useRef(false);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const [state, setState] = useState<ConnectionState>('connecting');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const send = useCallback((message: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  const sendInput = useCallback((data: string) => {
    if (ctrlRef.current) {
      ctrlRef.current = false;
      setCtrlArmed(false);
      const seq = ctrlSequence(data);
      if (seq) { send({ type: 'input', data: seq }); return; }
    }
    send({ type: 'input', data });
  }, [send]);

  /** A keyboard copy only speaks up when it fails; a tap on Copy confirms. */
  const copyText = useCallback(async (text: string, confirm: boolean) => {
    const ok = await copyToClipboard(text);
    // The execCommand fallback selects a textarea of its own: give the focus back.
    termRef.current?.focus();
    if (!ok) toast.error(t('terminal.clipboard.copyFailed'));
    else if (confirm) toast.success(t('terminal.clipboard.copied'));
  }, []);

  const refit = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || !hostRef.current?.offsetParent) return;
    try { fit.fit(); } catch { return; }
    send({ type: 'resize', cols: term.cols, rows: term.rows });
  }, [send]);

  const connect = useCallback(() => {
    if (endedRef.current || !termRef.current) return;
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    const previous = wsRef.current;
    if (previous && (previous.readyState === WebSocket.OPEN || previous.readyState === WebSocket.CONNECTING)) return;
    setState(retryRef.current === 0 ? 'connecting' : 'retrying');
    const ws = new WebSocket(terminalStreamUrl(sessionId));
    wsRef.current = ws;
    let replayed = false;

    ws.onopen = () => {
      retryRef.current = 0;
      setState('open');
      refit();
    };
    ws.onmessage = (event) => {
      let msg: { type?: string; data?: string; code?: number | null };
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      const term = termRef.current;
      if (!term) return;
      if (msg.type === 'output' && typeof msg.data === 'string') {
        // The first frame of a connection is the scrollback: repaint from clean.
        if (!replayed) { term.reset(); replayed = true; }
        term.write(msg.data);
      } else if (msg.type === 'exit') {
        endedRef.current = true;
        setExitCode(msg.code ?? null);
        setState('ended');
        onEndedRef.current?.(msg.code ?? null);
      }
    };
    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      if (endedRef.current) return;
      // The browser hides the handshake status: ask the daemon why.
      void fetchTerminalStatus().then((status) => {
        if (endedRef.current) return;
        if (!status.enabled && status.reason === 'unauthorized') { setState('unauthorized'); return; }
        if (status.enabled && !status.sessions.some((s) => s.id === sessionId)) {
          endedRef.current = true;
          setState('ended');
          onEndedRef.current?.(null);
          return;
        }
        scheduleRetry();
      }).catch(() => scheduleRetry());
    };

    function scheduleRetry(): void {
      const delay = RETRY_DELAYS_MS[Math.min(retryRef.current, RETRY_DELAYS_MS.length - 1)]!;
      retryRef.current += 1;
      setState('retrying');
      retryTimer.current = setTimeout(connect, delay);
    }
  }, [sessionId, refit]);

  // Terminal lifetime: one per session id.
  useEffect(() => {
    let disposed = false;
    endedRef.current = false;
    retryRef.current = 0;
    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon: Fit }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        loadSymbolFont(),
      ]);
      const host = hostRef.current;
      if (disposed || !host) return;
      const term = new XTerm({
        cursorBlink: true,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: window.innerWidth < 768 ? 12 : 13,
        scrollback: 5_000,
        theme: TERMINAL_THEME,
      });
      const fit = new Fit();
      term.loadAddon(fit);
      term.open(host);
      term.onData((data) => sendInput(data));
      const platform = detectTerminalPlatform();
      // Called for keydown, keypress and keyup: every event of a clipboard
      // chord is kept from the shell, the copy itself runs once, on keydown.
      // A paste is left to the browser: its native paste event reaches xterm,
      // which brackets it, and it works over plain http where reading the
      // clipboard from script does not.
      term.attachCustomKeyEventHandler((event) => {
        const action = terminalClipboardAction(event, platform, term.hasSelection());
        if (!action) return true;
        if (action === 'copy' && event.type === 'keydown') {
          // Ctrl+Shift+C opens the browser's inspector otherwise.
          event.preventDefault();
          const text = term.getSelection();
          // Windows Terminal drops the selection once Ctrl+C copied it.
          if (platform === 'windows' && !event.shiftKey) term.clearSelection();
          if (text) void copyText(text, false);
        }
        return false;
      });
      term.onSelectionChange(() => setHasSelection(term.hasSelection()));
      termRef.current = term;
      fitRef.current = fit;
      try { fit.fit(); } catch { /* not laid out yet */ }
      connect();
    })();
    return () => {
      disposed = true;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      setHasSelection(false);
      setMenu(null);
    };
  }, [sessionId, connect, sendInput, copyText]);

  // Follow the container: window resized, docked panel dragged, keyboard opened.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refit);
    });
    observer.observe(host);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [refit]);

  useEffect(() => {
    if (!active) return;
    refit();
    termRef.current?.focus();
  }, [active, refit]);

  // Screen unlocked, tab shown again: reconnect now rather than at the next backoff step.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      retryRef.current = 0;
      connect();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [connect]);

  // The user accepted a suggested command: typed as keystrokes, no Enter.
  const insertedNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!insert || state !== 'open' || insertedNonce.current === insert.nonce) return;
    insertedNonce.current = insert.nonce;
    send({ type: 'input', data: insert.text });
    termRef.current?.focus();
  }, [insert, state, send]);

  const toggleCtrl = useCallback(() => {
    ctrlRef.current = !ctrlRef.current;
    setCtrlArmed(ctrlRef.current);
    termRef.current?.focus();
  }, []);

  const pressKey = useCallback((sequence: string) => {
    sendInput(sequence);
    termRef.current?.focus();
  }, [sendInput]);

  const copySelection = useCallback(() => {
    const text = termRef.current?.getSelection();
    if (text) void copyText(text, true);
  }, [copyText]);

  const pasteClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) termRef.current?.paste(text);
    } catch {
      toast.error(t('terminal.clipboard.pasteFailed'));
    }
    termRef.current?.focus();
  }, []);

  // Without a selection nor a readable clipboard (plain http), the browser's
  // own menu stays: xterm puts its input under the pointer, so its Paste works.
  const openMenu = useCallback((event: ReactMouseEvent) => {
    const term = termRef.current;
    const canPaste = typeof navigator.clipboard?.readText === 'function';
    if (!term || (!term.hasSelection() && !canPaste)) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const closeMenu = useCallback(() => {
    setMenu(null);
    termRef.current?.focus();
  }, []);

  const menuItems: FileMenuItem[] = [];
  if (menu && termRef.current?.hasSelection()) {
    menuItems.push({ key: 'copy', label: t('terminal.clipboard.copy'), icon: <Copy className="size-3.5" />, onSelect: copySelection });
  }
  if (menu && typeof navigator.clipboard?.readText === 'function') {
    menuItems.push({ key: 'paste', label: t('terminal.clipboard.paste'), icon: <ClipboardPaste className="size-3.5" />, onSelect: () => { void pasteClipboard(); } });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} style={{ background: TERMINAL_BACKGROUND }} className="absolute inset-0 px-2 py-1.5" onClick={() => termRef.current?.focus()} onContextMenu={openMenu} />
        {state !== 'open' && (
          <div className={cn(
            'pointer-events-none absolute right-2 top-2 flex items-center gap-1.5 rounded-md bg-muted/90 px-2 py-1 text-xs text-muted-foreground',
            (state === 'ended' || state === 'unauthorized') && 'pointer-events-auto',
          )}>
            {(state === 'connecting' || state === 'retrying') && <Loader2 className="size-3 animate-spin" />}
            {state === 'connecting' && t('terminal.state.connecting')}
            {state === 'retrying' && t('terminal.state.retrying')}
            {state === 'unauthorized' && t('terminal.state.unauthorized')}
            {state === 'ended' && (exitCode === null ? t('terminal.state.ended') : t('terminal.state.exited', { code: exitCode }))}
            {state === 'retrying' && (
              <button
                type="button"
                className="pointer-events-auto rounded p-0.5 hover:text-foreground"
                aria-label={t('terminal.actions.reconnect')}
                onClick={() => { retryRef.current = 0; connect(); }}
              >
                <RotateCw className="size-3" />
              </button>
            )}
          </div>
        )}
      </div>
      {menu && menuItems.length > 0 && (
        <FileContextMenu x={menu.x} y={menu.y} label={t('terminal.clipboard.menu')} items={menuItems} onClose={closeMenu} />
      )}
      {showKeyBar && <TerminalKeyBar ctrlArmed={ctrlArmed} canCopy={hasSelection} onCtrl={toggleCtrl} onKey={pressKey} onCopy={copySelection} />}
    </div>
  );
}
