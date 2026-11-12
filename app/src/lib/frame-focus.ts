/**
 * Focus of a document iframe (ADR-MCPUI D4.1).
 *
 * The risk: the document takes the focus by script while the user types in
 * the composer, and reads what follows. An opaque-origin iframe hands the host
 * none of its `pointerdown`, `keydown` or `focusin`, so the rule can only rest
 * on what the HOST observes: its own keys, its own focus moves, the pointer
 * entering and leaving the iframe element. A click inside the document's form
 * is never seen as a click — which is why the entry is judged, not the click.
 *
 * `decideFrameFocus` is the rule, pure: timestamped signals in, a decision
 * out. `createFrameFocusTracker` gathers those signals with the host's
 * listeners and applies the decision. `navigator.userActivation` is NOT a
 * signal: a keystroke in the composer activates the page too.
 */

export const TAB_WINDOW_MS = 500;
export const TYPING_WINDOW_MS = 1000;
export const THEFTS_BEFORE_NEUTRALIZE = 3;

export type FrameFocusSignals = {
  now: number;
  /** The last Tab / Shift+Tab pressed on the host, and whether the element it
   *  left is the iframe's immediate neighbour in that direction. */
  tab: { at: number; shift: boolean; fromNeighbour: boolean } | null;
  /** The card's entry control was activated, or its arming layer clicked or
   *  touched, and the focus has not left the document since. */
  armed: boolean;
  /** A mouse or a pen is over the iframe (`pointerenter` without `pointerleave`). */
  pointerOver: boolean;
  /** The last key pressed on the host other than Tab. */
  lastHostKeyAt: number | null;
  /** The element that lost the focus to the iframe is a text field of the host. */
  fromTextField: boolean;
  /** No hover (`(hover: none)`): the arming layer is the only way in. */
  touch: boolean;
  /** Thefts counted since the card was shown or reactivated. */
  thefts: number;
  /** Reactivated after a neutralization: one more theft suffices. */
  reactivated: boolean;
};

export type FrameFocusDecision =
  | { kind: 'allow' }
  /** Give the focus back. `theft`: announce it and count it. `arm`: cover the
   *  iframe with the arming layer, whose click the host does see. */
  | { kind: 'restore'; theft: boolean; arm: boolean }
  /** Third theft (one after a reactivation): the iframe becomes `inert`. */
  | { kind: 'neutralize' };

export function decideFrameFocus(s: FrameFocusSignals): FrameFocusDecision {
  // Condition 2: the host gave the focus itself.
  if (s.armed) return { kind: 'allow' };
  const recentTab = s.tab !== null && s.now - s.tab.at < TAB_WINDOW_MS;
  // Condition 1: keyboard, from the iframe's neighbour only.
  if (recentTab && s.tab!.fromNeighbour) return { kind: 'allow' };
  // Condition 3: mouse or pen over the document, nobody typing on the host.
  const typing = (s.lastHostKeyAt !== null && s.now - s.lastHostKeyAt < TYPING_WINDOW_MS) || recentTab;
  if (!s.touch && s.pointerOver && !typing) {
    if (!s.fromTextField) return { kind: 'allow' };
    // Coming straight from a text field, the document could be the one calling
    // focus() under a resting mouse: one click on the layer settles it. A
    // legitimate click takes this path too, so it is not a theft.
    return { kind: 'restore', theft: false, arm: true };
  }
  if (s.thefts + 1 >= (s.reactivated ? 1 : THEFTS_BEFORE_NEUTRALIZE)) return { kind: 'neutralize' };
  return { kind: 'restore', theft: true, arm: s.touch };
}

export type FrameFocusState = {
  /** The arming layer covers the iframe. */
  overlay: boolean;
  neutralized: boolean;
  thefts: number;
  /** Bumped on every theft: the card re-announces even the same sentence. */
  announcements: number;
};

export type FrameFocusTracker = {
  /** The entry control or the arming layer was used: the next entry is legitimate. */
  arm(): void;
  /** Lifts the neutralization; one theft is enough to bring it back. */
  reactivate(): void;
  /** The reader is using the document: focus inside, card armed, or a mouse over it (D10). */
  engaged(): boolean;
  /** The focus is in the document and came in by a legitimate way (D4.1), on a card not
   *  neutralized: what a `submit` requires (D6). A mouse merely over it is not enough. */
  legitimatelyInside(): boolean;
  readonly state: FrameFocusState;
  dispose(): void;
};

const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]';
const NOT_TEXT_INPUTS: ReadonlySet<string> = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
]);

/** Elements a Tab press can land on, in document order. Visibility is not
 *  read (jsdom has no layout); hidden, inert and disabled ones are left out. */
function tabbables(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) =>
    el.tabIndex >= 0
    && !el.matches(':disabled')
    && el.closest('[inert], [hidden]') === null
    && (el.getAttribute('contenteditable') === null || el.getAttribute('contenteditable') !== 'false'));
}

export function isHostTextField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') return !NOT_TEXT_INPUTS.has(((el as HTMLInputElement).type || 'text').toLowerCase());
  const editable = el.closest('[contenteditable]');
  return editable !== null && editable.getAttribute('contenteditable') !== 'false';
}

