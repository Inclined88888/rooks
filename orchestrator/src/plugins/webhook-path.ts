/**
 * The public path of plugin webhooks, kept dependency-free like
 * `triggers/hook-path.ts`: the auth middleware and the body-parser bypass of
 * `kernel-boot.ts` import it before any database is open. Exact, never a
 * prefix (cf. `PUBLIC_ENDPOINTS`).
 *
 * `POST /api/plugins/hooks/<slug>/<name>`: the path carries neither `@` nor
 * `%`. Senders refuse them (the Discord bot's Worker stops sending, without
 * an error), so a scoped id is never percent-encoded but turned into a slug:
 * `@timon/todo-connector-discord` → `timon-todo-connector-discord`. Two
 * plugins whose ids give the same slug cannot both register (`webhooks.ts`).
 * `hooks` is a reserved plugin id, so no plugin router sits on this path.
 */
export const PLUGIN_HOOK_PATH = /^\/api\/plugins\/hooks\/[a-z0-9][a-z0-9-]{0,99}\/[a-z0-9][a-z0-9-]{0,62}\/?$/;
/** A manifest `webhooks[].name`: same shape as a trigger slug. */
export const PLUGIN_HOOK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A plugin's segment in the path, see `pluginHookSlug`. */
export const PLUGIN_HOOK_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
/** The plugin id no package may take: its router would sit on the hook path. */
export const RESERVED_PLUGIN_ID = 'hooks';

/** `@scope/name` → `scope-name`; `null` when the id cannot give `[a-z0-9-]`. */
export function pluginHookSlug(pluginId: string): string | null {
  const slug = pluginId.replace(/^@/, '').replace(/\//g, '-');
  return PLUGIN_HOOK_SLUG_RE.test(slug) ? slug : null;
}

export function pluginHookPath(pluginId: string, name: string): string {
  const slug = pluginHookSlug(pluginId);
  if (!slug) throw new Error(`plugin \`${pluginId}\`: its id gives no webhook slug ([a-z0-9-] only)`);
  return `/api/plugins/hooks/${slug}/${name}`;
}
