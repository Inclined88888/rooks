/**
 * The command menu (⌘K / Ctrl+K): every page from the registry, every action, every Settings section, and a search of
 * your chats and everything Rooks keeps (docs/design/0003-workroom.md, section 6, principle 5: keyboard first). A
 * shortcut's keys are shown on the right of the action they run, read from the one shortcut list (lib/shortcuts.ts).
 * Moving onto a page warms its chunk, so it opens at once.
 */
import {
  BookMarked, Contrast, CornerDownLeft, Github, Inbox, Keyboard, LucideIcon, MessageSquare, Moon, Pause, Play, Plus, Power, Search, Settings, Sun, Type,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FONTS, setAppearance, THEMES } from "./appearance";
import { api } from "./api";
import { IS_MAC } from "./keys";
import { keyCaps, shortcut, shortcutForPath, type Shortcut } from "./lib/shortcuts";
import { Hit, KIND_ROUTE } from "./memory/types"; // feat/memory-core: universal search
import { openNeedsYou } from "./needs/store";
import { SETTINGS_SECTIONS } from "./pages/settings/sections";
import { warmPath } from "./pages/warm";
import { PRODUCT } from "./product";
import { refreshPresence, roomOn, usePresence } from "./shell/presence";
import { openShortcuts } from "./shell/ShortcutsSheet";
import { Kbd } from "./ui";
import { pushToast } from "./ui/toast";

export type PaletteItem = {
  id: string; label: string; group: string; icon: LucideIcon; hint?: string; keywords?: string; run: () => void;
  /** The page this item opens (warmed when the item is selected). */
  to?: string;
  /** The shortcut that does the same, shown on the right. */
  keys?: Shortcut;
  /** Running it changes the menu instead of closing it (the search scopes). */
  stay?: boolean;
};

type Scope = null | "chats" | "everything";
type Conv = { id: number; title: string };

/** Small fuzzy match: every query character in order, earlier and contiguous hits score higher. */
function score(text: string, q: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 100 - direct;
  let ti = 0, s = 0, last = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return 0;
    s += at === last + 1 ? 3 : 1;
    last = at;
    ti = at + 1;
  }
  return s;
}

const HIT_WORD: Record<string, string> = { message: "Chat", task: "Task", file: "File", note: "Note", event: "Calendar", meeting: "Meeting", site: "Site", draft: "Email", memory: "Memory", entity: "Person or project", site_record: "Site record" };

/**
 * Every action the menu offers, in order. Exported so a test can check each one is here and that its shortcut, when it
 * has one, comes from the shortcut list.
 */
