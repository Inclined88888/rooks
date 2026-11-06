// @ts-check
/**
 * Minimal dialect for a fictitious JSON-lines CLI named echo, not the OS
 * echo command. Use a profile instead when an existing CLI speaks the protocol.
 * The daemon launches the process, checks pluginPolicy.exec.allow, and removes
 * registrations on unload. This example is covered by the product's internal
 * conformance tests; the public provider guide describes those checks.
 *
 * The dialect is built FROM the daemon's runtime (`ctx.provider.runtime`, API 12)
 * instead of carrying its own codecs: the event vocabulary, the JSON-lines
 * reader and the session-id rule are the daemon's, so a fix to one reaches this
 * plugin without a new release.
 */

/**
 * @param {import('@timon-ai/sdk/provider').ProviderRuntime} runtime `ctx.provider.runtime`, or
 *   the copy `createProviderContext()` carries in a test.
 * @returns {import('@timon-ai/sdk/provider').Dialect}
 */
export function createEchoDialect(runtime) {
  const { events, jsonLines } = runtime

  return {
    id: 'echo',
    /** Default executable, checked against pluginPolicy.exec.allow. */
    defaultCmd: 'echo',
    /** One process per turn. */
    persistentProcess: false,
    /** The mission must survive each process exit. */
    finishMissionOnExit: false,
    sessionResumable: true,
    sessionStore: 'global',
    /** This fictitious CLI does not arbitrate tool calls. */
    permissionModel: 'none',
    /** Its stream carries no usage-limit signal. */
    rateLimitReporting: 'none',
    hostedConnectors: false,
    /** Prompts travel in argv, so advertise the supported byte limit. */
    maxPromptBytes: 100_000,

    async buildSpawn(opts, profile) {
      const args = ['--model', opts.cfg.model ?? 'echo-1', '--system', opts.systemPrompt]
      if (opts.resumeSession) args.push('--resume', opts.resumeSession)
      args.push(opts.message)
      return {
        cmd: profile.cmd,
        args,
        // Use the resolved profile environment, never process.env.
        env: { ...profile.env },
        cwd: opts.cfg.cwd,
        initialStdin: null,
      }
    },

    /** One-shot: the next turn starts a new process. */
    writeUserInput() { /* noop */ },

    /**
     * Normalize CLI lines into system / assistant / result events. A line that is
     * not a JSON object is dropped instead of throwing and killing the mission.
     */
    parseLine(line) {
      const row = jsonLines.parseJsonObjectLine(line)
      if (!row) return []
      if (row.type === 'init') return [events.systemInitEvent({ sessionId: String(row.session ?? '') })]
      if (row.type === 'text') return [events.assistantTextEvent(String(row.text ?? ''))]
      if (row.type === 'done') {
        return [row.error ? events.resultErrorEvent({ error: String(row.error) }) : events.resultSuccessEvent()]
      }
      return []
    },

    /** Only system:init carries a session ID; an empty string is no ID. */
    extractSessionId: events.extractInitSessionId,
  }
}
