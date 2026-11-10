/**
 * Keyboard shortcuts: every shortcut in one sheet, read from the one list (lib/shortcuts.ts) the command menu and the
 * shell's key handler use. Opened with ?, from the command menu, and from the More sheet. Mounted once, in the shell.
 */
import { useSyncExternalStore } from "react";
import { IS_MAC } from "../keys";
import { keyCaps, SHORTCUT_GROUPS, SHORTCUTS } from "../lib/shortcuts";
import { Kbd, Sheet } from "../ui";

let open = false;
const listeners = new Set<() => void>();
const notify = () => { for (const fn of listeners) fn(); };

export function openShortcuts() { if (!open) { open = true; notify(); } }
export function closeShortcuts() { if (open) { open = false; notify(); } }
export function toggleShortcuts() { open = !open; notify(); }
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function ShortcutsSheet() {
  const isOpen = useSyncExternalStore(subscribe, () => open, () => false);
  return (
    <Sheet open={isOpen} onClose={closeShortcuts} title="Keyboard shortcuts" side="right" width={380}>
      <div className="shortcuts">
        {SHORTCUT_GROUPS.map((g) => (
          <section key={g} className="shortcuts-group" aria-label={g}>
            <h3 className="shortcuts-title">{g}</h3>
            <dl className="shortcuts-list">
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <div key={s.id} className="shortcuts-row">
                  <dt>{s.label}</dt>
                  <dd>
                    {keyCaps(s, IS_MAC).map((k, i) => (
                      <span key={i}>{i > 0 && s.then && <span className="shortcuts-then">then</span>}<Kbd>{k}</Kbd></span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p className="shortcuts-note">Letters and ? work when you are not typing in a box.</p>
      </div>
    </Sheet>
  );
}
