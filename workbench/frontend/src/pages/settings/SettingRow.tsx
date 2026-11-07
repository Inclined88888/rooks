/**
 * Settings parts the shared primitives do not have (page package B). Built on the same tokens as src/ui:
 * SettingsGroup (a hairline box of rows), SettingRow (label, one line of help, the control on the right),
 * Switch (an on/off checkbox drawn as a switch), Notice (a plain line in a box), Progress (a still bar) and
 * Choice (a small set of mutually exclusive pills).
 */
import { useId, type ReactNode } from "react";
import "./settings.css";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/** A box of setting rows, separated by hairlines. No shadow. */
export function SettingsGroup({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return <div className={cx("st-group", className)} role={label ? "group" : undefined} aria-label={label}>{children}</div>;
}

/** One setting: the label, one line of help, and the control on the right. On a phone the control goes underneath. */
export function SettingRow({ label, help, children, stack, htmlFor, className }: {
  label: ReactNode; help?: ReactNode; children?: ReactNode; stack?: boolean; htmlFor?: string; className?: string;
}) {
  const Label = htmlFor ? "label" : "span";
  return (
    <div className={cx("st-row", stack && "is-stacked", className)}>
      <div className="st-row-text">
        <Label className="st-row-label" {...(htmlFor ? { htmlFor } : {})}>{label}</Label>
        {help && <span className="st-row-help">{help}</span>}
      </div>
      {children && <div className="st-row-control">{children}</div>}
    </div>
  );
}

/** An on/off setting. A real checkbox (keyboard, screen reader) drawn as a switch. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={cx("st-switch", disabled && "is-disabled")}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span className="st-switch-track" aria-hidden="true"><span className="st-switch-thumb" /></span>
    </label>
  );
}

/** A plain line in a quiet box. `danger` for something that failed, `ok` for something that worked. */
export function Notice({ tone = "neutral", children, action, className }: { tone?: "neutral" | "ok" | "danger"; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx("st-notice", `st-notice-${tone}`, className)} role={tone === "danger" ? "alert" : "status"}>
      <span className="st-notice-text">{children}</span>
      {action && <span className="st-notice-action">{action}</span>}
    </div>
  );
}

/** A still progress bar with its words beside it. */
export function Progress({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="st-progress">
      <div className="st-progress-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="st-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="st-progress-text">{label}</span>
    </div>
  );
}

/** A small set of mutually exclusive choices, as pills. */
export function Choice<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <div className="st-choice" role="radiogroup" aria-label={label} id={id}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={cx("st-choice-item", value === o.id && "is-on")} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
