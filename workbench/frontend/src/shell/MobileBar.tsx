import { AlertTriangle, Laptop, Layers, MessageSquare, MoreHorizontal } from "lucide-react";
import { NavLink } from "react-router-dom";
import { openNeedsYou } from "../needs/store";
import { useRoomStatus } from "../room/status";
import { usePresence } from "./presence";

/**
 * Below 900px the rail becomes this bottom bar: Chat, Room, Jobs, Needs you, More (shell.css shows it). The Room item
 * carries a live dot while the Room runs; Needs you opens the inbox sheet in place.
 */
export function MobileBar({ onMore }: { onMore: () => void }) {
  const p = usePresence();
  const room = useRoomStatus();
  const cls = ({ isActive }: { isActive: boolean }) => `mobile-item${isActive ? " is-active" : ""}`;
  return (
    <nav className="mobile-nav" aria-label="Main">
      <NavLink to="/assistant" className={cls}><MessageSquare size={20} aria-hidden="true" /><span>{"Chat"}</span></NavLink>
      <NavLink to="/room" className={cls}>
        <Laptop size={20} aria-hidden="true" />
        <span>{"Room"}</span>
        {room.running && <><span className="mobile-live" aria-hidden="true" /><span className="sr-only">, on</span></>}
      </NavLink>
      <NavLink to="/jobs" className={cls} end><Layers size={20} aria-hidden="true" /><span>{"Jobs"}</span></NavLink>
      <button type="button" className={`mobile-item${p.needs_you ? " has-count" : ""}`} onClick={() => openNeedsYou()} aria-label={`Needs you: ${p.needs_you}`} aria-haspopup="dialog">
        <AlertTriangle size={20} aria-hidden="true" />
        <span>{"Needs you"}</span>
        {p.needs_you > 0 && <span className="mobile-count" aria-hidden="true">{p.needs_you}</span>}
      </button>
      <button type="button" className="mobile-item" onClick={onMore} aria-haspopup="dialog"><MoreHorizontal size={20} aria-hidden="true" /><span>{"More"}</span></button>
    </nav>
  );
}
