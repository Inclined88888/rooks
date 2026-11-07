import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import "./settings.css";

/** Technical detail (addresses, ids, commands, keys) lives here, closed until someone opens it. */
export function Advanced({ children, label = "Advanced", open, className }: { children: ReactNode; label?: string; open?: boolean; className?: string }) {
  return (
    <details className={`st-advanced${className ? ` ${className}` : ""}`} open={open}>
      <summary><ChevronRight size={14} aria-hidden="true" className="st-advanced-chev" />{label}</summary>
      <div className="st-advanced-body">{children}</div>
    </details>
  );
}
