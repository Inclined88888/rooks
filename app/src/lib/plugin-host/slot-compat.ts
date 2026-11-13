'use client';

/**
 * Slot admission: which slots a plugin may fill, given the ones its manifest
 * declares.
 *
 * A manifest lists slot NAMES, and until now that list was also the exact set
 * of destinations: a widget shipped for `cockpit.widget` could never be moved
 * to a sidebar, because the loader compared names one to one. Making widgets
 * movable means comparing NATURES instead — but only within a nature, never
 * across. Admission stays a security control: a widget must not be able to
 * take over `root`, `page`, `settings.section`, `settings.missions` or
 * `nav.footer`, which carry entirely different contracts (the whole
 * interface, the routed page, a plugin's own settings category, a graft into
 * a native group, the foot of the nav). Settings slots stay exact: declaring `settings.missions` does
 * not open `settings.resources`, and a `*.widget` never lands there.
 *
 * The nature of a slot is read from its name, deliberately: the layout itself
 * is a plugin (§10.8), so third-party layouts declare their own slots and no
 * closed list could ever cover them. A slot whose last segment is `widget`
 * (`cockpit.widget`, `sidebar.left.widget`, `acme.dock.widget`…) is a widget
 * host and accepts any widget. Every other slot keeps exact-name matching —
 * naming a slot `widget` is what opens it, nothing else does.
 */

const WIDGET_NATURE = 'widget';

/**
 * The nature a slot belongs to, or `null` when the slot is only interchangeable
 * with itself.
 */
export function slotNature(slot: string): string | null {
  const last = slot.slice(slot.lastIndexOf('.') + 1);
  return last === WIDGET_NATURE ? WIDGET_NATURE : null;
}

/** True when a plugin declaring `declared` may register into `slot`. */
export function isSlotAdmissible(declared: Iterable<string>, slot: string): boolean {
  const nature = slotNature(slot);
  for (const candidate of declared) {
    if (candidate === slot) return true;
    if (nature !== null && slotNature(candidate) === nature) return true;
  }
  return false;
}

/** Developer-facing message: what was refused, and what the manifest allows. */
export function slotAdmissionError(pluginId: string, slot: string, declared: Iterable<string>): Error {
  const list = [...declared];
  return new Error(
    `Plugin ${pluginId} is not allowed in slot ${slot}: `
    + `its manifest declares ${list.length ? list.join(', ') : 'no slot'}, `
    + 'and slots of a different nature are never interchangeable.',
  );
}
