/**
 * Where a page sits in the navigation, as a number and a name for its micro-label ([04 // DAY]). The numbers follow
 * the top bar from left to right (Chat, Room, Jobs, Day, Memory, Library), then the More sections (Workspace,
 * Settings, Advanced); the Settings page and the pages in More's Settings section share one place. The names are the
 * registry's own words (pages/registry.ts). Decoration only: a page with no place in the navigation has no label.
 */
export type Place = { n: number; name: string };

const PLACES: { key: string; name: string }[] = [
  { key: "chat", name: "Chat" },
  { key: "room", name: "Room" },
  { key: "jobs", name: "Jobs" },
  { key: "day", name: "Day" },
  { key: "memory", name: "Memory" },
  { key: "library", name: "Library" },
  { key: "Workspace", name: "Workspace" },
  { key: "Settings", name: "Settings" },
  { key: "Advanced", name: "Advanced" },
];

function at(key: string | undefined): Place | null {
  if (!key) return null;
  const i = PLACES.findIndex((p) => p.key === key);
  return i < 0 ? null : { n: i + 1, name: PLACES[i].name };
}

/** The place of a page entry (its rail tab, its group, or its More section), or of a group or a section by name. */
export function placeOf(entry: { rail?: string; group?: string; section?: string }): Place | null {
  if (entry.rail === "settings") return at("Settings");
  return at(entry.rail) ?? at(entry.group) ?? at(entry.section);
}
