/**
 * Marker for the bundled `@timon/agent-chat` browser half.
 *
 * Its implementation lives in `app/src/plugins-client/agent-chat.tsx`: like
 * `ui-layout`, the Next image has `app/` as its Docker context and can't
 * import a sibling file. The catalog declares it `clientOnly`, so this file is
 * never loaded as a Cordis module on the daemon side.
 *
 * The widget has no host half at all: it talks to routes the kernel already
 * serves (`/api/agents`, `/api/layout`), so there is nothing for the daemon to
 * run on its behalf — exactly the case `docs/PLUGINS.md` describes for a
 * third-party widget shipped without `main`.
 */
export const clientOnly = true;
