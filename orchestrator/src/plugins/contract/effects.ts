/**
 * Effect bodies and handles (`ctx.effect`).
 *
 * Extracted verbatim from `plugins/context.ts`, which re-exports it: the public
 * contract lives in leaf modules so `@timon-ai/sdk` can name it without the
 * implementation (TODO #512, option B).
 */

/**
 * Function returned by an effect and called during unload. It may be async:
 * the kernel waits for it before considering the plugin unloaded, which is the
 * only reliable way to close a socket, file, or process.
 */
export type PluginDisposer = () => void | Promise<void>;

/**
 * Accepted effect body forms — the kernel's Cordis 4.0.1 `Effect`, not a
 * subset: a disposer, an iterable producing several, or either async form.
 * Freezing less would force `apiVersion 2` on the first plugin that releases
 * an asynchronous resource.
 */
export type PluginSyncEffect = PluginDisposer | Iterable<PluginDisposer, void, void>;
export type PluginAsyncEffect = Promise<PluginDisposer> | AsyncIterable<PluginDisposer, void, void>;
export type PluginEffect = PluginSyncEffect | PluginAsyncEffect;

/** Return value of `effect()`: calling the disposer removes the effect and
 *  returns a promise settled when all disposers have finished. */
export type PluginEffectHandle = () => Promise<void>;

/** Async effect variant: the handle is also awaitable and yields the disposer
 *  once the effect body has been established. */
export type PluginAsyncEffectHandle = PluginEffectHandle & PromiseLike<PluginEffectHandle>;
