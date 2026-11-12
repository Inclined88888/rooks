# Remote backend plugin

This template drives an agent that has **no local process**: a session driver
that a real plugin points at an HTTP or WebSocket API. The daemon runs the
mission exactly as it runs a CLI's — events in the thread, permission cards,
the stop button, the reaper, the mission's return — and spawns nothing.

It needs `apiVersion: 7` and the `backends:register` permission. No
`pluginPolicy.exec.allow` entry: there is no binary. A real driver reaches its
agent with `ctx.fetch`, so it also declares `http:outbound` and the operator
allows the host in `pluginPolicy.http.allow`.

The "agent" here lives in memory and answers `Echo: <message>`. It is a
protocol template, **not a working AI backend**.

## What the dialect provides

- `transport: 'remote'`, and no `defaultCmd`, `buildSpawn` or `parseLine`.
- `openSession({ spawn, host, env, profileId })` returns a `SessionDriver`:
  `start()` opens the remote session and emits `system:init`, `prompt()` runs a
  turn and emits its `assistant` and `result` events before resolving,
  `cancel()` stops the turn (it resolves with `cancelled`), `close()` aborts
  everything and emits nothing afterwards.
- `env` is the profile's environment, resolved at each launch: read the
  address and key there, never from `process.env`.
- `host.end({ reason })` says the session is over when no turn is running to
  carry the news: `completed`, `failed` (with a `message` the user reads) or
  `cancelled`.

- `host.saveResume({ sessionId, lastSeq })` after `start()` and after each
  event: when the daemon restarts, it reopens the mission with
  `resume: { state, turnActive }` and the driver replays what follows
  `lastSeq`. The template's "server" lives at module level so a session
  outlives its driver, as a real one outlives the daemon. Never put a key in
  that state.

The full contract is in [Write a provider](../../public-docs/docs/plugins/providers.md).
