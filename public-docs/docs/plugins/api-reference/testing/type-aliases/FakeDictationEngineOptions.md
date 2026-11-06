
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: FakeDictationEngineOptions

> **FakeDictationEngineOptions** = `object`

## Properties

### availability?

> `optional` **availability?**: `DictationAvailability`

***

### fail?

> `optional` **fail?**: \{ `message?`: `string`; `on`: `"start"`; \} \| \{ `afterMs?`: `number`; `code?`: `DictationErrorCode`; `fatal?`: `boolean`; `message?`: `string`; `on`: `"feed"`; \}

Make `start()` reject, or emit an error after some audio (fatal by default, which ends the session).

***

### id?

> `optional` **id?**: `string`

***

### interim?

> `optional` **interim?**: `DictationInterim`

***

### label?

> `optional` **label?**: `string`

***

### languages?

> `optional` **languages?**: `DictationLanguages`

***

### transcribe?

> `optional` **transcribe?**: (`heard`) => `string`

The text for what was heard. Default: nothing on silence, `fake transcript (1.5 s of speech)` otherwise.

#### Parameters

##### heard

[`FakeHearing`](FakeHearing.md)

#### Returns

`string`
