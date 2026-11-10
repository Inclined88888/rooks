import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ButtonVariant } from "../../ui";

/** A link that looks like a Button: a route inside the app (`to`) or a page outside it (`href`, opens a new tab). */
export function ButtonLink({ to, href, variant = "secondary", size = "md", icon, children, onClick, className }: {
  to?: string; href?: string; variant?: ButtonVariant; size?: "sm" | "md"; icon?: ReactNode; children: ReactNode; onClick?: () => void; className?: string;
}) {
  const cls = `ui-btn ui-btn-${variant}${size === "sm" ? " ui-btn-sm" : ""}${className ? ` ${className}` : ""}`;
  const body = <>{icon && <span className="ui-btn-icon" aria-hidden="true">{icon}</span>}{children}</>;
  if (to) return <Link className={cls} to={to} onClick={onClick}>{body}</Link>;
  return <a className={cls} href={href} target="_blank" rel="noreferrer" onClick={onClick}>{body}</a>;
}
