
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProviderMcpPlan

> **ProviderMcpPlan** = `object`

## Properties

### commandPolicy

> `readonly` **commandPolicy**: *typeof* `COMMAND_POLICY`

***

### daemonUrl

> `readonly` **daemonUrl**: `string`

***

### excludedServers?

> `readonly` `optional` **excludedServers?**: readonly `string`[]

***

### identityEnv

> `readonly` **identityEnv**: `Readonly`\<`Record`\<`string`, `string`\>\>

***

### permissionTool

> `readonly` **permissionTool**: `string` \| `null`

***

### preApprovedTools

> `readonly` **preApprovedTools**: readonly `string`[]

***

### scripts

> `readonly` **scripts**: `object`

#### forms

> `readonly` **forms**: `string`

#### rooks

> `readonly` **rooks**: `string`

***

### servers

> `readonly` **servers**: readonly [`ProviderMcpServer`](ProviderMcpServer.md)[]
