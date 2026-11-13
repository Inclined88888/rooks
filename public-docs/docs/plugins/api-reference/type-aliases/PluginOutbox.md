
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginOutbox

> **PluginOutbox** = `object`

## Methods

### get()

> **get**(`id`): `Promise`\<[`PluginOutboxEntry`](PluginOutboxEntry.md) \| `undefined`\>

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`PluginOutboxEntry`](PluginOutboxEntry.md) \| `undefined`\>

***

### post()

> **post**(`target`, `body?`, `opts?`): `Promise`\<\{ `id`: `string`; \}\>

#### Parameters

##### target

[`PluginOutboxTarget`](PluginOutboxTarget.md)

##### body?

`unknown`

##### opts?

[`PluginOutboxOptions`](PluginOutboxOptions.md)

#### Returns

`Promise`\<\{ `id`: `string`; \}\>
