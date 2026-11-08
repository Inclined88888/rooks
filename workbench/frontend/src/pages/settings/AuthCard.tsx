import type { ReactNode } from "react";
import { PRODUCT } from "../../product";
import { RooksMark } from "../../ui/RooksMark";
import "./settings.css";

/**
 * The first impression: one quiet card in the middle of the page. The mark and the product name small at the top, an optional step
 * in words ("Step 2 of 4"), one heading, one line, then the one choice. Used by Auth (the lock) and Welcome.
 */
export function AuthCard({ title, line, step, wide, footer, children, brand = true }: {
  title: string; line?: ReactNode; step?: string; wide?: boolean; footer?: ReactNode; children: ReactNode; brand?: boolean;
}) {
  return (
    <div className="auth st-auth">
      <div className="st-auth-inner">
        <div className={`auth-card st-auth-card${wide ? " is-wide" : ""}`}>
          <header className="st-auth-head">
            {(brand || step) && (
              <p className="st-auth-top">
                {brand && <span className="st-auth-brand"><RooksMark size={24} />{PRODUCT}</span>}
                {step && <span className="st-auth-step">{step}</span>}
              </p>
            )}
            <h1 className="st-auth-title">{title}</h1>
            {line && <p className="st-auth-line">{line}</p>}
          </header>
          {children}
        </div>
        {footer && <p className="st-auth-foot">{footer}</p>}
      </div>
    </div>
  );
}

/** The card's bottom row: Back on the left, the one primary action on the right. */
export function AuthActions({ children }: { children: ReactNode }) {
  return <div className="st-auth-actions">{children}</div>;
}
