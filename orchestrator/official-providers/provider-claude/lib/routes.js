/** Preserve the write-only token endpoint used by the CLI and Settings. */
export function registerClaudeTokenRoutes(ctx, token, usage) {
  function install(router, path) {
    const status = () => ({ ...token.claudeTokenStatus(), serviceOutsideSession: process.env.ROOKS_SERVICE_KIND === 'launchd-system' });
    // No anonymous first-run exemption, no browser fallback to the daemon identity.
    router.use((req, res, next) => {
      if (!req.auth) return void res.status(401).json({ error: 'unauthorized' });
      if (!req.auth.isSuperadmin) return void res.status(403).json({ error: 'forbidden' });
      next();
    });
    router.get(path, (_req, res) => res.json(status()));
    router.put(path, (req, res) => {
      const raw = token.parseBody(req.body);
      if (raw === null) return void res.status(400).json({ error: 'expected {"token": "<value printed by claude setup-token>"}' });
      try { token.setClaudeToken(raw); }
      catch (e) {
        return void res.status(e.code === 'invalid' ? 400 : 503).json({ error: e.code === 'invalid' ? e.message : 'The secrets vault is unavailable; the token was not saved.', code: e.code });
      }
      usage.resetClaudeUsageCache();
      res.json(status());
    });
    router.delete(path, (_req, res) => {
      token.clearClaudeToken();
      usage.resetClaudeUsageCache();
      res.json(status());
    });
  }
  install(ctx.router('/api/backends/claude-token'), '/');
  install(ctx.router(), '/token');
}
