/**
 * Singleton SSE connection to /api/ui/stream.
 * All components share one EventSource instead of each opening their own —
 * prevents exhausting the browser's 6-connection-per-domain HTTP/1.1 limit.
 */

type Listener = (event: MessageEvent) => void;
type EventMap = Map<string, Set<Listener>>;

/**
 * Names this document's streams to the daemon (`?client=<id>.<slot>`) so that a
 * reconnect replaces the stream it supersedes instead of stacking beside it.
 * Per document and never persisted: a duplicated browser tab copies
 * `sessionStorage`, and two live tabs sharing an id would keep evicting each
 * other. A slot is unique per `EventSource`, so two streams of one window
 * (two chats on one mission) never collide either.
 */
const documentId = randomToken();

function randomToken(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '').slice(0, 8);
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

/** `?client=…` for a new stream of the given kind (`g`lobal, `c`hat, `v`oice). */
export function streamClientQuery(kind: string): string {
  const slot = kind === 'g' ? kind : `${kind}${randomToken().slice(0, 6)}`;
  return `?client=${documentId}.${slot}`;
}

let es: EventSource | null = null;
let refCount = 0;
const listeners: EventMap = new Map();

function getOrOpen(): EventSource | null {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return null;
  if (!es || es.readyState === EventSource.CLOSED) {
    try {
      es = new EventSource(`/api/ui/stream${streamClientQuery('g')}`);
    } catch {
      es = null;
      return null;
    }
    // Re-attach all registered listeners on reconnect
    for (const [type, handlers] of listeners) {
      for (const fn of handlers) {
        es.addEventListener(type, fn as EventListener);
      }
    }
  }
  return es;
}

export function sseOn(type: string, fn: Listener): () => void {
  // Each subscription owns its listener, even if two callers pass the same fn.
  const listener: Listener = (event) => fn(event);
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(listener);
  refCount++;

  const stream = getOrOpen();
  stream?.addEventListener(type, listener as EventListener);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    es?.removeEventListener(type, listener as EventListener);
    const handlers = listeners.get(type);
    handlers?.delete(listener);
    if (handlers?.size === 0) listeners.delete(type);
    refCount--;
    // Close if nobody is listening anymore
    if (refCount === 0 && es) {
      es.close();
      es = null;
    }
  };
}
