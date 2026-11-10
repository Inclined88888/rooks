import type { ReactNode } from "react";
import { PRODUCT } from "../../product";
import { Headline, MicroLabel } from "../../ui";
import { RooksMark } from "../../ui/RooksMark";
import "./settings.css";

/**
 * The first impression, a hero (industrial redesign, CHANGELOG): on the blueprint grid, the mark and the product name
 * small at the top, an optional step in words ("Step 2 of 4") as a micro-label, the heading as a huge two-line
 * uppercase headline with the second line offset, the one line as a small mono intro; the one choice in a card framed
 * by a 1 px line with one orange mark on its corner. Side by side on wide windows, stacked on phones (the headline
 * first, then the card, then the footer). Used by Auth (the lock) and Welcome. The words are exactly the ones passed.
 */
export function AuthCard({ title, line, step, wide, footer, children, brand = true }: {
  title: string; line?: ReactNode; step?: string; wide?: boolean; footer?: ReactNode; children: ReactNode; brand?: boolean;
}) {
  const inner = ["st-auth-inner", wide ? "is-wide" : "", title.length > 26 ? "is-long" : ""].filter(Boolean).join(" ");
  return (
    <div className="auth st-auth">
      <div className={inner}>
        <header className="st-auth-head">
          {(brand || step) && (
            <p className="st-auth-top">
              {brand && <span className="st-auth-brand"><RooksMark size={24} />{PRODUCT}</span>}
              {step && <MicroLabel name={step} decorative={false} />}
            </p>
          )}
          <Headline as="h1" className="st-auth-title" text={title} />
          {line && <p className="st-auth-line">{line}</p>}
        </header>
        <div className={`auth-card st-auth-card${wide ? " is-wide" : ""}`}>
          {children}
        </div>
        {footer && <p className="st-auth-foot" data-mark={PRODUCT}>{footer}</p>}
      </div>
    </div>
  );
}

/** The card's bottom row: Back on the left, the one primary action on the right. */
export function AuthActions({ children }: { children: ReactNode }) {
  return <div className="st-auth-actions">{children}</div>;
}
