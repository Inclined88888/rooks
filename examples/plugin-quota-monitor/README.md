# plugin-quota-monitor

The product's LLM quota monitor, written **entirely with the SDK**. Guide:
[UI kit, Reading usage](../../public-docs/docs/plugins/ui-kit.md#reading-usage); compatibility rules:
[Manifest](../../public-docs/docs/plugins/manifest.md).

It is the **proof of the open-core contract**: this feature first shipped as a
bundled module (a daemon route, a catalogue entry, an aggregator in
`usage.ts`), which a community author could not have reproduced. It is now an
ordinary package: if something were missing from the SDK, this file would not
compile.

## Two surfaces, one identity

| Slot | What it shows |
|---|---|
| `cockpit.widget` | **one** widget that takes the shape of its zone: in a compact zone, its rings (side by side on the top bar's row, `topbar.widget`, where it starts; stacked in a sidebar) and, on click, the details in the platform's anchored popover (`AnchoredPopover`); in a wide zone (cockpit, chat column), the tile |
| `settings.section` | a settings category: visible providers, thresholds |

The registration carries `bar: true` (admitted on the bar's row),
`placedByDefault` (placed in the bar on every view, even a layout saved
before) and `formerKeys: ['']` (the earlier tile, with no key, gives way if the
user had placed it). The component reads `compact` and `orientation` from its
props.

## Capabilities used

- `usage:read`: `ctx.usage.list()`, one `UsageEntry` per active backend,
  never exposing a token or a path;
- `storage`: 90 days of history in `ctx.storage.kv`, one 15-minute slice per
  backend, purged beyond the retention;
- `settings`: thresholds, hidden providers and retention, declared in the
  manifest and editable from `/settings` as well as from the plugin's
  category.

The plugin's own routes (`ctx.router()`, mounted on
`/api/plugins/quota-monitor/`): `/all`, `/history`, `/providers`.

## Try it

```bash
TIMON_HOME=$(mktemp -d) timon plugin add ./examples/plugin-quota-monitor
```

The package has **no build step**: native ESM, with React and `@timon/ui`
imported from the platform (never bundled).
