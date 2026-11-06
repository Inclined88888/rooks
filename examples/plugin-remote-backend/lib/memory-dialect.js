/**
 * Minimal remote dialect: the "agent" lives in memory, so the template runs
 * with no network and no server. A real plugin keeps this shape and replaces
 * each marked step with a call to its agent's API through ctx.fetch (declare
 * `http:outbound`; the operator allows the host in `pluginPolicy.http`).
 *
 * A remote dialect spawns nothing: no defaultCmd, no buildSpawn, no
 * parseLine. The daemon opens one session per mission launch and drives it
 * like any other mission (stop button, reaper, permissions, mission return).
 */
import { randomUUID } from 'node:crypto'

/**
 * The fictitious agent's server. It lives at module level, so a session
 * outlives the driver that opened it — as a real server's session outlives a
 * daemon restart. Each session keeps a numbered event log: a driver that
 * reconnects asks for what follows the last number it saw.
 */
const sessions = new Map()

function serverSession(sessionId) {
  let session = sessions.get(sessionId)
  if (!session) {
    session = { id: sessionId, log: [], turn: null, listener: null }
    sessions.set(sessionId, session)
  }
  return session
}


const CAPABILITIES = { loadSession: false, resume: true, mcp: false, image: false }

/**
 * Builds the dialect from the daemon's runtime: `createMemoryDialect(ctx.provider.runtime)`
 * in `apply(ctx)`, the same object from `createProviderContext()` in a test.
 *
 * @param {import('@timon-ai/sdk/provider').ProviderRuntime} runtime
 * @returns {import('@timon-ai/sdk/provider').RemoteDialect}
 */
