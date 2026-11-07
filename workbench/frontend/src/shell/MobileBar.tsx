import { Bell, Laptop, Layers, MessageSquare, MoreHorizontal } from "lucide-react";
import { NavLink } from "react-router-dom";
import { openNeedsYou } from "../needs/store";
import { warmProps } from "../pages/warm";
import { roomOn, usePresence } from "./presence";

/**
 * Below 900px the top bar becomes this floating glass dock: a pill with Chat, Room, Jobs and More (the current one
 * widens to show its name), and Needs you in its own glass circle with the count. The Room item carries a live dot
 * while the Room runs; Needs you opens the inbox sheet in place.
 */
export function MobileBar({ onMore }: { onMore: () => void }) {
  const p = usePresence();
  const cls = ({ isActive }: { isActive: boolean }) => `mobile-item${isActive ? " is-active" : ""}`;
  return (
    <div className="mobile-dock">
      <nav className="mobile-nav glass" aria-label="Main">
        <NavLink to="/assistant" className={cls} {...warmProps("/assistant")}><MessageSquare size={20} aria-hidden="true" /><span>{"Chat"}</span></NavLink>
        <NavLink to="/room" className={cls} {...warmProps("/room")}>
          <Laptop size={20} aria-hidden="true" />
          <span>{"Room"}</span>
          {roomOn(p) && <><i className="mobile-live" aria-hidden="true" /><b className="sr-only">, on</b></>}
        </NavLink>
        <NavLink to="/jobs" className={cls} {...warmProps("/jobs")} end><Layers size={20} aria-hidden="true" /><span>{"Jobs"}</span></NavLink>
        <button type="button" className="mobile-item" onClick={onMore} aria-haspopup="dialog"><MoreHorizontal size={20} aria-hidden="true" /><span>{"More"}</span></button>
      </nav>
      <button type="button" className={`mobile-needs glass${p.needs_you ? " has-count" : ""}`} onClick={() => openNeedsYou()} aria-label={`Needs you: ${p.needs_you}`} aria-haspopup="dialog">
        <Bell size={20} aria-hidden="true" />
        <span className="sr-only">{"Needs you"}</span>
        {p.needs_you > 0 && <span className="mobile-count" aria-hidden="true">{p.needs_you}</span>}
      </button>
    </div>
  );
}
