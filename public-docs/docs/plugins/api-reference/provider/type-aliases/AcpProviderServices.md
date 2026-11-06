
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: AcpProviderServices

> **AcpProviderServices** = `object`

## Properties

### binary?

> `readonly` `optional` **binary?**: `object`

#### converse()

> **converse**(`name`, `args`, `options?`): `Promise`\<`AcpConversation`\>

##### Parameters

###### name

`string`

###### args

readonly `string`[]

###### options?

###### env?

`Readonly`\<`Record`\<`string`, `string`\>\>

###### timeoutMs?

`number`

##### Returns

`Promise`\<`AcpConversation`\>

## Methods

### mcp()

> **mcp**(`spawn`, `options?`): `Promise`\<[`ProviderMcpPlan`](ProviderMcpPlan.md)\>

#### Parameters

##### spawn

[`BuildSpawnOpts`](BuildSpawnOpts.md)

##### options?

[`ProviderMcpOptions`](ProviderMcpOptions.md)

#### Returns

`Promise`\<[`ProviderMcpPlan`](ProviderMcpPlan.md)\>
