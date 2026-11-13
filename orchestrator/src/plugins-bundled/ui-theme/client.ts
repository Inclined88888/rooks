/**
 * Marker for the bundled `ui-theme` browser half.
 *
 * Its implementation lives in `app/src/plugins-client/ui-theme.tsx`: the
 * Next image has `app/` as its Docker context and can't import a sibling
 * file. The catalog declares it `clientOnly`, so this file is never loaded
 * as a Cordis module on the daemon side.
 */
export const clientOnly = true;
