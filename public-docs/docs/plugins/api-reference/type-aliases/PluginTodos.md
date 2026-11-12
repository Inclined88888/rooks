
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginTodos

> **PluginTodos** = `object`

## Properties

### attachments

> **attachments**: `object`

#### add()

> **add**(`todoId`, `file`): `Promise`\<[`PluginTodoAttachment`](PluginTodoAttachment.md)\>

##### Parameters

###### todoId

`number`

###### file

[`PluginTodoAttachmentInput`](PluginTodoAttachmentInput.md)

##### Returns

`Promise`\<[`PluginTodoAttachment`](PluginTodoAttachment.md)\>

#### list()

> **list**(`todoId`): `Promise`\<[`PluginTodoAttachment`](PluginTodoAttachment.md)[]\>

##### Parameters

###### todoId

`number`

##### Returns

`Promise`\<[`PluginTodoAttachment`](PluginTodoAttachment.md)[]\>

#### read()

> **read**(`todoId`, `attachmentId`): `Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

##### Parameters

###### todoId

`number`

###### attachmentId

`string`

##### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

#### remove()

> **remove**(`todoId`, `attachmentId`): `Promise`\<`boolean`\>

##### Parameters

###### todoId

`number`

###### attachmentId

`string`

##### Returns

`Promise`\<`boolean`\>

***

### links

> **links**: `object`

#### findByRef()

> **findByRef**(`provider`, `ref`): `Promise`\<[`PluginTodo`](PluginTodo.md) \| `undefined`\>

##### Parameters

###### provider

`string`

###### ref

`string`

##### Returns

`Promise`\<[`PluginTodo`](PluginTodo.md) \| `undefined`\>

#### list()

> **list**(`todoId`): `Promise`\<[`PluginTodoLink`](PluginTodoLink.md)[]\>

##### Parameters

###### todoId

`number`

##### Returns

`Promise`\<[`PluginTodoLink`](PluginTodoLink.md)[]\>

#### remove()

> **remove**(`todoId`, `provider`, `ref`): `Promise`\<`boolean`\>

##### Parameters

###### todoId

`number`

###### provider

`string`

###### ref

`string`

##### Returns

`Promise`\<`boolean`\>

#### set()

> **set**(`todoId`, `link`): `Promise`\<[`PluginTodoLink`](PluginTodoLink.md)\>

##### Parameters

###### todoId

`number`

###### link

[`PluginTodoLinkInput`](PluginTodoLinkInput.md)

##### Returns

`Promise`\<[`PluginTodoLink`](PluginTodoLink.md)\>

## Methods

### close()

> **close**(`id`): `Promise`\<[`PluginTodo`](PluginTodo.md)\>

#### Parameters

##### id

`number`

#### Returns

`Promise`\<[`PluginTodo`](PluginTodo.md)\>

***

### create()

> **create**(`input`, `links?`): `Promise`\<\{ `created`: `boolean`; `item`: [`PluginTodo`](PluginTodo.md); \}\>

#### Parameters

##### input

[`PluginTodoInput`](PluginTodoInput.md)

##### links?

readonly [`PluginTodoLinkInput`](PluginTodoLinkInput.md)[]

#### Returns

`Promise`\<\{ `created`: `boolean`; `item`: [`PluginTodo`](PluginTodo.md); \}\>

***

### delete()

> **delete**(`id`): `Promise`\<`void`\>

#### Parameters

##### id

`number`

#### Returns

`Promise`\<`void`\>

***

### get()

> **get**(`id`): `Promise`\<[`PluginTodo`](PluginTodo.md) \| `undefined`\>

#### Parameters

##### id

`number`

#### Returns

`Promise`\<[`PluginTodo`](PluginTodo.md) \| `undefined`\>

***

### list()

> **list**(`filter?`): `Promise`\<[`PluginTodo`](PluginTodo.md)[]\>

#### Parameters

##### filter?

[`PluginTodoListFilter`](PluginTodoListFilter.md)

#### Returns

`Promise`\<[`PluginTodo`](PluginTodo.md)[]\>

***

### promote()

> **promote**(`id`, `input`): `Promise`\<\{ `item`: [`PluginTodo`](PluginTodo.md); `task`: `unknown`; \}\>

#### Parameters

##### id

`number`

##### input

[`PluginTodoPromoteInput`](PluginTodoPromoteInput.md)

#### Returns

`Promise`\<\{ `item`: [`PluginTodo`](PluginTodo.md); `task`: `unknown`; \}\>

***

### update()

> **update**(`id`, `patch`): `Promise`\<[`PluginTodo`](PluginTodo.md)\>

#### Parameters

##### id

`number`

##### patch

[`PluginTodoPatch`](PluginTodoPatch.md)

#### Returns

`Promise`\<[`PluginTodo`](PluginTodo.md)\>
