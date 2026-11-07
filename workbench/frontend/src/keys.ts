/** The modifier key as people see it: ⌘ on a Mac, Ctrl elsewhere. */
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const IS_MAC = isMac;
export const MOD_KEY = isMac ? "⌘" : "Ctrl";
