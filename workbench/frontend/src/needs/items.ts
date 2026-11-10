/**
 * Needs you items as the inbox shows them (docs/design/0003-workroom.md, section 8): one word for where an item comes
 * from, the effect line the approval card says, the line of arguments it shows, and where Open goes. Pure, so the
 * tests run it. The service sends {id, kind, title, detail, since, conversation_id, job_id, actions}; held tool
 * calls (kinds approval and room) also carry tool, effect, reason and the raw args.
 */
import { argsLine } from "../chat/turns";
import { pointLine } from "../room/words";

export type NeedsItem = {
  id: string;
  kind: "approval" | "job" | "room" | "browser" | "desktop" | string;
  title: string;
  detail?: string | null;
  since?: string | null;
  conversation_id?: number | null;
  job_id?: number | string | null;
  actions?: string[];
  tool?: string;
  effect?: string;
  reason?: string;
  args?: string | null;
  /** design 0012: what a held work change takes out and puts in (a Docs or Sheets edit, a post's exact text) */
  change?: { op: "remove" | "add" | "set" | string; text: string }[];
};

const KIND_WORD: Record<string, string> = { approval: "Chat", room: "Room", job: "Job", desktop: "Computer", browser: "Browser", schedule: "Coworker" };

/** Where the item comes from, as the badge says it. */
export function kindWord(kind: string): string {
  return KIND_WORD[kind] ?? "Chat";
}

function parsedArgs(item: Pick<NeedsItem, "args">): Record<string, unknown> {
  try {
    const v = JSON.parse(item.args || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The effect the one approval card explains: a hand-off out of the Room has its own line. */
export function effectFor(item: Pick<NeedsItem, "kind" | "tool" | "effect" | "args">): string {
  if (item.kind === "room") return parsedArgs(item).action === "handoff" ? "handoff" : item.effect || "external";
  if (item.kind === "desktop") return "command";
  if (item.kind === "browser" || item.kind === "job") return "external";
  return item.effect || "external";
}

export type ItemLink = { to: string; label: string };

/** Where Open goes: the item's own home. */
export function linkFor(item: Pick<NeedsItem, "kind" | "conversation_id" | "job_id">): ItemLink | null {
  const job = item.job_id === null || item.job_id === undefined ? "" : encodeURIComponent(String(item.job_id));
  if (item.kind === "room") return { to: "/room", label: "Open the Room" };
  if (item.kind === "desktop") return job ? { to: `/computer/${job}`, label: "Open computer" } : null;
  if (item.kind === "browser") return job ? { to: `/browser/${job}`, label: "Open browser" } : null;
  if (item.kind === "job") return { to: "/jobs", label: "Open jobs" };
  if (item.kind === "schedule") return { to: "/coworkers", label: "Open coworkers" };
  if (item.conversation_id) return { to: `/assistant/${item.conversation_id}`, label: "Open chat" };
  return null;
}

/** A second link to the chat the item came from, when it is not already the first one. */
export function chatLinkFor(item: Pick<NeedsItem, "kind" | "conversation_id" | "job_id">): ItemLink | null {
  if (!item.conversation_id || item.kind === "approval") return null;
  return { to: `/assistant/${item.conversation_id}`, label: "Open chat" };
}

/** What a Room call is about: the file and where it goes, the command, the goal, the label or the point. Never its
 * request id or the tool's own action word: those are not for a normal screen. */
function roomLine(args: Record<string, unknown>): string {
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string).trim() : "");
  switch (String(args.action || "").toLowerCase()) {
    case "handoff": return s("src") && s("dest") ? `${s("src")} → ${s("dest")}` : s("src") || s("dest");
    case "run": return s("command");
    case "up": return s("goal");
    case "checkpoint": return s("label");
    case "reset": return s("name") ? pointLine(s("name")) : "";
    default: return "";
  }
}

/** The arguments a held call would run with, one line, for the card; nothing for a job or a helper's step. */
export function commandFor(item: Pick<NeedsItem, "kind" | "args">): string {
  if (item.kind === "room") return roomLine(parsedArgs(item));
  if (item.kind !== "approval") return "";
  return argsLine(item.args || "");
}

/** What the toast says after an answer, from the service's status for a held call. */
export function decidedWords(approve: boolean, status: string | undefined, kind?: string): string {
  if (!approve) return kind === "schedule" ? "Removed. Nothing else changed." : "Skipped.";
  if (status === "done") return "Done.";
  if (status === "approved") return "Approved. Rooks carries on.";
  return "Done.";
}
