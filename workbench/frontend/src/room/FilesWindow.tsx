/**
 * The Files window (docs/design/0006-room-desktop.md, section 3.2): what is in the Room's own folder, from
 * GET /api/room/files?path=…, whether the Room is on or off (the folder is there either way). Reading only: nothing is
 * changed from here. Hand off opens the hand off form with the file filled in (the copy waits in Needs you); Show in
 * terminal types a cd into the open terminal through the send route.
 */
import { ArrowUp, File, FileOutput, Folder, Link2, RefreshCw, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { Button, EmptyState, ErrorState, IconButton, List, Loading, Row, useToast } from "../ui";
import { cdCommand, crumbs, entryMeta, joinPath, parentOf, sortEntries, whenWords, type FileEntry } from "./desk";
import { RoomWindow } from "./RoomView";
import type { RoomState } from "./status";
import { showInTerminalBlock, typedCdWords, type RoomTerminal } from "./words";

type Listing = { path?: string; parent?: string; root_label?: string; entries?: FileEntry[]; truncated?: boolean };
type Load = { state: "loading" } | { state: "ok"; listing: Listing } | { state: "gone" } | { state: "error"; line: string };

export function FilesWindow({ status, terminal, onHandOff, stale = false }: {
  status: RoomState;
  /** The terminal Show in terminal types into (the one showing, open), or null when none is open. */
  terminal: RoomTerminal | null;
  onHandOff: (src: string) => void;
  stale?: boolean;
}) {
  const toast = useToast();
  const [path, setPath] = useState("");
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [gen, setGen] = useState(0);
  const lastCrumb = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);

  const ask = useCallback(async (p: string) => {
    try {
      const listing = await api<Listing>(`/room/files?path=${encodeURIComponent(p)}`);
      setLoad({ state: "ok", listing });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setLoad({ state: "gone" });
      else setLoad({ state: "error", line: e instanceof ApiError && e.status === 400 ? "That is outside the Room." : "Rooks did not answer. Try again in a moment." });
    }
  }, []);
  // Asked again when the folder changes, on Refresh, and when the Room starts or stops (an install may have finished).
  useEffect(() => {
    setLoad((l) => (l.state === "ok" ? l : { state: "loading" }));
    void ask(path);
  }, [ask, path, gen, status.running]);
  useEffect(() => {
    if (moved.current && load.state === "ok") { moved.current = false; lastCrumb.current?.focus(); }
  }, [load]);

  const go = (p: string) => { moved.current = true; setLoad({ state: "loading" }); setPath(p); };
  // A cd is typed into the terminal, nothing more: the words say what was typed, never that the terminal is there now.
  // While the terminal runs something the line would go into that program, so the button waits.
  const blocked = showInTerminalBlock(terminal);
  const showInTerminal = async (folder: string) => {
    if (!terminal || blocked) return;
    try {
      await api(`/room/terminals/${encodeURIComponent(terminal.id)}/send`, { body: { text: cdCommand(folder), enter: true } });
      toast.ok(typedCdWords(folder, terminal.name));
    } catch (e) {
      toast.err(e);
    }
  };

  const verbs = (
    <>
      <Button size="sm" variant="ghost" icon={<ArrowUp size={13} />} disabled={!path} onClick={() => go(parentOf(path))}>Up one folder</Button>
      <IconButton label="Refresh" size="sm" onClick={() => setGen((g) => g + 1)}><RefreshCw size={14} /></IconButton>
    </>
  );
  const label = status.running ? "What is in the Room's folder." : "What is in the Room's folder. The Room is off. Its files are still here.";

  let body;
  if (load.state === "loading") body = <Loading rows={4} label="Reading the Room's folder" />;
  else if (load.state === "gone") {
    body = <EmptyState icon={<Folder size={24} />} title="That folder is gone." line="It may have been moved or removed in the terminal."
      action={<Button size="sm" variant="secondary" onClick={() => go("")}>Back to Home</Button>} />;
  }
  else if (load.state === "error") body = <ErrorState title="The folder could not be read." line={load.line} onRetry={() => setGen((g) => g + 1)} />;
  else {
    const entries = sortEntries(load.listing.entries ?? []);
    body = !entries.length
      ? <EmptyState icon={<Folder size={24} />} title="Nothing here yet." line="What you install or save in the terminal shows up here." />
      : (
        <List label={`In ${path || "Home"}`} className="room-files">
          {entries.map((e) => {
            const at = joinPath(path, e.name);
            const when = whenWords(e.modified);
            const meta = e.kind !== "link" && when ? `${entryMeta(e)} · ${when}` : entryMeta(e);
            const icon = e.kind === "folder" ? <Folder size={16} /> : e.kind === "link" ? <Link2 size={16} /> : <File size={16} />;
            return (
              <Row key={e.name} title={e.name} meta={meta} leading={icon} className="room-file"
                onClick={e.kind === "folder" ? () => go(at) : undefined}
                actions={e.kind === "link" ? undefined : (
                  // icon buttons with their names (the column is narrow); each says what it does on hover and to a reader
                  <>
                    {e.kind === "file" && <IconButton label={`Hand off ${e.name}`} onClick={() => onHandOff(at)}><FileOutput size={15} /></IconButton>}
                    <IconButton label={blocked ? `Show in terminal: ${blocked}` : `Show in terminal: type a cd to ${e.kind === "folder" ? e.name : crumbs(path).pop()?.label || "Home"} into ${terminal?.name}`}
                      disabled={!!blocked} onClick={() => void showInTerminal(e.kind === "folder" ? at : path)}><SquareTerminal size={15} /></IconButton>
                  </>
                )} />
            );
          })}
        </List>
      );
  }
  const trail = crumbs(path);
  return (
    <RoomWindow id="files" title="Files" verbs={verbs} label={label} stale={stale}>
      <nav className="room-crumbs" aria-label="Where you are in the Room's folder">
        {trail.map((c, i) => {
          const last = i === trail.length - 1;
          return (
            <span key={c.path} className="room-crumb">
              {i > 0 && <span className="room-crumb-sep" aria-hidden="true">›</span>}
              <button type="button" ref={last ? lastCrumb : undefined} className="room-crumb-btn" aria-current={last ? "location" : undefined} onClick={() => go(c.path)}>{c.label}</button>
            </span>
          );
        })}
      </nav>
      <div className="room-files-body">{body}</div>
      {load.state === "ok" && load.listing.truncated && <p className="room-window-foot">Showing the first 500. Use the terminal to see more.</p>}
    </RoomWindow>
  );
}

export default FilesWindow;
