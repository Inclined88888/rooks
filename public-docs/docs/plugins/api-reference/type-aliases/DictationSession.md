
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: DictationSession

> **DictationSession** = `object`

One dictation, from `start` to `stop` or `cancel`.

## Methods

### cancel()

> **cancel**(): `void`

Drops what is pending; no `final` follows.

#### Returns

`void`

***

### feed()

> **feed**(`pcm`): `void`

PCM, 16 kHz mono, Float32 in [-1, 1], about 100 ms per call (1 sample to
2 s). The product opens the microphone; an engine never does, and only
receives samples between `start()` and `stop()` / `cancel()`.

#### Parameters

##### pcm

`Float32Array`

#### Returns

`void`

***

### stop()

> **stop**(): `Promise`\<`void`\>

Resolves after the last `final`.

#### Returns

`Promise`\<`void`\>
