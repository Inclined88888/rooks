/**
 * The one public path of native triggers, kept dependency-free: the auth
 * middleware and the body-parser bypass of `kernel-boot.ts` import it before
 * any database is open. Exact, never a prefix (cf. `PUBLIC_ENDPOINTS`).
 */
export const TRIGGER_HOOK_PATH = /^\/api\/triggers\/hooks\/[a-z0-9][a-z0-9-]{0,62}\/?$/;
export const TRIGGER_HOOK_BODY_LIMIT = 256 * 1024;
/**
 * Set by the app's same-origin relay on every call it forwards. The relay is
 * a loopback peer, so without this mark an unauthenticated route would take
 * the whole world behind the app for a sender on this machine.
 */
export const TRIGGER_RELAY_HEADER = 'x-timon-relayed-by';
