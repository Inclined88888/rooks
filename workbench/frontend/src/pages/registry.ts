/**
 * The one page registry (docs/design/0003-workroom.md, section 3): the single source for routes, the rail, the rail
 * flyouts, the More sheet and the command palette's "Go to" group. App.tsx builds all of them from PAGES and
 * REDIRECTS; nothing else lists pages by hand. Every path that worked before the Workroom still works.
 */
import type { LucideIcon } from "lucide-react";
import {
  Activity, AudioLines, BookMarked, Building2, CalendarClock, CalendarDays, CheckSquare, Code2, CreditCard, Columns3, FileText, FlaskConical,
  FolderKanban, FolderOpen, Gauge, Globe, Globe2, GraduationCap, Hammer, History, Home, Info, Laptop, Layers, LineChart, ListChecks, ListTree, Lock,
  Mail, MessageCircle, MessageSquare, Mic, Monitor, NotebookPen, Package, Palette, Plug, Scale, Search, Settings, Shield,
  SquareTerminal, UserRound, Users, UsersRound, Video,
} from "lucide-react";
import type { ComponentType } from "react";

export type RailId = "chat" | "room" | "jobs" | "day" | "memory" | "library" | "settings";
export type GroupId = "day" | "memory" | "library";
export type Section = "Workspace" | "Settings" | "Advanced";

/** The parts of /api/status the registry gates on. */
export type StatusLike = { browser_enabled?: boolean; desk_enabled?: boolean };

export type PageContext = { refresh: () => void };

