
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginUiDocuments

> **PluginUiDocuments** = `object`

## Methods

### create()

> **create**(`input`): `Promise`\<[`PluginOwnUiDocument`](PluginOwnUiDocument.md)\>

#### Parameters

##### input

[`PluginUiDocumentInput`](PluginUiDocumentInput.md)

#### Returns

`Promise`\<[`PluginOwnUiDocument`](PluginOwnUiDocument.md)\>

***

### dismiss()

> **dismiss**(`id`): `Promise`\<[`PluginOwnUiDocument`](PluginOwnUiDocument.md) \| `undefined`\>

#### Parameters

##### id

`string`

#### Returns

`Promise`\<[`PluginOwnUiDocument`](PluginOwnUiDocument.md) \| `undefined`\>

***

### findByRef()

> **findByRef**(`provider`, `ref`): `Promise`\<[`PluginOwnUiDocument`](PluginOwnUiDocument.md) \| `undefined`\>

#### Parameters

##### provider

`string`

##### ref

`string`

#### Returns

`Promise`\<[`PluginOwnUiDocument`](PluginOwnUiDocument.md) \| `undefined`\>

***

### get()

> **get**(`id`): `Promise`\<`Readonly`\<`Omit`\<`UiDocumentView`, `"reply"`\>\> \| [`PluginOwnUiDocument`](PluginOwnUiDocument.md) \| `undefined`\>

#### Parameters

##### id

`string`

#### Returns

`Promise`\<`Readonly`\<`Omit`\<`UiDocumentView`, `"reply"`\>\> \| [`PluginOwnUiDocument`](PluginOwnUiDocument.md) \| `undefined`\>

***

### list()

> **list**(`filter?`): `Promise`\<(`Readonly`\<`Omit`\<`UiDocumentView`, `"reply"`\>\> \| [`PluginOwnUiDocument`](PluginOwnUiDocument.md))[]\>

#### Parameters

##### filter?

###### limit?

`number`

###### missionId?

`string`

###### status?

`UiDocumentStatus`

#### Returns

`Promise`\<(`Readonly`\<`Omit`\<`UiDocumentView`, `"reply"`\>\> \| [`PluginOwnUiDocument`](PluginOwnUiDocument.md))[]\>
