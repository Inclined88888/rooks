# Agent sync

This template creates one Timon agent per profile of an external system, and
refreshes them on the next call. It needs a single permission,
`agents:manage`, and `apiVersion: 7`.

Its browser half (or any signed-in client) calls
`POST /api/plugins/agent-sync-example/sync` with
`{ "profiles": [{ "id": "support", "prompt": "You answer support tickets." }] }`;
a job can call `syncAgents(ctx, profiles)` directly.

A profile may carry a `look` — the mascot drawn for the agent when it has no
picture: `{ "shape": "gem", "color": "#d4a373", "eyes": "happy", "acc": "loupe" }`
(`acc` optional). The lists are closed (`PluginAgentLook*` types of
`@timon-ai/sdk`): a value off them is refused with `invalid`, and the message
names the accepted values. `ctx.agents.list()` reads it back as `look`, or
`null` when none is set.

What the daemon guarantees, so the plugin does not have to:

- the call runs with the rights of the account that makes it: without
  `agents:manage` on that account, it is refused even though the plugin holds
  the permission. An anonymous call is refused;
- `create` never overwrites: a name already taken, in any case, is a
  `conflict`. `update` only reaches the agents this plugin created;
- the agents keep the mark `createdBy: "plugin:agent-sync-example"`.
  Uninstalling the plugin names them and deletes none.

`role` is required on creation (`research` here). An `orchestrator` can only be
created by a superadmin, and a non-superadmin is held to the same backend and
directory rules as in the Agents page.
