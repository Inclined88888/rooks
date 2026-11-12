/**
 * What `ctx.router()` returns: an Express router, so a plugin writes its
 * routes with the API every Node developer knows (TODO #512).
 *
 * The second door out of `plugins/contract/`, and the only package one, by
 * decision (arbitrated 2026-10-29, TODO #512, volet 3). A structural interface
 * would narrow what a TypeScript plugin compiles against (`req.body` typed
 * `unknown` rather than `any`, no `route()` or `param()`): a break of the
 * public contract. So the contract keeps Express's type, and the published
 * package declares `@types/express` as a type dependency (volet 5). A
 * structural `PluginRouter` belongs to a future API version.
 */
export type { Router } from 'express';
