
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: BackendProfile

> **BackendProfile** = `object`

## Properties

### brand?

> `optional` **brand?**: `string`

***

### capabilities?

> `optional` **capabilities?**: `Partial`\<[`BackendCapabilities`](BackendCapabilities.md)\>

***

### cmd?

> `optional` **cmd?**: `string`

***

### credentialDirs?

> `optional` **credentialDirs?**: readonly `string`[]

***

### custom?

> `optional` **custom?**: `boolean`

***

### defaultModel

> **defaultModel**: `string` \| `null`

***

### dialect

> **dialect**: `string`

***

### disabled?

> `optional` **disabled?**: `boolean`

***

### env?

> `optional` **env?**: `Record`\<`string`, [`EnvValue`](EnvValue.md)\>

***

### envFrom?

> `optional` **envFrom?**: `Record`\<`string`, `string`\>

***

### fallbackRank?

> `optional` **fallbackRank?**: `number`

***

### icon?

> `optional` **icon?**: `string`

***

### id

> **id**: `string`

***

### label

> **label**: `string`

***

### minCliVersion?

> `optional` **minCliVersion?**: `string`

***

### models

> **models**: [`CatalogModel`](CatalogModel.md)[]

***

### modelsEndpoint?

> `optional` **modelsEndpoint?**: `object`

#### authFrom?

> `optional` **authFrom?**: `Record`\<`string`, `string`\>

#### format

> **format**: `"openai"`

#### url

> **url**: `string`

***

### providerConfig?

> `optional` **providerConfig?**: [`ProviderConfig`](ProviderConfig.md)

***

### rank?

> `optional` **rank?**: `number`

***

### requiredBinary?

> `optional` **requiredBinary?**: `string`

***

### requiredEnv?

> `optional` **requiredEnv?**: `string`[]

***

### slugPrefixes?

> `optional` **slugPrefixes?**: `string`[]

***

### subscription?

> `optional` **subscription?**: `object`

#### note

> **note**: `string`

#### planMaxToggle?

> `optional` **planMaxToggle?**: `boolean`

***

### vendor?

> `optional` **vendor?**: `string`
