import { Building2, ExternalLink, Keyboard, MessageSquare, Plug, Search } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { narrowQuery, useMediaQuery } from "./breakpoints";
import { MOD_KEY } from "../keys";
import { morePages, type StatusLike } from "../pages/registry";
import { warmProps } from "../pages/warm";
import { openShortcuts } from "./ShortcutsSheet";
import { Button, Kbd, Sheet, useFocusTrap } from "../ui";

type Links = StatusLike & { chat_url?: string; paperclip_url?: string; hermes_url?: string };

/**
 * Every other page, grouped by section. Above 900px a glass menu drops from the More button at the top right, with
 * the sections side by side; on phones it is a side sheet. Both trap focus and close on Escape. Built from the page
 * registry.
 */
export function MoreSheet({ open, onClose, status, name, onSearch }: { open: boolean; onClose: () => void; status: Links | null; name: string; onSearch: () => void }) {
  const location = useLocation();
  const groups = morePages(status);
  const extras = status && (status.chat_url || status.paperclip_url || status.hermes_url);
  const narrow = useMediaQuery(narrowQuery);
  const footer = (
    <>
      <Button variant="ghost" size="sm" icon={<Search size={14} />} onClick={() => { onClose(); onSearch(); }}>Search or jump to <Kbd>{MOD_KEY}K</Kbd></Button>
      <Button variant="ghost" size="sm" icon={<Keyboard size={14} />} onClick={() => { onClose(); openShortcuts(); }}>Keyboard shortcuts <Kbd>?</Kbd></Button>
    </>
  );
  const body = groups.map((g) => (
        <div key={g.section} className="more-group">
          <div className="more-section">{g.section}</div>
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
          {g.section === "Advanced" && extras && (
            <>
              {status?.chat_url && <a className="more-link" href={status.chat_url} target="_blank" rel="noreferrer"><MessageSquare size={16} aria-hidden="true" /> Open WebUI <ExternalLink size={12} className="more-ext" aria-hidden="true" /></a>}
              {status?.paperclip_url && <a className="more-link" href={status.paperclip_url} target="_blank" rel="noreferrer"><Building2 size={16} aria-hidden="true" /> Paperclip <ExternalLink size={12} className="more-ext" aria-hidden="true" /></a>}
              {status?.hermes_url && <a className="more-link" href={status.hermes_url} target="_blank" rel="noreferrer"><Plug size={16} aria-hidden="true" /> Hermes agent <ExternalLink size={12} className="more-ext" aria-hidden="true" /></a>}
            </>
          )}
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
