import { ExternalLink, Keyboard, Search } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { narrowQuery, useMediaQuery } from "./breakpoints";
import { MOD_KEY } from "../keys";
import { externalLinks, morePages, type StatusLike } from "../pages/registry";
import { warmProps } from "../pages/warm";
import { openShortcuts } from "./ShortcutsSheet";
import { placeOf } from "../pages/places";
import { Button, Kbd, MicroLabel, Sheet, useFocusTrap } from "../ui";

/**
 * Every other page, grouped by section. Above 900px a square menu with an ink edge drops from the More button at the
 * top right, with the sections side by side between hairlines; on phones it is a side sheet. Each section is titled by
 * a micro-label with the place's number ([07 // WORKSPACE], decoration; the name is read once). Both trap focus and
 * close on Escape. Built from the page registry.
 */
export function MoreSheet({ open, onClose, status, name, onSearch }: { open: boolean; onClose: () => void; status: StatusLike | null; name: string; onSearch: () => void }) {
  const location = useLocation();
  const groups = morePages(status);
  const links = externalLinks(status); // Open WebUI, Paperclip, Hermes: only with "Show developer tools" on
  const narrow = useMediaQuery(narrowQuery);
  const footer = (
    <>
      <Button variant="ghost" size="sm" icon={<Search size={14} />} onClick={() => { onClose(); onSearch(); }}>Search or jump to <Kbd>{MOD_KEY}K</Kbd></Button>
      <Button variant="ghost" size="sm" icon={<Keyboard size={14} />} onClick={() => { onClose(); openShortcuts(); }}>Keyboard shortcuts <Kbd>?</Kbd></Button>
    </>
  );
  const body = groups.map((g) => (
        <div key={g.section} className="more-group">
          <div className="more-section"><MicroLabel n={placeOf({ section: g.section })?.n} name={g.section} /><span className="sr-only">{g.section}</span></div>
          {g.pages.map((p) => {
            const on = location.pathname === p.path || location.pathname.startsWith(`${p.path}/`);
            return (
              <NavLink key={p.path} to={p.path} className={`more-link${on ? " is-active" : ""}`} aria-current={on ? "page" : undefined}
                onClick={onClose} {...warmProps(p.path)}>
                <p.icon size={16} aria-hidden="true" />
                <span className="truncate">{p.label}</span>
              </NavLink>
            );
          })}
          {g.section === "Advanced" && links.map((l) => (
            <a key={l.label} className="more-link" href={l.href} target="_blank" rel="noreferrer"><l.icon size={16} aria-hidden="true" /> {l.label} <ExternalLink size={12} className="more-ext" aria-hidden="true" /></a>
          ))}
        </div>
      ));
  if (narrow) return <Sheet open={open} onClose={onClose} title={name} side="left" width={300} footer={footer}>{body}</Sheet>;
  return <MoreMenu open={open} onClose={onClose} title={name} footer={footer}>{body}</MoreMenu>;
}

function MoreMenu({ open, onClose, title, footer, children }: { open: boolean; onClose: () => void; title: string; footer: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, open, onClose);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest?.("[data-more-trigger]")) return; // the More button toggles it itself
      onClose();
    };
    // the click that opened it has already finished; listen from the next tick
    const t = window.setTimeout(() => document.addEventListener("mousedown", away), 0);
    return () => { window.clearTimeout(t); document.removeEventListener("mousedown", away); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className="more-pop glass-menu" role="dialog" aria-modal="false" aria-label={`${title}: more pages`} tabIndex={-1}>
      <div className="more-pop-grid">{children}</div>
      <div className="more-pop-foot">{footer}</div>
    </div>
  );
}
