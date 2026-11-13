
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginStorage

> **PluginStorage** = `object`

## Properties

### dir

> `readonly` **dir**: `string`

***

### kv

> **kv**: `object`

#### del()

> **del**(`key`): `Promise`\<`void`\>

##### Parameters

###### key

`string`

##### Returns

`Promise`\<`void`\>

#### get()

> **get**\<`T`\>(`key`): `Promise`\<`T` \| `undefined`\>

##### Type Parameters

###### T

`T` = `unknown`

##### Parameters

###### key

`string`

##### Returns

`Promise`\<`T` \| `undefined`\>

#### list()

> **list**(`prefix?`): `Promise`\<`object`[]\>

##### Parameters

###### prefix?

`string`

##### Returns

`Promise`\<`object`[]\>

#### set()

> **set**(`key`, `value`): `Promise`\<`void`\>

##### Parameters

###### key

`string`

###### value

`unknown`

##### Returns

`Promise`\<`void`\>
