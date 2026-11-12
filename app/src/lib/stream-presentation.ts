type Scheduler = {
  request: (callback: (time: number) => void) => number;
  cancel: (id: number) => void;
  now: () => number;
  reducedMotion: () => boolean;
};

const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function nextBoundary(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const segment = segmenter?.segment(text).containing(Math.max(0, index - 1));
  if (segment) return segment.index + segment.segment.length;
  return /[\uD800-\uDBFF]/.test(text[index - 1] ?? '') ? index + 1 : index;
}

/** Smooth network bursts without delaying the authoritative final message. */
export function createStreamPresentation(paint: (text: string) => void, clock: Scheduler) {
  let target = '';
  let visible = '';
  let frame: number | null = null;
  let lastPaint = -Infinity;
  let lastInput = 0;
  let generation = 0;

  function schedule() {
    if (frame !== null) return;
    const scheduledGeneration = generation;
    frame = clock.request((time) => {
      if (scheduledGeneration !== generation) return;
      frame = null;
      const elapsed = time - lastPaint;
      if (!clock.reducedMotion() && elapsed < 32 && time - lastInput < 160) { schedule(); return; }
      const backlog = target.length - visible.length;
      const take = clock.reducedMotion() || time - lastInput >= 160
        ? backlog
        : Math.max(1, Math.ceil(backlog * Math.min(40, Number.isFinite(elapsed) ? elapsed : 32) / 100));
      visible = target.slice(0, nextBoundary(target, visible.length + take));
      lastPaint = time;
      paint(visible);
      if (visible !== target) schedule();
    });
  }

  return {
    push(text: string, mode: 'append' | 'replace') {
      target = mode === 'replace' ? text : target + text;
      if (!target.startsWith(visible)) visible = '';
      lastInput = clock.now();
      schedule();
    },
    reset() {
      generation++;
      if (frame !== null) clock.cancel(frame);
      frame = null;
      target = visible = '';
      lastPaint = -Infinity;
      paint('');
    },
    dispose() {
      generation++;
      if (frame !== null) clock.cancel(frame);
      frame = null;
    },
  };
}
