/**
 * Rooks UI primitives (docs/design/0003-workroom.md, section 6). Small, typed, tokens only (ui.css), sensible aria.
 * Pages outside the shell keep their old className strings; new shell work uses these.
 */
import { AlertTriangle, Check, CircleDashed, Hand, Minus, X } from "lucide-react";
import {
  forwardRef, useEffect, useId, useRef, useSyncExternalStore,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { AssistantFace, type Mood } from "../AssistantFace";
import { dismissToast, errorText, getToasts, isPrimaryToastHost, pushToast, registerToastHost, subscribeToasts, type ToastItem } from "./toast";

export type { Mood };
const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/* ---------------------------------------------------------------- Button, IconButton */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md"; icon?: ReactNode; busy?: boolean };

/** Primary is saffron with ink text; secondary an outline; ghost bare; danger for the one destructive act. 36px, sm 28px. */
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

/* ---------------------------------------------------------------- Card */
export function Card({ children, className, padding = "md", as: Tag = "div", ...rest }: { children: ReactNode; className?: string; padding?: "none" | "sm" | "md"; as?: "div" | "section" | "article" } & Record<string, unknown>) {
  return <Tag className={cx("ui-card", padding !== "md" && `ui-card-pad-${padding}`, className)} {...rest}>{children}</Tag>;
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

/* ---------------------------------------------------------------- Toast */
function ToastStack({ hostId }: { hostId: symbol }) {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const primary = useSyncExternalStore(subscribeToasts, () => isPrimaryToastHost(hostId), () => false);
  if (!primary || !items.length) return null;
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
export function useToast() {
  return {
    node: <ToastFallback />,
    ok: (text: string) => { pushToast("ok", text); },
    info: (text: string) => { pushToast("info", text); },
    err: (e: unknown) => { pushToast("err", errorText(e)); },
  };
}

/* ---------------------------------------------------------------- EmptyState, Stat */
/** One Bodoni line, one sentence, one action. */
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

/** Step rows with the drawing line (motion/signature.css draws each segment as it arrives). */
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
            {s.receipt && <Receipt state={s.receipt.state} evidence={s.receipt.evidence} className="ui-timeline-receipt" />}
          </>
        );
        return (
          <li key={s.id} className={cx("ui-timeline-step", `is-${s.state}`, current === s.id && "is-current")} aria-current={current === s.id ? "step" : undefined}>
            {onPick ? <button type="button" className="ui-timeline-row" onClick={() => onPick(s.id)}>{row}</button> : <span className="ui-timeline-row">{row}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/* ---------------------------------------------------------------- ApprovalCard: the one approval card */
const EFFECT_LINE: Record<string, string> = {
  persistent: "This would change how the assistant behaves from now on.",
  write: "This changes a file on your computer.",
  command: "This runs a command on your computer.",
  send: "This sends something to someone outside this app.",
  external: "This acts outside this app.",
  handoff: "This copies a file out of the Room.",
};

export function ApprovalCard({ title, detail, effect, command, diff, onApprove, onDeny, busy, className }: {
  title: string; detail?: string; effect: string; command?: string; diff?: ReactNode; onApprove: () => void; onDeny: () => void; busy?: boolean; className?: string;
}) {
  const id = useId();
  return (
    <section className={cx("ui-approval spring-in", className)} aria-labelledby={id} aria-busy={busy || undefined}>
      <div className="ui-approval-head">
        <Hand size={15} aria-hidden="true" />
        <span className="ui-approval-kicker">Needs your OK</span>
      </div>
      <h3 id={id} className="ui-approval-title">{title}</h3>
      {detail && <p className="ui-approval-detail">{detail}</p>}
      <p className="ui-approval-effect">{EFFECT_LINE[effect] ?? "This acts outside the workspace."}</p>
      {command && <pre className="ui-approval-command">{command}</pre>}
      {diff && <div className="ui-approval-diff">{diff}</div>}
      <div className="ui-approval-actions">
        <Button variant="primary" size="sm" onClick={onApprove} busy={busy}>Approve</Button>
        <Button variant="secondary" size="sm" onClick={onDeny} disabled={busy}>Deny</Button>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- StageFrame: the live view's frame */
/** 16px frame, live edge, controls bar. `captured` means your mouse and keyboard go to the surface: the edge glows. */
export function StageFrame({ title, label, live, captured, controls, children, className }: {
  title: string; label: string; live: boolean; captured: boolean; controls: ReactNode; children: ReactNode; className?: string;
}) {
  const id = useId();
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
      {captured && <p className="ui-stage-captured" role="status">Your mouse and keyboard go to {place}. Hand back to stop.</p>}
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
