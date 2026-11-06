
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginAccountProvider

> **PluginAccountProvider** = `object`

## Methods

### audit()

> **audit**(`action`, `target?`): `void`

#### Parameters

##### action

`string`

##### target?

`string` \| `null`

#### Returns

`void`

***

### auditLog()

> **auditLog**(`limit?`): [`PluginAuditEntry`](PluginAuditEntry.md)[]

#### Parameters

##### limit?

`number`

#### Returns

[`PluginAuditEntry`](PluginAuditEntry.md)[]

***

### findByEmail()

> **findByEmail**(`email`): [`PluginProviderAccount`](PluginProviderAccount.md) \| `undefined`

#### Parameters

##### email

`string`

#### Returns

[`PluginProviderAccount`](PluginProviderAccount.md) \| `undefined`

***

### get()

> **get**(`userId`): [`PluginProviderAccount`](PluginProviderAccount.md) \| `undefined`

#### Parameters

##### userId

`string`

#### Returns

[`PluginProviderAccount`](PluginProviderAccount.md) \| `undefined`

***

### list()

> **list**(): [`PluginProviderAccount`](PluginProviderAccount.md)[]

#### Returns

[`PluginProviderAccount`](PluginProviderAccount.md)[]

***

### onAccountChanged()

> **onAccountChanged**(`fn`): () => `void`

#### Parameters

##### fn

(`change`) => `void`

#### Returns

() => `void`

***

### openSession()

> **openSession**(`userId`, `req`, `res`): `void`

#### Parameters

##### userId

`string`

##### req

[`PluginSessionRequest`](PluginSessionRequest.md)

##### res

[`PluginSessionResponse`](PluginSessionResponse.md)

#### Returns

`void`

***

### provision()

> **provision**(`input`): [`PluginProvisionedAccount`](PluginProvisionedAccount.md)

#### Parameters

##### input

[`PluginProvisionInput`](PluginProvisionInput.md)

#### Returns

[`PluginProvisionedAccount`](PluginProvisionedAccount.md)

***

### readLegacy()

> **readLegacy**(`table`): `Record`\<`string`, `unknown`\>[]

#### Parameters

##### table

[`PluginLegacyAccountTable`](PluginLegacyAccountTable.md)

#### Returns

`Record`\<`string`, `unknown`\>[]

***

### update()

> **update**(`userId`, `patch`): [`PluginProviderAccount`](PluginProviderAccount.md)

#### Parameters

##### userId

`string`

##### patch

[`PluginProviderAccountPatch`](PluginProviderAccountPatch.md)

#### Returns

[`PluginProviderAccount`](PluginProviderAccount.md)