export function createFrameFocusTracker(options: {
  doc: Document;
  iframe: HTMLIFrameElement;
  /** The card's entry control: where the focus goes when its previous holder is gone. */
  entry: () => HTMLElement | null;
  touch: () => boolean;
  onChange: (state: FrameFocusState) => void;
  /** The document handed the focus back to the page (the bootstrap's Escape):
   *  the card puts it on its entry control rather than leave it on `body`. */
  onReturn?: () => void;
  now?: () => number;
}): FrameFocusTracker {
  const { doc, iframe } = options;
  const win = doc.defaultView;
  const now = options.now ?? (() => Date.now());
  let state: FrameFocusState = { overlay: options.touch(), neutralized: false, thefts: 0, announcements: 0 };
  let tab: { at: number; shift: boolean; from: Element | null } | null = null;
  let lastHostKeyAt: number | null = null;
  let lastHost: HTMLElement | null = null;
  let pointerOver = false;
  let armed = false;
  let inside = false;
  let reactivated = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const set = (patch: Partial<FrameFocusState>): void => {
    state = { ...state, ...patch };
    options.onChange(state);
  };

  function neighbour(shift: boolean): HTMLElement | null {
    const list = tabbables(doc);
    const at = list.indexOf(iframe);
    if (at < 0) return null;
    return list[shift ? at + 1 : at - 1] ?? null;
  }

  function giveBack(): void {
    const target = lastHost && lastHost.isConnected && lastHost !== iframe ? lastHost : options.entry();
    target?.focus();
  }

  function enter(): void {
    if (inside || disposed || state.neutralized) return;
    const from = tab && now() - tab.at < TAB_WINDOW_MS ? tab.from : lastHost;
    const decision = decideFrameFocus({
      now: now(),
      tab: tab ? { at: tab.at, shift: tab.shift, fromNeighbour: tab.from !== null && tab.from === neighbour(tab.shift) } : null,
      armed,
      pointerOver,
      lastHostKeyAt,
      fromTextField: isHostTextField(from),
      touch: options.touch(),
      thefts: state.thefts,
      reactivated,
    });
    if (decision.kind === 'allow') {
      inside = true;
      if (state.overlay) set({ overlay: false });
      return;
    }
    if (decision.kind === 'neutralize') {
      // The attribute, not the property: React 18 does not know `inert`, and
      // the attribute is what the specification reflects.
      iframe.setAttribute('inert', '');
      giveBack();
      set({ neutralized: true, overlay: false, thefts: state.thefts + 1, announcements: state.announcements + 1 });
      return;
    }
    giveBack();
    set({
      overlay: state.overlay || decision.arm,
      ...(decision.theft ? { thefts: state.thefts + 1, announcements: state.announcements + 1 } : {}),
    });
  }

  function exit(): void {
    if (!inside && !armed) return;
    inside = false;
    armed = false;
    const overlay = options.touch();
    if (state.overlay !== overlay) set({ overlay });
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') tab = { at: now(), shift: event.shiftKey, from: doc.activeElement };
    else lastHostKeyAt = now();
  };
  const onFocusOut = (event: FocusEvent): void => {
    const target = event.target;
    // The body is where focus rests when nobody holds it: never a holder to give it back to.
    if (target instanceof (win?.HTMLElement ?? HTMLElement) && target !== iframe && target !== doc.body) lastHost = target;
  };
  const onFocusIn = (event: FocusEvent): void => {
    if (event.target === iframe) enter();
    else exit();
  };
  // The focus went into a sub-frame: the host window blurs, and the iframe is
  // the active element once the move is done (read at the next task).
  const onBlur = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (doc.activeElement === iframe) enter();
    }, 0);
  };
  const onWindowFocus = (): void => {
    if (doc.activeElement === iframe) return;
    const wasInside = inside;
    exit();
    if (wasInside && (doc.activeElement === null || doc.activeElement === doc.body)) options.onReturn?.();
  };
  const pointerKind = (event: PointerEvent): boolean => event.pointerType === 'mouse' || event.pointerType === 'pen';
  const onPointerEnter = (event: PointerEvent): void => { if (pointerKind(event)) pointerOver = true; };
  const onPointerLeave = (event: PointerEvent): void => { if (pointerKind(event)) pointerOver = false; };

  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('focusout', onFocusOut, true);
  doc.addEventListener('focusin', onFocusIn, true);
  win?.addEventListener('blur', onBlur);
  win?.addEventListener('focus', onWindowFocus);
  iframe.addEventListener('pointerenter', onPointerEnter);
  iframe.addEventListener('pointerleave', onPointerLeave);

  return {
    get state() { return state; },
    engaged: () => inside || armed || pointerOver,
    legitimatelyInside: () => inside && !state.neutralized && doc.activeElement === iframe,
    arm() {
      armed = true;
      if (state.overlay) set({ overlay: false });
    },
    reactivate() {
      iframe.removeAttribute('inert');
      reactivated = true;
      set({ neutralized: false, thefts: 0, overlay: options.touch() });
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('focusout', onFocusOut, true);
      doc.removeEventListener('focusin', onFocusIn, true);
      win?.removeEventListener('blur', onBlur);
      win?.removeEventListener('focus', onWindowFocus);
      iframe.removeEventListener('pointerenter', onPointerEnter);
      iframe.removeEventListener('pointerleave', onPointerLeave);
    },
  };
}
