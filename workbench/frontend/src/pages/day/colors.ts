/**
 * The colours a person can give a calendar. A calendar's colour is the person's own data (it marks that calendar's
 * events), not part of the theme, so these hex values live here and nowhere else in the page package. The first is
 * the default for a new calendar.
 */
export const CALENDAR_COLORS: { value: string; name: string }[] = [
  { value: "#0ea5e9", name: "Blue" },
  { value: "#2f7d4f", name: "Green" },
  { value: "#c98a00", name: "Amber" },
  { value: "#b3372b", name: "Red" },
  { value: "#7c5cc4", name: "Purple" },
  { value: "#5e5d59", name: "Grey" },
];
export const DEFAULT_CALENDAR_COLOR = CALENDAR_COLORS[0].value;
