/**
 * Rooks UI primitives (docs/design/0003-workroom.md, section 6; restyled "industrial" in design system v4, CHANGELOG).
 * Small, typed, tokens only (ui.css), sensible aria. Pages outside the shell keep their old className strings; new shell
 * work uses these.
 */
import { AlertTriangle, Check, CircleDashed, Hand, Minus, MoreHorizontal, X } from "lucide-react";
import {
  createContext, forwardRef, useContext, useEffect, useId, useRef, useSyncExternalStore,
  useState,
  type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type TextareaHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { AssistantFace, type Mood } from "../AssistantFace";
import { splitHeadline } from "./headline";
import { dismissToast, errorText, getToasts, isPrimaryToastHost, pushToast, registerToastHost, subscribeToasts, type ToastItem } from "./toast";

export type { Mood };
const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/* ---------------------------------------------------------------- Button, IconButton */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md"; icon?: ReactNode; busy?: boolean };

/** Primary is a black rectangle that hovers to orange; secondary a 1 px ink outline; ghost bare; danger for the one
 *  destructive act. Mono uppercase words, square. 36px, sm 28px, 44px on touch screens. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, busy, className, children, type = "button", disabled, ...rest }, ref,
) {
  return (
    <button ref={ref} type={type} className={cx("ui-btn", `ui-btn-${variant}`, size === "sm" && "ui-btn-sm", busy && "is-busy", className)}
      disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {icon && <span className="ui-btn-icon" aria-hidden="true">{icon}</span>}
      {children}
    </button>
  );
});

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "sm" | "md"; active?: boolean; children: ReactNode };

/** A square button that is only an icon. The label is required: it is the name a screen reader hears and the tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, size = "md", active, className, children, type = "button", ...rest }, ref) {
  return (
    <button ref={ref} type={type} className={cx("ui-iconbtn", size === "sm" && "ui-iconbtn-sm", active && "is-active", className)} aria-label={label} title={label} aria-pressed={active} {...rest}>
      {children}
    </button>
  );
});

/* ---------------------------------------------------------------- Page, Section */
/** Every page: the heading (28), one line of description, the actions, and the content width (880 to read, full for boards). */
/** Where the page sits in the navigation ([04 // DAY], pages/places.ts). The route provides it (App.tsx); a page
 *  outside the routes has none and its meta column holds only its kicker. */
export const PageMark = createContext<{ n: number; name: string } | null>(null);

/** A real headline in two lines, the second offset, each wiped in orange as it arrives. The words are the same as
 *  `text` (screen readers hear one heading); one word stays one line. `as="p"` keeps a greeting that is not a heading
 *  (the new chat's) a paragraph. On a wide window each line stays on one row: CSS sizes the headline to fit its column
 *  from its longest line (--hl-ch, ui.css .hl-fit). */
export function Headline({ text, as: Tag = "h1", className, id }: { text: string; as?: "h1" | "h2" | "p"; className?: string; id?: string }) {
  const [a, b] = splitHeadline(text);
  return (
    <Tag className={cx("hl-fit", className)} id={id} style={{ "--hl-ch": Math.max(a.length, b.length) } as CSSProperties}>
      <span className="hl-line reveal">{a}</span>
      {b && <>{" "}<span className="hl-line display-offset reveal">{b}</span></>}
    </Tag>
  );
}

/** A page: the header pattern (a left meta column with the place's number and a mono label, the title, description
 *  and actions on the right; stacked on phones), then the content. `hero` makes the title the huge two-line headline
 *  on the blueprint grid (Home). */
export function Page({ title, description, actions, kicker, wide, hero, children, className }: {
  title: string; description?: ReactNode; actions?: ReactNode; kicker?: string; wide?: boolean; hero?: boolean; children: ReactNode; className?: string;
}) {
  const mark = useContext(PageMark);
  return (
    <div className={cx("ui-page", wide && "ui-page-wide", hero && "ui-page-hero", className)}>
      <header className={cx("ui-page-head", hero && "is-hero")}>
        <div className="ui-page-meta">
          {mark && <MicroLabel n={mark.n} name={mark.name} />}
          {kicker && <p className="ui-page-kicker">{kicker}</p>}
        </div>
        <div className="ui-page-main">
          <div className="ui-page-titles">
            {hero ? <Headline as="h1" className="ui-page-title ui-page-hero-title" text={title} /> : <h1 className="ui-page-title">{title}</h1>}
            {description && <p className="ui-page-desc">{description}</p>}
          </div>
          {actions && <div className="ui-page-actions">{actions}</div>}
        </div>
      </header>
      {children}
    </div>
  );
}

/** A titled part of a page, separated by a hairline and numbered 01, 02, ... in a mono label. At the top level of a
 *  wide page the number and title sit in the left meta column and the content in the right one. */
export function Section({ title, description, actions, children, className }: {
  title?: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  const id = useId();
  return (
    <section className={cx("ui-section", className)} aria-labelledby={title ? id : undefined}>
      {(title || actions) && (
        <div className="ui-section-head">
          {/* [01 // NAME]: the number is a CSS counter and the name the title's own words; decoration, so screen readers
              skip it (they hear the heading) */}
          {title && <span className="micro ui-section-num" aria-hidden="true" data-name={title} />}
          {title && <h2 id={id} className="ui-section-title">{title}</h2>}
          {actions && <div className="ui-section-actions">{actions}</div>}
        </div>
      )}
      <div className="ui-section-body">
        {description && <p className="ui-section-desc">{description}</p>}
        {children}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- MicroLabel */
/** "[01 // NAME]": the number in two digits; without a number, "[NAME]". */
export function microText(n: number | undefined, name: string): string {
  return n == null ? `[${name}]` : `[${String(n).padStart(2, "0")} // ${name}]`;
}

/** The tiny mono label beside an orange square, [01 // NAME]. It is decoration: hidden from screen readers unless
 *  `decorative` is false (only when it is the one place a name is written); then a screen reader hears the name alone
 *  ("Step 1 of 5"), the brackets and the number are drawn, not read. Never put ids or addresses in it. */
export function MicroLabel({ n, name, decorative = true, className }: { n?: number; name: string; decorative?: boolean; className?: string }) {
  return (
    <span className={cx("micro", "ui-micro", className)} aria-hidden={decorative || undefined}>
      {decorative ? microText(n, name) : (
        // one inner span, so the label's flex gap (after its orange square) does not space the brackets apart
        <span><span aria-hidden="true">[</span>{n != null && <span aria-hidden="true">{`${String(n).padStart(2, "0")} // `}</span>}{name}<span aria-hidden="true">]</span></span>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- Card */
/** White, a 1 px line, square. With `label` (and `index`) a micro-label sits on top; with `heading` a bold uppercase
 *  title; either one draws the thin divider under the head. */
export function Card({ children, className, padding = "md", as: Tag = "div", label, index, heading, ...rest }: {
  children: ReactNode; className?: string; padding?: "none" | "sm" | "md"; as?: "div" | "section" | "article"; label?: string; index?: number; heading?: ReactNode;
} & Record<string, unknown>) {
  return (
    <Tag className={cx("ui-card", padding !== "md" && `ui-card-pad-${padding}`, className)} {...rest}>
      {(label || heading) && (
        <header className="ui-card-head">
          {label && <MicroLabel n={index} name={label} decorative={!!heading} />}
          {heading && <h3 className="ui-card-title">{heading}</h3>}
        </header>
      )}
      {children}
    </Tag>
  );
}

/* ---------------------------------------------------------------- Input, Select */
export type InputProps = InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, className, id, ...rest }, ref) {
  const own = useId();
  const inputId = id ?? own;
  const control = <input ref={ref} id={inputId} className={cx("ui-input", className)} aria-describedby={hint ? `${inputId}-hint` : undefined} {...rest} />;
  if (!label) return control;
  return (
    <label className="ui-field" htmlFor={inputId}>
      <span className="ui-field-label">{label}</span>
      {control}
      {hint && <span className="ui-field-hint" id={`${inputId}-hint`}>{hint}</span>}
    </label>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; hint?: string };

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, hint, className, id, rows = 4, ...rest }, ref) {
  const own = useId();
  const areaId = id ?? own;
  const control = <textarea ref={ref} id={areaId} rows={rows} className={cx("ui-input ui-textarea", className)} aria-describedby={hint ? `${areaId}-hint` : undefined} {...rest} />;
  if (!label) return control;
  return (
    <label className="ui-field" htmlFor={areaId}>
      <span className="ui-field-label">{label}</span>
      {control}
      {hint && <span className="ui-field-hint" id={`${areaId}-hint`}>{hint}</span>}
    </label>
  );
});

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label?: string; children: ReactNode };

/** A styled native select: the keyboard, the screen reader and the phone all already know how it works. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ label, className, id, children, ...rest }, ref) {
  const own = useId();
  const selectId = id ?? own;
  const control = <select ref={ref} id={selectId} className={cx("ui-select", className)} {...rest}>{children}</select>;
  if (!label) return control;
  return (
    <label className="ui-field" htmlFor={selectId}>
      <span className="ui-field-label">{label}</span>
      {control}
    </label>
  );
});

/* ---------------------------------------------------------------- Tabs */
export type TabItem = { id: string; label: string; count?: number };

export function Tabs({ items, value, onChange, label, size = "md" }: { items: TabItem[]; value: string; onChange: (id: string) => void; label: string; size?: "sm" | "md" }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -i : e.key === "End" ? items.length - 1 - i : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + items.length) % items.length;
    onChange(items[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div className={cx("ui-tabs", size === "sm" && "ui-tabs-sm")} role="tablist" aria-label={label}>
      {items.map((t, i) => (
        <button key={t.id} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" id={`tab-${t.id}`} className={cx("ui-tab", t.id === value && "is-active")}
          aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1} onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}>
          {t.label}{t.count != null && <span className="ui-tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Badge, Chip, Kbd */
export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "live";

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return <span className={cx("ui-badge", `ui-badge-${tone}`, className)} title={title}>{children}</span>;
}

/** A pill. With onClick it is a button (and `active` is announced); with onRemove it carries its own remove control. */
export function Chip({ children, active, onClick, onRemove, removeLabel = "Remove", icon, className, title }: {
  children: ReactNode; active?: boolean; onClick?: () => void; onRemove?: () => void; removeLabel?: string; icon?: ReactNode; className?: string; title?: string;
}) {
  const body = <>{icon && <span className="ui-chip-icon" aria-hidden="true">{icon}</span>}<span className="ui-chip-text">{children}</span></>;
  return (
    <span className={cx("ui-chip", active && "is-active", onClick && "is-button", className)} title={title}>
      {onClick ? <button type="button" className="ui-chip-main" aria-pressed={active} onClick={onClick}>{body}</button> : <span className="ui-chip-main">{body}</span>}
      {onRemove && <button type="button" className="ui-chip-x" aria-label={removeLabel} onClick={onRemove}><X size={11} /></button>}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}

/* ---------------------------------------------------------------- Sheet (side sheet with a focus trap) */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab inside `ref`, close on Escape, and put focus back where it was. Shared by the Sheet and the rail flyouts. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void, autoFocus = true) {
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const before = document.activeElement as HTMLElement | null;
    if (autoFocus) {
      const first = el.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab") return;
      const list = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!list.length) { e.preventDefault(); el.focus(); return; }
      const first = list[0], last = list[list.length - 1];
      const here = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (here === first || !el.contains(here))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (here === last || !el.contains(here))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (before && document.contains(before)) before.focus();
    };
  }, [active, ref, onClose, autoFocus]);
}

export function Sheet({ open, onClose, title, side = "right", children, footer, width }: {
  open: boolean; onClose: () => void; title: string; side?: "left" | "right"; children: ReactNode; footer?: ReactNode; width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(ref, open, onClose);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="ui-scrim" onMouseDown={onClose}>
      <div ref={ref} className={cx("ui-sheet", `ui-sheet-${side}`)} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}
        style={width ? { width: `min(${width}px, 100vw)` } : undefined} onMouseDown={(e) => e.stopPropagation()}>
        <header className="ui-sheet-head">
          <h2 id={id} className="ui-sheet-title">{title}</h2>
          <IconButton label="Close" onClick={onClose} size="sm"><X size={16} /></IconButton>
        </header>
        <div className="ui-sheet-body">{children}</div>
        {footer && <footer className="ui-sheet-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------- Menu */
export type MenuItem = { id: string; label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string };

/** A ⋯ button that opens a short list of actions. Arrow keys move, Enter picks, Escape closes and focus returns. */
export function Menu({ label, items, icon, align = "end", className }: { label: string; items: MenuItem[]; icon?: ReactNode; align?: "start" | "end"; className?: string }) {
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useFocusTrap(pop, open, close);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!pop.current?.parentElement?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const list = [...(pop.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = list.indexOf(document.activeElement as HTMLElement);
    list[(at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
  };
  return (
    <span className={cx("ui-menu", className)}>
      <IconButton label={label} size="sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{icon ?? <MoreHorizontal size={16} />}</IconButton>
      {open && (
        <div ref={pop} className={cx("ui-menu-pop", `ui-menu-${align}`)} role="menu" aria-label={label} tabIndex={-1} onKeyDown={onKey}>
          {items.map((it) => (
            <button key={it.id} type="button" role="menuitem" className={cx("ui-menu-item", it.danger && "is-danger")} disabled={it.disabled}
              onClick={() => { close(); it.onSelect(); }}>
              {it.icon && <span className="ui-menu-icon" aria-hidden="true">{it.icon}</span>}
              <span className="ui-menu-label">{it.label}</span>
              {it.hint && <span className="ui-menu-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- List, Row */
/** The one list. Rows are separated by hairlines; the list itself has no shadow. */
export function List({ label, children, className }: { label?: string; children: ReactNode; className?: string }) {
  return <ul className={cx("ui-list", className)} aria-label={label}>{children}</ul>;
}

/** The one list row: an optional leading mark, the title, a meta line, trailing actions. With onClick the title is the button. */
export function Row({ title, meta, leading, actions, onClick, active, className }: {
  title: ReactNode; meta?: ReactNode; leading?: ReactNode; actions?: ReactNode; onClick?: () => void; active?: boolean; className?: string;
}) {
  const body = (
    <>
      {leading && <span className="ui-row-leading" aria-hidden="true">{leading}</span>}
      <span className="ui-row-text">
        <span className="ui-row-title">{title}</span>
        {meta && <span className="ui-row-meta">{meta}</span>}
      </span>
    </>
  );
  return (
    <li className={cx("ui-row", onClick && "is-button", active && "is-active", className)} aria-current={active || undefined}>
      {onClick ? <button type="button" className="ui-row-main" onClick={onClick}>{body}</button> : <span className="ui-row-main">{body}</span>}
      {actions && <span className="ui-row-actions">{actions}</span>}
    </li>
  );
}

/* ---------------------------------------------------------------- Loading, ErrorState */
/** Static skeleton rows while a page fills in. No sheen, no pulse. */
export function Loading({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="ui-loading" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ui-loading-row" aria-hidden="true">
          <span className="ui-loading-bar" style={{ width: `${[56, 72, 44, 64][i % 4]}%` }} />
          <span className="ui-loading-bar is-meta" />
        </div>
      ))}
    </div>
  );
}

/** What went wrong in plain words, and Try again. */
export function ErrorState({ title = "That did not load", line, onRetry, className }: { title?: string; line?: string; onRetry?: () => void; className?: string }) {
  return (
    <div className={cx("ui-error", className)} role="alert">
      <AlertTriangle size={18} aria-hidden="true" className="ui-error-icon" />
      <div className="ui-error-text">
        <p className="ui-error-title">{title}</p>
        {line && <p className="ui-error-line">{line}</p>}
      </div>
      {onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

/* ---------------------------------------------------------------- Toast */
function ToastStack({ hostId }: { hostId: symbol }) {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const primary = useSyncExternalStore(subscribeToasts, () => isPrimaryToastHost(hostId), () => false);
  // The live region stays mounted while this host is the primary one, so a toast added to it is announced.
  if (!primary) return null;
  return (
    <div className="ui-toasts" aria-live="polite">
      {items.map((t: ToastItem) => (
        <div key={t.id} className={cx("ui-toast", `ui-toast-${t.kind}`, t.leaving && "is-leaving")} role={t.kind === "err" ? "alert" : "status"}>
          <span className="ui-toast-icon" aria-hidden="true">{t.kind === "err" ? <X size={12} strokeWidth={3} /> : t.kind === "ok" ? <Check size={12} strokeWidth={3} /> : <Minus size={12} strokeWidth={3} />}</span>
          <span className="ui-toast-text">{t.text}</span>
          <button type="button" className="ui-toast-x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}><X size={12} /></button>
        </div>
      ))}
    </div>
  );
}

/** Mount once, in the shell. Every useToast() in any page or root lands here. */
export function ToastHost() {
  const id = useRef(Symbol("toast-host")).current;
  useEffect(() => registerToastHost(id, true), [id]);
  return <ToastStack hostId={id} />;
}

function ToastFallback() {
  const id = useRef(Symbol("toast-fallback")).current;
  useEffect(() => registerToastHost(id, false), [id]);
  return <ToastStack hostId={id} />;
}

/** The same shape pages always used: toast.ok(text), toast.err(error), and toast.node, which only a screen without the shell
 *  (the ask bar) renders; inside the shell the one ToastHost shows everything. */
const TOAST = {
  node: <ToastFallback />,
  ok: (text: string) => { pushToast("ok", text); },
  info: (text: string) => { pushToast("info", text); },
  err: (e: unknown) => { pushToast("err", errorText(e)); },
};

/** One object for every caller and every render, so a callback that depends on it is not remade on each render. */
export function useToast() {
  return TOAST;
}

/* ---------------------------------------------------------------- EmptyState, Stat */
/** One line, one sentence, one action, on the blueprint grid: the line big and uppercase, the sentence in mono. */
export function EmptyState({ title, line, action, icon, className }: { title: string; line?: string; action?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={cx("ui-empty", className)}>
      {icon && <div className="ui-empty-icon" aria-hidden="true">{icon}</div>}
      <p className="ui-empty-title">{title}</p>
      {line && <p className="ui-empty-line">{line}</p>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone = "neutral" }: { label: string; value: ReactNode; hint?: string; tone?: Tone }) {
  return (
    <div className={cx("ui-stat", `ui-stat-${tone}`)}>
      <span className="ui-stat-label">{label}</span>
      <span className="ui-stat-value">{value}</span>
      {hint && <span className="ui-stat-hint">{hint}</span>}
    </div>
  );
}

/* ---------------------------------------------------------------- Receipt, Timeline */
export type ReceiptState = "verified" | "partly" | "unverified" | "contradicted";
const RECEIPT: Record<ReceiptState, { word: string; icon: ReactNode }> = {
  verified: { word: "Verified", icon: <Check size={11} strokeWidth={3} /> },
  partly: { word: "Partly verified", icon: <Minus size={11} strokeWidth={3} /> },
  unverified: { word: "Not verified", icon: <CircleDashed size={11} strokeWidth={2.5} /> },
  contradicted: { word: "Contradicted", icon: <X size={11} strokeWidth={3} /> },
};

/** A receipt mark. The evidence shows on hover and on keyboard focus, and is read out as part of the label. */
export function Receipt({ state, evidence, className }: { state: ReceiptState; evidence?: string; className?: string }) {
  const r = RECEIPT[state];
  const id = useId();
  return (
    <span className={cx("ui-receipt", `ui-receipt-${state}`, className)} tabIndex={0} aria-label={evidence ? `${r.word}: ${evidence}` : r.word} aria-describedby={evidence ? id : undefined}>
      <span className="ui-receipt-mark" aria-hidden="true">{r.icon}</span>
      <span className="ui-receipt-word">{r.word}</span>
      {evidence && <span className="ui-receipt-evidence" role="tooltip" id={id}>{evidence}</span>}
    </span>
  );
}

export type TimelineStep = { id: string | number; text: string; state: "running" | "ok" | "failed" | "held"; receipt?: { state: ReceiptState; evidence?: string } };
const STEP_WORD: Record<TimelineStep["state"], string> = { running: "Working", ok: "Done", failed: "Failed", held: "Needs your OK" };

/** Step rows joined by a still line. */
export function Timeline({ steps, label = "Steps", onPick, current }: { steps: TimelineStep[]; label?: string; onPick?: (id: TimelineStep["id"]) => void; current?: TimelineStep["id"] }) {
  if (!steps.length) return null;
  return (
    <ol className="ui-timeline" aria-label={label}>
      {steps.map((s) => {
        const row = (
          <>
            <span className={cx("ui-timeline-dot", `is-${s.state}`)} aria-hidden="true" />
            <span className="ui-timeline-text">{s.text}</span>
            <span className="sr-only">, {STEP_WORD[s.state]}</span>
          </>
        );
        // The receipt sits beside the row, never inside its button: it has its own focus and its own evidence.
        return (
          <li key={s.id} className={cx("ui-timeline-step", `is-${s.state}`, current === s.id && "is-current")} aria-current={current === s.id ? "step" : undefined}>
            {onPick ? <button type="button" className="ui-timeline-row" onClick={() => onPick(s.id)}>{row}</button> : <span className="ui-timeline-row">{row}</span>}
            {s.receipt && <Receipt state={s.receipt.state} evidence={s.receipt.evidence} className="ui-timeline-receipt" />}
          </li>
        );
      })}
    </ol>
  );
}

/* ---------------------------------------------------------------- ApprovalCard: the one approval card */
const EFFECT_LINE: Record<string, string> = {
  persistent: "This would change how the assistant behaves from now on.",
  schedule: "Once on, it runs by itself at the times shown until you turn it off.",
  write: "This changes a file on your computer.",
  command: "This runs a command on your computer.",
  send: "This sends something to someone outside this app.",
  external: "This acts outside this app.",
  handoff: "This copies a file out of the Room.",
};

/** whole: the diff is shown in full, never in a scroll box (a work change's lines: every person a share invites must be
 * seen before a yes, not only the first few). */
export function ApprovalCard({ title, detail, effect, command, diff, whole, onApprove, onDeny, busy, className }: {
  title: string; detail?: string; effect: string; command?: string; diff?: ReactNode; whole?: boolean; onApprove: () => void; onDeny: () => void; busy?: boolean; className?: string;
}) {
  const id = useId();
  return (
    <section className={cx("ui-approval", className)} aria-labelledby={id} aria-busy={busy || undefined}>
      <div className="ui-approval-head">
        <Hand size={15} aria-hidden="true" />
        <span className="ui-approval-kicker">Needs your OK</span>
      </div>
      <h3 id={id} className="ui-approval-title">{title}</h3>
      {detail && <p className="ui-approval-detail">{detail}</p>}
      <p className="ui-approval-effect">{EFFECT_LINE[effect] ?? "This acts outside the workspace."}</p>
      {command && <pre className="ui-approval-command">{command}</pre>}
      {diff && <div className={cx("ui-approval-diff", whole && "is-whole")}>{diff}</div>}
      <div className="ui-approval-actions">
        <Button variant="primary" size="sm" onClick={onApprove} busy={busy}>Approve</Button>
        <Button variant="secondary" size="sm" onClick={onDeny} disabled={busy}>Deny</Button>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- StageFrame: the live view's frame */
/** The frame's status line: how to get out while stepped in, "Handed back." once released, nothing before. */
export function capturedLine(captured: boolean, wasCaptured: boolean, place: string): string {
  if (captured) return `Your mouse and keyboard go to ${place}. Press Escape or Hand back to stop.`;
  return wasCaptured ? "Handed back." : "";
}
/** Square frame, controls bar. `captured` means your mouse and keyboard go to the surface: a still 2px accent border shows it. */
export function StageFrame({ title, label, live, captured, controls, children, className }: {
  title: string; label: string; live: boolean; captured: boolean; controls: ReactNode; children: ReactNode; className?: string;
}) {
  const id = useId();
  // The status line stays mounted so stepping in and handing back are both announced.
  const wasCaptured = useRef(false);
  if (captured) wasCaptured.current = true;
  const place = /^the\s/i.test(title) ? title.replace(/^the\s/i, "the ") : `the ${title}`; // "The Room" reads "the Room", never "the The Room"
  return (
    <section className={cx("ui-stage", live && "is-live", captured && "is-captured", className)} aria-labelledby={id} data-live={live || undefined} data-captured={captured || undefined}>
      <header className="ui-stage-head">
        <div className="ui-stage-titles">
          <h2 id={id} className="ui-stage-title">{title}</h2>
          <p className="ui-stage-label">{label}</p>
        </div>
        <Badge tone={live ? "live" : "neutral"}>{live ? "Live" : "Off"}</Badge>
      </header>
      <div className="ui-stage-body">{children}</div>
      <div className="ui-stage-controls" role="toolbar" aria-label={`${title} controls`}>{controls}</div>
      <p className="ui-stage-captured" role="status">{capturedLine(captured, wasCaptured.current, place)}</p>
    </section>
  );
}

/* ---------------------------------------------------------------- Presence: face, name, status line, Needs you pill */
export type Where = "room" | "browser" | "desktop" | "terminal" | "chat" | null | undefined;
const WHERE_WORD: Record<string, string> = { room: "Room", browser: "Browser", desktop: "Desktop", terminal: "Terminal" };

export function Presence({ name, mood, doing, where, needsYou, onNeedsYou, className }: {
  name: string; mood: Mood; doing: string; where?: Where; needsYou: number; onNeedsYou: () => void; className?: string;
}) {
  const place = where ? WHERE_WORD[where] : "";
  return (
    <div className={cx("ui-presence", className)}>
      <AssistantFace mood={mood} name={name} size={26} />
      <span className="ui-presence-name">{name}</span>
      <span className="ui-presence-doing" role="status" aria-live="polite">{doing}</span>
      {place && <Badge tone={mood === "working" ? "live" : "neutral"} className="ui-presence-where">{place}</Badge>}
      <span className="ui-presence-space" />
      {needsYou > 0 && (
        <button type="button" className="ui-needs" onClick={onNeedsYou} aria-label={`Needs you: ${needsYou}`}>
          <AlertTriangle size={13} aria-hidden="true" />
          <span>Needs you</span>
          <span className="ui-needs-count">{needsYou}</span>
        </button>
      )}
    </div>
  );
}
