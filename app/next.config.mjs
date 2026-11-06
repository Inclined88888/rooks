/** Staging dir for `timon-dev rebuild --app`: the live `.next` stays up
 *  until the new build has written prerender-manifest.json. Relative only —
 *  Next refuses an absolute `distDir`. */
const distDir = process.env.NEXT_DIST_DIR || '.next';

/**
 * Writes `<distDir>/bundle-modules.json`: for each client chunk file, the
 * modules it carries, their source size and their static importers. Built
 * from webpack's own chunk graph — no analyzer dependency to ship or audit
 * for one diagnostic.
 */
class BundleModulesPlugin {
  apply(compiler) {
    // Importers are read before optimization: module concatenation drops the
    // connections inside a concatenated group, which hid most of the graph.
    const importers = new Map();
    compiler.hooks.compilation.tap('BundleModulesPlugin', (compilation) => {
      compilation.hooks.finishModules.tap('BundleModulesPlugin', (modules) => {
        for (const m of modules) {
          const from = new Set();
          for (const c of compilation.moduleGraph.getIncomingConnections(m)) {
            // Static importers only: an `import()`, and the weak
            // `require.resolveWeak` next/dynamic adds next to it, are exactly
            // what does NOT hold a module in a chunk.
            if (c.originModule && c.dependency?.type !== 'import()' && !c.dependency?.weak) from.add(c.originModule);
          }
          importers.set(m, from);
        }
      });
    });
    compiler.hooks.afterEmit.tapPromise('BundleModulesPlugin', async (compilation) => {
      const { writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const name = (m) => m.readableIdentifier(compilation.requestShortener).replace(/^.*!/, '');
      const out = {};
      for (const chunk of compilation.chunks) {
        const modules = [];
        for (const m of compilation.chunkGraph.getChunkModulesIterable(chunk)) {
          // A concatenated module hides its parts: list them, not the wrapper.
          for (const inner of m.modules ?? [m]) {
            const from = [...(importers.get(inner) ?? [])].map(name);
            modules.push({ name: name(inner), size: inner.size(), importers: from });
          }
        }
        for (const file of chunk.files) if (file.endsWith('.js')) out[file] = modules;
      }
      await writeFile(join(compiler.outputPath, 'bundle-modules.json'), JSON.stringify(out));
    });
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir,
  // Desktop packages only (the release build's `buildPlan` sets it): the
  // traced `.next/standalone` carries ~3 000 files where the full
  // `node_modules` carried 25 000, each scanned by Windows Defender at
  // install time. A checkout and the Docker image keep the regular build.
  ...(process.env.TIMON_NEXT_STANDALONE === '1' ? { output: 'standalone' } : {}),
  // No automatic 308 on URLs with a trailing slash.
  //
  // Next answers `308 Permanent Redirect` to `/path/` to send it to `/path`.
  // On the cockpit, that POISONS the browser stream: when a project's
  // container is stopped, its Traefik router no longer exists and
  // `/browser/<slug>/` falls back here, where Next sends a 308 to
  // `/browser/<slug>`. Chrome caches 308s PERMANENTLY. When the container
  // restarts, Traefik redirects `/browser/<slug>` (no slash) to
  // `/browser/<slug>/` with a 302 — and the browser replays its cached 308:
  // infinite loop, ERR_TOO_MANY_REDIRECTS, immune to rebuilds and reboots
  // since the loop lives in the client's cache.
  // Without this normalization, an orphan URL answers 404: nothing to cache,
  // nothing to poison. No internal link uses a trailing slash.
  skipTrailingSlashRedirect: true,
  // The middleware's `Location` goes out exactly as written (step 5.9.6).
  //
  // Without this, the middleware adapter reparses our header into a `NextURL`
  // and, when the host equals the request's, rewrites `Location` with the
  // normalized form — and `parseURL()` folds `127.0.0.1` and `[::1]` back into
  // `localhost` (`next-url.js:15`). A browser sitting on `127.0.0.1:3110` thus
  // changed origin on every login redirect: that is the IPv4/IPv6 loop of step
  // 5.9.1. This flag skips that rewrite (`adapter.js:251`).
  // No side effect here: the normalization it also disables covers the
  // `buildId` and locale of `/_next/data/...` URLs, which only exist in the
  // Pages Router — this app is App Router throughout, with no routing i18n.
  skipMiddlewareUrlNormalize: true,
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3'],
    externalDir: true,
  },
  // No redirect on `/` any more: the root serves the cockpit ((main)/page.tsx).
  // The redirect lived here because an old `src/app/page.tsx` only did
  // `redirect('/agents')` and its static prerender ended up baked into the
  // image as a 307 without Location — the PWA (start_url '/') opened blank.
  // The root now renders a real page, so the original cause is gone.
  webpack(config, { isServer }) {
    // graphology/sigma UMD: CommonJS, not ESM. Without this webpack 5 parses
    // them as modules and `this` is no longer `module.exports`.
    config.module.rules.push({
      test: /vendor\/vault-graph\/(graphology\.umd\.min|sigma\.min)\.js$/,
      type: 'javascript/auto',
    });
    // `scripts/measure-bundle.mjs --modules` reads this to say WHAT a chunk
    // carries. Opt-in: a regular build writes nothing more.
    if (!isServer && process.env.TIMON_BUNDLE_STATS === '1') config.plugins.push(new BundleModulesPlugin());
    return config;
  },
};
export default nextConfig;
