// A real terminal in the app window. Each tab is its own shell and stays running when you switch tabs.
// The server allows six at once (terminal_pty.MAX_SESSIONS). Each tab is a Shell (terminal/Shell.tsx, shared with the
// Room's terminals) on /api/terminal/ws.
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Shell, type Phase } from "../terminal/Shell";
import { publishTerminals } from "../terminalHost";
import { Button, Page } from "../ui";
import "../work.css";

const MAX = 6;
const REASON: Record<number, string> = {
  4401: "You are signed out. Sign in again, then reopen the terminal.",
  4403: "The terminal only opens on the computer running this app, and only when it is switched on in Settings.",
  4429: "Too many terminals are open. Close one and try again.",
};

function terminalWhy(code: number, reason: string): string {
  if (REASON[code]) return REASON[code];
  if (reason) return reason;
  if (code === 1006 || code === 1005) return "The terminal could not connect. Press Reopen this terminal.";
  return "The shell exited.";
}

function TabChip({ pane, active, over, onPick, onRename, onClose, onDragStart, onDragOver, onDrop, onDragEnd }: {
  pane: { id: number; name: string }; active: boolean; over: boolean;
  onPick: () => void; onRename: (name: string) => void; onClose: () => void;
  onDragStart: () => void; onDragOver: () => void; onDrop: () => void; onDragEnd: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pane.name);
  const commit = () => { setEditing(false); onRename(draft); setDraft((d) => d.trim() || pane.name); };
  return (
    <div className={`terminal-tab${active ? " is-active" : ""}${over ? " is-over" : ""}`}
      draggable={!editing}
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(pane.id)); e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
      onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
      onDragEnd={onDragEnd}>
      {editing ? (
        <input className="terminal-tab-rename" autoFocus aria-label="Terminal name" value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") { setDraft(pane.name); setEditing(false); } }} />
      ) : (
        <button type="button" role="tab" aria-selected={active} className="terminal-tab-name" title="Double-click to rename. Drag to move."
          onClick={onPick} onDoubleClick={() => { setDraft(pane.name); setEditing(true); }}>{pane.name}</button>
      )}
      <button type="button" className="terminal-tab-x" aria-label={`Close ${pane.name}`} title="Close this terminal" onClick={onClose}><X size={12} /></button>
    </div>
  );
}

type Pane = { id: number; name: string };
const STORE = "aiw.terminals";

function readSaved(): { panes: Pane[]; active: number; next: number } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || "null");
    if (!raw || !Array.isArray(raw.panes) || !raw.panes.length) return null;
    const panes = raw.panes.filter((p: Pane) => p && typeof p.id === "number" && typeof p.name === "string").slice(0, MAX);
    if (!panes.length) return null;
    const active = panes.some((p: Pane) => p.id === raw.active) ? raw.active : panes[0].id;
    const next = Math.max(raw.next || 1, ...panes.map((p: Pane) => p.id)) + 1;
    return { panes, active, next };
  } catch {
    return null;
  }
}

export default function TerminalPage({ bare = false, parked = false }: { bare?: boolean; parked?: boolean }) {
  const saved = useRef(readSaved());
  const [panes, setPanes] = useState<Pane[]>(saved.current?.panes ?? [{ id: 1, name: "Terminal 1" }]);
  const [active, setActive] = useState(saved.current?.active ?? 1);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [over, setOver] = useState<number | null>(null);
  const next = useRef(saved.current?.next ?? 2);
  const dragId = useRef<number | null>(null);
  const senders = useRef(new Map<number, (cmd: string) => void>());
  const full = panes.length >= MAX;

  useEffect(() => {
    localStorage.setItem(STORE, JSON.stringify({ panes, active, next: next.current }));
    publishTerminals(panes, active);
  }, [panes, active]);

  const add = () => {
    if (full) return;
    const id = next.current++;
    setPanes((list) => [...list, { id, name: `Terminal ${list.length + 1}` }]);
    setActive(id);
    setPhase("connecting");
  };
  const close = (id: number) => {
    senders.current.delete(id);
    const rest = panes.filter((p) => p.id !== id);
    if (!rest.length) {
      const fresh = next.current++;
      setPanes([{ id: fresh, name: "Terminal 1" }]);
      setActive(fresh);
      return;
    }
    setPanes(rest);
    if (active === id) setActive(rest[rest.length - 1].id);
  };
  const rename = (id: number, name: string) => {
    const clean = name.trim().slice(0, 40);
    if (!clean) return;
    setPanes((list) => list.map((p) => (p.id === id ? { ...p, name: clean } : p)));
  };
  const move = (from: number, to: number) => {
    if (from === to) return;
    setPanes((list) => {
      const nextList = list.slice();
      const i = nextList.findIndex((p) => p.id === from);
      const j = nextList.findIndex((p) => p.id === to);
      if (i < 0 || j < 0) return list;
      const [item] = nextList.splice(i, 1);
      nextList.splice(j, 0, item);
      return nextList;
    });
  };

  return (
    <Page wide className={`ag-page terminal-page${bare ? " is-bare" : ""}`} title="Terminal"
      description="Drag a name to move it. Double-click a name to rename it. Each one keeps running when you leave for chat or settings. Up to six."
      actions={<>
        <Button size="sm" onClick={() => senders.current.get(active)?.("rooks")} disabled={phase !== "open"} title="Start the coding assistant in this terminal">Start coding</Button>
        <Button size="sm" icon={<Plus size={14} />} onClick={add} disabled={full} title={full ? "Six terminals can run at once. Close one to open another." : "Open another shell. The ones already open keep running."}>New terminal</Button>
      </>}>
      <div className="terminal-tabs" role="tablist" aria-label="Terminals">
        {panes.map((p) => (
          <TabChip key={p.id} pane={p} active={p.id === active} over={over === p.id}
            onPick={() => setActive(p.id)} onRename={(name) => rename(p.id, name)} onClose={() => close(p.id)}
            onDragStart={() => { dragId.current = p.id; }}
            onDragOver={() => setOver(p.id)}
            onDrop={() => { if (dragId.current != null) move(dragId.current, p.id); dragId.current = null; setOver(null); }}
            onDragEnd={() => { dragId.current = null; setOver(null); }} />
        ))}
      </div>
      <div className="terminal-screen">
        <div className="terminal-screen-bar">
          <span className="terminal-dots" aria-hidden><i /><i /><i /></span>
          <span className="terminal-screen-title">{panes.find((p) => p.id === active)?.name || "Terminal"}</span>
        </div>
        <div className="terminal-stage">
          {panes.map((p) => (
            <Shell key={p.id} url="/api/terminal/ws" active={p.id === active} hold={parked} label={p.name} why={terminalWhy}
              onPhase={(ph, _why) => { if (p.id === active) setPhase(ph); }}
              onSend={(send) => { senders.current.set(p.id, send); }} />
          ))}
        </div>
      </div>
    </Page>
  );
}