export function createMemoryDialect(runtime) {
  const { events } = runtime

  const initEvent = (sessionId) => events.systemInitEvent({ sessionId })

  const assistantEvent = (text) => events.assistantTextEvent(text, randomUUID())

  /** A turn that ended. The factory knows `success` and `error`; a cancellation is
   *  a success that says it stopped early. */
  function resultEvent(stopReason, text) {
    const base = events.resultSuccessEvent()
    return {
      type: 'result',
      payload: {
        ...(/** @type {Record<string, unknown>} */ (base.payload)),
        ...(stopReason === 'cancelled' ? { subtype: 'cancelled' } : {}),
        ...(text ? { result: text } : {}),
        stop_reason: stopReason,
      },
    }
  }

  /** Server side: log an event and push it to the connected driver, if any. */
  function publish(session, event) {
    const entry = { seq: session.log.length + 1, event }
    session.log.push(entry)
    session.listener?.(entry)
  }

  /** Server side: the turn runs whether or not a driver is connected. */
  function runTurn(session, text, delay) {
    session.turn = setTimeout(() => {
      session.turn = null
      const reply = `Echo: ${text}`
      publish(session, assistantEvent(reply))
      publish(session, resultEvent('end_turn', reply))
    }, delay)
  }

  function stopTurn(session) {
    if (!session.turn) return false
    clearTimeout(session.turn)
    session.turn = null
    publish(session, resultEvent('cancelled'))
    return true
  }

  /**
   * The driver of one session. `env` is the profile's environment, resolved for
   * this launch: a real driver reads its address and key from it. `resume` is
   * there only when the daemon restarted under a live mission: the state this
   * driver saved with host.saveResume, and whether a turn was running.
   *
   * The fictitious agent replies `Echo: <message>` after a short delay. A few
   * variables make it misbehave on purpose, the way a real server can:
   *   MEMORY_AGENT_DELAY_MS     time before each reply (default 10)
   *   MEMORY_AGENT_FAIL         'start' refuses the handshake, 'prompt' drops the turn
   *   MEMORY_AGENT_END_AFTER    after this many turns the agent closes the session…
   *   MEMORY_AGENT_END          …this way: 'completed' (default), 'failed' or 'cancelled'
   *
   * @param {import('@timon-ai/sdk/provider').RemoteSessionOpenArgs} args
   */
  function createDriver({ spawn, host, env, resume }) {
    const delay = Number(env.MEMORY_AGENT_DELAY_MS ?? 10)
    const endAfter = Number(env.MEMORY_AGENT_END_AFTER ?? 0)
    let info = null
    let closed = false
    let turns = 0
    let session = null
    /** The prompt in flight, settled when its result comes back. */
    let current = null

    /** What the server pushes: into the thread, then into the resume state. */
    const deliver = (entry) => {
      if (closed) return
      host.emit(entry.event)
      // Right after the emit: a daemon restarted from here resumes after it.
      // Never the key: it comes back from env at every launch.
      host.saveResume({ sessionId: session.id, lastSeq: entry.seq })
      if (entry.event.type !== 'result') return
      const stopReason = entry.event.payload.stop_reason
      const settle = current
      current = null
      settle?.resolve({ stopReason })
      if (stopReason !== 'end_turn') return
      turns += 1
      if (endAfter > 0 && turns >= endAfter) {
        const reason = /** @type {'completed' | 'failed' | 'cancelled'} */ (env.MEMORY_AGENT_END ?? 'completed')
        setTimeout(() => {
          if (closed) return
          host.end(reason === 'failed'
            ? { reason, message: 'the agent closed the session for maintenance' }
            : { reason })
        }, 0)
      }
    }

    return {
      get info() { return info },

      async start() {
        // Real driver: authenticate and open (or reopen) the remote session here,
        // never in openSession. A rejection is shown in the mission's thread.
        if (env.MEMORY_AGENT_FAIL === 'start') throw new Error('the agent refused the API key')
        if (resume) {
          // Real driver: reconnect to the run the saved state names, and ask
          // for the events after lastSeq — the `result` of a turn that ended
          // while the daemon was down included.
          const known = typeof resume.state.sessionId === 'string' ? sessions.get(resume.state.sessionId) : undefined
          if (!known) throw new Error('the agent no longer knows this session')
          session = known
          const lastSeq = Number(resume.state.lastSeq) || 0
          info = { sessionId: session.id, capabilities: CAPABILITIES, resumed: true }
          // Takes over from the driver of the daemon that died.
          session.listener = deliver
          for (const entry of session.log.slice(lastSeq)) deliver(entry)
          return info
        }
        session = serverSession(spawn.resumeSession ?? `memory-${randomUUID()}`)
        session.listener = deliver
        info = { sessionId: session.id, capabilities: CAPABILITIES, resumed: Boolean(spawn.resumeSession) }
        // Real driver: send spawn.systemPrompt with the session request.
        host.emit(initEvent(session.id))
        // From now on a restarted daemon can find this session again, even in
        // the middle of the first turn.
        host.saveResume({ sessionId: session.id, lastSeq: session.log.length })
        return info
      },

      prompt(text) {
        if (closed) return Promise.reject(new Error('the session is closed'))
        if (!info) return Promise.reject(new Error('the session is not started'))
        if (current || session.turn) return Promise.reject(new Error('a turn is already running'))
        return new Promise((resolve, reject) => {
          const turn = { resolve, reject }
          current = turn
          if (env.MEMORY_AGENT_FAIL === 'prompt') {
            setTimeout(() => {
              if (current !== turn) return
              current = null
              reject(new Error('the agent dropped the turn (HTTP 502)'))
            }, delay)
            return
          }
          // Real driver: post the message; the events come back on the stream
          // (SSE, WebSocket) and go through deliver, the result last.
          runTurn(session, text, delay)
        })
      },

      async cancel() {
        // Real driver: ask the server to stop the run, then let its stream end.
        if (session && stopTurn(session)) return
        if (!current) return
        const { resolve } = current
        current = null
        host.emit(resultEvent('cancelled'))
        resolve({ stopReason: 'cancelled' })
      },

      close() {
        // Real driver: abort the open requests and cancel the remote run — a
        // close is a stop. A daemon that dies closes nothing, which is what
        // lets the next one reattach. Nothing is emitted afterwards.
        if (closed) return
        closed = true
        if (session && session.listener === deliver) {
          session.listener = null
          if (session.turn) clearTimeout(session.turn)
          sessions.delete(session.id)
        }
        if (current) {
          current.reject(new Error('the session was closed'))
          current = null
        }
      },
    }
  }

  /** @type {import('@timon-ai/sdk/provider').RemoteDialect} */
  const memoryDialect = {
    id: 'memory-remote',
    /** No process: the session is all there is. */
    transport: 'remote',
    /** A session id given back reopens the conversation. */
    sessionResumable: true,
    sessionStore: 'global',
    /** This fictitious agent runs no tools, so it asks nothing. A real agent
     *  that asks should declare 'protocol' and call host.requestPermission. */
    permissionModel: 'none',
    rateLimitReporting: 'none',
    hostedConnectors: false,

    openSession(args) {
      return createDriver(args)
    },

    extractSessionId: events.extractInitSessionId,
  }

  return memoryDialect
}
