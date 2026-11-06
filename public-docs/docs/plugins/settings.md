---
title: Settings
sidebar_position: 12
---

Plugin settings are part of the manifest and do not require a new plugin kind. A settings-only extension can be `behavior`.

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
<TabItem value="auto" label="Generated form">

Declare `timon.settings` entries with `key`, `type`, `label` and optional `default`. Supported types are `string`, `number`, `boolean` and `secret`. No browser code is needed. Timon creates a tab for the plugin under **Plugins** and renders a form, saving through the plugin settings endpoint. The host reads values with `ctx.settings.get(key)` and the `settings` permission.

</TabItem>
<TabItem value="graft" label="Existing category">

Declare an exact slot such as `settings.missions` and register a row or block. It appears after the product's fields in the tab that holds that group. It is not a widget card and needs no drag handle or surrounding tile.

</TabItem>
<TabItem value="custom" label="Custom category">

Declare `settings.section` and register your pane component. The slot is keyed by plugin ID, and the pane becomes a tab under **Plugins**. Its tab label comes from `timon.label`, falling back to the ID. A custom pane can declare a child slot such as `settings.acme`, but must render that slot itself.

</TabItem>
</Tabs>

When both a custom category and manifest fields exist, the custom occupant wins: one tab, not duplicate forms. A disabled plugin loses its registration and its tab. The client settings API exposes asynchronous `get()` and `set(key, value)`; host settings reads and browser settings reads have different signatures.

## Native settings slots

| Group | Exact slot |
| --- | --- |
| Missions | `settings.missions` |
| LLM fallback | `settings.llmfallback` |
| Resources | `settings.resources` |
| Reaper | `settings.reaper` |
| Worktrees | `settings.worktrees` |
| Permissions | `settings.permissions` |
| Wake | `settings.wake` |
| Memory injection | `settings.memoryinjection` |
| Memory capture | `settings.memorycapture` |
| Memory synthesis | `settings.memorysynthesis` |
| Memory promotion | `settings.memorypromotion` |
| Global digest | `settings.digest` |
| Scoring | `settings.scoring` |
| Dreaming | `settings.dreaming` |
| Terminal | `settings.terminal` |
| Misc | `settings.misc` |
| Infra | `settings.infra` |
| Backlog | `settings.backlog` |
| Voice dictation (Interface) | `settings.voice` |
| Backup (System › Backups & trash) | `settings.backup` |
| Agent trash (System › Backups & trash) | `settings.agenttrash` |
| Push | `settings.notifications` |

Do not generate a slot name from its translated label: `settings.llmfallback` has no hyphen. Admission remains exact for each group. A deep link opens the Settings dialog over any page with `?settings=plugins/<plugin id>` (URL-encoded); older `/settings?group=<plugin id>` links still redirect there. See [Secrets](secrets.md) before handling secret fields.