export function paletteActions(o: {
  navigate: (to: string, opts?: { state?: unknown }) => void; roomRunning: boolean; setScope: (s: Scope) => void;
}): PaletteItem[] {
  const { navigate } = o;
  const room = async (up: boolean) => {
    try {
      const r = await api<{ running?: boolean; error?: string }>(up ? "/room/up" : "/room/down", { method: "POST" });
      if (up) pushToast(r?.running ? "ok" : "err", r?.running ? "The Room is on." : r?.error || "The Room did not start.");
      else pushToast("ok", "The Room is off.");
    } catch (e) { pushToast("err", e instanceof Error ? e.message : "That did not work."); }
    void refreshPresence();
  };
  return [
    { id: "new-chat", label: "New chat", group: "Actions", icon: Plus, keywords: "assistant ask message start", keys: shortcut("new-chat"), to: "/assistant", run: () => navigate("/assistant", { state: { fresh: true } }) },
    { id: "new-task", label: "New task", group: "Actions", icon: Plus, keywords: "add todo", to: "/tasks", run: () => navigate("/tasks") },
    { id: "new-note", label: "New note", group: "Actions", icon: Plus, keywords: "write doc", to: "/notes", run: () => navigate("/notes") },
    o.roomRunning
      ? { id: "room-stop", label: "Stop the Room", group: "Actions", icon: Power, keywords: "room computer off turn off", run: () => void room(false) }
      : { id: "room-start", label: "Start the Room", group: "Actions", icon: Power, keywords: "room computer on turn on", run: () => void room(true) },
    { id: "needs-you", label: "Open Needs you", group: "Actions", icon: Inbox, keywords: "approvals waiting ok inbox", run: () => openNeedsYou() },
    { id: "search-chats", label: "Search chats", group: "Actions", icon: MessageSquare, keywords: "find conversation history", stay: true, run: () => o.setScope("chats") },
    { id: "search-everything", label: "Search memory, files and notes", group: "Actions", icon: BookMarked, keywords: "find knowledge remember people projects", stay: true, run: () => o.setScope("everything") },
    { id: "shortcuts", label: "Keyboard shortcuts", group: "Actions", icon: Keyboard, keywords: "keys help hotkeys", keys: shortcut("shortcuts"), run: () => openShortcuts() },
    { id: "add-skill", label: "Add a skill from GitHub", group: "Actions", icon: Github, keywords: "install skill plugin", to: "/skills", run: () => navigate("/skills?tab=add") },
    ...THEMES.map((t) => ({ id: `theme-${t.id}`, label: t.id === "auto" ? "Theme: match my computer" : `${t.label} theme`, group: "Appearance", icon: t.id === "dark" ? Moon : t.id === "contrast" ? Contrast : Sun, keywords: "appearance colour color dark light contrast", run: () => setAppearance({ theme: t.id }) })),
    ...FONTS.map((f) => ({ id: `font-${f.id}`, label: `${f.label} type`, group: "Appearance", icon: Type, keywords: "appearance font typeface", run: () => setAppearance({ font: f.id }) })),
    { id: "motion-full", label: "Motion: on", group: "Appearance", icon: Play, keywords: "fade animation", run: () => setAppearance({ motion: "full" }) },
    { id: "motion-off", label: "Motion: off", group: "Appearance", icon: Pause, keywords: "fade animation reduce stop", run: () => setAppearance({ motion: "off" }) },
    ...SETTINGS_SECTIONS.map((s) => {
      const to = s.id === "general" ? "/settings" : `/settings?section=${s.id}`;
      return { id: `settings-${s.id}`, label: `Settings: ${s.label}`, group: "Settings", icon: Settings, keywords: `preferences ${s.line}`, to, run: () => navigate(to) };
    }),
  ];
}

