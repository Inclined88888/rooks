/**
 * Paths of the gallery's install flow (TODO #332), dependency-free like
 * `webhook-path.ts`: the body parser imports it to let the archive upload
 * through raw. `-` is never a plugin id (ids are 3+ characters), so nothing
 * here can collide with `/api/plugins/:id/...`.
 */
export const PLUGIN_INSTALL_PREFIX = '/api/plugins/-/install';
/** The browser's archive upload: raw bytes, never JSON. Exact match. */
export const PLUGIN_UPLOAD_PATH = /^\/api\/plugins\/-\/install\/upload\/?$/;
/** Compressed size of an uploaded archive — the body limit of the route. */
export const PLUGIN_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
