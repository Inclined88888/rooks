
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Interface: SessionDriver

## Properties

### info

> `readonly` **info**: [`SessionInfo`](../type-aliases/SessionInfo.md) \| `null`

## Methods

### cancel()

> **cancel**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### close()

> **close**(): `void`

#### Returns

`void`

***

### prompt()

> **prompt**(`text`, `images?`): `Promise`\<[`TurnOutcome`](../type-aliases/TurnOutcome.md)\>

#### Parameters

##### text

`string`

##### images?

[`ImageAttachment`](../type-aliases/ImageAttachment.md)[]

#### Returns

`Promise`\<[`TurnOutcome`](../type-aliases/TurnOutcome.md)\>

***

### setModel()?

> `optional` **setModel**(`model`): `Promise`\<`boolean`\>

#### Parameters

##### model

`string`

#### Returns

`Promise`\<`boolean`\>

***

### start()

> **start**(): `Promise`\<[`SessionInfo`](../type-aliases/SessionInfo.md)\>

#### Returns

`Promise`\<[`SessionInfo`](../type-aliases/SessionInfo.md)\>

***

### steer()?

> `optional` **steer**(`text`): `Promise`\<`boolean`\>

#### Parameters

##### text

`string`

#### Returns

`Promise`\<`boolean`\>
