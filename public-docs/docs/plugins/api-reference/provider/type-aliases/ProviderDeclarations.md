
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProviderDeclarations

> **ProviderDeclarations** = `object`

## Properties

### accounts?

> `readonly` `optional` **accounts?**: [`ProviderAccountsDeclaration`](ProviderAccountsDeclaration.md)

***

### binary?

> `readonly` `optional` **binary?**: [`ProviderBinaryDeclaration`](ProviderBinaryDeclaration.md)

***

### brand?

> `readonly` `optional` **brand?**: [`ProviderBrand`](ProviderBrand.md)

***

### browserToolsHint?

> `readonly` `optional` **browserToolsHint?**: `string`

***

### capabilities?

> `readonly` `optional` **capabilities?**: `Partial`\<[`BackendCapabilities`](BackendCapabilities.md)\>

***

### credentialDirEnv?

> `readonly` `optional` **credentialDirEnv?**: readonly `string`[]

***

### credentialDirs?

> `readonly` `optional` **credentialDirs?**: readonly `string`[]

***

### hostedConnectors?

> `readonly` `optional` **hostedConnectors?**: `boolean`

***

### localEnv?

> `readonly` `optional` **localEnv?**: [`LocalEnvPolicy`](LocalEnvPolicy.md)

***

### modelCache?

> `readonly` `optional` **modelCache?**: `ProviderModelCache`

***

### oneShot?

> `readonly` `optional` **oneShot?**: `object`

#### model

> `readonly` **model**: `string`

***

### passthroughEnv?

> `readonly` `optional` **passthroughEnv?**: readonly `string`[]

***

### permissionsHint?

> `readonly` `optional` **permissionsHint?**: `string`

***

### protocols?

> `readonly` `optional` **protocols?**: readonly `ProviderProtocol`[]

***

### spans?

> `readonly` `optional` **spans?**: `"stream-json"` \| ((`ev`, `state`, `eventId`) => [`SpanOp`](SpanOp.md)[])

***

### unverified?

> `readonly` `optional` **unverified?**: readonly [`ProviderUnverified`](ProviderUnverified.md)[]

## Methods

### authStatus()?

> `optional` **authStatus**(`env`): [`ProviderAuthStatus`](ProviderAuthStatus.md) \| `Promise`\<[`ProviderAuthStatus`](ProviderAuthStatus.md)\>

#### Parameters

##### env

`Readonly`\<`Record`\<`string`, `string`\>\>

#### Returns

[`ProviderAuthStatus`](ProviderAuthStatus.md) \| `Promise`\<[`ProviderAuthStatus`](ProviderAuthStatus.md)\>
