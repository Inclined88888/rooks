/**
 * User Timing measures of one chat switch (`bindMission`): what the series
 * "instant chat switch" measures itself against. Nothing is logged:
 * the measures live in the page's performance timeline, readable from the
 * devtools Performance panel, `performance.getEntriesByType('measure')` or a
 * `PerformanceObserver`.
 *
 * Measures, each from the end of the previous phase:
 * - `timon:chat-bind:request` — fetch until the response headers;
 * - `timon:chat-bind:json`    — body read and parsed;
 * - `timon:chat-bind:replay`  — every event through `ingest`;
 * - `timon:chat-bind:cache`   — instead of the three above, a conversation
 *   restored from the cache of recent ones (chat-mission-cache.ts);
 * - `timon:chat-bind:paint`   — until the next frame is painted;
 * - `timon:chat-bind:total`   — the whole switch, up to that paint.
 * After a cache hit, `timon:chat-bind:delta` runs from the start of the
 * switch to the replay of the rows the daemon added since (`?after=`).
 * Each carries `detail: { missionId }`. A new switch clears the previous one's
 * entries, so the timeline holds one switch, not one per click of the session.
 */
export const CHAT_BIND_PREFIX = 'timon:chat-bind:';

export type ChatBindPhase = 'request' | 'json' | 'replay' | 'cache' | 'paint';

type Perf = Pick<Performance, 'mark' | 'measure' | 'clearMarks' | 'clearMeasures' | 'getEntriesByType'>;

/** Runs `done` once the frame holding the current React commit is painted. */
export type AfterPaint = (done: () => void) => void;

const afterNextPaint: AfterPaint = (done) => {
  // rAF fires before the paint; a task queued from it runs after.
  if (typeof requestAnimationFrame !== 'function') { setTimeout(done, 0); return; }
  requestAnimationFrame(() => setTimeout(done, 0));
};

export interface ChatBindTimer {
  phase(name: Exclude<ChatBindPhase, 'paint'>): void;
  /** Closes `paint` and `total` after the next paint, if `stillCurrent()` —
   *  a switch overtaken by another one measures nothing more. */
  painted(stillCurrent: () => boolean): void;
  /** The delta after a cache hit is in, measured from the start of the switch. */
  delta(): void;
}

const NOOP: ChatBindTimer = { phase() {}, painted() {}, delta() {} };

/** Bumped by every switch: an overtaken one stops measuring, otherwise it would
 *  write its late phases against the marks of the switch that replaced it. */
let generation = 0;

function usablePerf(): Perf | null {
  const p = (globalThis as { performance?: Partial<Perf> }).performance;
  return p && typeof p.mark === 'function' && typeof p.measure === 'function'
    && typeof p.clearMarks === 'function' && typeof p.clearMeasures === 'function'
    && typeof p.getEntriesByType === 'function'
    ? (p as Perf)
    : null;
}

export function startChatBind(
  missionId: string,
  perf: Perf | null = usablePerf(),
  afterPaint: AfterPaint = afterNextPaint,
): ChatBindTimer {
  if (!perf) return NOOP;
  const mine = ++generation;
  try {
    for (const type of ['mark', 'measure'] as const) {
      const names = new Set(perf.getEntriesByType(type).map((e) => e.name).filter((n) => n.startsWith(CHAT_BIND_PREFIX)));
      for (const name of names) (type === 'mark' ? perf.clearMarks(name) : perf.clearMeasures(name));
    }
    const start = `${CHAT_BIND_PREFIX}start`;
    perf.mark(start);
    let previous = start;
    const close = (name: ChatBindPhase): void => {
      if (mine !== generation) return;
      const end = `${CHAT_BIND_PREFIX}${name}-end`;
      perf.mark(end);
      perf.measure(`${CHAT_BIND_PREFIX}${name}`, { start: previous, end, detail: { missionId } });
      previous = end;
    };
    return {
      phase(name) {
        try { close(name); } catch { /* a measure never breaks a switch */ }
      },
      painted(stillCurrent) {
        afterPaint(() => {
          if (mine !== generation || !stillCurrent()) return;
          try {
            close('paint');
            perf.measure(`${CHAT_BIND_PREFIX}total`, { start, end: previous, detail: { missionId } });
          } catch { /* idem */ }
        });
      },
      delta() {
        if (mine !== generation) return;
        try {
          const end = `${CHAT_BIND_PREFIX}delta-end`;
          perf.mark(end);
          perf.measure(`${CHAT_BIND_PREFIX}delta`, { start, end, detail: { missionId } });
        } catch { /* idem */ }
      },
    };
  } catch {
    return NOOP;
  }
}
