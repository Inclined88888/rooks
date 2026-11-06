
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: RemoteDriverCodec

> **RemoteDriverCodec** = `object`

## Properties

### kind

> `readonly` **kind**: `"driver"`

## Methods

### extractSessionId()?

> `optional` **extractSessionId**(`ev`): `string` \| `null`

#### Parameters

##### ev

[`NormalizedEvent`](NormalizedEvent.md)

#### Returns

`string` \| `null`

***

### openSession()

> **openSession**(`args`): [`SessionDriver`](../interfaces/SessionDriver.md)

#### Parameters

##### args

`Omit`\<[`RemoteSessionOpenArgs`](RemoteSessionOpenArgs.md), `"env"` \| `"profileId"` \| `"launch"`\> & `Partial`\<`Pick`\<[`RemoteSessionOpenArgs`](RemoteSessionOpenArgs.md), `"env"` \| `"profileId"` \| `"launch"`\>\>

#### Returns

[`SessionDriver`](../interfaces/SessionDriver.md)
