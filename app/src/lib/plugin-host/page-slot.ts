'use client';

/**
 * The `page` slot is keyed by route: one entry per path, so a plugin can
 * bring its own screen instead of the single tenant the router used to be.
 *
 * The Next tree itself keeps ONE reserved key. It is not a route key: the
 * router serves a different page on every navigation, and re-keying its
 * entry on each path change would let a plugin claim `/settings` first and
 * take a product route away — admission is not supposed to be a race. The
 * layout therefore always paints the reserved key, and plugin pages are
 * reached through the catch-all route, which Next only reaches for paths it
 * serves no page for.
 */
export const NEXT_ROUTER_KEY = 'next-router';
