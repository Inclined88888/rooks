
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProviderPluginContext

> **ProviderPluginContext** = `object`

## Properties

### backends

> **backends**: `object`

#### registerDialect()

> **registerDialect**(`id`, `dialect`): () => `void`

##### Parameters

###### id

`string`

###### dialect

[`Dialect`](../interfaces/Dialect.md) \| [`RemoteDialect`](RemoteDialect.md)

##### Returns

() => `void`

#### registerProfile()

> **registerProfile**(`profile`): () => `void`

##### Parameters

###### profile

[`RegisteredProfile`](RegisteredProfile.md)

##### Returns

() => `void`

***

### log

> **log**: `object`

#### error()

> **error**(...`args`): `void`

##### Parameters

###### args

...`unknown`[]

##### Returns

`void`

#### info()

> **info**(...`args`): `void`

##### Parameters

###### args

...`unknown`[]

##### Returns

`void`

#### warn()

> **warn**(...`args`): `void`

##### Parameters

###### args

...`unknown`[]

##### Returns

`void`

***

### provider

> **provider**: [`ProviderServices`](ProviderServices.md)

***

### settings

> **settings**: `object`

#### get()

> **get**(`key`): [`ProviderSettingValue`](ProviderSettingValue.md)

##### Parameters

###### key

`string`

##### Returns

[`ProviderSettingValue`](ProviderSettingValue.md)
