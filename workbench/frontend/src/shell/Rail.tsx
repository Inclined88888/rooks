import { ChevronDown, MoreHorizontal, Search } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { MOD_KEY } from "../keys";
import { isActive, railItems, SETTINGS_PAGE, type GroupId, type RailItem, type StatusLike } from "../pages/registry";
import { warmPath, warmProps } from "../pages/warm";
import { useFocusTrap } from "../ui";
import { RooksMark } from "../ui/RooksMark";
import { PresenceStrip } from "./PresenceStrip";
import { roomOn, usePresence } from "./presence";

/**
 * The glass navigation bar (docs/design/0003-workroom.md, section 6): a floating top bar above 900px. Left: the mark,
 * the Rooks tower (search or jump) and the presence line. Centre: one frosted pill holding Chat, Room, Jobs and the Day, Memory and
 * Library groups, with a solid pill that slides to the page you are on. Right: round glass buttons for search, More
 * and Settings. Groups open a glass menu below their tab (focus trapped, Escape closes). Everything comes from the
 * page registry.
 */
export function Rail({ status, onMore, onSearch, name }: { status: StatusLike | null; onMore: () => void; onSearch: () => void; name: string }) {
  const items = railItems(status);
  const location = useLocation();
  // the Room item shows a live dot while the Room runs, from the presence answer the strip already polls
  const roomLive = roomOn(usePresence());
  const [open, setOpen] = useState<GroupId | null>(null);
  const closeFlyout = useCallback(() => setOpen(null), []);
  useEffect(() => setOpen(null), [location.pathname]);
  const pill = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  // the sliding pill: measure the tab that is current and move the indicator under it
  useLayoutEffect(() => {
    const measure = () => {
      const on = pill.current?.querySelector<HTMLElement>(".rail-item.is-active");
      setInd(on ? { x: on.offsetLeft, w: on.offsetWidth } : null);
    };
    measure();
    window.addEventListener("resize", measure);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => window.removeEventListener("resize", measure);
  }, [location.pathname, items.length, open]); // an open group gains its label at <=1280px, so re-measure then too
  const settingsOn = isActive(SETTINGS_PAGE, location.pathname);
  return (
    <header className="topbar">
      <div className="topbar-start">
        <button type="button" className="rail-mark" onClick={onSearch} title={`Search or jump to (${MOD_KEY}K)`} aria-label={`${name}: search or jump to`}>
          <RooksMark size={40} />
        </button>
        <PresenceStrip />
      </div>
      <nav className="rail glass" aria-label="Main">
        <div className="rail-pill" ref={pill}>
          {ind && <span className="rail-ind" aria-hidden="true" style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} />}
          {items.map((it) => (it.page
            ? <RailLink key={it.id} item={it} pathname={location.pathname} live={it.id === "room" && roomLive} />
            : <RailGroup key={it.id} item={it} pathname={location.pathname} open={open === it.group} onToggle={() => setOpen((o) => (o === it.group ? null : it.group!))} onClose={closeFlyout} />))}
        </div>
      </nav>
      <div className="topbar-end">
        <button type="button" className="glass-round" onClick={onSearch} aria-label={`Search or jump to (${MOD_KEY}K)`} title={`Search or jump to (${MOD_KEY}K)`}>
          <Search size={18} aria-hidden="true" />
        </button>
        <button type="button" className="glass-round" data-more-trigger onClick={onMore} aria-haspopup="dialog" aria-label="More pages" title="More pages">
          <MoreHorizontal size={18} aria-hidden="true" />
        </button>
        <NavLink to={SETTINGS_PAGE.path} className={`glass-round${settingsOn ? " is-active" : ""}`} aria-label={SETTINGS_PAGE.label} title={SETTINGS_PAGE.label}
          aria-current={settingsOn ? "page" : undefined} {...warmProps(SETTINGS_PAGE.path)}>
          <SETTINGS_PAGE.icon size={18} aria-hidden="true" />
        </NavLink>
      </div>
      <span className="sr-only">Press {MOD_KEY} K to search or jump anywhere.</span>
    </header>
  );
}

function RailLink({ item, pathname, live }: { item: RailItem; pathname: string; live?: boolean }) {
  const page = item.page!;
  const on = isActive(page, pathname);
  return (
    <NavLink to={page.path} title={item.label} className={`rail-item${on ? " is-active" : ""}`} aria-current={on ? "page" : undefined} end={false} {...warmProps(page.path)}>
      <item.icon size={16} aria-hidden="true" />
      <span className="rail-label">{item.label}</span>
      {live && <><span className="rail-live" aria-hidden="true" /><span className="sr-only">, on</span></>}
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
      <button type="button" title={item.label} className={`rail-item${anyActive ? " is-active" : ""}${open ? " is-open" : ""}`} onClick={onToggle}
        onPointerEnter={() => item.pages.forEach((p) => warmPath(p.path))} onFocus={() => item.pages.forEach((p) => warmPath(p.path))}
        aria-haspopup="menu" aria-expanded={open} aria-controls={id}>
        <item.icon size={16} aria-hidden="true" />
        <span className="rail-label">{item.label}</span>
        <ChevronDown size={12} className="rail-chev" aria-hidden="true" />
      </button>
      {open && (
        <div ref={pop} id={id} className="rail-flyout glass-menu" role="menu" aria-label={item.label} tabIndex={-1} onKeyDown={onKey}>
          <div className="rail-flyout-title" aria-hidden="true">{item.label}</div>
          {item.pages.map((p) => {
            const on = isActive(p, pathname);
            return (
              <a key={p.path} href={p.path} role="menuitem" className={`rail-flyout-link${on ? " is-active" : ""}`} aria-current={on ? "page" : undefined} {...warmProps(p.path)}
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
