
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProviderServices

> **ProviderServices** = `object`

## Properties

### account

> `readonly` **account**: [`ProviderAccount`](ProviderAccount.md)

***

### binary

> `readonly` **binary**: [`ProviderBinary`](ProviderBinary.md)

***

### git

> `readonly` **git**: [`ProviderGit`](ProviderGit.md)

***

### media

> `readonly` **media**: [`ProviderMedia`](ProviderMedia.md)

***

### osCredentials

> `readonly` **osCredentials**: [`ProviderOsCredentials`](ProviderOsCredentials.md)

***

### redact

> `readonly` **redact**: [`ProviderRedact`](ProviderRedact.md)

***

### runtime

> `readonly` **runtime**: [`ProviderRuntime`](ProviderRuntime.md)

***

### scratch

> `readonly` **scratch**: [`ProviderScratch`](ProviderScratch.md)

## Methods

### credentialStore()

> **credentialStore**(`spec`): [`ProviderCredentialStore`](ProviderCredentialStore.md)

#### Parameters

##### spec

###### key

`string`

###### marker

`string`

###### store

`string`

#### Returns

[`ProviderCredentialStore`](ProviderCredentialStore.md)

***

### env()

> **env**(`spawn`): `Promise`\<[`ProviderEnvPlan`](ProviderEnvPlan.md)\>

#### Parameters

##### spawn

[`BuildSpawnOpts`](BuildSpawnOpts.md)

#### Returns

`Promise`\<[`ProviderEnvPlan`](ProviderEnvPlan.md)\>

***

### mcp()

> **mcp**(`spawn`, `options?`): `Promise`\<[`ProviderMcpPlan`](ProviderMcpPlan.md)\>

#### Parameters

##### spawn

[`BuildSpawnOpts`](BuildSpawnOpts.md)

##### options?

[`ProviderMcpOptions`](ProviderMcpOptions.md)

#### Returns

`Promise`\<[`ProviderMcpPlan`](ProviderMcpPlan.md)\>

***

### modelReasoning()

> **modelReasoning**(`profile`, `model`): `Promise`\<[`ModelReasoning`](ModelReasoning.md) \| `undefined`\>

#### Parameters

##### profile

[`ProfileRuntime`](ProfileRuntime.md)

##### model

`string` \| `undefined`

#### Returns

`Promise`\<[`ModelReasoning`](ModelReasoning.md) \| `undefined`\>

***

### registerProductProfile()

> **registerProductProfile**(`profile`): () => `void`

#### Parameters

##### profile

[`BackendProfile`](BackendProfile.md)

#### Returns

() => `void`

***

### registerProvider()

> **registerProvider**(`definition`): () => `void`

#### Parameters

##### definition

[`NativeProviderDefinition`](NativeProviderDefinition.md)

#### Returns

() => `void`

***

### replaceProvider()

> **replaceProvider**(`definition`): () => `void`

#### Parameters

##### definition

[`NativeProviderDefinition`](NativeProviderDefinition.md)

#### Returns

() => `void`