export function CommandPalette({ open, onClose, pages }: { open: boolean; onClose: () => void; pages: { to: string; label: string; icon: PaletteItem["icon"] }[] }) {
  const navigate = useNavigate();
  const presence = usePresence();
  const roomRunning = roomOn(presence);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [scope, setScope] = useState<Scope>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  const items: PaletteItem[] = useMemo(() => [
    ...paletteActions({ navigate, roomRunning, setScope: (s) => { setScope(s); setQ(""); requestAnimationFrame(() => inputRef.current?.focus()); } }),
    ...pages.map((p) => ({ id: `go-${p.to}`, label: p.label, group: "Go to", icon: p.icon, hint: "Page", to: p.to, keys: shortcutForPath(p.to), run: () => navigate(p.to) })),
  ], [pages, navigate, roomRunning]);

  const query = q.trim().toLowerCase();
  // feat/memory-core: Cmd/Ctrl+K also searches chats, files, notes, tasks, people, projects, meetings and memories
  const [hits, setHits] = useState<Hit[]>([]);
  const [chats, setChats] = useState<Conv[]>([]);
  useEffect(() => {
    if (scope === "chats" || query.length < (scope ? 2 : 3)) { setHits([]); return; }
    const t = setTimeout(() => api<Hit[]>(`/knowledge/search?q=${encodeURIComponent(query)}`).then(setHits).catch(() => setHits([])), 160);
    return () => clearTimeout(t);
  }, [query, scope]);
  useEffect(() => {
    if (scope !== "chats" || query.length < 2) { setChats([]); return; }
    const t = setTimeout(() => api<Conv[]>(`/conversations?q=${encodeURIComponent(query)}`).then((c) => setChats(Array.isArray(c) ? c : [])).catch(() => setChats([])), 160);
    return () => clearTimeout(t);
  }, [query, scope]);

  const hitItems = hits.map((h): PaletteItem => {
    const to = (KIND_ROUTE[h.kind] ?? (() => "/knowledge"))(h.ref);
    return { id: `kn-${h.kind}-${h.ref}`, label: h.title || h.kind, group: "Your stuff", icon: BookMarked, hint: HIT_WORD[h.kind] ?? h.kind, to, run: () => navigate(to) };
  });
  const chatItems = chats.map((c): PaletteItem => ({ id: `chat-${c.id}`, label: c.title || "Chat", group: "Chats", icon: MessageSquare, hint: "Chat", to: `/assistant/${c.id}`, run: () => navigate(`/assistant/${c.id}`) }));

  const results = useMemo(() => {
    if (scope === "chats") return chatItems;
    if (scope === "everything") return hitItems;
    return [...items
      .map((it) => ({ it, s: Math.max(score(it.label, query), score(it.keywords ?? "", query) * 0.6) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (query ? b.s - a.s : 0))
      .map((x) => x.it).slice(0, query ? 8 : undefined),
    ...hitItems];
  }, [items, query, hits, chats, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement;
    setQ("");
    setSel(0);
    setScope(null);
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => restore.current?.focus?.();
  }, [open]);
  useEffect(() => setSel(0), [query, scope]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: "nearest" });
    const to = results[sel]?.to;
    if (open && to) warmPath(to); // the page is on its way before Enter
  }, [sel, results, open]);

  if (!open) return null;
  const run = (it?: PaletteItem) => {
    if (!it) return;
    if (!it.stay) onClose();
    it.run();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); run(results[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); if (scope) { setScope(null); setQ(""); } else onClose(); }
    else if (e.key === "Backspace" && scope && !q) { e.preventDefault(); setScope(null); }
    else if (e.key === "Tab") e.preventDefault(); // keep focus inside the dialog
  };

  const placeholder = scope === "chats" ? "Search your chats…" : scope === "everything" ? "Search memory, files, notes, people and projects…"
    : "Search everything: chats, files, people, projects, pages…";
  const empty = scope && query.length < 2 ? "Type a few letters to search." : `No results for “${q}”`;
  let lastGroup = "";
  return (
    <div className="modal-back palette-back" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command menu" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="palette-input">
          <Search size={18} />
          {scope && <span className="palette-scope">{scope === "chats" ? "Chats" : "Memory and files"}</span>}
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder}
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={results[sel] ? `pal-${results[sel].id}` : undefined} aria-autocomplete="list" />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {results.length === 0 && <div className="palette-empty">{empty}</div>}
          {results.map((it, i) => {
            const head = it.group !== lastGroup && !query ? it.group : "";
            lastGroup = it.group;
            const caps = it.keys ? keyCaps(it.keys, IS_MAC) : [];
            return (
              <div key={it.id}>
                {head && <div className="palette-group" role="presentation">{head}</div>}
                <button id={`pal-${it.id}`} data-index={i} type="button" role="option" aria-selected={i === sel} className="palette-item" tabIndex={-1}
                  onMouseMove={() => sel !== i && setSel(i)} onClick={() => run(it)}>
                  <it.icon size={16} /> <span className="truncate">{it.label}</span>
                  {caps.length > 0 && (
                    <span className="palette-keys" aria-label={`Shortcut: ${caps.join(it.keys?.then ? " then " : " ")}`}>
                      {caps.map((k, n) => <Kbd key={n}>{k}</Kbd>)}
                    </span>
                  )}
                  {it.hint && !caps.length && <span className="hint">{it.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span><span className="kbd">↑</span><span className="kbd">↓</span> to move</span>
          <span><span className="kbd"><CornerDownLeft size={11} /></span> to open</span>
          <span style={{ marginLeft: "auto" }}>{PRODUCT}</span>
        </div>
      </div>
    </div>
  );
}
