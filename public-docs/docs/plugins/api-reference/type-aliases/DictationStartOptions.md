
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: DictationStartOptions

> **DictationStartOptions** = `object`

What the product hands an engine to start a session.

## Properties

### language

> **language**: `string` \| `null`

The language the user chose, or `null` for automatic.

***

### signal

> **signal**: `AbortSignal`

Aborted when the product cancels the session; stop feeding work then.

## Methods

### onEvent()

> **onEvent**(`event`): `void`

#### Parameters

##### event

[`DictationEvent`](DictationEvent.md)

#### Returns

`void`