export type PageEntry = {
  /** The canonical route and link target. */
  path: string;
  label: string;
  icon: LucideIcon;
  load: () => Promise<{ default: ComponentType<any> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Props the page element takes (static, or built from the app context). */
  props?: Record<string, unknown> | ((ctx: PageContext) => Record<string, unknown>);
  /** Other route patterns that render the same page, such as "/assistant/:id". */
  also?: string[];
  /** Sits on the rail itself (chat, room, jobs, settings). */
  rail?: RailId;
  /** Listed in a rail flyout (day, memory, library). */
  group?: GroupId;
  /** Where it sits in the More sheet. Rail and flyout pages are not repeated there. */
  section?: Section;
  /** Only when that part is running on this computer. */
  addon?: "browser" | "desk";
  /** Hide for this status (the registry's own addon rule is the common case). */
  hideWhen?: (s: StatusLike) => boolean;
  /** Not in the More sheet (default: listed when it has a section). */
  more?: boolean;
  /** Not in the palette's "Go to" group (default: listed). */
  palette?: boolean;
  /** Active on the rail for these paths (default: the path and anything under it). */
  match?: (pathname: string) => boolean;
};

export type Redirect = { from: string; to: string };

const under = (base: string) => (p: string) => p === base || p.startsWith(`${base}/`);

export const PAGES: PageEntry[] = [
  // ---- the rail ----
  { path: "/assistant", label: "Chat", icon: MessageSquare, rail: "chat", load: () => import("./Assistant"), props: { tab: "chat" }, also: ["/assistant/:id"],
    match: (p) => under("/assistant")(p) },
  { path: "/room", label: "Room", icon: Laptop, rail: "room", load: () => import("./Room") },
  { path: "/jobs", label: "Jobs", icon: Layers, rail: "jobs", load: () => import("../v02/Jobs") },
  { path: "/settings", label: "Settings", icon: Settings, rail: "settings", load: () => import("./Settings"), props: (ctx) => ({ onChanged: ctx.refresh }) },

  // ---- Day ----
  { path: "/mail", label: "Mail", icon: Mail, group: "day", load: () => import("./Mail") },
  { path: "/calendar", label: "Calendar", icon: CalendarDays, group: "day", load: () => import("./Calendar") },
  { path: "/tasks", label: "Tasks", icon: CheckSquare, group: "day", load: () => import("./Tasks") },

  // ---- Memory: facts, skills, what it noticed ----
  { path: "/knowledge", label: "Memory", icon: BookMarked, group: "memory", load: () => import("../memory/Knowledge") },
  { path: "/skills", label: "Skills", icon: ListChecks, group: "memory", load: () => import("./Skills") },
  { path: "/about-you", label: "About you", icon: UserRound, group: "memory", load: () => import("./AboutYou") },
  { path: "/teach", label: "Show me how", icon: GraduationCap, group: "memory", load: () => import("./Teach"), also: ["/teach/:id"] },

  // ---- Library ----
  { path: "/files", label: "Files", icon: FolderOpen, group: "library", load: () => import("./Files") },
  { path: "/notes", label: "Notes", icon: NotebookPen, group: "library", load: () => import("./Docs"), props: { kind: "note" }, also: ["/notes/:id"] },
  { path: "/documents", label: "Documents", icon: FileText, group: "library", load: () => import("./Docs"), props: { kind: "document" }, also: ["/documents/:id"] },
  { path: "/sites", label: "Sites", icon: Globe2, group: "library", load: () => import("./Sites") },
  { path: "/projects", label: "Projects", icon: FolderKanban, group: "library", load: () => import("./Projects"), also: ["/projects/:id"] },

  // ---- More: Workspace ----
  { path: "/home", label: "Home", icon: Home, section: "Workspace", load: () => import("./Dashboard") },
  { path: "/automations", label: "Automations", icon: CalendarClock, section: "Workspace", load: () => import("./Automations") },
  { path: "/code", label: "Code", icon: Code2, section: "Workspace", load: () => import("./Code"), also: ["/code/:id"] },
  { path: "/terminal", label: "Terminal", icon: SquareTerminal, section: "Workspace", load: () => import("../terminalHost").then((m) => ({ default: m.TerminalSlot })) },
  { path: "/browser", label: "Browser", icon: Globe, section: "Workspace", addon: "browser", load: () => import("./Browser"), also: ["/browser/:id"] },
  { path: "/computer", label: "Computer", icon: Monitor, section: "Workspace", addon: "desk", load: () => import("./Computer"), also: ["/computer/:id"] },
  { path: "/research", label: "Research", icon: Search, section: "Workspace", load: () => import("./Research"), also: ["/research/:id"] },
  { path: "/meetings", label: "Meetings", icon: Video, section: "Workspace", load: () => import("./Meetings"), also: ["/meetings/:id"] },
  { path: "/team", label: "Team", icon: UsersRound, section: "Workspace", load: () => import("../team/Team"), also: ["/team/people/:id"] },
  { path: "/pages", label: "Pages", icon: FileText, section: "Workspace", load: () => import("../teammates/Pages"), also: ["/pages/:id"] },
  { path: "/teammates", label: "Teammates", icon: Users, section: "Workspace", load: () => import("../teammates/Teammates"), also: ["/teammates/:id"] },
  { path: "/channels", label: "Channels", icon: MessageCircle, section: "Workspace", load: () => import("../teammates/Channels") },
  { path: "/talk", label: "Talk", icon: AudioLines, section: "Workspace", load: () => import("./Talk") },
  { path: "/vault", label: "Vault", icon: Lock, section: "Workspace", load: () => import("../teammates/Vault") },
  { path: "/coworkers", label: "Coworkers", icon: UsersRound, section: "Workspace", load: () => import("./Coworkers") },  // feat/coworkers
  { path: "/packs", label: "Packs", icon: Package, section: "Workspace", load: () => import("./Packs") },

  // ---- More: Settings ----
  { path: "/models", label: "AI models", icon: Gauge, section: "Settings", load: () => import("./Models") },
  { path: "/voice", label: "Ask anywhere & voice", icon: Mic, section: "Settings", load: () => import("./VoiceSettings") },
  { path: "/appearance", label: "Appearance", icon: Palette, section: "Settings", load: () => import("./Appearance") },
  { path: "/plan", label: "Your plan", icon: CreditCard, section: "Settings", load: () => import("./Plan") },
  { path: "/about", label: "About", icon: Info, section: "Settings", load: () => import("./About") },
  { path: "/privacy", label: "Privacy", icon: Shield, section: "Settings", load: () => import("./Privacy") },

  // ---- More: Advanced ----
  { path: "/history", label: "History", icon: History, section: "Advanced", load: () => import("./History") },
  { path: "/runs", label: "Run log", icon: ListTree, section: "Advanced", load: () => import("./Runs"), also: ["/runs/:id"] },
  { path: "/insights", label: "Insights", icon: LineChart, section: "Advanced", load: () => import("./Insights") },
  { path: "/compare", label: "Compare models", icon: Columns3, section: "Advanced", load: () => import("./Compare") },
  { path: "/fine-tune", label: "Fine-tune", icon: FlaskConical, section: "Advanced", load: () => import("./FineTune") },
  { path: "/company", label: "Company", icon: Building2, section: "Advanced", load: () => import("./Company") },
  { path: "/status", label: "System status", icon: Activity, section: "Advanced", load: () => import("./Status") },
  // /mcp itself belongs to the service (the MCP endpoint), so a page there would be answered by the service on a reload
  { path: "/extra-tools", label: "Extra tools", icon: Plug, section: "Advanced", load: () => import("./McpServers") },

  // ---- routes without a place in the nav (reached from inside pages) ----
  // the packs' own pages: opened from the Packs page, from a pack's result in chat ("/packs/trade?doc=…") and from ⌘K
  { path: "/packs/legal", label: "Legal pack", icon: Scale, load: () => import("./PackLegal") },
  { path: "/packs/study", label: "Study pack", icon: GraduationCap, load: () => import("./PackStudy") },
  { path: "/packs/trade", label: "Trade pack", icon: Hammer, load: () => import("./PackTrade") },
  { path: "/assistant-memory", label: "Chat memory", icon: BookMarked, load: () => import("./Assistant"), props: { tab: "memory" }, palette: false },
  { path: "/assistant-settings", label: "Chat settings", icon: Settings, load: () => import("./Assistant"), props: { tab: "settings" }, palette: false },
  { path: "/groups/:id", label: "Group", icon: Users, load: () => import("../teammates/Groups"), palette: false },
];

export const REDIRECTS: Redirect[] = [
  { from: "/", to: "/assistant" },
  { from: "/connect", to: "/settings" },
  { from: "/customize", to: "/settings" },  // the Customize page only linked to other pages; Settings has them all
  { from: "/assistant-skills", to: "/skills" },
  { from: "/packs/*", to: "/packs" },
  { from: "/mcp", to: "/extra-tools" },
  { from: "/welcome", to: "/assistant" },
  { from: "*", to: "/" },
];

/** Rail order, top to bottom; Settings sits at the bottom on its own. */
export const RAIL_ORDER: RailId[] = ["chat", "room", "jobs", "day", "memory", "library"];
export const RAIL_GROUPS: Record<GroupId, { label: string; icon: LucideIcon }> = {
  day: { label: "Day", icon: CalendarDays },
  memory: { label: "Memory", icon: BookMarked },
  library: { label: "Library", icon: FolderOpen },
};

export function allowed(p: PageEntry, s: StatusLike | null | undefined): boolean {
  if (p.addon === "browser" && !s?.browser_enabled) return false;
  if (p.addon === "desk" && !s?.desk_enabled) return false;
  if (p.hideWhen && s && p.hideWhen(s)) return false;
  return true;
}

/** Every page this status may show. */
export function visiblePages(s: StatusLike | null | undefined): PageEntry[] {
  return PAGES.filter((p) => allowed(p, s));
}

export function pageAt(path: string): PageEntry | undefined {
  return PAGES.find((p) => p.path === path);
}

export function isActive(p: PageEntry, pathname: string): boolean {
  return p.match ? p.match(pathname) : under(p.path)(pathname);
}

/** The pages inside one rail flyout. */
export function flyoutPages(group: GroupId, s: StatusLike | null | undefined): PageEntry[] {
  return visiblePages(s).filter((p) => p.group === group);
}

/** What the rail shows, in order: a page, or a group that opens a flyout. */
export type RailItem = { id: RailId; label: string; icon: LucideIcon; page?: PageEntry; group?: GroupId; pages: PageEntry[] };

export function railItems(s: StatusLike | null | undefined): RailItem[] {
  const out: RailItem[] = [];
  for (const id of RAIL_ORDER) {
    const page = PAGES.find((p) => p.rail === id);
    if (page) { out.push({ id, label: page.label, icon: page.icon, page, pages: [page] }); continue; }
    const g = RAIL_GROUPS[id as GroupId];
    if (g) out.push({ id, label: g.label, icon: g.icon, group: id as GroupId, pages: flyoutPages(id as GroupId, s) });
  }
  return out;
}

export const SETTINGS_PAGE = PAGES.find((p) => p.rail === "settings")!;

/** The More sheet: every page that is not already on the rail or in a flyout, grouped by section. */
export function morePages(s: StatusLike | null | undefined): { section: Section; pages: PageEntry[] }[] {
  const sections: Section[] = ["Workspace", "Settings", "Advanced"];
  return sections
    .map((section) => ({ section, pages: visiblePages(s).filter((p) => p.section === section && p.more !== false && !p.rail && !p.group) }))
    .filter((g) => g.pages.length > 0);
}

/** The palette's "Go to" group: every reachable page with a place in the app. */
export function palettePages(s: StatusLike | null | undefined): PageEntry[] {
  return visiblePages(s).filter((p) => p.palette !== false && !p.path.includes(":"));
}
