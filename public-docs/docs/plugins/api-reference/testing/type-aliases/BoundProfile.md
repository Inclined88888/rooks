
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: BoundProfile

> **BoundProfile** = `object`

## Properties

### cmd?

> `readonly` `optional` **cmd?**: `string`

Binary; defaults to the dialect's `defaultCmd`.

***

### env?

> `readonly` `optional` **env?**: `Readonly`\<`Record`\<`string`, `string`\>\>

The resolved environment of the profile (what its `env` resolver returned).

***

### id

> `readonly` **id**: `string`

The profile's id: what the daemon calls the provider.

***

### knownModels?

> `readonly` `optional` **knownModels?**: readonly `string`[]

***

### minCliVersion?

> `readonly` `optional` **minCliVersion?**: `string`

***

### providerConfig?

> `readonly` `optional` **providerConfig?**: `ProfileRuntime`\[`"providerConfig"`\]
