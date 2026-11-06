import { Bot, Building2, ExternalLink, MessageSquare, Search } from "lucide-react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { MOD_KEY } from "../keys";
import { transitionClick } from "../motion";
import { morePages, type StatusLike } from "../pages/registry";
import { Button, Kbd, Sheet } from "../ui";

type Links = StatusLike & { chat_url?: string; paperclip_url?: string; hermes_url?: string };

/** Every other page, grouped, in a side sheet with a focus trap. Built from the page registry. */
export function MoreSheet({ open, onClose, status, name, onSearch }: { open: boolean; onClose: () => void; status: Links | null; name: string; onSearch: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const groups = morePages(status);
  const extras = status && (status.chat_url || status.paperclip_url || status.hermes_url);
  return (
    <Sheet open={open} onClose={onClose} title={name} side="left" width={300}
      footer={<Button variant="ghost" size="sm" icon={<Search size={14} />} onClick={() => { onClose(); onSearch(); }}>Search or jump to <Kbd>{MOD_KEY}K</Kbd></Button>}>
      {groups.map((g) => (
        <div key={g.section} className="more-group">
          <div className="more-section">{g.section}</div>
          {g.pages.map((p) => {
            const on = location.pathname === p.path || location.pathname.startsWith(`${p.path}/`);
            return (
              <NavLink key={p.path} to={p.path} className={`more-link${on ? " is-active" : ""}`} aria-current={on ? "page" : undefined}
                onClick={transitionClick(() => { onClose(); navigate(p.path); })}>
                <p.icon size={16} aria-hidden="true" />
                <span className="truncate">{p.label}</span>
              </NavLink>
            );
          })}
          {g.section === "Advanced" && extras && (
            <>
              {status?.chat_url && <a className="more-link" href={status.chat_url} target="_blank" rel="noreferrer"><MessageSquare size={16} aria-hidden="true" /> Open WebUI <ExternalLink size={12} className="more-ext" aria-hidden="true" /></a>}
              {status?.paperclip_url && <a className="more-link" href={status.paperclip_url} target="_blank" rel="noreferrer"><Building2 size={16} aria-hidden="true" /> Paperclip <ExternalLink size={12} className="more-ext" aria-hidden="true" /></a>}
              {status?.hermes_url && <a className="more-link" href={status.hermes_url} target="_blank" rel="noreferrer"><Bot size={16} aria-hidden="true" /> Hermes agent <ExternalLink size={12} className="more-ext" aria-hidden="true" /></a>}
            </>
          )}
        </div>
      ))}
    </Sheet>
  );
}
