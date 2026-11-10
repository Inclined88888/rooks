/**
 * Where a watched job's picture comes from (chat watch events and watch cards; docs/design/0003-workroom.md, section
 * 8). One mapping for every surface: the Room is drawn from GET /api/room/screenshot, a browser job from its job, the
 * desktop from its desk job. The Room's picture is asked for only while the Room says it is running and has a real
 * screen (honesty rules 1 and 3): the card reads /api/room/status first and never polls a screenshot otherwise.
 */
import type { Watch } from "./events";

export type WatchSource = {
  /** The word on the card: Room, Browser or Computer. */
  kicker: string;
  /** The picture, as an image URL (the card adds a cache-busting query). */
  screenshot: string;
  /** Where Open or Take over goes. */
  open: string;
  /** The api path that says whether a picture may be shown at all (the Room only; a job's frame is served while it runs). */
  status?: string;
};

export type RoomStatus = {
  available?: boolean; running?: boolean; screen?: boolean; pointer?: boolean; label?: string; note?: string; error?: string | null;
};

export function watchSource(w: Pick<Watch, "surface" | "job_id">): WatchSource {
  if (w.surface === "room") return { kicker: "Room", screenshot: "/api/room/screenshot", open: "/room", status: "/room/status" };
  const id = encodeURIComponent(w.job_id);
  if (w.surface === "browser") return { kicker: "Browser", screenshot: `/api/browser/jobs/${id}/screenshot`, open: `/browser/${id}` };
  return { kicker: "Computer", screenshot: `/api/desk/jobs/${id}/screenshot`, open: `/computer/${id}` };
}

/** True only when the Room is on and has a real display: the only time a picture of it is asked for. */
export function roomScreenLive(s: RoomStatus | null | undefined): boolean {
  return !!s && s.running === true && s.screen === true;
}

/** What the card says instead of a picture of the Room. */
export function roomNoScreenLine(s: RoomStatus | null | undefined): string {
  if (!s || !s.running) return "The Room is off.";
  const label = (s.label || "").trim().replace(/\.$/, "");
  return label ? `${label}. It has no screen to show; what it runs is in the steps.` : "This Room has no screen to show; what it runs is in the steps.";
}
