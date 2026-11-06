const STORAGE_KEY = 'timon:diagnostic:agent-editor';
let mountSequence = 0;

/** Opt-in, local-only evidence for native focus failures that jsdom cannot reproduce. */
export function startAgentEditorDiagnostic(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => {};
  try {
    if (win.sessionStorage.getItem(STORAGE_KEY) !== '1') return () => {};
  } catch {
    return () => {};
  }

  const mount = ++mountSequence;
  const ids = new WeakMap<Element, number>();
  let nextId = 0;
  let remaining = 150;
  let stopped = false;
  const frames = new Set<number>();
  // Do not collect text, values, key characters, URLs, IDs or accessible names.
  const describe = (element: Element | null) => {
    if (!element) return null;
    if (!ids.has(element)) ids.set(element, ++nextId);
    const style = win.getComputedStyle(element);
    return {
      node: ids.get(element), tag: element.tagName,
      nameField: element.matches('[data-agent-editor-name]'),
      inEditor: root.contains(element), connected: element.isConnected,
      pointerEvents: style.pointerEvents, zIndex: style.zIndex,
      position: style.position, visibility: style.visibility, display: style.display,
      appRegion: style.getPropertyValue('-webkit-app-region'),
      inert: element.hasAttribute('inert'), ariaHidden: element.getAttribute('aria-hidden') === 'true',
    };
  };
  const hit = (x: number, y: number) => doc.elementsFromPoint?.(x, y).slice(0, 6).map(describe) ?? [];
  const snapshot = (phase: string, event?: Event) => {
    if (stopped || remaining-- <= 0) return;
    const input = root.querySelector<HTMLInputElement>('[data-agent-editor-name]');
    const rect = input?.getBoundingClientRect();
    const ancestors = [];
    for (let el: Element | null = input ?? root; el && ancestors.length < 16; el = el.parentElement) {
      ancestors.push(describe(el));
    }
    const pointer = event && 'clientX' in event ? event as MouseEvent : null;
    console.info('[TIM-0021]', JSON.stringify({
      mount, phase, time: Math.round(win.performance.now()),
      event: event?.type, prevented: event?.defaultPrevented,
      target: describe(event?.target instanceof win.Element ? event.target : null),
      active: describe(doc.activeElement), documentFocused: doc.hasFocus(),
      body: describe(doc.body), ancestors,
      name: input ? { node: describe(input), disabled: input.disabled, readOnly: input.readOnly,
        length: input.value.length,
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null } : null,
      nameHit: rect ? hit(rect.x + rect.width / 2, rect.y + rect.height / 2) : [],
      clickHit: pointer ? hit(pointer.clientX, pointer.clientY) : [],
      dialogs: Array.from(doc.querySelectorAll('[role="dialog"]')).slice(0, 8).map(describe),
    }));
  };
  const afterPaint = (phase: string, event?: Event) => {
    const frame = win.requestAnimationFrame(() => {
      frames.delete(frame);
      snapshot(phase, event);
    });
    frames.add(frame);
  };
  const capture = (event: Event) => {
    if (remaining <= 0) return;
    snapshot('capture', event);
    // The second sample sees cancellation, focus redirects and React's committed value.
    afterPaint('after-dispatch', event);
  };
  const events = ['pointerdown', 'click', 'focusin', 'focusout', 'keydown', 'beforeinput', 'input', 'compositionstart', 'compositionend'];
  for (const event of events) doc.addEventListener(event, capture, true);
  win.addEventListener('focus', capture);
  win.addEventListener('blur', capture);
  snapshot('mount');
  afterPaint('ready');
  return () => {
    snapshot('unmount');
    stopped = true;
    for (const event of events) doc.removeEventListener(event, capture, true);
    win.removeEventListener('focus', capture);
    win.removeEventListener('blur', capture);
    for (const frame of frames) win.cancelAnimationFrame(frame);
  };
}
