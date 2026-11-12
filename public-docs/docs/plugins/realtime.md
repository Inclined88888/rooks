---
title: Live updates
sidebar_position: 12.5
---

A plugin's browser half only knows what it fetched. When the data changes elsewhere — an agent calling your route, a background job, another tab — the host half can tell the browser half to reload. This channel is available from **API 4** and requires the **`realtime:publish`** permission.

```json
{
  "rooks": {
    "apiVersion": 4,
    "permissions": ["realtime:publish"]
  }
}
```

## Publish from the host

Call `ctx.realtime.publish(topic, payload, { ownerUserId })` **after** the change is saved, so a browser that reloads on the signal reads the new state.

```js
router.post('/items/:id/done', (request, response) => {
  const ownerUserId = ctx.user().id
  const item = markDone(ownerUserId, request.params.id)
  ctx.realtime.publish('item.changed', { id: item.id }, { ownerUserId })
  response.json({ item })
})
```

| Argument | Rule |
| --- | --- |
| `topic` | Matches `^[a-z0-9][a-z0-9._-]{0,63}$`. An invalid topic throws. |
| `payload` | JSON-serialisable, at most **16 KiB** once encoded as UTF-8. Secrets known to the vault are masked before delivery. |
| `ownerUserId` | Required. The account that owns the changed resource. |

Take the owner from the resource or from `ctx.user()` inside an authenticated route. Never accept an owner id sent by the browser.

## Subscribe from the browser

```js
export function apply(clientCtx) {
  function Items() {
    const [items, setItems] = React.useState([])
    React.useEffect(() => {
      let timer
      const reload = async () => {
        const response = await clientCtx.api('items', { cache: 'no-store' })
        if (response.ok) setItems((await response.json()).items)
      }
      const unsubscribe = clientCtx.realtime.subscribe('item.changed', () => {
        clearTimeout(timer)
        timer = setTimeout(() => { void reload() }, 100)
      })
      void reload()
      return () => { clearTimeout(timer); unsubscribe() }
    }, [])
    // render items…
  }
  return clientCtx.slots.register({ slot: 'cockpit.widget' }, Items)
}
```

- The handler receives the **payload** only.
- A plugin can only subscribe to **its own** topics. The platform prefixes every topic with your plugin ID; there is no way to listen to another plugin.
- The returned function unsubscribes. Call it on unmount; the loader also unsubscribes when the plugin is disabled.

## Who receives a signal

**Only the owner account**, on its own open tabs. There is no broadcast: another account receives nothing, and neither does an administrator who can read every account's data. A view that lists resources from several accounts therefore refreshes live only for the viewer's own resources; the others appear on the next load.

Between accounts, communication goes through agents, not through plugin signals.

## Design your signals as invalidations

- **Send an identifier, not the data.** Reload through your authenticated API, which applies the caller's permissions.
- **Read on mount.** The channel is not a durable queue: a tab that was closed or disconnected missed the signals sent meanwhile.
- **Group bursts.** An agent may change ten items in a second. Debounce the reload (100–150 ms) instead of issuing one request per signal.
- **Publish only on success.** A rejected write must not trigger a reload.

The [`plugin-realtime` example](examples.md#realtime) implements all of the above with an owner-scoped counter shared by the account's open tabs.
