
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProviderConversation

> **ProviderConversation** = `object`

## Properties

### cwd

> `readonly` **cwd**: `string`

***

### exited

> `readonly` **exited**: `Promise`\<\{ `code`: `number` \| `null`; `signal`: `NodeJS.Signals` \| `null`; \}\>

***

### pid

> `readonly` **pid**: `number` \| `null`

## Methods

### onData()

> **onData**(`listener`): () => `void`

#### Parameters

##### listener

(`chunk`) => `void`

#### Returns

() => `void`

***

### stderr()

> **stderr**(): `string`

#### Returns

`string`

***

### stop()

> **stop**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### write()

> **write**(`data`): `void`

#### Parameters

##### data

`string` \| `Uint8Array`\<`ArrayBufferLike`\>

#### Returns

`void`
