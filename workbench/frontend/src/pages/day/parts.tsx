/**
 * Small pieces the day and library pages share (Mail, Calendar, Tasks, Notes, Files, Sites, Projects, Home, History,
 * Jobs). They sit on the primitives in src/ui and add only what those pages need and the primitives do not have:
 * a two pane split, a plain notice, a "working" line in words, a disclosure, a checkbox field and the model picker.
 * Tokens only (day.css); nothing here moves.
 */
import { ChevronRight } from "lucide-react";
import { useId, type ReactNode } from "react";
import type { Model } from "../../api";
import { Select } from "../../ui";
import { reliabilityLabel } from "../../util";
import "./day.css";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/** The plain words of an error, for an ErrorState line or a notice. Never a status code or a stack. */
export function plainError(e: unknown, fallback = "Something went wrong. Try again in a moment."): string {
  const msg = e instanceof Error ? e.message.trim() : typeof e === "string" ? e.trim() : "";
  if (!msg || /^\d{3}\b/.test(msg) || /gateway timeout|failed to fetch|networkerror|traceback/i.test(msg)) return fallback;
  return msg;
}

/** A list beside its detail. On a phone only one shows: the list, or the detail once something is picked. */
export function Split({ list, main, picked, label, className }: { list: ReactNode; main: ReactNode; picked: boolean; label: string; className?: string }) {
  return (
    <div className={cx("day-split", picked && "is-picked", className)}>
      <nav className="day-split-list" aria-label={label}>{list}</nav>
      <div className="day-split-main">{main}</div>
    </div>
  );
}

export type NoticeTone = "info" | "ok" | "warn" | "danger";

/** A plain line in the page (not a toast): what happened or what to do next. Neutral unless it is a problem. */
export function Notice({ tone = "info", title, children, actions, className }: { tone?: NoticeTone; title?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx("day-notice", `day-notice-${tone}`, className)} role={tone === "danger" ? "alert" : "status"}>
      <div className="day-notice-text">
        {title && <p className="day-notice-title">{title}</p>}
        {children && <div className="day-notice-body">{children}</div>}
      </div>
      {actions && <div className="day-notice-actions">{actions}</div>}
    </div>
  );
}

/** Work in progress, said in words ("Reading the site…"). Still: no spinner. */
export function Busy({ children }: { children: ReactNode }) {
  return <p className="day-busy" role="status"><span className="day-busy-dot" aria-hidden="true" />{children}</p>;
}

/** A native disclosure with a quiet summary line. */
export function Disclosure({ summary, children, open, onToggle, id, className }: { summary: ReactNode; children: ReactNode; open?: boolean; onToggle?: (open: boolean) => void; id?: string; className?: string }) {
  return (
    <details id={id} className={cx("day-more", className)} open={open} onToggle={onToggle ? (e) => onToggle((e.currentTarget as HTMLDetailsElement).open) : undefined}>
      <summary><ChevronRight size={14} aria-hidden="true" className="day-more-mark" />{summary}</summary>
      <div className="day-more-body">{children}</div>
    </details>
  );
}

/** A checkbox with its words, or a radio when `radio` names the group. */
export function CheckField({ checked, onChange, children, radio, className }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; radio?: string; className?: string }) {
  const id = useId();
  return (
    <label className={cx("day-check", className)} htmlFor={id}>
      <input id={id} type={radio ? "radio" : "checkbox"} name={radio} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/** The model picker for "Draft with AI", "Break down" and the writing help: the same groups as before, on the Select primitive. */
export function ModelPicker({ value, onChange, models, className }: { value: string; onChange: (v: string) => void; models: Model[]; className?: string }) {
  const groups = new Map<string, Model[]>();
  models.forEach((m) => groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]));
  return (
    <Select className={cx("day-model", className)} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Model">
      <option value="">Default model</option>
      {[...groups.entries()].map(([provider, list]) => (
        <optgroup key={provider} label={provider}>
          {list.map((m) => (
            <option key={m.ref} value={m.ref}>
              {m.label || (m.model === "default" ? "Recommended (the plan's default)" : m.model)}{m.free ? "  (free)" : ""}{reliabilityLabel(m)}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

/** A numbered list of steps, for setting things up. */
export function Steps({ items, className }: { items: string[]; className?: string }) {
  return <ol className={cx("day-steps", className)}>{items.map((x) => <li key={x}>{x}</li>)}</ol>;
}
