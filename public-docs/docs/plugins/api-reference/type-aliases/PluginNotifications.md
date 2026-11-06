
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginNotifications

> **PluginNotifications** = `object`

## Methods

### dismiss()

> **dismiss**(`id`): `Promise`\<`boolean`\>

#### Parameters

##### id

`string`

#### Returns

`Promise`\<`boolean`\>

***

### list()

> **list**(`filter?`): `Promise`\<`Readonly`\<\{ `agent`: `string` \| `null`; `anchor`: `string` \| `null`; `body`: `string` \| `null`; `createdAt`: `number`; `dismissedAt`: `number` \| `null`; `id`: `string`; `missionId`: `string` \| `null`; `readAt`: `number` \| `null`; `source`: `string` \| `null`; `taskId`: `string` \| `null`; `title`: `string`; `type`: `NotificationType`; `urgent`: `boolean`; \}\>[]\>

#### Parameters

##### filter?

[`PluginNotificationListFilter`](PluginNotificationListFilter.md)

#### Returns

`Promise`\<`Readonly`\<\{ `agent`: `string` \| `null`; `anchor`: `string` \| `null`; `body`: `string` \| `null`; `createdAt`: `number`; `dismissedAt`: `number` \| `null`; `id`: `string`; `missionId`: `string` \| `null`; `readAt`: `number` \| `null`; `source`: `string` \| `null`; `taskId`: `string` \| `null`; `title`: `string`; `type`: `NotificationType`; `urgent`: `boolean`; \}\>[]\>
