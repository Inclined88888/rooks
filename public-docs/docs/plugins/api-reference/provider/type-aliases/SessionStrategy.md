
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: SessionStrategy

> **SessionStrategy** = `object`

## Properties

### compact?

> `readonly` `optional` **compact?**: `object`

#### command

> `readonly` **command**: `string`

***

### maxPromptBytes?

> `readonly` `optional` **maxPromptBytes?**: `number`

***

### resumable

> `readonly` **resumable**: `boolean`

***

### store

> `readonly` **store**: [`SessionStore`](SessionStore.md)

## Methods

### notFound()?

> `optional` **notFound**(`stderr`): `boolean`

#### Parameters

##### stderr

`string`

#### Returns

`boolean`

***

### setModel()?

> `optional` **setModel**(`io`, `model`): `Promise`\<`boolean`\>

#### Parameters

##### io

[`SessionStdio`](SessionStdio.md)

##### model

`string`

#### Returns

`Promise`\<`boolean`\>
