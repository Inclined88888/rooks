
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginBusinessEvents

> **PluginBusinessEvents** = `object`

## Methods

### publish()

> **publish**(`type`, `input`, `options?`): `Promise`\<`string`[]\>

#### Parameters

##### type

`string`

##### input

[`PluginBusinessEventInput`](PluginBusinessEventInput.md)

##### options?

###### connectionId?

`string`

#### Returns

`Promise`\<`string`[]\>

***

### register()

> **register**(`definition`): () => `void`

#### Parameters

##### definition

[`PluginBusinessEventDefinition`](PluginBusinessEventDefinition.md)

#### Returns

() => `void`
