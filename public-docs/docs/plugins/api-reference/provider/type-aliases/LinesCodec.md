
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: LinesCodec

> **LinesCodec** = `object`

## Properties

### kind

> `readonly` **kind**: `"lines"`

## Methods

### extractSessionId()

> **extractSessionId**(`ev`): `string` \| `null`

#### Parameters

##### ev

[`NormalizedEvent`](NormalizedEvent.md)

#### Returns

`string` \| `null`

***

### parseLine()

> **parseLine**(`line`): [`NormalizedEvent`](NormalizedEvent.md)[]

#### Parameters

##### line

`string`

#### Returns

[`NormalizedEvent`](NormalizedEvent.md)[]

***

### writeUserInput()

> **writeUserInput**(`io`, `text`, `images?`): `void`

#### Parameters

##### io

[`SessionStdio`](SessionStdio.md)

##### text

`string`

##### images?

[`ImageAttachment`](ImageAttachment.md)[]

#### Returns

`void`
