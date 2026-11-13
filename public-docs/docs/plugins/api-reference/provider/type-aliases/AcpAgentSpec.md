
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: AcpAgentSpec

> **AcpAgentSpec** = `object`

## Properties

### args

> `readonly` **args**: readonly `string`[]

***

### authenticateWith?

> `readonly` `optional` **authenticateWith?**: `string`

***

### binary

> `readonly` **binary**: [`ProviderBinaryDeclaration`](ProviderBinaryDeclaration.md)

***

### declares?

> `readonly` `optional` **declares?**: `Omit`\<[`ProviderDeclarations`](ProviderDeclarations.md), `"binary"` \| `"spans"`\>

***

### extensionRequests?

> `readonly` `optional` **extensionRequests?**: `Readonly`\<`Record`\<`string`, [`AcpExtensionHandler`](AcpExtensionHandler.md)\>\>

***

### id

> `readonly` **id**: `string`

***

### modelProbe?

> `readonly` `optional` **modelProbe?**: `"session-new"`

***

### models?

> `readonly` `optional` **models?**: [`ModelsStrategy`](ModelsStrategy.md)

***

### oneShotEnv?

> `readonly` `optional` **oneShotEnv?**: `Readonly`\<`Record`\<`string`, `string`\>\>

***

### permissionsByAgent?

> `readonly` `optional` **permissionsByAgent?**: `boolean`

***

### signIn?

> `readonly` `optional` **signIn?**: [`AcpSignIn`](AcpSignIn.md)

## Methods

### env()?

> `optional` **env**(`spawn`): `Record`\<`string`, `string`\>

#### Parameters

##### spawn

[`BuildSpawnOpts`](BuildSpawnOpts.md)

#### Returns

`Record`\<`string`, `string`\>
