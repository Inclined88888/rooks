import { ChevronRight, MoreHorizontal, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { MOD_KEY } from "../keys";
import { isActive, railItems, SETTINGS_PAGE, type GroupId, type RailItem, type StatusLike } from "../pages/registry";
import { useFocusTrap } from "../ui";

/**
 * The rail: 64px, icon above an 11px label, 44px hit targets, always visible above 900px. Chat, Room, Jobs are
 * pages; Day, Memory and Library open a small flyout listing their pages (focus trapped, Escape closes); More opens
 * the sheet; Settings sits at the bottom. Everything comes from the page registry.
 */
export function Rail({ status, onMore, onSearch, name }: { status: StatusLike | null; onMore: () => void; onSearch: () => void; name: string }) {
  const items = railItems(status);
  const location = useLocation();
  const [open, setOpen] = useState<GroupId | null>(null);
  const closeFlyout = useCallback(() => setOpen(null), []);
  useEffect(() => setOpen(null), [location.pathname]);
  return (
    <nav className="rail" aria-label="Main">
      <button type="button" className="rail-mark" onClick={onSearch} title={`Search or jump to (${MOD_KEY}K)`} aria-label={`${name}: search or jump to`}>
        <span aria-hidden="true">{name.trim().charAt(0).toUpperCase() || "R"}</span>
      </button>
      {items.map((it) => (it.page
        ? <RailLink key={it.id} item={it} pathname={location.pathname} />
        : <RailGroup key={it.id} item={it} pathname={location.pathname} open={open === it.group} onToggle={() => setOpen((o) => (o === it.group ? null : it.group!))} onClose={closeFlyout} />))}
      <span className="rail-spacer" />
      <button type="button" className="rail-item" onClick={onMore} aria-haspopup="dialog">
        <MoreHorizontal size={20} aria-hidden="true" />
        <span className="rail-label">More</span>
      </button>
      <NavLink to={SETTINGS_PAGE.path} className={({ isActive: on }) => `rail-item${on ? " is-active" : ""}`}>
        <SETTINGS_PAGE.icon size={20} aria-hidden="true" />
        <span className="rail-label">{SETTINGS_PAGE.label}</span>
      </NavLink>
      <span className="sr-only">Press {MOD_KEY} K to search or jump anywhere.</span>
      <button type="button" className="sr-only rail-search" onClick={onSearch}><Search size={12} aria-hidden="true" /> Search</button>
    </nav>
  );
}

function RailLink({ item, pathname }: { item: RailItem; pathname: string }) {
  const page = item.page!;
  const on = isActive(page, pathname);
  return (
    <NavLink to={page.path} className={`rail-item${on ? " is-active" : ""}`} aria-current={on ? "page" : undefined} end={false}>
      <item.icon size={20} aria-hidden="true" />
      <span className="rail-label">{item.label}</span>
    </NavLink>
  );
}

function RailGroup({ item, pathname, open, onToggle, onClose }: { item: RailItem; pathname: string; open: boolean; onToggle: () => void; onClose: () => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const anyActive = item.pages.some((p) => isActive(p, pathname));
  const close = useCallback(() => onClose(), [onClose]);
  useFocusTrap(pop, open, close);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open, onClose]);
  const onKey = (e: ReactKeyboardEvent) => {
    const links = [...(pop.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = links.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); links[(i + 1) % links.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); links[(i - 1 + links.length) % links.length]?.focus(); }
  };
  const id = `rail-flyout-${item.id}`;
  return (
    <div className="rail-group" ref={wrap}>
      <button type="button" className={`rail-item${anyActive ? " is-active" : ""}${open ? " is-open" : ""}`} onClick={onToggle}
        aria-haspopup="menu" aria-expanded={open} aria-controls={id}>
        <item.icon size={20} aria-hidden="true" />
        <span className="rail-label">{item.label}</span>
        <ChevronRight size={10} className="rail-chev" aria-hidden="true" />
      </button>
      {open && (
        <div ref={pop} id={id} className="rail-flyout" role="menu" aria-label={item.label} tabIndex={-1} onKeyDown={onKey}>
          <div className="rail-flyout-title" aria-hidden="true">{item.label}</div>
          {item.pages.map((p) => {
            const on = isActive(p, pathname);
            return (
              <a key={p.path} href={p.path} role="menuitem" className={`rail-flyout-link${on ? " is-active" : ""}`} aria-current={on ? "page" : undefined}
                onClick={(e) => { e.preventDefault(); onClose(); navigate(p.path); }}>
                <p.icon size={16} aria-hidden="true" />
                <span>{p.label}</span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
