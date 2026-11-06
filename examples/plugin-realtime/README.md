# Owner-only realtime counter (API 4)

This ready-to-load ESM example uses only the plugin SDK facades. Install this
folder with `timon plugin add ./examples/plugin-realtime` from the repository
root in developer mode. No build or additional dependency is needed.

Open the widget in two tabs signed in as the same account. Clicking Increment
calls the authenticated `POST /increment` route, publishes `changed` to that
account and reloads `GET /count` in both tabs. Another account, even a
superadmin, receives no signal and has its own counter. Anonymous requests
receive 401. The route takes no input or owner id from the browser.

The counter is deliberately in memory and resets on unload. The widget
subscribes before its initial read, groups bursts with a 100 ms debounce and
unsubscribes on unmount; the loader also cleans up on plugin disposal. Realtime
signals are invalidations, not durable delivery: reload on mount and fetch
current state through the authenticated API. This example uses English UI
strings for brevity; a published plugin should provide its own translations.
