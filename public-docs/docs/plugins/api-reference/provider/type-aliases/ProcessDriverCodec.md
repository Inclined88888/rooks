
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: ProcessDriverCodec

> **ProcessDriverCodec** = `object`

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

`Omit`\<[`SessionOpenArgs`](SessionOpenArgs.md), `"profileId"` \| `"launch"`\> & `Partial`\<`Pick`\<[`SessionOpenArgs`](SessionOpenArgs.md), `"profileId"` \| `"launch"`\>\>

#### Returns

[`SessionDriver`](../interfaces/SessionDriver.md)
