/**
 * Marker for the bundled `ui-layout` browser half.
 *
 * Its implementation lives in `app/src/lib/plugin-host/ui-layout.tsx`: the
 * Next image has `app/` as its Docker context and can't import a sibling
 * file. The catalog declares it `clientOnly`, so this file is never loaded
 * as a Cordis module on the daemon side.
 */
export const clientOnly = true;
