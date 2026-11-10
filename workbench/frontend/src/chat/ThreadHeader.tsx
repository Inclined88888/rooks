/**
 * The thread header: the Chats column toggle, the title, the mode tabs and the menu on the first line; the project,
 * the model, effort and Check answers as chips on the second. Nothing a person needs every day hides in the menu.
 */
import { Ellipsis, PanelLeft, SquareTerminal } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Model } from "../api";
import { MOD_KEY } from "../keys";
import { IconButton, Kbd, useFocusTrap } from "../ui";
import { EffortSelect, ModelSelect } from "../util";
import { CheckToggle, ProjectSwitcher } from "../v02/ChatExtras";
import type { WorkMode } from "./types";

export type ThreadHeaderProps = {
  title: string;
  cid: number | null;
  listOpen: boolean;
  onToggleList: () => void;
  workMode: WorkMode;
  onMode: (m: WorkMode) => void;
  codeDepth: "plan" | "build";
  /** "Show developer tools" (Settings, Advanced): the Chat and Code tabs, Plan and Build, Code and Continue in terminal. */
  devTools: boolean;
  model: string;
  onModel: (ref: string) => void;
  models: Model[];
  defaultRef: string;
  isPlan: boolean;
  effort: string;
  onEffort: (v: string) => void;
  busy: boolean;
  showRoutines: boolean;
  onRoutines: () => void;
  onTerminal: () => void;
  onBeside: () => void;
  onNewChat: () => void;
  onStop: () => void;
  onFocusComposer: () => void;
};

export function ThreadHeader(p: ThreadHeaderProps) {
  const modelLabel = (p.models.find((m) => m.ref === (p.model || p.defaultRef))?.label)
    || p.models.find((m) => m.ref === (p.model || p.defaultRef))?.model
    || "No model connected";
  return (
    <header className="chat-head">
      <div className="toolbar chat-top agents-thread-top">
        <IconButton label={p.listOpen ? "Hide chats" : "Show chats"} size="sm" active={p.listOpen} aria-expanded={p.listOpen} aria-controls="chat-list" onClick={p.onToggleList}>
          <PanelLeft size={16} />
        </IconButton>
        <div className="toolbar-title truncate">{p.title}</div>
        <span className="agents-local-pill" title="Work stays on this computer">On this computer</span>
        <div className="spacer" />
        {p.devTools && (
          <div className="tabs mode-tabs agents-mode-head" role="group" aria-label="Mode" title="Chat is for the day. Code is for changing a project, and it asks before it changes files.">
            <button type="button" className={`tab ${p.workMode === "chat" ? "active" : ""}`} onClick={() => p.onMode("chat")}>Chat</button>
            <button type="button" className={`tab ${p.workMode !== "chat" ? "active" : ""}`} onClick={() => { if (p.workMode === "chat") p.onMode(p.codeDepth); }}>Code</button>
          </div>
        )}
        {p.devTools && p.workMode !== "chat" && (
          <div className="tabs mode-tabs agents-mode-head" role="group" aria-label="Code">
            <button type="button" className={`tab ${p.workMode === "plan" ? "active" : ""}`} onClick={() => p.onMode("plan")}>Plan</button>
            <button type="button" className={`tab ${p.workMode === "build" ? "active" : ""}`} onClick={() => p.onMode("build")}>Build</button>
          </div>
        )}
        {p.devTools && <span className="sr-only">Chat is for the day. Code is for changing a project, and it asks before it changes files.</span>}
        <ChatMenu showRoutines={p.showRoutines} onRoutines={p.onRoutines} cid={p.cid} busy={p.busy} devTools={p.devTools}
          onTerminal={p.onTerminal} onBeside={p.onBeside} onNewChat={p.onNewChat} onStop={p.onStop} onFocusComposer={p.onFocusComposer} />
      </div>
      <div className="chat-chips" aria-label="This chat">
        <span className="chat-chip-wrap"><ProjectSwitcher cid={p.cid} /></span>
        <span className="chat-chip-select" title="Model">
          <ModelSelect value={p.model} onChange={p.onModel} models={p.models} emptyLabel={modelLabel} />
        </span>
        {p.isPlan && p.workMode !== "chat" && (
          <span className="chat-chip-select" title="How hard the plan's model thinks"><EffortSelect value={p.effort} onChange={p.onEffort} /></span>
        )}
        <span className="chat-chip-wrap"><CheckToggle cid={p.cid} /></span>
      </div>
    </header>
  );
}

function ChatMenu({ showRoutines, onRoutines, cid, busy, devTools, onTerminal, onBeside, onNewChat, onStop, onFocusComposer }: {
  showRoutines: boolean; onRoutines: () => void; cid: number | null; busy: boolean; devTools: boolean;
  onTerminal: () => void; onBeside: () => void; onNewChat: () => void; onStop: () => void; onFocusComposer: () => void;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useFocusTrap(panel, open, close);
  const go = (fn: () => void) => () => { fn(); setOpen(false); };
  return (
    <div className="chat-menu">
      <button type="button" className={`ui-btn ui-btn-ghost ui-btn-sm ui-btn-square${open ? " on" : ""}`} aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Ellipsis size={16} />
      </button>
      {open && (
        <div ref={panel} className="chat-menu-panel" role="menu" tabIndex={-1}>
          <button type="button" role="menuitem" onClick={go(onNewChat)}>New chat <span className="chat-menu-keys"><Kbd>{MOD_KEY}</Kbd><Kbd>⇧</Kbd><Kbd>O</Kbd></span></button>
          <button type="button" role="menuitem" onClick={go(onFocusComposer)}>Write a message <span className="chat-menu-keys"><Kbd>{MOD_KEY}</Kbd><Kbd>/</Kbd></span></button>
          <button type="button" role="menuitem" disabled={!busy} onClick={go(onStop)}>Stop <span className="chat-menu-keys"><Kbd>Esc</Kbd></span></button>
          <hr />
          <button type="button" role="menuitem" className={showRoutines ? "on" : ""} onClick={go(onRoutines)}>Routines</button>
          {devTools && <button type="button" role="menuitem" onClick={go(() => navigate("/code"))}>Code</button>}
          <button type="button" role="menuitem" onClick={go(onBeside)}>Open mail beside</button>
          {devTools && cid ? <button type="button" role="menuitem" onClick={go(onTerminal)}><SquareTerminal size={14} /> Continue in terminal</button> : null}
          <hr />
          <button type="button" role="menuitem" onClick={go(() => navigate("/knowledge"))}>Memory</button>
          <button type="button" role="menuitem" onClick={go(() => navigate("/assistant-settings"))}>Chat settings</button>
          <button type="button" role="menuitem" onClick={go(() => navigate("/settings"))}>Settings</button>
        </div>
      )}
    </div>
  );
}
