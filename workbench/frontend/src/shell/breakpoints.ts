/**
 * The two breakpoints of the Workroom, the same numbers as --bp-narrow and --bp-wide in tokens.css. Custom properties
 * cannot be read inside @media, so the shell stylesheets write these values and the scripts read them from here.
 */
import { useEffect, useState } from "react";

export const BP_NARROW = 900;
export const BP_WIDE = 1280;

/** Phones and narrow windows: the rail becomes a bottom bar and the Stage stacks under the thread. */
export const narrowQuery = `(max-width: ${BP_NARROW}px)`;
/** Wide windows: the Chats column is open by default. */
export const wideQuery = `(min-width: ${BP_WIDE + 1}px)`;

export function matches(query: string): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(query).matches;
}

export function useMediaQuery(query: string): boolean {
  const [on, setOn] = useState(() => matches(query));
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const update = () => setOn(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, [query]);
  return on;
}
